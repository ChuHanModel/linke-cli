/**
 * 强智教务（Kingosoft，jsxsd 路径）登录密码加密。
 * 与 App 端 services/auth/jwLoginService.js computeEncoded 逐字节同源；
 * 算法：账号%%%密码 的前 20 个字符，每个字符后按 sxh 对应位数字
 * 从 scode 头部取 N 个字符插入；20 字符之后原样拼接。
 */
export function computeEncoded(account, password, seedScode, seedSxh) {
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
