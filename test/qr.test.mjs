/**
 * QR 编码器对拍测试：与系统 qrencode（若安装）逐模块比对。
 * 断言策略：
 *   1) 编码正确性（硬）：qrencode 输出矩阵 ∈ 我方 8 掩码矩阵集合
 *      ——数据/纠错/放置/format 全对，任何掩码下都可扫；
 *   2) penalty 掩码选择（软，容忍 tie-break 差异）：我方自动选择
 *      与 qrencode 相同则 OK；不同只记录，不判失败（规范允许
 *      encoder 自选掩码，两方都合法）。
 * 未安装 qrencode 的环境自动 skip（本机验证已跑过）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { buildQr, buildQrWithMask, renderTerminal, encodeCodewords } from '../src/qr.js'

function qrencodeMatrix(text, version) {
  const stdout = execFileSync('qrencode', [
    '-t', 'ASCII', '-m', '0', '-8', '-l', 'L',
    '--strict-version', '-v', String(version), text,
  ]).toString()
  const lines = stdout.split('\n').filter((l) => l.length > 0)
  const size = 17 + 4 * version
  return lines.slice(0, size).map((l) =>
    Array.from({ length: size }, (_, c) => l.slice(c * 2, c * 2 + 2) === '##')
  )
}

function matricesEqual(a, b) {
  if (a.length !== b.length) return false
  for (let r = 0; r < a.length; r++) {
    for (let c = 0; c < a.length; c++) {
      if (a[r][c] !== b[r][c]) return false
    }
  }
  return true
}

const hasQrencode = (() => {
  try {
    execFileSync('which', ['qrencode'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
})()

const samples = [
  'A',
  'https://github.com/ChuHanModel/linke-cli',
  'http://127.0.0.1:54321/?t=a1b2c3d4e5f60718293a4b5c6d7e8f90',
  'http://192.168.31.42:54321/?t=00112233445566778899aabbccddeeff',
  'http://10.0.0.8:65535/?t=ffeeddccbbaa99887766554433221100&x=1',
]

test('码字编码：A 的 v1-L 数据码字与填充序列正确', () => {
  const { version, codewords } = encodeCodewords(Buffer.from('A'))
  assert.equal(version, 1)
  assert.equal(codewords.length, 26)
  assert.equal(codewords[0], 0x40) // 0100(模式) 000000(计数高6位)
  assert.equal(codewords[1], 0x14) // 计数低2位+数据高6位
  assert.equal(codewords[2], 0x10) // 'A' 低2位 + terminator
  assert.equal(codewords[3], 0xec) // 填充字节 1
  assert.equal(codewords[4], 0x11) // 填充字节 2
})

test('容量边界：超 v6-L（136 数据字节）报错', () => {
  assert.throws(() => encodeCodewords(Buffer.alloc(135 + 1, 0x61)), /超出 v6-L 容量/)
  // 134 字节数据 + 2 字节头 = 136 恰好满
  const { version } = encodeCodewords(Buffer.alloc(134, 0x61))
  assert.equal(version, 6)
})

test('终端渲染：半块字符行数为模块数一半（向上取整）+ quiet zone', () => {
  const { modules, size } = buildQr(Buffer.from('hello qr'))
  const text = renderTerminal(modules, 4)
  const lines = text.split('\n')
  const total = size + 8
  assert.equal(lines.length, Math.ceil(total / 2))
  assert.ok(lines.every((l) => l.length === total))
})

if (hasQrencode) {
  test('与 qrencode 逐模块对拍：输出矩阵 ∈ 我方 8 掩码集合（编码正确性）', () => {
    for (const text of samples) {
      const bytes = Buffer.from(text, 'utf8')
      const built = buildQr(bytes)
      const ref = qrencodeMatrix(text, built.version)
      const candidates = Array.from({ length: 8 }, (_, m) => buildQrWithMask(bytes, m).modules)
      const matched = candidates.some((m) => matricesEqual(m, ref))
      assert.ok(matched, `对拍失败: ${text}（v${built.version}）`)
    }
  })

  test('与 qrencode penalty 掩码选择对照（软断言：不一致仅告警）', () => {
    for (const text of samples) {
      const built = buildQr(Buffer.from(text, 'utf8'))
      const ref = qrencodeMatrix(text, built.version)
      const same = matricesEqual(built.modules, ref)
      if (!same) {
        console.warn(`[qr] penalty 掩码选择与 qrencode 不同（均合法）: ${text.slice(0, 40)}...`)
      }
    }
  })
} else {
  test.skip('系统未安装 qrencode，跳过对拍', () => {})
}
