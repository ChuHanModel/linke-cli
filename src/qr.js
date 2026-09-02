/**
 * 精简 QR Code 编码器（Model 2，byte mode，纠错级 L，version 1-6）。
 * 为守住「零依赖」架构决策（T3）手写实现：局域网 URL ≈ 60-100 字节，
 * v6-L 容量 136 字节已覆盖；version ≤ 6 无需 version info 块，复杂度可控。
 *
 * 结构：
 *   buildQr(bytes) → { size, modules }（布尔矩阵，true=黑）
 *   renderTerminal(matrix, quietZone) → 终端半块字符文本
 *
 * 正确性由 test/qr.test.mjs 与系统 qrencode 逐模块对拍保障。
 */

// ---- version 参数表（L 级）----
// blocks: [ [totalCodewords, dataCodewords], ... ] 每块
const VERSION_PARAMS = {
  1: { size: 21, blocks: [[26, 19]] },
  2: { size: 25, blocks: [[44, 34]] },
  3: { size: 29, blocks: [[70, 55]] },
  4: { size: 33, blocks: [[100, 80]] },
  5: { size: 37, blocks: [[134, 108]] },
  6: { size: 41, blocks: [[86, 68], [86, 68]] },
}

// alignment pattern 中心坐标候选（仅右下角组合不与 finder 重叠，v2-6）
const ALIGN_POS = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34] }

// ---- GF(256)，本原多项式 0x11d ----
const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)
;(function buildGf() {
  let x = 1
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x
    GF_LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]
})()

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0
  return GF_EXP[GF_LOG[a] + GF_LOG[b]]
}

/** RS 生成多项式 g(x) = ∏(x - α^i)，系数最高次在前 */
function rsGeneratorPoly(degree) {
  let poly = [1]
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i])
    }
    poly = next
  }
  return poly
}

/** 求数据多项式的 RS 纠错码字（systematic 编码） */
function rsEncode(data, ecLen) {
  const gen = rsGeneratorPoly(ecLen)
  const rem = new Array(data.length + ecLen).fill(0)
  for (let i = 0; i < data.length; i++) rem[i] = data[i]
  for (let i = 0; i < data.length; i++) {
    const factor = rem[i]
    if (factor === 0) continue
    for (let j = 0; j < gen.length; j++) {
      rem[i + j] ^= gfMul(gen[j], factor)
    }
  }
  return rem.slice(data.length)
}

// ---- 数据位流 ----

/** 按最小可用 version 编码为总码字流（含块交织）；导出供测试分层验证 */
export function encodeCodewords(bytes) {
  const len = bytes.length
  let version = 0
  for (let v = 1; v <= 6; v++) {
    const dataCap = VERSION_PARAMS[v].blocks.reduce((sum, [t, d]) => sum + d, 0)
    // byte mode 头部开销：mode 4bit + 计数 8bit
    if (len + 2 <= dataCap) {
      version = v
      break
    }
  }
  if (!version) {
    throw new Error(`内容过长（${len} 字节），超出 v6-L 容量`)
  }
  const { blocks } = VERSION_PARAMS[version]
  const dataCap = blocks.reduce((sum, [t, d]) => sum + d, 0)

  // 位流：mode(0100) + 8bit 计数 + 数据 + 终止符 + 填充
  const bits = []
  const push = (value, count) => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >> i) & 1)
  }
  push(0b0100, 4)
  push(len, 8)
  for (const byte of bytes) push(byte, 8)
  const capacityBits = dataCap * 8
  push(0, Math.min(4, capacityBits - bits.length))
  while (bits.length % 8 !== 0) bits.push(0)
  const stream = []
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]
    stream.push(byte)
  }
  const padBytes = [0xec, 0x11]
  let padIdx = 0
  while (stream.length < dataCap) stream.push(padBytes[padIdx++ % 2])

  // 分块 + 各块纠错 + 交织（数据列优先，纠错随后）
  const dataBlocks = []
  const ecBlocks = []
  let offset = 0
  for (const [, dataLen] of blocks) {
    const chunk = stream.slice(offset, offset + dataLen)
    offset += dataLen
    dataBlocks.push(chunk)
    ecBlocks.push(rsEncode(chunk, blocks[0][0] - blocks[0][1]))
  }
  const maxData = Math.max(...dataBlocks.map((b) => b.length))
  const maxEc = Math.max(...ecBlocks.map((b) => b.length))
  const codewords = []
  for (let i = 0; i < maxData; i++) {
    for (const block of dataBlocks) if (i < block.length) codewords.push(block[i])
  }
  for (let i = 0; i < maxEc; i++) {
    for (const block of ecBlocks) if (i < block.length) codewords.push(block[i])
  }
  return { version, codewords }
}

// ---- 矩阵 ----

function makeMatrices(size) {
  const modules = Array.from({ length: size }, () => new Array(size).fill(false))
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false))
  return { modules, reserved }
}

function reserveFinder(modules, reserved, row, col) {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r
      const cc = col + c
      if (rr < 0 || rr >= modules.length || cc < 0 || cc >= modules.length) continue
      const inRing =
        (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
        (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
        (r >= 2 && r <= 4 && c >= 2 && c <= 4)
      modules[rr][cc] = inRing
      reserved[rr][cc] = true
    }
  }
}

function reserveAlignment(modules, reserved, centers, size) {
  for (const [row, col] of centers) {
    for (let r = -2; r <= 2; r++) {
      for (let c = -2; c <= 2; c++) {
        const rr = row + r
        const cc = col + c
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue
        if (reserved[rr][cc]) continue
        const isRing = Math.max(Math.abs(r), Math.abs(c)) !== 1
        modules[rr][cc] = isRing
        reserved[rr][cc] = true
      }
    }
  }
}

/** format info 的两份副本共 30 个固定位置（值由 placeFormat 填充） */
function formatPositions(size) {
  return [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
    [size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8],
    [size - 5, 8], [size - 6, 8], [size - 7, 8],
    [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5], [8, size - 4],
    [8, size - 3], [8, size - 2], [8, size - 1],
  ]
}

function buildFunctionPatterns(version) {
  const { size } = VERSION_PARAMS[version]
  const { modules, reserved } = makeMatrices(size)
  // finder + separator（三个角）
  reserveFinder(modules, reserved, 0, 0)
  reserveFinder(modules, reserved, 0, size - 7)
  reserveFinder(modules, reserved, size - 7, 0)
  // timing
  for (let i = 8; i < size - 8; i++) {
    modules[6][i] = i % 2 === 0
    reserved[6][i] = true
    modules[i][6] = i % 2 === 0
    reserved[i][6] = true
  }
  // alignment（跳过与 finder 保留区重叠的组合——v2-6 实际仅右下一个）
  const centers = []
  const pos = ALIGN_POS[version]
  for (const r of pos) {
    for (const c of pos) {
      if (reserved[r] && reserved[r][c]) continue
      centers.push([r, c])
    }
  }
  reserveAlignment(modules, reserved, centers, size)
  // format info 区预留（数据放置须跳过，值由 placeFormat 填充）
  for (const [r, c] of formatPositions(size)) reserved[r][c] = true
  // dark module
  modules[4 * version + 9][8] = true
  reserved[4 * version + 9][8] = true
  return { modules, reserved }
}

const MASK_FUNCS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
]

/** 把码字按蛇形顺序放置并用 mask 翻转（功能模块不动） */
function placeData(modules, reserved, codewords, maskFn) {
  const size = modules.length
  const bits = []
  for (const byte of codewords) {
    for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1)
  }
  let bitIdx = 0
  const takeBit = () => (bitIdx < bits.length ? bits[bitIdx++] : 0)
  let col = size - 1
  let upward = true
  while (col > 0) {
    if (col === 6) col -= 1
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i
      for (const cc of [col, col - 1]) {
        if (reserved[row][cc]) continue
        let bit = takeBit()
        if (maskFn(row, cc)) bit ^= 1
        modules[row][cc] = bit === 1
      }
    }
    col -= 2
    upward = !upward
  }
  return modules
}

/** BCH(15,5) 计算 format 信息（未异或 mask 前的 15 bit） */
function formatBits(mask) {
  const data = (0b01 << 3) | mask // L = 01
  let rem = data
  for (let i = 0; i < 10; i++) {
    rem = (rem << 1) ^ ((rem >> 9) * 0x537)
  }
  return ((data << 10) | (rem & 0x3ff)) ^ 0x5412
}

function placeFormat(modules, mask) {
  const size = modules.length
  const bits = formatBits(mask)
  const bitAt = (i) => ((bits >> i) & 1) === 1 // i: 14..0
  const seq = formatPositions(size)
  seq.forEach(([r, c], idx) => {
    modules[r][c] = bitAt(idx < 15 ? 14 - idx : 14 - (idx - 15))
  })
}

// ---- penalty（标准 4 规则，用于选最优掩码）----

function penaltyFor(modules) {
  const size = modules.length
  let penalty = 0

  // N1/N3：行、列两个方向
  for (const horizontal of [true, false]) {
    for (let i = 0; i < size; i++) {
      let run = 1
      const cells = []
      for (let j = 0; j < size; j++) {
        cells.push(horizontal ? modules[i][j] : modules[j][i])
      }
      for (let j = 1; j < size; j++) {
        if (cells[j] === cells[j - 1]) run++
        else {
          if (run >= 5) penalty += 3 + (run - 5)
          run = 1
        }
      }
      if (run >= 5) penalty += 3 + (run - 5)
      const line = cells.map((v) => (v ? '1' : '0')).join('')
      let from = 0
      while (true) {
        const idx1 = line.indexOf('10111010000', from)
        const idx2 = line.indexOf('00001011101', from)
        if (idx1 === -1 && idx2 === -1) break
        penalty += 40
        from = (idx1 === -1 ? idx2 : idx1) + 1
      }
    }
  }

  // N2：2×2 同色块
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      if (
        modules[r][c] === modules[r][c + 1] &&
        modules[r][c] === modules[r + 1][c] &&
        modules[r][c] === modules[r + 1][c + 1]
      ) {
        penalty += 3
      }
    }
  }

  // N4：暗模块比例偏离 50%
  let dark = 0
  for (const row of modules) for (const v of row) if (v) dark++
  const percent = (dark * 100) / (size * size)
  penalty += Math.floor(Math.abs(percent - 50) / 5) * 10
  return penalty
}

/**
 * 编码入口：返回带掩码的完整矩阵。
 * @param {Uint8Array|number[]} bytes byte mode 内容
 */
export function buildQr(bytes) {
  const { version, codewords } = encodeCodewords(Array.from(bytes))
  let best = null
  let bestPenalty = Infinity
  let bestMask = 0
  for (let mask = 0; mask < 8; mask++) {
    const { modules, reserved } = buildFunctionPatterns(version)
    placeData(modules, reserved, codewords, MASK_FUNCS[mask])
    placeFormat(modules, mask)
    const penalty = penaltyFor(modules)
    if (penalty < bestPenalty) {
      bestPenalty = penalty
      best = modules
      bestMask = mask
    }
  }
  return { size: best.length, modules: best, mask: bestMask, version }
}

/** 按指定掩码构建（测试对拍用） */
export function buildQrWithMask(bytes, mask) {
  const { version, codewords } = encodeCodewords(Array.from(bytes))
  const { modules, reserved } = buildFunctionPatterns(version)
  placeData(modules, reserved, codewords, MASK_FUNCS[mask])
  placeFormat(modules, mask)
  return { size: modules.length, modules, mask, version }
}

/** 终端渲染：半块字符，每字符 1 模块宽 × 2 模块高，含 quiet zone */
export function renderTerminal(matrix, quietZone = 4) {
  const size = matrix.length
  const total = size + quietZone * 2
  const grid = Array.from({ length: total }, () => new Array(total).fill(false))
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) grid[r + quietZone][c + quietZone] = matrix[r][c]
  }
  const lines = []
  for (let r = 0; r < total; r += 2) {
    let line = ''
    for (let c = 0; c < total; c++) {
      const top = grid[r][c]
      const bottom = grid[r + 1] ? grid[r + 1][c] : false
      if (top && bottom) line += '█'
      else if (top) line += '▀'
      else if (bottom) line += '▄'
      else line += ' '
    }
    lines.push(line)
  }
  return lines.join('\n')
}
