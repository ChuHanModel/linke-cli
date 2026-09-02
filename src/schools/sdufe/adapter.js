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
  parseCreditsHtml,
  parseCoursesHtml,
  parseGpaHtml,
  parseXjHtml,
  parsePlanHtml,
  parsePyfaHtml,
  parseExamsHtml,
  parseProgressPlansHtml,
  parseProgressDetailHtml,
  parseSimpleTable,
  parseJwcNotices,
  parseMakeupsHtml,
} from './parsers.js'

const USER_AGENT = 'Apifox/1.0.0 (https://apifox.com)'
const REQUEST_TIMEOUT_MS = 20000

/** 课程属性中文名 → zzdKcSX 表单码（强智 kbxx_kc_ifr 口径） */
export const COURSE_TYPE_MAP = {
  必修: '1',
  实践选修: '2',
  专选: '3',
  通选: '4',
  实践必修: '5',
  其它: '9',
}

/** 考试类别中文名 → xqlb 码；xqlbmc 须为选中项文本（表单页 JS 口径） */
const EXAM_KIND_MAP = { 期初: '1', 期中: '2', 期末: '3' }

export const sdufeAdapter = {
  id: 'sdufe',
  name: '山东财经大学（强智教务）',
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

  /** 抓学分修读（通选课统计，GET 直出） */
  async fetchCredits(cookie) {
    const res = await this.request(`${this.baseUrl}/jsxsd/xxwcqk/xstxkxdqk.do`, 'GET', { cookie })
    return parseCreditsHtml(res.text || '')
  },

  /**
   * 课程课表查询网格（全校课程维度，POST kbxx_kc_ifr）。
   * @param {object} q { term 学期, type 课程属性(中文名或码), department
   *   开课院系代码, courseName 课程名, teacher 教师 }——空参数不下发
   *   （规格书样例口径：仅带非空字段）
   */
  async fetchCourses(cookie, { term = '', type = '', department = '', courseName = '', teacher = '' } = {}) {
    const typeCode = COURSE_TYPE_MAP[type] || String(type || '')
    const pairs = [
      ['xnxqh', term],
      ['kkyx', department],
      ['zzdKcSX', typeCode],
      ['kc', courseName],
      ['skls', teacher],
    ].filter(([, v]) => v !== '' && v !== undefined && v !== null)
    const form = pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
    const res = await this.request(`${this.baseUrl}/jsxsd/kbcx/kbxx_kc_ifr`, 'POST', {
      body: form,
      cookie,
    })
    return parseCoursesHtml(res.text || '')
  },

  /** 平均学分绩点（含辅修行，GET 直出） */
  async fetchGpa(cookie) {
    const res = await this.request(`${this.baseUrl}/jsxsd/kscj/cjcx_avg`, 'GET', { cookie })
    return parseGpaHtml(res.text || '')
  },

  /** 学籍卡片（默认裁剪敏感字段，full=true 输出白名单内扩展字段） */
  async fetchXj(cookie, { full = false } = {}) {
    const res = await this.request(`${this.baseUrl}/jsxsd/grxx/xsxx`, 'GET', { cookie })
    return parseXjHtml(res.text || '', { full })
  },

  /** 培养执行计划（GET 直出，逐学期课程列表） */
  async fetchPlan(cookie) {
    const res = await this.request(`${this.baseUrl}/jsxsd/pyfa/pyfa_query`, 'GET', { cookie })
    return parsePlanHtml(res.text || '')
  },

  /** 培养方案明细（GET 直出 75KB，畸形标记专用流式解析） */
  async fetchPyfa(cookie) {
    const res = await this.request(`${this.baseUrl}/jsxsd/pyfa/topyfamx`, 'GET', { cookie })
    return parsePyfaHtml(res.text || '')
  },

  /**
   * 考试安排（T11 口径攻坚成果）：真实数据端点是 xsksap_list——
   * 表单页 JS queryKsap() 会把 action 从空改写为此并填 xqlbmc 文本，
   * 直 POST xsksap_query 只回表单页。
   * @param {object} q { term 学期, kind 期初|期中|期末（空=全部） }
   */
  async fetchExams(cookie, { term = '', kind = '' } = {}) {
    const xqlb = EXAM_KIND_MAP[kind] || String(kind || '')
    const body =
      `xnxqid=${encodeURIComponent(term)}&xqlb=${encodeURIComponent(xqlb)}` +
      `&xqlbmc=${encodeURIComponent(kind || '')}`
    const res = await this.request(`${this.baseUrl}/jsxsd/xsks/xsksap_list`, 'POST', { body, cookie })
    return parseExamsHtml(res.text || '')
  },

  /**
   * 学业完成情况（T11 口径攻坚成果）：两步——GET 入口页取修读方案
   * （每方案一个 form，主修带 ndzydm/辅修带 fxzydm 隐藏码），再逐个
   * POST xxwcqkOnkcxz.do 取双表数据。入口真实 URL 带 xxwcqk_ 前缀
   * （全菜单树文档的 xstxkxdqk_ 前缀为误记）。
   */
  async fetchProgress(cookie) {
    const entry = await this.request(`${this.baseUrl}/jsxsd/xxwcqk/xxwcqk_idxOnxz.do`, 'GET', { cookie })
    const { plans } = parseProgressPlansHtml(entry.text || '')
    const results = []
    for (const plan of plans) {
      const body = `${plan.codeField}=${encodeURIComponent(plan.code)}&jx0301zxjhid=`
      const res = await this.request(`${this.baseUrl}/jsxsd/xxwcqk/xxwcqkOnkcxz.do`, 'POST', { body, cookie })
      const detail = parseProgressDetailHtml(res.text || '')
      results.push({ type: plan.type, name: plan.name, ...detail })
    }
    return { plans: results }
  },

  /**
   * T13 通用简表页抓取（GET 直出 + pageIndex 翻页）。
   * @param {string} path 教务路径（如 /jsxsd/xsxj/xsydxx.do）
   * @param {object} options { pageIndex 页码（默认 1），dropFirst
   *   数据行首列丢弃（changes 展开图标列），tableIndex 取第几张含
   *   th 的表（social 第二张为考级成绩） }
   */
  /** T14 学科竞赛（POST xkjsbm_list，jsmc 竞赛名/jsnf 年份，空=全部） */
  async fetchContests(cookie, { name = '', year = '' } = {}) {
    const body = `jsmc=${encodeURIComponent(name)}&jsnf=${encodeURIComponent(year)}`
    const res = await this.request(`${this.baseUrl}/jsxsd/xsxkjs/xkjsbm_list`, 'POST', { body, cookie })
    return parseSimpleTable(res.text || '')
  },

  /** T14 教学进度/授课计划（POST skjhxx，xnxqid 必填——JS 校验同口径） */
  async fetchSyllabusQuery(cookie, { term = '', course = '', teacher = '', department = '' } = {}) {
    const body =
      `kcmc=${encodeURIComponent(course)}&kkyx=${encodeURIComponent(department)}` +
      `&skjs=${encodeURIComponent(teacher)}&xnxqid=${encodeURIComponent(term)}`
    const res = await this.request(`${this.baseUrl}/jsxsd/xkgl/skjhxx`, 'POST', { body, cookie })
    return parseSimpleTable(res.text || '')
  },

  /** T14 教师课表（POST kbxx_teacher_ifr；jsid=教工号，courses 输出的 teacherCode） */
  async fetchTeacherSchedule(cookie, { teacherId, term = '', department = '' } = {}) {
    const body =
      `jsid=${encodeURIComponent(teacherId)}&skyx=${encodeURIComponent(department)}` +
      `&xnxqh=${encodeURIComponent(term)}&xz=`
    const res = await this.request(`${this.baseUrl}/jsxsd/kbcx/kbxx_teacher_ifr`, 'POST', { body, cookie })
    return parseSimpleTable(res.text || '')
  },

  /** T14 教室课表（POST kbxx_classroom_ifr；campus 用中文名映射，week 默认当前周） */
  async fetchRoomSchedule(cookie, { campusCode, week = '1', building = '', fromSec = '', toSec = '', term = '' } = {}) {
    const body =
      `xnxqh=${encodeURIComponent(term)}&xqid=${encodeURIComponent(campusCode)}` +
      `&jzwid=${encodeURIComponent(building)}&zc1=${encodeURIComponent(week)}&zc2=${encodeURIComponent(week)}` +
      `&jc1=${encodeURIComponent(fromSec)}&jc2=${encodeURIComponent(toSec)}`
    const res = await this.request(`${this.baseUrl}/jsxsd/kbcx/kbxx_classroom_ifr`, 'POST', { body, cookie })
    return parseSimpleTable(res.text || '')
  },

  /** T14 选课学分统计（POST xs_xkglxftjlist，xnxq 学期） */
  async fetchXkCredits(cookie, { term = '' } = {}) {
    const body = `xnxq=${encodeURIComponent(term)}`
    const res = await this.request(`${this.baseUrl}/jsxsd/xsxk/xs_xkglxftjlist`, 'POST', { body, cookie })
    return parseSimpleTable(res.text || '')
  },

  /** T14 选退课日志（POST xs_txlist，xnxqh 学期 + xkmc 选课轮次，空=全部） */
  async fetchXkLogs(cookie, { term = '', round = '' } = {}) {
    const body = `xkmc=${encodeURIComponent(round)}&xnxqh=${encodeURIComponent(term)}`
    const res = await this.request(`${this.baseUrl}/jsxsd/xsxk/xs_txlist`, 'POST', { body, cookie })
    return parseSimpleTable(res.text || '')
  },

  /**
   * jwc.sdufe.edu.cn 通知公告（公开源，无需登录；T17 双源之一）。
   * 礼貌纪律：只抓请求的页（分页路径 tzgg/2.htm…），不预取整站。
   */
  async fetchJwcNotices(page = 1) {
    const path = page <= 1 ? '/zxdt/tzgg.htm' : `/zxdt/tzgg/${page - 1}.htm`
    let response
    try {
      response = await fetch('https://jwc.sdufe.edu.cn' + path, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) linke-cli' },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      })
    } catch (err) {
      throw networkError('抓取教务处公告页', err)
    }
    if (!response.ok) {
      throw networkError(`抓取教务处公告页（HTTP ${response.status}）`, null)
    }
    return parseJwcNotices(await response.text())
  },

  /** 教务系统「已收公告」（个人收件，登录态；T17 双源之二） */
  async fetchJwNotices(cookie, { pageIndex = 1 } = {}) {
    return this.fetchSimplePage(cookie, '/jsxsd/ggly/ysgg_query', { pageIndex })
  },

  /** 补考报名（bkbm_query；非报名期返回语义空态） */
  async fetchMakeups(cookie) {
    const res = await this.request(`${this.baseUrl}/jsxsd/kscj/bkbm_query`, 'GET', { cookie })
    return parseMakeupsHtml(res.text || '')
  },

  /** 选课轮次列表（xklc_list 只读：轮次/时间窗口；选课动作是写域不碰） */
  async fetchXklcList(cookie) {
    return this.fetchSimplePage(cookie, '/jsxsd/xsxk/xklc_list')
  },

  /**
   * 班级三级联动目录（T17 破译，T14 终判翻案）：
   * getZyByAjax?skyx=院系码&sknj=年级 → [{dm,dmmc}] 专业
   * getBjByZyAndAjax?skzy=专业dm&sknj=年级 → [{dm,dmmc}] 班级（传 dm 不传名）
   */
  async fetchClasses(cookie, { collegeCode = '', grade = '' } = {}) {
    const results = {}
    const zyRes = await this.request(
      `${this.baseUrl}/jsxsd/kbcx/getZyByAjax?skyx=${encodeURIComponent(collegeCode)}&sknj=${encodeURIComponent(grade)}`,
      'GET',
      { cookie }
    )
    results.majors = safeJson(zyRes.text)
    if (results.majors && results.majors.length > 0) {
      const first = results.majors[0]
      const bjRes = await this.request(
        `${this.baseUrl}/jsxsd/kbcx/getBjByZyAndAjax?skzy=${encodeURIComponent(first.dm)}&sknj=${encodeURIComponent(grade)}`,
        'GET',
        { cookie }
      )
      results.sampleClasses = safeJson(bjRes.text) // 首专业班级样例
    }
    return results
  },

  /** 班级课表（skbj=班级 dm 码；sknj 参数实测无效，班级码才是关键过滤） */
  async fetchClassSchedule(cookie, { classCode, term = '' } = {}) {
    const body = `xnxqh=${encodeURIComponent(term)}&sknj=&skyx=&skzy=&skbj=${encodeURIComponent(classCode)}`
    const res = await this.request(`${this.baseUrl}/jsxsd/kbcx/kbxx_xzb_ifr`, 'POST', { body, cookie })
    return parseSimpleTable(res.text || '')
  },

  /** T14 教学周历（GET jxzl_query，xnxq01id 学期，空=教务默认） */
  async fetchCalendar(cookie, { term = '' } = {}) {
    const q = term ? `?xnxq01id=${encodeURIComponent(term)}` : ''
    const res = await this.request(`${this.baseUrl}/jsxsd/jxzl/jxzl_query${q}`, 'GET', { cookie })
    return parseSimpleTable(res.text || '')
  },

  async fetchSimplePage(cookie, path, { pageIndex = 1, dropFirst = false, tableIndex = 0 } = {}) {
    const sep = path.includes('?') ? '&' : '?'
    const res = await this.request(`${this.baseUrl}${path}${sep}pageIndex=${pageIndex}`, 'GET', { cookie })
    return parseSimpleTable(res.text || '', { dropFirst, tableIndex })
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

function safeJson(text) {
  try {
    const parsed = JSON.parse(String(text || ''))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
