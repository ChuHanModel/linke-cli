/**
 * 教务 HTML 预处理与 cookie 提取（环境无关纯函数）。
 * 口径与 App 端 linke_App/repositories/jwHttp.js、utils/jwLoginExpired.js 保持同源。
 */

/**
 * 从响应对象提取 "k=v; k2=v2" 形式的 Cookie 头。
 * 接受带 getSetCookie() 的标准 fetch Response（Node >= 18.14），
 * 也接受宿主垫片构造的同形对象（uni.request 等）。
 */
export function extractCookieHeader(response) {
  const headers = response && response.headers ? response.headers : {}
  const list = headers.getSetCookie ? headers.getSetCookie() : []
  const pairs = []
  for (const raw of list) {
    const pair = String(raw).split(';')[0]
    if (pair) pairs.push(pair.trim())
  }
  return pairs.join('; ')
}

/**
 * 教务 HTML 预处理：删除空格（含全角）与换行。
 * PHP 端与 App 端解析前都做同一处理，正则依赖此口径（<td align= 会变 <tdalign=）。
 */
export function stripSpaces(html) {
  return String(html ?? '').replace(/[ \u3000\t\n\r]/g, '')
}

/**
 * 教务「登录过期」判定。
 * 判定序（T12 修订：短页阈值曾误伤 cjcx_avg 这类 <5KB 小业务页）：
 *   1. 登录页表单特征（RANDOMCODE + 账号/密码输入框）——最准；
 *   2. 「用户登录 / 请先登录」文案；
 *   3. 短 html + </html> 且不含 <table>——登录页/错误页兜底
 *      （业务页必有数据表，小页面如 gpa 页含表即放行）。
 */
export function isJwLoginExpired(html) {
  if (!html || typeof html !== 'string') return false
  const trimmed = html.trim()
  if (
    trimmed.includes('RANDOMCODE') &&
    (trimmed.includes('userAccount') || trimmed.includes('userPassword'))
  ) {
    return true
  }
  if (trimmed.includes('用户登录') || trimmed.includes('请先登录')) return true
  if (trimmed.includes('</html>') && trimmed.length < 5000 && !/<table[\s>]/i.test(trimmed)) {
    return true
  }
  return false
}
