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

const USAGE = `linke —— 林课教务 CLI（只读查询，供 agent / 人类使用）

用法:
  linke config [--school sdufe] [--api-base URL]   交互式录入学号/密码（存 ~/.linke-cli/，权限 600）
  linke config --clear                             清除本机凭据
  linke status                                     配置与教务会话状态（JSON）
  linke login                                      强制重新登录（状态机平时自动做）
  linke scores [--term 2025-2026-1]                成绩查询（缺省=全部学期）
  linke schedule [--term 2025-2026-1] [--week 3]   课表查询（缺省=当前学期全部周）
  linke schools                                    列出可用学校适配器
  linke skill install [--path ~/.agents/skills]    安装 agent skill 说明书
  linke logout                                     清除本机教务 session（保留凭据）
  linke help                                       本帮助

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
  progress(`已保存到 ~/.linke-cli/config.json（权限 600）。运行 linke login 验证，或直接运行任意查询命令。`)
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

async function cmdLogin() {
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
      return cmdLogin()
    case 'scores':
      return cmdScores(flags)
    case 'schedule':
      return cmdSchedule(flags)
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
