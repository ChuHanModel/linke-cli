/**
 * 命令分发与参数解析（零依赖手写，不引 commander）。
 * 输出契约：stdout 只有业务 JSON；进度与错误走 stderr；
 * exit code 见 src/errors.js EXIT 表（与 SKILL.md 同步）。
 */
import { resolveConfig, saveConfig, clearConfig, redactConfig, DEFAULT_SCHOOL, DEFAULT_API_BASE } from './config.js'
import { configMissing, LinkeError } from './errors.js'
import { listAdapters, getAdapter } from './schools/registry.js'
import {
  withSession,
  login as forceLogin,
  inspectSession,
  clearSession,
} from './session.js'
import { installSkill, skillSourceDir } from './skill.js'
import { ask, askPassword } from './prompt.js'
import { emitJson, progress } from './util.js'
import { startLoginServer } from './loginserver.js'
import { buildQr, renderTerminal } from './qr.js'
import { exec } from 'node:child_process'

const USAGE = `linke —— 林课教务 CLI（只读查询，供 agent / 人类使用）

用法:
  linke login [--qr]                                   网页配置凭据（首选）：本机起登录页自动开浏览器；
                                                       --qr 额外展示局域网二维码，手机同 Wi-Fi 填写
  linke config [--school sdufe] [--api-base URL]       终端录入凭据（非 TTY / SSH 兜底）
  linke config --clear                                 清除本机凭据
  linke verify                                         验证已存凭据（自动登录教务并显示身份）
  linke status                                         配置与教务会话状态（JSON）
  linke scores [--term 2025-2026-1]                    成绩查询（缺省=全部学期）
  linke schedule [--term 2025-2026-1] [--week 3]       课表查询（缺省=当前学期全部周）
  linke credits                                        学分修读（类别统计 + 通选课明细）
  linke courses [--term 2025-2026-1] [--type 通选]     全校课程查询（可再加 --dept 院系代码
                                                       --name 课程名 --teacher 教师）
  linke gpa                                            平均学分绩点（含辅修行）
  linke xj [--full]                                    学籍卡片（默认核心字段；--full 附
                                                       非敏感扩展字段）
  linke plan                                           培养执行计划（逐学期课程列表）
  linke pyfa                                           培养方案明细（体系/学时/开课学期）
  linke exams [--term 2025-2026-2] [--kind 期末]       考试安排（期初|期中|期末，缺省全部）
  linke progress                                       学业完成情况（各修读方案进度）
  linke levels|innovation|changes|warning|             长尾查询（表头自说明 JSON，空数据=无记录）：
    recognized|mentor|thesis|social|messages|            等级考试/创新学分/学籍异动/学籍预警/
    minor-plan|diversion                                 成绩认定/学业导师/论文成绩/社会考试/
                                                          留言/辅修计划/专业方向分流
  （以上长尾命令通用 --page N 翻页）
  linke contests [--name 竞赛名] [--year 年份]         学科竞赛获奖
  linke syllabus-query [--term] [--course] [--teacher]  教学进度（授课计划，可加 --college）
  linke teacher-schedule --teacher-id 19856550          教师课表（教工号见 courses 的 teacherCode）
  linke room-schedule --campus 舜耕 [--week 3]          教室课表（week 缺省当前周；可加 --building
                                                        --from-sec --to-sec）
  linke xk-credits [--term]                             选课学分统计
  linke xk-logs [--term] [--round 轮次]                 选退课日志
  linke calendar [--term]                               教学周历
  linke textbooks / textbook-orders / thesis-guide      教材账目/选订教材/毕业过程指导（--page 翻页）
  linke me                                             当前登录身份（学号/姓名/院系/班级/教学周）
  linke schools                                        列出可用学校适配器
  linke skill install [--path ~/.agents/skills]        安装 agent skill 说明书
  linke logout                                         清除本机教务 session（保留凭据）
  linke help                                           本帮助

说明:
  登录请求从本机直发教务系统；验证码图片仅用于云端识别（传图返文字）。
  每个数据命令内置鉴权状态机：session 有效直接用，过期自动重登，
  凭据失效才报错（exit 2，重新 linke config）。stdout 仅输出 JSON。`

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const body = token.slice(2)
    const eq = body.indexOf('=')
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1)
      continue
    }
    if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      flags[body] = argv[i + 1]
      i += 1
    } else {
      flags[body] = true
    }
  }
  return { positional, flags }
}

function requireConfig() {
  const config = resolveConfig()
  if (!config) throw configMissing()
  return config
}

async function cmdConfig(flags) {
  if (flags.clear) {
    clearConfig()
    clearSession()
    progress('已清除本机凭据与 session')
    return 0
  }
  const school = String(flags.school || DEFAULT_SCHOOL)
  getAdapter(school) // 校验适配器存在
  const apiBase = String(flags['api-base'] || DEFAULT_API_BASE)

  process.stderr.write(`配置林课教务凭据（学校适配器: ${school}）\n`)
  const userId = await ask('学号: ')
  if (!userId) {
    progress('学号为空，已取消')
    return 1
  }
  const password = await askPassword('教务密码（输入不回显）: ')
  if (!password) {
    progress('密码为空，已取消')
    return 1
  }
  saveConfig({ school, userId, password, apiBase })
  clearSession() // 凭据变更后旧 session 一律作废
  progress(`已保存到 ~/.linke-cli/config.json（权限 600）。建议运行 linke verify 验证凭据，或直接运行任意查询命令。`)
  return 0
}

async function cmdStatus() {
  const config = resolveConfig()
  const adapters = listAdapters()
  if (!config) {
    emitJson({ configured: false, adapters, skill: skillSourceDir() })
    return 0
  }
  const sessionInfo = await inspectSession(config)
  emitJson({
    configured: true,
    config: redactConfig(config),
    adapters,
    session: sessionInfo,
    skill: skillSourceDir(),
  })
  return 0
}

function openBrowser(url) {
  const platform = process.platform
  const cmd =
    platform === 'darwin' ? `open ${JSON.stringify(url)}` :
    platform === 'win32' ? `start "" ${JSON.stringify(url)}` :
    `xdg-open ${JSON.stringify(url)}`
  exec(cmd, () => {}) // 打开失败不致命：终端已打印 URL
}

function pickPrimaryLanUrl(urls) {
  // 主网卡取舍：192.168.x 优先（家用路由常态），其次 10.x / 172.16-31.x
  const score = (url) => {
    if (url.includes('//192.168.')) return 0
    if (url.includes('//10.')) return 1
    if (/\/\/172\.(1[6-9]|2\d|3[01])\./.test(url)) return 2
    return 3
  }
  return [...urls].sort((a, b) => score(a) - score(b))[0] || null
}

/**
 * 验证回调工厂（T7 验收 8：复用 session 状态机的登录实现，不另写
 * 登录路径）。凭据仅在验证通过后才落盘（0600 不变式），失败不留
 * 半成品文件。导出供测试注入 fake 适配器验证分类与落盘纪律。
 */
export function createVerifyCredentials({ school = DEFAULT_SCHOOL, apiBase = DEFAULT_API_BASE } = {}) {
  return async function verifyCredentials(userId, password) {
    const config = { school, userId, password, apiBase }
    const adapter = getAdapter(school)
    try {
      const session = await forceLogin(adapter, config) // 内部含 saveSession
      saveConfig(config) // 验证通过才落盘
      const info = session.userInfo || {}
      return {
        ok: true,
        summary: {
          name: info.name || '',
          unit: info.unit || '',
          weekNow: info.week ? info.week.now : '',
          weekAll: info.week ? info.week.all : '',
        },
      }
    } catch (err) {
      if (err instanceof LinkeError && err.code === 'CREDENTIAL_INVALID') {
        return { ok: false, kind: 'credential', message: err.message }
      }
      return { ok: false, kind: 'service', message: err.message || String(err) }
    }
  }
}

async function cmdLogin(flags) {
  const qr = flags.qr === true
  const verifyCredentials = createVerifyCredentials()

  let terminalOutcome = 'closed'
  const onEvent = (event) => {
    switch (event.type) {
      case 'submitted':
        progress(`收到网页提交（第 ${event.attempts}/3 次尝试），正在验证教务登录...`)
        break
      case 'success': {
        const s = event.summary || {}
        const bits = [s.name, s.weekNow ? `第 ${s.weekNow} 周` : ''].filter(Boolean).join(' · ')
        progress(`验证通过${bits ? `（${bits}）` : ''}`)
        progress(`凭据已保存到 ~/.linke-cli/config.json（权限 600），session 已就绪`)
        break
      }
      case 'credential-error':
        progress(`教务返回密码错误${event.remaining > 0 ? `（剩余 ${event.remaining} 次尝试）` : ''}`)
        break
      case 'service-error':
        progress(`验证服务异常：${event.message}${event.remaining > 0 ? `（剩余 ${event.remaining} 次尝试）` : ''}`)
        break
      case 'attempts-exhausted':
        progress('已达尝试上限（3 次），登录服务关闭；请确认凭据后重新运行 linke login')
        break
      case 'timeout':
        progress('超时未完成验证，凭据未保存；可重新运行 linke login')
        break
      default:
        break
    }
    if (event.type === 'success') terminalOutcome = 'success'
    if (event.type === 'timeout') terminalOutcome = 'timeout'
    if (event.type === 'attempts-exhausted') terminalOutcome = 'exhausted'
  }

  const handle = await startLoginServer({ qr, verify: verifyCredentials, onEvent })
  progress('登录页已就绪（提交后网页内完成验证；5 分钟超时，成功或达尝试上限后自动关闭）')
  progress(`本机访问: ${handle.urls.local}`)
  progress('（该地址仅本机浏览器可用；CLI 运行在远程机器上时，请在那台机器的浏览器中打开）')
  if (qr && handle.urls.lan.length > 0) {
    progress('局域网访问（含会话令牌，勿转发他人）:')
    for (const lan of handle.urls.lan) progress(`  ${lan}`)
    const primary = pickPrimaryLanUrl(handle.urls.lan)
    if (primary) {
      const { modules } = buildQr(Buffer.from(primary, 'utf8'))
      process.stderr.write('\n' + renderTerminal(modules, 2) + '\n\n')
    }
  } else if (qr) {
    progress('未探测到局域网 IPv4 地址，二维码不可用（本机访问不受影响）')
  } else {
    progress('提示：手机填写请改用 linke login --qr（展示局域网二维码）')
  }
  progress('正在打开浏览器...')
  openBrowser(handle.urls.local)
  process.on('SIGINT', () => {
    handle.close()
    progress('已取消，凭据未保存')
    process.exit(130)
  })

  await handle.done
  if (terminalOutcome === 'success') {
    emitJson({ ok: true, outcome: 'success' })
    return 0
  }
  if (terminalOutcome === 'exhausted') return 3 // 对齐 LOGIN_RETRY_EXHAUSTED 契约
  if (terminalOutcome === 'timeout') return 1
  // closed：页面未完成验证即被关闭（如令牌取走失败后的兜底收摊）
  progress('登录服务已结束，凭据未保存；可重新运行 linke login')
  return 1
}

async function cmdVerify() {
  const config = requireConfig()
  const adapter = getAdapter(config.school)
  const session = await forceLogin(adapter, config)
  emitJson({ ok: true, userInfo: session.userInfo })
  return 0
}

async function cmdScores(flags) {
  const config = requireConfig()
  const term = flags.term ? String(flags.term) : ''
  const rows = await withSession(config, (adapter, session) =>
    adapter.fetchScores(session.cookie, { term })
  )
  emitJson(rows)
  return 0
}

async function cmdSchedule(flags) {
  const config = requireConfig()
  let term = flags.term ? String(flags.term) : ''
  const week = flags.week !== undefined ? String(flags.week) : ''
  const result = await withSession(config, async (adapter, session) => {
    if (!term) {
      term = (await adapter.fetchCurrentTerm(session.cookie)) || ''
      if (!term) progress('未能解析当前学期，交给教务默认值')
      else progress(`当前学期: ${term}`)
    }
    const schedule = await adapter.fetchSchedule(session.cookie, { term, week })
    return { term: term || null, week: week || null, ...schedule }
  })
  emitJson(result)
  return 0
}

async function cmdCredits() {
  const config = requireConfig()
  const credits = await withSession(config, (adapter, session) =>
    adapter.fetchCredits(session.cookie)
  )
  emitJson(credits)
  return 0
}

async function cmdCourses(flags) {
  const config = requireConfig()
  const query = {
    term: flags.term ? String(flags.term) : '',
    type: flags.type && flags.type !== true ? String(flags.type) : '',
    department: flags.dept && flags.dept !== true ? String(flags.dept) : '',
    courseName: flags.name && flags.name !== true ? String(flags.name) : '',
    teacher: flags.teacher && flags.teacher !== true ? String(flags.teacher) : '',
  }
  const result = await withSession(config, async (adapter, session) => {
    if (!query.term) {
      query.term = (await adapter.fetchCurrentTerm(session.cookie)) || ''
      if (!query.term) progress('未能解析当前学期，交给教务默认值')
      else progress(`当前学期: ${query.term}`)
    }
    const courses = await adapter.fetchCourses(session.cookie, query)
    return { term: query.term || null, type: query.type || null, ...courses }
  })
  emitJson(result)
  return 0
}

async function cmdMe() {
  const config = requireConfig()
  const me = await withSession(config, async (adapter, session) => {
    const userInfo = await adapter.probeSession(session.cookie) // 实时探活取身份
    return {
      userId: config.userId,
      name: userInfo.name || '',
      unit: userInfo.unit || '',
      discipline: userInfo.discipline || '',
      class: userInfo.class || '',
      week: userInfo.week || null,
    }
  })
  emitJson(me)
  return 0
}

async function cmdGpa() {
  const config = requireConfig()
  const gpa = await withSession(config, (adapter, session) => adapter.fetchGpa(session.cookie))
  emitJson(gpa)
  return 0
}

async function cmdXj(flags) {
  const config = requireConfig()
  const full = flags.full === true
  const xj = await withSession(config, (adapter, session) =>
    adapter.fetchXj(session.cookie, { full })
  )
  emitJson(xj)
  return 0
}

async function cmdPlan() {
  const config = requireConfig()
  const plan = await withSession(config, (adapter, session) => adapter.fetchPlan(session.cookie))
  emitJson(plan)
  return 0
}

async function cmdPyfa() {
  const config = requireConfig()
  const pyfa = await withSession(config, (adapter, session) => adapter.fetchPyfa(session.cookie))
  emitJson(pyfa)
  return 0
}

async function cmdExams(flags) {
  const config = requireConfig()
  let term = flags.term ? String(flags.term) : ''
  const kind = flags.kind && flags.kind !== true ? String(flags.kind) : ''
  if (kind && !['期初', '期中', '期末'].includes(kind)) {
    progress(`未知考试类别: ${kind}（支持 期初|期中|期末），按全部类别查询`)
  }
  const result = await withSession(config, async (adapter, session) => {
    if (!term) {
      term = (await adapter.fetchCurrentTerm(session.cookie)) || ''
      if (term) progress(`当前学期: ${term}`)
    }
    const exams = await adapter.fetchExams(session.cookie, { term, kind })
    return { term: term || null, kind: kind || null, ...exams }
  })
  emitJson(result)
  return 0
}

async function cmdProgress() {
  const config = requireConfig()
  const progressResult = await withSession(config, (adapter, session) =>
    adapter.fetchProgress(session.cookie)
  )
  emitJson(progressResult)
  return 0
}

/**
 * T13 长尾查询页配置（GET 直出 + pageIndex 翻页）。
 * dropFirst：changes 数据行首列是「+」展开图标；social 两张表
 * （报名列表 + 考级成绩）；diversion 合并专业/方向两个分流页。
 */
const SIMPLE_PAGES = {
  levels: { path: '/jsxsd/kscj/djkscj_list', label: '等级考试成绩' },
  innovation: { path: '/jsxsd/pyfa/cxxf_query', label: '创新学分' },
  changes: { path: '/jsxsd/xsxj/xsydxx.do', label: '学籍异动', dropFirst: true },
  warning: { path: '/jsxsd/xsxj/xsyjxx.do', label: '学籍预警' },
  recognized: { path: '/jsxsd/kscj/cjrd_list', label: '成绩认定' },
  mentor: { path: '/jsxsd/kscj/cjcx_xzds', label: '学业导师', note: '导师数据接口（facjdy_list）教务侧拦截，无分配时输出空表' },
  thesis: { path: '/jsxsd/bysj/bydbcj.do', label: '毕业论文成绩', note: '低年级无记录为正常态' },
  social: { path: '/jsxsd/xsdjks/xsdjks_list', label: '社会考试报名' },
  messages: { path: '/jsxsd/ggly/ysly_query', label: '已收留言' },
  'minor-plan': { path: '/jsxsd/fxgl/fxzxjh', label: '辅修执行计划' },
  textbooks: { path: '/jsxsd/xsjc/xsjc', label: '教材账目' },
  'textbook-orders': { path: '/jsxsd/xsjc/xdjcxx', label: '选订教材' },
  'thesis-guide': { path: '/jsxsd/bysj/gcfk.do', label: '毕业过程指导' },
  diversion: {
    label: '专业/方向分流查询',
    combined: [
      { key: 'majorOptions', path: '/jsxsd/xsxj/toQueryZyfl.do', label: '可选专业' },
      { key: 'directionOptions', path: '/jsxsd/xsxj/toQueryfxfl.do', label: '可选专业方向' },
    ],
  },
}

/** T14 校区中文名 → xqid 码（真实页 select 实锤） */
const CAMPUS_MAP = { 舜耕: '1', 燕山: '2', 章丘: '3', 明水: '4', 莱芜: '5' }

/** T14 表单型查询页配置（真实提交端点均经探针验证，见 devlog） */
const FORM_PAGES = {
  contests: {
    label: '学科竞赛',
    run: (adapter, cookie, flags, term) =>
      adapter.fetchContests(cookie, {
        name: str(flags.name),
        year: str(flags.year),
      }),
  },
  'syllabus-query': {
    label: '教学进度（授课计划）',
    requireTerm: true,
    run: (adapter, cookie, flags, term) =>
      adapter.fetchSyllabusQuery(cookie, {
        term,
        course: str(flags.course),
        teacher: str(flags.teacher),
        department: str(flags.college),
      }),
  },
  'teacher-schedule': {
    label: '教师课表',
    requireTerm: true,
    requireFlags: ['teacher-id'],
    run: (adapter, cookie, flags, term) =>
      adapter.fetchTeacherSchedule(cookie, {
        teacherId: str(flags['teacher-id']),
        term,
        department: str(flags.college),
      }),
  },
  'room-schedule': {
    label: '教室课表',
    requireTerm: true,
    requireFlags: ['campus'],
    currentWeek: true,
    run: (adapter, cookie, flags, term, weekNow) =>
      adapter.fetchRoomSchedule(cookie, {
        campusCode: CAMPUS_MAP[str(flags.campus)] || str(flags.campus),
        week: str(flags.week) || weekNow || '1',
        building: str(flags.building),
        fromSec: str(flags['from-sec']),
        toSec: str(flags['to-sec']),
        term,
      }),
  },
  'xk-credits': {
    label: '选课学分统计',
    requireTerm: true,
    run: (adapter, cookie, flags, term) => adapter.fetchXkCredits(cookie, { term }),
  },
  'xk-logs': {
    label: '选退课日志',
    requireTerm: true,
    run: (adapter, cookie, flags, term) =>
      adapter.fetchXkLogs(cookie, { term, round: str(flags.round) }),
  },
  calendar: {
    label: '教学周历',
    run: (adapter, cookie, flags) =>
      adapter.fetchCalendar(cookie, { term: str(flags.term) }),
  },
}

function str(v) {
  return v !== undefined && v !== true && v !== false ? String(v) : ''
}

async function cmdFormPage(name, flags) {
  const config = requireConfig()
  const spec = FORM_PAGES[name]
  const missing = (spec.requireFlags || []).filter((k) => !str(flags[k]))
  if (missing.length) {
    progress(`缺少必填参数: ${missing.map((k) => '--' + k).join(' ')}（见 linke help）`)
    return 1
  }
  const result = await withSession(config, async (adapter, session) => {
    let term = str(flags.term)
    if (!term && (spec.requireTerm || spec.run.length >= 5)) {
      term = (await adapter.fetchCurrentTerm(session.cookie)) || ''
      if (term) progress(`当前学期: ${term}`)
    }
    let weekNow = ''
    if (spec.currentWeek) {
      const info = await adapter.probeSession(session.cookie)
      weekNow = info && info.week ? String(info.week.now) : ''
    }
    const base = await spec.run(adapter, session.cookie, flags, term, weekNow)
    return { label: spec.label, ...base }
  })
  emitJson(result)
  return 0
}

async function cmdSimplePage(name, flags) {
  const config = requireConfig()
  const spec = SIMPLE_PAGES[name]
  const page = flags.page && flags.page !== true ? Number(flags.page) : 1
  if (!Number.isInteger(page) || page < 1) {
    progress('无效页码，按第 1 页查询')
  }
  const pageIndex = Number.isInteger(page) && page >= 1 ? page : 1
  const result = await withSession(config, async (adapter, session) => {
    if (spec.combined) {
      const out = { label: spec.label }
      for (const part of spec.combined) {
        out[part.key] = await adapter.fetchSimplePage(session.cookie, part.path, { pageIndex })
      }
      return out
    }
    const base = await adapter.fetchSimplePage(session.cookie, spec.path, {
      pageIndex,
      dropFirst: spec.dropFirst === true,
    })
    const out = { label: spec.label, page: pageIndex, ...base }
    if (spec.path === '/jsxsd/xsdjks/xsdjks_list') {
      // social 第二张表：考级成绩记录
      out.records = await adapter.fetchSimplePage(session.cookie, spec.path, {
        pageIndex,
        tableIndex: 1,
      })
    }
    if (spec.note) out.note = spec.note
    return out
  })
  emitJson(result)
  return 0
}

async function cmdSchools() {
  emitJson(listAdapters())
  return 0
}

async function cmdSkillInstall(flags) {
  const explicit = flags.path && flags.path !== true ? String(flags.path) : ''
  const installed = installSkill(explicit)
  emitJson({ ok: true, installed })
  return 0
}

async function cmdLogout() {
  clearSession()
  progress('已清除本机教务 session（凭据保留）')
  return 0
}

function printUsage() {
  process.stderr.write(USAGE + '\n')
  return 0
}

export async function runCli(argv) {
  try {
    return await dispatch(argv)
  } catch (err) {
    if (err instanceof LinkeError) {
      process.stderr.write(`[linke] ${err.code}: ${err.message}\n`)
      if (err.hint) process.stderr.write(`提示: ${err.hint}\n`)
      return err.exitCode
    }
    process.stderr.write(`[linke] UNEXPECTED: ${err && err.message ? err.message : err}\n`)
    return 1
  }
}

async function dispatch(argv) {
  const { positional, flags } = parseArgs(argv)
  const command = positional[0] || 'help'

  if (flags.help || flags.h) return printUsage()

  switch (command) {
    case 'help':
      return printUsage()
    case 'config':
      return cmdConfig(flags)
    case 'status':
      return cmdStatus()
    case 'login':
      return cmdLogin(flags)
    case 'verify':
      return cmdVerify()
    case 'scores':
      return cmdScores(flags)
    case 'schedule':
      return cmdSchedule(flags)
    case 'credits':
      return cmdCredits()
    case 'courses':
      return cmdCourses(flags)
    case 'gpa':
      return cmdGpa()
    case 'xj':
      return cmdXj(flags)
    case 'plan':
      return cmdPlan()
    case 'pyfa':
      return cmdPyfa()
    case 'exams':
      return cmdExams(flags)
    case 'progress':
      return cmdProgress()
    case 'levels':
    case 'innovation':
    case 'changes':
    case 'warning':
    case 'recognized':
    case 'mentor':
    case 'thesis':
    case 'social':
    case 'messages':
    case 'minor-plan':
    case 'diversion':
      return cmdSimplePage(command, flags)
    case 'contests':
    case 'syllabus-query':
    case 'teacher-schedule':
    case 'room-schedule':
    case 'xk-credits':
    case 'xk-logs':
    case 'calendar':
      return cmdFormPage(command, flags)
    case 'textbooks':
    case 'textbook-orders':
    case 'thesis-guide':
      return cmdSimplePage(command, flags)
    case 'me':
      return cmdMe()
    case 'schools':
      return cmdSchools()
    case 'skill':
      if (positional[1] !== 'install') return printUsage()
      return cmdSkillInstall(flags)
    case 'logout':
      return cmdLogout()
    default:
      process.stderr.write(`未知命令: ${command}\n\n`)
      return printUsage()
  }
}
