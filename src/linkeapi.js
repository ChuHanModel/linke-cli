/**
 * 林课自有数据接口（二期，T18/T19）。鉴权：userKey = md5(学号+密码)
 * **现算不落盘**（App 端 sessionService.computeUserKey 同源）；公共
 * 签名复用 appapi.callAppApi。这是登录识别之外唯一合法的后端交互面
 * （教务查询链路仍零后端，静态断言守卫不回归）。
 */
import crypto from 'node:crypto'
import { callAppApi } from './appapi.js'

/** 与 App 端同源：md5(String(userId) + String(password))，不落盘 */
export function computeUserKey(userId, password) {
  if (!userId || !password) return ''
  return crypto.createHash('md5').update(String(userId) + String(password)).digest('hex')
}

/**
 * 带现算 userKey 调林课接口。
 * @param {object} config resolveConfig() 结果（含明文密码，仅内存）
 * @param {string} service 接口名
 * @param {object} params 业务参数（不含 userKey，此处注入）
 */
export async function callLinkeApi(config, service, params = {}) {
  const userKey = computeUserKey(config.userId, config.password)
  if (!userKey) throw new Error('缺少凭据，无法计算用户标识')
  return callAppApi(service, { ...params, userKey }, config.apiBase)
}
