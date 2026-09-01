/**
 * 山财（sdufe）教务适配器：登录流程与数据抓取。
 * 流程移植自 linke_App/services/auth/loginFlowService.js 与
 * linke_App/utils/jwAutoLogin.js（本机直连教务的现役实现），
 * 差异：验证码识别改调 cloudOcr（App 内同走 App.Captcha.Recognize）。
 *
 * 链路纪律：对 jw.sdufe.edu.cn 的所有请求都从用户本机发出；
 * 云端只收验证码图片 base64（传图返文字）。
 */
import { extractCookieHeader, isJwLoginExpired, progress } from '../../util.js'
import { networkError, credentialInvalid, loginRetryExhausted, LinkeError, EXIT } from '../../errors.js'
import { computeEncoded } from './encoding.js'
import {
  parseUserData,
  hasAuthenticatedProfileMarkers,
  parseCurrentTerm,
  parseScheduleHtml,
  parseScoresHtml,
} from './parsers.js'

const USER_AGENT = 'Apifox/1.0.0 (https://apifox.com)'
const REQUEST_TIMEOUT_MS = 20000

export const sdufeAdapter = {
  id: 'sdufe',
  name: '山东财经大学（正方教务 jsxsd）',
  baseUrl: 'http://jw.sdufe.edu.cn',

  /**
   * 教务 HTTP 请求（cookie 手动管理，redirect 跟随——与 uni.request 默认行为一致）。
   * 返回 { status, text, arrayBuffer }。
   */
  async request(url, method, { body, cookie, expect = 'text' } = {}) {
    let response
    try {
      response = await fetch(url, {
        method,
        redirect: 'follow',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: '*/*',
          Connection: 'keep-alive',
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (err) {
      throw networkError('请求教务系统', err)
    }
    const nextCookie = extractCookieHeader(response)
    if (expect === 'buffer') {
      return { status: response.status, buffer: Buffer.from(await response.arrayBuffer()), nextCookie }
    }
    return { status: response.status, text: await response.text(), nextCookie }
  },

  /** 获取会话种子（scode/sxh）与初始 Cookie */
  async fetchSeed() {
    const res = await this.request(`${this.baseUrl}/Logon.do?method=logon&flag=sess`, 'POST')
    const parts = String(res.text || '').trim().split('#')
    if (parts.length < 2 || !res.nextCookie) {
      throw new LinkeError('SEED_FAILED', '获取教务会话种子失败', {
        exitCode: EXIT.NETWORK,
        hint: '教务系统可能暂不可达，稍后重试',
      })
    }
    return { seedScode: parts[0] || '', seedSxh: parts[1] || '', cookie: res.nextCookie }
  },

  /** 获取验证码图片 base64 */
  async fetchCaptcha(cookie) {
    const res = await this.request(`${this.baseUrl}/verifycode.servlet`, 'GET', {
      cookie,
      expect: 'buffer',
    })
    const textPeek = res.buffer.subarray(0, 200).toString('utf8')
    if (textPeek.includes('</html>')) {
      throw new LinkeError('CAPTCHA_FAILED', '获取验证码图片失败（教务返回了页面而非图片）', {
        exitCode: EXIT.NETWORK,
        hint: '稍后重试；若持续出现，教务可能正在维护',
      })
    }
    return res.buffer.toString('base64')
  },

  /** 提交登录。验证码错误 → isCaptchaError；密码错误 → isPasswordError */
  async submitLogin({ userId, password, captcha, cookie, seedScode, seedSxh }) {
    const encoded = computeEncoded(userId, password, seedScode, seedSxh)
    if (!encoded) throw new Error('登录参数计算失败')
    const form = [
      ['userAccount', userId],
      ['userPassword', password],
      ['RANDOMCODE', captcha],
      ['encoded', encoded],
    ]
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&')
    const res = await this.request(`${this.baseUrl}/Logon.do?method=logon`, 'POST', {
      body: form,
      cookie,
    })
    const text = res.text || ''
    if (text.includes('验证码错误')) {
      const err = new Error('验证码错误')
      err.isCaptchaError = true
      throw err
    }
    if (text.includes('密码错误')) {
      const err = new Error('账号或密码错误')
      err.isPasswordError = true
      throw err
    }
    return res
  },

  /** 获取个人主页 HTML（登录确认 / session 探活） */
  async fetchProfileHtml(cookie) {
    const res = await this.request(`${this.baseUrl}/jsxsd/framework/xsMain_new.jsp`, 'GET', { cookie })
    return res.text || ''
  },

  /**
   * 完整登录：种子 → 验证码 → 云端识别 → 提交 → 主页确认。
   * 验证码识别/验证码错误自动重试（整体重新取种子+验证码，maxRetries 次）。
   * @returns {{ cookie: string, userInfo: object }}
   */
  async login({ userId, password, recognizeCaptcha }, { maxRetries = 3, onProgress = progress } = {}) {
    let lastCaptchaError = null
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      onProgress(`获取教务会话（第 ${attempt}/${maxRetries} 次）...`)
      const { seedScode, seedSxh, cookie } = await this.fetchSeed()
      try {
        onProgress('获取验证码图片...')
        const captchaBase64 = await this.fetchCaptcha(cookie)
        onProgress('云端识别验证码...')
        const captcha = await recognizeCaptcha(captchaBase64)
        if (!captcha) throw Object.assign(new Error('识别结果为空'), { isCaptchaError: true })

        onProgress('提交登录...')
        try {
          await this.submitLogin({ userId, password, captcha, cookie, seedScode, seedSxh })
        } catch (err) {
          if (err.isCaptchaError) throw err
          if (err.isPasswordError) throw credentialInvalid('教务返回密码错误')
          throw err
        }

        onProgress('确认登录状态...')
        const html = await this.fetchProfileHtml(cookie)
        // 假登录检测（App 1.0.6/1.0.8 修复口径）
        const isLoginPage =
          typeof html === 'string' &&
          html.includes('RANDOMCODE') &&
          (html.includes('userAccount') || html.includes('userPassword'))
        const userInfo = parseUserData(html)
        if (isLoginPage || isJwLoginExpired(html) || !hasAuthenticatedProfileMarkers(html, userInfo)) {
          throw Object.assign(new Error('假登录：主页未命中已登录特征'), { isCaptchaError: true })
        }
        return { cookie, userInfo }
      } catch (err) {
        if (err.isCaptchaError && attempt < maxRetries) {
          lastCaptchaError = err
          onProgress('验证码未通过，刷新重试...')
          continue
        }
        if (err.isCaptchaError) {
          lastCaptchaError = err
          break
        }
        throw err
      }
    }
    throw loginRetryExhausted(maxRetries)
  },

  /** 解析当前学期（课表页 select），失败返回 null */
  async fetchCurrentTerm(cookie) {
    const res = await this.request(`${this.baseUrl}/jsxsd/xskb/xskb_list.do`, 'GET', { cookie })
    return parseCurrentTerm(res.text || '')
  },

  /** 抓课表：term 空 = 教务默认学期；week 空 = 全部周 */
  async fetchSchedule(cookie, { term = '', week = '' } = {}) {
    const form = `xnxq01id=${encodeURIComponent(term)}&zc=${encodeURIComponent(String(week))}`
    const res = await this.request(`${this.baseUrl}/jsxsd/xskb/xskb_list.do`, 'POST', {
      body: form,
      cookie,
    })
    return parseScheduleHtml(res.text || '')
  },

  /** 抓成绩：term 空 = 全部学期 */
  async fetchScores(cookie, { term = '' } = {}) {
    const form = `kksj=${encodeURIComponent(term)}&xsfs=all`
    const res = await this.request(`${this.baseUrl}/jsxsd/kscj/cjcx_list`, 'POST', {
      body: form,
      cookie,
    })
    return parseScoresHtml(res.text || '')
  },

  /** session 探活：返回当前登录用户信息；过期抛 isJwLoginExpired 错误 */
  async probeSession(cookie) {
    const html = await this.fetchProfileHtml(cookie)
    if (isJwLoginExpired(html)) {
      const err = new Error('jw login expired')
      err.isJwLoginExpired = true
      throw err
    }
    const userInfo = parseUserData(html)
    if (!hasAuthenticatedProfileMarkers(html, userInfo)) {
      const err = new Error('jw login expired')
      err.isJwLoginExpired = true
      throw err
    }
    return userInfo
  },
}
