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
import fsSync from 'node:fs'
import pathSync from 'node:path'
import { fileURLToPath as urlToPath } from 'node:url'

function fsReadPkg() {
  return fsSync.readFileSync(
    pathSync.join(pathSync.dirname(urlToPath(import.meta.url)), '..', 'package.json'),
    'utf8'
  )
}
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
  linke notices [--source jwc|jw|all] [--keyword]    教务公告双源现场获取（jwc=教务处网站公开页，
    [--page N]                                          jw=教务系统已收公告；缺省 all；数据面零后端依赖）
  linke makeups                                        补考报名查询（非报名期返回空态注记）
  linke rounds                                         选课轮次列表（只读）
  linke classes [--college 院系码] [--grade 年级]       班级目录（专业→班级联动，T17 破译）
  linke class-schedule --class <班级dm>                班级课表（班级 dm 从 linke classes 获取）
  linke progress [--by plan|nature|attr]               学业完成情况（plan=按修读方案缺省）
  linke me                                             当前登录身份（学号/姓名/院系/班级/教学周）
  linke update                                          手动立即更新（透明链路；开发态跳过）
  linke course-search <关键词>                          林课课程库检索（22k 用户共建数据）
  linke course-stats <课程名或编号>                      课程给分统计（人数/均分/箱线图五数/挂科率）
  linke rankings [--by star|score] [--limit 20]         林课榜单（评分榜/给分榜）
  linke comment-post <课程> --stars 5,4,3 --text ...    发布评课（--stars 依次=内容价值/管理
                                                        轻松度/良师指数，1-5=很差~很好；两段式：先
                                                        预览，--confirm 才发布，全校可见）
  linke comment-update <课程> --stars ... --text ...    修改自己的评课（stars 语义同上；--confirm）
  linke comment-delete <课程>                           删除自己的评课（--confirm）
  linke collect / uncollect <课程>                      收藏 / 取消收藏（--confirm）
  linke like <评论ID>                                   给评论点赞（--confirm）
  linke nickname <新昵称>                               修改林课昵称（--confirm）
  linke my-comments [--course 课程名]                   我发布的评课
  linke pending-reviews [--term]                        待评价课程（已修未评）
  linke collections                                     我的收藏课程
  linke profile                                         我的林课档案
  linke comments <课程名> [--page N]                    课程评论与综合评分（只读）
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
  if (flags['auto-update'] !== undefined || flags.sync !== undefined) {
    const existing = resolveConfig()
    if (!existing) throw configMissing()
    const updates = {}
    if (flags['auto-update'] !== undefined) {
      const v = String(flags['auto-update'])
      if (!['on', 'off'].includes(v)) {
        progress('--auto-update 只支持 on|off')
        return 1
      }
      updates.autoUpdate = v === 'on'
    }
    if (flags.sync !== undefined) {
      const v = String(flags.sync)
      if (!['on', 'off'].includes(v)) {
        progress('--sync 只支持 on|off')
        return 1
      }
      if (v === 'on' && existing.sync !== true) {
        // 首次开启：三要素同意流程（T18 五红线之一）
        progress('开启成绩回流前请确认以下三要素：')
        progress('  · 上传什么：你的课程成绩与学号标识（userKey 匿名摘要）')
        progress('  · 去哪里：林课服务器（api.linketeam.com）')
        progress('  · 用来干嘛：汇入课程给分统计与排行榜，帮助其他同学选课')
        const { ask } = await import('./prompt.js')
        const answer = await ask('同意并开启？（输入 y 确认）: ')
        if (answer.toLowerCase() !== 'y') {
          progress('已取消，保持关闭')
          return 0
        }
      }
      updates.sync = v === 'on'
    }
    saveConfig({ ...loadConfigRaw(), ...updates })
    progress('配置已更新: ' + JSON.stringify(updates))
    return 0
  }
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
  let linkeAccount = null
  try {
    const { callAppApi } = await import('./appapi.js')
    linkeAccount = await callAppApi('App.User.CheckUserExists', { userId: config.userId }, config.apiBase)
  } catch {
    linkeAccount = { error: '探测失败（网络）' }
  }
  emitJson({
    configured: true,
    config: redactConfig(config),
    linkeAccount,
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
  await maybeSyncScores(config, credits) // T18 opt-in 回流（JSON 已输出后进行）
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

async function cmdProgress(flags) {
  const config = requireConfig()
  const by = str(flags.by) || 'plan'
  if (by === 'plan') {
    const progressResult = await withSession(config, (adapter, session) =>
      adapter.fetchProgress(session.cookie)
    )
    emitJson(progressResult)
    return 0
  }
  if (by === 'nature' || by === 'attr') {
    // 性质视图数据已含于 plan 输出（summary 即课程性质维度）；
    // 属性/体系视图（idxOnlb/idxOntx）服务端校验拦截（正确菜单 URL
    // + GET/空 POST 双拒，证据 T11/T17 devlog 在案）——空态+注记
    const progressResult = await withSession(config, (adapter, session) =>
      adapter.fetchProgress(session.cookie)
    )
    emitJson({
      by,
      note:
        by === 'nature'
          ? '性质维度已并入 plan 输出（各方案 summary 的 nature 字段即课程性质汇总）'
          : '属性视图（idxOnlb）服务端校验拦截不可达，返回 plan 数据供参考（证据见 devlog）',
      ...progressResult,
    })
    return 0
  }
  progress(`未知 --by: ${by}（支持 plan|nature|attr）`)
  return 1
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

function loadConfigRaw() {
  return resolveConfig() || {}
}

/** 二期：课程库检索（App.Course.GetCourseByNameLike） */
async function cmdCourseSearch(query) {
  const config = requireConfig()
  const { callLinkeApi } = await import('./linkeapi.js')
  const data = await callLinkeApi(config, 'App.Course.GetCourseByNameLike', {
    nameLike: query,
  })
  emitJson(data)
  return 0
}

/** 二期：课程给分统计（先检索解析 courseId，再 GetCourseScoreStats） */
async function cmdCourseStats(query) {
  const config = requireConfig()
  const { callLinkeApi } = await import('./linkeapi.js')
  const searched = await callLinkeApi(config, 'App.Course.GetCourseByNameLike', {
    nameLike: query,
  })
  const list = Array.isArray(searched) ? searched : searched.list || []
  if (!list.length) {
    emitJson({ query, matches: [], note: '课程库未命中该关键词' })
    return 0
  }
  const first = list[0]
  const stats = await callLinkeApi(config, 'App.UserScore.GetCourseScoreStats', {
    courseId: first.courseId,
  })
  emitJson({ query, matched: { courseId: first.courseId, lessonName: first.lessonName || first.courseName || '' }, otherMatches: list.length - 1, stats })
  return 0
}

/** 二期B：榜单（评分榜 star / 给分榜 score） */
async function cmdRankings(flags) {
  const config = requireConfig()
  const { callLinkeApi } = await import('./linkeapi.js')
  const by = str(flags.by) || 'star'
  const limit = str(flags.limit) || '20'
  if (!['star', 'score'].includes(by)) {
    progress('--by 只支持 star|score')
    return 1
  }
  const service = by === 'star' ? 'App.CourseRanking.GetRankingStarAVG' : 'App.CourseRanking.GetRankingScoreAVG'
  const data = await callLinkeApi(config, service, { numberLimit: limit })
  emitJson({ by, limit: Number(limit), ...(Array.isArray(data) ? { rankings: data } : data) })
  return 0
}

/** 二期B：课程评论（只读；发评/点赞等写域红线不接） */
async function cmdComments(query, flags) {
  const config = requireConfig()
  const { callLinkeApi } = await import('./linkeapi.js')
  const searched = await callLinkeApi(config, 'App.Course.GetCourseByNameLike', { nameLike: query })
  const list = Array.isArray(searched) ? searched : searched.list || []
  if (!list.length) {
    emitJson({ query, matches: [], note: '课程库未命中该关键词' })
    return 0
  }
  const first = list[0]
  const courseId = first.courseId
  const page = str(flags.page) || '1'
  const [count, rating, comments] = await Promise.all([
    callLinkeApi(config, 'App.CourseComment.GetCommentCount', { courseId }),
    callAppApiSafe('App.CourseComment.GetCourseRating', { courseId }, config),
    callLinkeApi(config, 'App.CourseComment.GetComment', { courseId, page, pageSize: '20' }),
  ])
  // 评课三星维度标注（T22：commentStar1/2/3 = 内容价值/管理轻松度/良师指数，1-5=很差~很好）
  const starDimensions = STAR_DIMENSIONS.map(([field, name]) => ({ field, name }))
  emitJson({
    query,
    course: { courseId, lessonName: first.lessonName || first.courseName || '' },
    starDimensions,
    commentCount: count,
    rating,
    comments,
  })
  return 0
}

async function callAppApiSafe(service, params, config) {
  try {
    const { callAppApi } = await import('./appapi.js')
    return await callAppApi(service, params, config.apiBase)
  } catch {
    return null
  }
}

/** T18 成绩回流（opt-in；仅 credits 命令触发；hash 无变化不传） */
async function maybeSyncScores(config, creditsResult) {
  const raw = loadConfigRaw()
  if (raw.sync !== true) return // 默认关闭
  try {
    const fs = await import('node:fs')
    const os = await import('node:os')
    const pathMod = await import('node:path')
    const crypto = await import('node:crypto')
    const statePath = pathMod.join(os.homedir(), '.linke-cli', 'sync-state.json')
    const payload = [{ courses: creditsResult.courses || [] }]
    const hash = crypto.createHash('md5').update(JSON.stringify(payload)).digest('hex')
    let state = {}
    try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')) } catch {}
    if (state.hash === hash) return // 无变化不重传
    const { callLinkeApi } = await import('./linkeapi.js')
    const result = await callLinkeApi(config, 'App.UserScore.ImportScoresFromCredit', {
      creditData: payload,
    })
    fs.mkdirSync(pathMod.dirname(statePath), { recursive: true })
    fs.writeFileSync(statePath, JSON.stringify({ hash, syncedAt: new Date().toISOString() }))
    progress(`成绩回流完成（opt-in，可用 linke config --sync off 关闭）: ${JSON.stringify(result).slice(0, 120)}`)
  } catch (err) {
    progress(`成绩回流失败（不影响查询结果）: ${err.message}`)
  }
}

/** 课程名→courseId（复用课程库检索；多命中取第一并提示） */
async function resolveCourseId(config, query) {
  const { callLinkeApi } = await import('./linkeapi.js')
  const searched = await callLinkeApi(config, 'App.Course.GetCourseByNameLike', { nameLike: query })
  const list = Array.isArray(searched) ? searched : searched.list || []
  if (!list.length) throw new Error(`课程库未命中「${query}」`)
  return { courseId: list[0].courseId, name: list[0].lessonName || list[0].courseName || query, others: list.length - 1 }
}

/**
 * T21 写命令统一处理：两段式确认 + 审计。
 * @param {string} op 命令名（入 ops.log）
 * @param {object} build (config) => { service, params, previewText, target, consequence }
 */
async function cmdWriteOp(op, flags, build) {
  const config = requireConfig()
  const { runWriteOp } = await import('./writeops.js')
  const { callLinkeApi } = await import('./linkeapi.js')
  const view = await build(config)
  const outcome = await runWriteOp(
    op,
    view,
    flags.confirm === true,
    (service, params) => callLinkeApi(config, service, params),
    progress
  )
  if (outcome === 1) return 1
  emitJson({ ok: true, op, target: view.target, result: outcome.result })
  return 0
}

/** 评课三星维度（App 端 evaluateGuide.vue 权威定义，T22 显性化） */
const STAR_DIMENSIONS = [
  ['commentStar1', '内容价值'],
  ['commentStar2', '管理轻松度'],
  ['commentStar3', '良师指数'],
]
const STAR_SCALE = { 1: '很差', 2: '较差', 3: '一般', 4: '较好', 5: '很好' }

function starsLabel(stars) {
  return STAR_DIMENSIONS.map(([, name], i) => `${name}：${stars[i]}（${STAR_SCALE[stars[i]]}）`).join(' / ')
}

function parseStars(raw) {
  const parts = String(raw || '').split(/[,,]/).map((x) => Number(x.trim()))
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 1 || n > 5)) {
    throw new Error('--stars 需为三个 1-5 整数，依次对应：内容价值 / 管理轻松度 / 良师指数（1=很差 2=较差 3=一般 4=较好 5=很好；如 5,4,3）')
  }
  return parts
}

async function cmdMyComments(flags) {
  const config = requireConfig()
  const { callLinkeApi } = await import('./linkeapi.js')
  const course = str(flags.course)
  if (course) {
    const target = await resolveCourseId(config, course)
    const data = await callLinkeApi(config, 'App.CourseComment.GetMyComment', { courseId: target.courseId })
    const starDimensions = STAR_DIMENSIONS.map(([field, name]) => ({ field, name }))
    emitJson({ course: target.name, starDimensions, myComment: data })
    return 0
  }
  emitJson({ note: '按课程查询请加 --course <课程名>（「我评过的全部课」后端未提供全量接口，App 端「我的」页同源口径）' })
  return 0
}

async function cmdCollections() {
  const config = requireConfig()
  const { callLinkeApi } = await import('./linkeapi.js')
  const data = await callLinkeApi(config, 'App.UserCollection.GetCollection', {})
  emitJson(data)
  return 0
}

async function cmdProfile() {
  const config = requireConfig()
  const { callLinkeApi } = await import('./linkeapi.js')
  const data = await callLinkeApi(config, 'App.User.GetUserInfo', { userId: config.userId })
  emitJson(data)
  return 0
}

async function cmdPendingReviews(flags) {
  const config = requireConfig()
  const { callLinkeApi } = await import('./linkeapi.js')
  const data = await callLinkeApi(config, 'App.UserCourse.GetCourseByUserId', {
    courseTerm: str(flags.term),
  })
  emitJson({ note: '已修读课程列表（待评价口径与 App 端评价页同源；按 courseTerm 过滤）', courses: data })
  return 0
}

async function cmdNotices(flags) {
  // T17 双源现场获取（用户拍板：数据面零后端依赖——不经林课后端，
  // jwc=公开网站现场抓取，jw=教务已收公告直连）
  const source = str(flags.source) || 'all'
  if (!['jwc', 'jw', 'all'].includes(source)) {
    progress(`未知 --source: ${source}（支持 jwc|jw|all），按 all 查询`)
  }
  const effectiveSource = ['jwc', 'jw', 'all'].includes(source) ? source : 'all'
  const keyword = str(flags.keyword)
  const page = Math.max(1, Number(str(flags.page)) || 1)
  const MAX_SCAN_PAGES = 5 // 礼貌纪律：本地过滤扫描上限

  const config = resolveConfig()
  const results = []
  const errors = []

  if (effectiveSource !== 'jw') {
    try {
      const { sdufeAdapter } = await import('./schools/sdufe/adapter.js')
      const scanPages = keyword ? Math.min(MAX_SCAN_PAGES, 5) : page
      let items = []
      const startPage = keyword ? 1 : page
      for (let p = startPage; p < startPage + (keyword ? scanPages : 1); p++) {
        const list = await sdufeAdapter.fetchJwcNotices(p)
        items = items.concat(list.map((x) => ({ ...x, source: 'jwc' })))
        if (!keyword && p === page) break
        if (list.length === 0) break
      }
      results.push(...items)
    } catch (err) {
      errors.push(`jwc: ${err.message}`)
    }
  }

  if (effectiveSource !== 'jwc') {
    if (!config) {
      errors.push('jw: 未配置教务凭据（已收公告需登录态），运行 linke login 后可查')
    } else {
      try {
        const table = await withSession(config, (adapter, session) =>
          adapter.fetchJwNotices(session.cookie, { pageIndex: page })
        )
        const headers = table.headers || []
        const titleIdx = headers.findIndex((h) => h.includes('标题'))
        const dateIdx = headers.findIndex((h) => h.includes('时间'))
        results.push(
          ...(table.rows || []).map((r) => ({
            title: titleIdx >= 0 ? r[titleIdx] : r[1] || '',
            url: '',
            date: dateIdx >= 0 ? r[dateIdx] : '',
            source: 'jw',
          }))
        )
      } catch (err) {
        errors.push(`jw: ${err.message}`)
      }
    }
  }

  let list = results
  if (keyword) list = list.filter((x) => (x.title || '').includes(keyword))

  emitJson({
    source: effectiveSource,
    page,
    total: list.length,
    list: list.slice(0, 50),
    ...(errors.length ? { errors } : {}),
  })
  return 0
}

async function cmdMakeups() {
  const config = requireConfig()
  const result = await withSession(config, (adapter, session) =>
    adapter.fetchMakeups(session.cookie)
  )
  emitJson(result)
  return 0
}

async function cmdRounds() {
  const config = requireConfig()
  const result = await withSession(config, (adapter, session) =>
    adapter.fetchXklcList(session.cookie)
  )
  emitJson({ label: '选课轮次（只读；选课操作是写域不提供）', ...result })
  return 0
}

async function cmdClasses(flags) {
  const config = requireConfig()
  const college = str(flags.college)
  const grade = str(flags.grade)
  const result = await withSession(config, (adapter, session) =>
    adapter.fetchClasses(session.cookie, { collegeCode: college, grade })
  )
  emitJson({
    label: '班级目录（专业→班级联动；班级 dm 用于 class-schedule --class）',
    college: college || null,
    grade: grade || null,
    ...result,
  })
  return 0
}

async function cmdClassSchedule(flags) {
  const config = requireConfig()
  const classCode = str(flags.class)
  if (!classCode) {
    progress('需要 --class <班级dm码>（用 linke classes 查目录；如 --class 3124A255C2…）')
    return 1
  }
  const result = await withSession(config, async (adapter, session) => {
    let term = str(flags.term)
    if (!term) {
      term = (await adapter.fetchCurrentTerm(session.cookie)) || ''
      if (term) progress(`当前学期: ${term}`)
    }
    const table = await adapter.fetchClassSchedule(session.cookie, { classCode, term })
    return { label: '班级课表', term: term || null, classCode, ...table }
  })
  emitJson(result)
  return 0
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
    // T16 透明更新钩子（update/help 自身与 JSON 输出无碍：一切走 stderr）
    const first = String(argv.find((a) => !a.startsWith('--')) || '')
    if (!['update', 'help', 'skill', 'config'].includes(first)) {
      const { maybeAutoUpdate } = await import('./updater.js')
      const { version } = JSON.parse(
        (await import('node:fs')).readFileSync(
          (await import('node:path')).join(
            (await import('node:path')).dirname((await import('node:url')).fileURLToPath(import.meta.url)),
            '..',
            'package.json'
          ),
          'utf8'
        )
      )
      const cfg = resolveConfig()
      await maybeAutoUpdate(version, { autoUpdate: cfg ? cfg.autoUpdate !== false : true })
    }
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
      return cmdProgress(flags)
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
    case 'notices':
      return cmdNotices(flags)
    case 'makeups':
      return cmdMakeups()
    case 'rounds':
      return cmdRounds()
    case 'classes':
      return cmdClasses(flags)
    case 'class-schedule':
      return cmdClassSchedule(flags)
    case 'me':
      return cmdMe()
    case 'update': {
      const { runManualUpdate } = await import('./updater.js')
      const { version } = JSON.parse(fsReadPkg())
      return runManualUpdate(version)
    }
    case 'course-search':
      if (!positional[1]) { progress('用法: linke course-search <关键词>'); return 1 }
      return cmdCourseSearch(positional.slice(1).join(' '))
    case 'course-stats':
      if (!positional[1]) { progress('用法: linke course-stats <课程名或编号>'); return 1 }
      return cmdCourseStats(positional.slice(1).join(' '))
    case 'rankings':
      return cmdRankings(flags)
    case 'comments':
      if (!positional[1]) { progress('用法: linke comments <课程名>'); return 1 }
      return cmdComments(positional.slice(1).join(' '), flags)
    case 'comment-post': {
      if (positional.length < 2) { progress('用法: linke comment-post <课程名> --stars 5,4,3 --text "评语"'); return 1 }
      const q = positional[1]
      return cmdWriteOp('comment-post', flags, async (config) => {
        const stars = parseStars(flags.stars)
        const text = str(flags.text)
        if (!text) throw new Error('缺少 --text "评语内容"')
        const target = await resolveCourseId(config, q)
        return {
          service: 'App.CourseComment.PostComment',
          params: { courseId: target.courseId, commentStar1: stars[0], commentStar2: stars[1], commentStar3: stars[2], commentMessage: text },
          previewText: [
            `课程：${target.name}${target.others ? `（另有 ${target.others} 个同名候选，按第一个执行）` : ''}`,
            `星级：${starsLabel(stars)}`,
            `评语：${text}`,
          ],
          consequence: '评课将公开发布，全校可见，并计入课程评分统计',
          target: `course=${target.courseId} stars=${stars.join(',')} text=${text}`,
        }
      })
    }
    case 'comment-update': {
      if (positional.length < 2) { progress('用法: linke comment-update <课程名> --stars 5,4,3 --text "新评语"'); return 1 }
      const q = positional[1]
      return cmdWriteOp('comment-update', flags, async (config) => {
        const stars = parseStars(flags.stars)
        const text = str(flags.text)
        if (!text) throw new Error('缺少 --text "新评语"')
        const target = await resolveCourseId(config, q)
        return {
          service: 'App.CourseComment.UpdateComment',
          params: { courseId: target.courseId, commentStar1: stars[0], commentStar2: stars[1], commentStar3: stars[2], commentMessage: text },
          previewText: [`课程：${target.name}`, `新星级：${starsLabel(stars)}`, `新评语：${text}`],
          consequence: '将覆盖你在该课程的既有评课（公开发布，全校可见）',
          target: `course=${target.courseId} stars=${stars.join(',')} text=${text}`,
        }
      })
    }
    case 'comment-delete': {
      if (positional.length < 2) { progress('用法: linke comment-delete <课程名>'); return 1 }
      const q = positional[1]
      return cmdWriteOp('comment-delete', flags, async (config) => {
        const target = await resolveCourseId(config, q)
        return {
          service: 'App.CourseComment.DeleteComment',
          params: { courseId: target.courseId },
          previewText: [`课程：${target.name}`, '操作：删除你在这门课的评课内容'],
          consequence: '删除后不可恢复（课程评分统计将随之更新）',
          target: `course=${target.courseId}`,
        }
      })
    }
    case 'collect':
    case 'uncollect': {
      if (positional.length < 2) { progress(`用法: linke ${command} <课程名>`); return 1 }
      const q = positional[1]
      const isCollect = command === 'collect'
      return cmdWriteOp(command, flags, async (config) => {
        const target = await resolveCourseId(config, q)
        return {
          service: isCollect ? 'App.UserCollection.PostCollection' : 'App.UserCollection.DeleteCollection',
          params: { courseId: target.courseId },
          previewText: [`课程：${target.name}`, `操作：${isCollect ? '加入收藏' : '取消收藏'}`],
          consequence: isCollect ? '该课程将出现在你的收藏列表' : '将从你的收藏列表移除',
          target: `course=${target.courseId}`,
        }
      })
    }
    case 'like': {
      const id = positional[1]
      if (!id) { progress('用法: linke like <评论ID>'); return 1 }
      return cmdWriteOp('like', flags, async () => ({
        service: 'App.CourseComment.LikeComment',
        params: { commentId: id },
        previewText: [`评论 ID：${id}`, '操作：点赞'],
        consequence: '该评论点赞数 +1',
        target: `comment=${id}`,
      }))
    }
    case 'nickname': {
      const name = positional.slice(1).join(' ')
      if (!name) { progress('用法: linke nickname <新昵称>'); return 1 }
      return cmdWriteOp('nickname', flags, async () => ({
        service: 'App.User.PostUserInfoNickname',
        params: { userNickname: name },
        previewText: [`新昵称：${name}`],
        consequence: '将更新你在林课的公开昵称（评论列表展示）',
        target: `nickname=${name}`,
      }))
    }
    case 'my-comments':
      return cmdMyComments(flags)
    case 'collections':
      return cmdCollections()
    case 'profile':
      return cmdProfile()
    case 'pending-reviews':
      return cmdPendingReviews(flags)
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
