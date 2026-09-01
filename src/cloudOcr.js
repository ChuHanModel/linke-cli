/**
 * 云端验证码识别客户端。
 *
 * 合规定位（T3 上下文 ①）：只使用「传图返文字」的无状态能力——
 * 验证码图片 base64 发往林课云端 App.Captcha.Recognize，云端不接触
 * 学号/密码/cookie；登录请求本身从用户本机直发教务系统。
 *
 * 签名口径与 App 端 repositories/appApi.js 同源：
 *   signMain = md5("Linke" + service + signTime)，signTime 为 Unix 秒。
 */
import crypto from 'node:crypto'
import { networkError } from './errors.js'

const SERVICE = 'App.Captcha.Recognize'
const SIGN_KEY = 'Linke'

function buildSignedUrl(apiBase) {
  const signTime = Math.floor(Date.now() / 1000)
  const signMain = crypto.createHash('md5').update(SIGN_KEY + SERVICE + String(signTime)).digest('hex')
  const base = apiBase.replace(/\?.*$/, '')
  return `${base}?service=${encodeURIComponent(SERVICE)}&signMain=${signMain}&signTime=${signTime}`
}

/**
 * 识别验证码图片。
 * @param {string} apiBase PhalApi 入口地址
 * @param {string} imageBase64 纯 base64（可带 data URI 前缀，会剥离）
 * @returns {Promise<string>} 识别文字（小写，教务验证码不区分大小写）
 */
export async function recognizeCaptcha(apiBase, imageBase64) {
  const pure = imageBase64.includes(',') ? imageBase64.split(',')[1] || imageBase64 : imageBase64
  let response
  try {
    response = await fetch(buildSignedUrl(apiBase), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=utf-8' },
      body: JSON.stringify({ image_base64: pure }),
      signal: AbortSignal.timeout(20000),
    })
  } catch (err) {
    throw networkError('云端验证码识别', err)
  }
  let body
  try {
    body = await response.json()
  } catch (err) {
    throw networkError('云端验证码识别（响应解析）', err)
  }
  if (body && body.ret == 200 && body.data) {
    if (body.data.result) return String(body.data.result).toLowerCase()
    if (body.data.error) throw new Error(`云端识别返回错误：${body.data.error}`)
  }
  throw new Error('云端识别返回格式异常')
}
