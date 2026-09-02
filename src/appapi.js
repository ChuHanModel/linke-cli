/**
 * 林课后端 PhalApi 通用客户端（T15：linke notices 使用）。
 * 签名口径与 App 端 appApi.js 同源：signMain = md5("Linke"+service+signTime)。
 * notices 是 CLI 中唯一走后端 API 的命令——教务公告是公共数据
 * （后端每日同步缓存），架构上不爬教务（T3 既有决策）。
 */
import crypto from 'node:crypto'
import { DEFAULT_API_BASE } from './config.js'
import { networkError } from './errors.js'

const SIGN_KEY = 'Linke'

/**
 * 调用林课后端接口（GET）。
 * @param {string} service 服务名（如 App.JwNotice.GetListFromDb）
 * @param {object} params 查询参数
 * @param {string} apiBase PhalApi 入口
 * @returns {Promise<object>} ret 200 的 data 部分
 */
export async function callAppApi(service, params = {}, apiBase = DEFAULT_API_BASE) {
  const signTime = Math.floor(Date.now() / 1000)
  const signMain = crypto
    .createHash('md5')
    .update(SIGN_KEY + service + String(signTime))
    .digest('hex')
  const query = new URLSearchParams({ service, signMain, signTime: String(signTime) })
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') query.set(k, String(v))
  }
  let response
  try {
    response = await fetch(`${apiBase.replace(/\?.*$/, '')}?${query}`, {
      signal: AbortSignal.timeout(20000),
    })
  } catch (err) {
    throw networkError('请求林课后端', err)
  }
  let body
  try {
    body = await response.json()
  } catch (err) {
    throw networkError('解析林课后端响应', err)
  }
  if (body && body.ret == 200) return body.data
  throw new Error((body && body.msg) || '后端接口返回异常')
}
