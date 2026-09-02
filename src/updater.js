/**
 * 透明自动更新（T16）。设计边界（用户拍板）：透明+可关+可审计，
 * 静默自更新是红线——所有告知走 stderr，stdout JSON 契约零污染。
 *
 * 机制：每次命令启动①先发上次更新的待告知（update.log 时间戳 >
 * lastNotified）；②缓存过期（24h）才查版本（官方源 3s→npmmirror→
 * 静默）；③发现新版且 autoUpdate 开→后台 detached 自更新脚本
 * （npm i -g + update.log + skill 重装），当前进程继续跑旧版，
 * 下次调用生效并收到告知；off→仅 stderr 通知。npm link 开发态跳过。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DAY_MS = 24 * 60 * 60 * 1000
const OFFICIAL = 'https://registry.npmjs.org'
const MIRROR = 'https://registry.npmmirror.com'

function statePath() {
  return path.join(os.homedir(), '.linke-cli', 'update-check.json')
}
function logPath() {
  return path.join(os.homedir(), '.linke-cli', 'update.log')
}
function selfUpdateScript() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'selfupdate.cjs')
}

export function readCheckState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'))
  } catch {
    return {}
  }
}
function writeCheckState(state) {
  fs.mkdirSync(path.dirname(statePath()), { recursive: true })
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2))
}

/** semver 比较：a > b 严格为真（同段数字比较，长度不同按 0 补） */
export function semverGt(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const x = pa[i] || 0
    const y = pb[i] || 0
    if (x > y) return true
    if (x < y) return false
  }
  return false
}

/** npm link 开发态：全局 node_modules/linke-cli 是软链（指向开发仓库） */
export function isDevInstall() {
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim()
    return fs.lstatSync(path.join(globalRoot, 'linke-cli')).isSymbolicLink()
  } catch {
    return false
  }
}

async function fetchVersion(registry) {
  const res = await fetch(`${registry}/linke-cli/latest`, {
    signal: AbortSignal.timeout(3000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  return data.version
}

/** 查最新版本：官方 3s 超时 → npmmirror → 失败返回 null（离线零感知） */
export async function fetchLatestVersion() {
  for (const registry of [OFFICIAL, MIRROR]) {
    try {
      return await fetchVersion(registry)
    } catch {
      /* 下一源 */
    }
  }
  return null
}

function appendUpdateLog(fromVersion, toVersion) {
  fs.mkdirSync(path.dirname(logPath()), { recursive: true })
  fs.appendFileSync(
    logPath(),
    `${new Date().toISOString()} ${fromVersion} -> ${toVersion}\n`
  )
}

function notify(text) {
  process.stderr.write(`[linke] ${text}\n`)
}

/** skill 三目录随更新重装（复用 installSkill；失败不影响更新） */
function reinstallSkill() {
  try {
    execFileSync(process.execPath, [process.argv[1] || 'linke', 'skill', 'install'], {
      stdio: 'ignore',
    })
  } catch {
    /* 非致命 */
  }
}

/**
 * 命令启动钩子（bin.js 调用；help/update 自身除外）。
 * @param {string} currentVersion
 * @param {{autoUpdate: boolean}} options 配置态
 */
export async function maybeAutoUpdate(currentVersion, { autoUpdate = true } = {}) {
  try {
    const state = readCheckState()
    // ① 待告知（上次后台更新完成，本次调用首次可见）
    if (state.pendingNotify) {
      notify(
        `已自动更新 ${state.pendingNotify.from} → ${state.pendingNotify.to}（本次仍运行旧版，下次调用生效；` +
          `关闭自动更新: linke config --auto-update off）`
      )
      writeCheckState({ ...state, pendingNotify: null })
    }
    // ② 每日至多一次版本检查
    const now = Date.now()
    if (state.lastCheckAt && now - state.lastCheckAt < DAY_MS) return
    writeCheckState({ ...state, lastCheckAt: now })
    if (isDevInstall()) return // 开发态跳过（不查不升级，避免覆盖 link）
    const latest = await fetchLatestVersion()
    if (!latest || !semverGt(latest, currentVersion)) return
    if (!autoUpdate) {
      notify(`发现新版 ${currentVersion} → ${latest}（自动更新已关闭，手动升级: linke update）`)
      return
    }
    // ③ 后台 detached 自更新：当前进程不受影响，下次调用生效
    notify(`发现新版 ${currentVersion} → ${latest}，正在后台更新（下次调用生效）...`)
    const child = spawn(process.execPath, [selfUpdateScript(), currentVersion, latest], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
  } catch {
    /* 更新机制任何异常都不影响当次命令 */
  }
}

/** `linke update` 手动更新（前台，等待完成） */
export async function runManualUpdate(currentVersion) {
  if (isDevInstall()) {
    notify('开发态（npm link），跳过更新——请 git pull 后继续开发')
    return 1
  }
  const latest = await fetchLatestVersion()
  if (!latest) {
    notify('查询最新版本失败（网络不可达），稍后再试')
    return 1
  }
  if (!semverGt(latest, currentVersion)) {
    notify(`已是最新版 ${currentVersion}`)
    return 0
  }
  notify(`更新 ${currentVersion} → ${latest} ...`)
  const code = await new Promise((resolve) => {
    const child = spawn('npm', ['install', '-g', `linke-cli@${latest}`, '--registry', OFFICIAL], {
      stdio: 'inherit',
    })
    child.on('exit', (c) => resolve(c ?? 1))
  })
  if (code === 0) {
    appendUpdateLog(currentVersion, latest)
    reinstallSkill()
    notify(`已更新到 ${latest}（本次仍运行旧版，下次调用生效）`)
    return 0
  }
  notify('更新失败（npm install 退出码 ' + code + '），可稍后重试 linke update')
  return 1
}

export { appendUpdateLog, reinstallSkill, notify as updateNotify }
