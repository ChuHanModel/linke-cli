/**
 * computeEncoded 对拍测试：基准函数逐字符复制自现役
 * linke_App/services/auth/jwLoginService.js computeEncoded，
 * 保证 CLI 实现与 App 端产出完全一致（登录兼容性的根）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { computeEncoded } from '../src/schools/sdufe/encoding.js'

// —— 基准（App 端现役实现，勿改）——
function computeEncodedBaseline(account, password, seedScode, seedSxh) {
  if (!account || !password || !seedScode || !seedSxh) return ''
  let scode = seedScode
  const code = `${account}%%%${password}`
  let encoded = ''
  for (let i = 0; i < code.length; i++) {
    if (i < 20) {
      const n = parseInt(seedSxh.substring(i, i + 1), 10)
      const take = Number.isNaN(n) ? 0 : n
      encoded += code.substring(i, i + 1) + scode.substring(0, take)
      scode = scode.substring(take, scode.length)
    } else {
      encoded += code.substring(i, code.length)
      break
    }
  }
  return encoded
}

const cases = [
  // 常规：12 位学号 + 常见密码
  ['202401140207', 'Passw0rd!2026', 'abcdefghijklmnopqrstuvwxyz0123456789', '12345012350123450123'],
  // sxh 全 0（不消耗 scode）
  ['202401140207', 'short', 'abcdef', '00000000000000000000'],
  // sxh 含非数字（NaN→0 分支）
  ['123', '456', 'seedseedseed', '1a3b5c7d9e'],
  // 短密码：code 长度 < 20
  ['1', 'p', 'scode', '999999'],
  // 密码含中文与百分号
  ['202401140207', '密码%%%', '组合种子值ABCDEF', '11111111111111111111'],
]

test('computeEncoded 与 App 端现役实现逐字节一致', () => {
  for (const [account, password, scode, sxh] of cases) {
    assert.equal(
      computeEncoded(account, password, scode, sxh),
      computeEncodedBaseline(account, password, scode, sxh),
      `不一致: ${account} / ${password}`
    )
  }
})

test('computeEncoded 空参数返回空串', () => {
  assert.equal(computeEncoded('', 'p', 's', '1'), '')
  assert.equal(computeEncoded('a', '', 's', '1'), '')
  assert.equal(computeEncoded('a', 'p', '', '1'), '')
  assert.equal(computeEncoded('a', 'p', 's', ''), '')
})
