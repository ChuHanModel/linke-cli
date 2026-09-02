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

async function cmdLogin(flags) {
  const qr = flags.qr === true
  let settle
  const submitted = new Promise((resolve) => {
    settle = resolve
  })
  const handle = await startLoginServer({ qr, onSubmit: settle })
  progress('登录页已就绪（5 分钟内有效，成功或超时后自动关闭）')
  progress(`本机访问: ${handle.urls.local}`)
  if (qr && handle.urls.lan.length > 0) {
    progress('局域网访问（含一次性令牌，勿转发他人）:')
    for (const lan of handle.urls.lan) {
      progress(`  ${lan}`)
      const { modules } = buildQr(Buffer.from(lan, 'utf8'))
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

  const result = await submitted
  if (!result.ok) {
    progress('超时未提交，凭据未保存；可重新运行 linke login')
    return 1
  }
  progress(`凭据已保存（学号 ${result.userId}），正在验证教务登录...`)
  // 复用 verify 逻辑：网页配置后立即做一次真实登录验证。
  // 验证失败不影响已保存的凭据（多为验证码偶发），提示后以非零码退出。
  try {
    return await cmdVerify()
  } catch (err) {
    progress(`凭据已保存，但本次自动验证未通过：${err.message || err}`)
    progress('稍后运行任意查询命令（如 linke scores）会自动重试登录')
    return err instanceof LinkeError ? err.exitCode : 1
  }
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
