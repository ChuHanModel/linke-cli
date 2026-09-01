/**
 * 鉴权状态机（T3 验收 3）：内建于每个数据命令，调用方无需知道「先登录」。
 *
 *   session 有效 → 直接用
 *   session 缺失/过期 → 自动重登（云端验证码识别）
 *   凭据失效（教务报密码错误）→ 报错让人介入（exit 2，提示 linke config）
 *   业务请求中发现 session 失效 → 重登一次后重试
 *
 * session 落 ~/.linke-cli/session.json（0600，同凭据目录 0700）：
 *   { cookie, userInfo, savedAt, expiresAt }
 * 过期口径：教务 JSESSIONID 为不活动过期（实测约 30 分钟量级），
 * 保守取 20 分钟无活动即重登；每次成功请求滑动续期。
 */
import fs from 'node:fs'
import { sessionPath, configDir } from './config.js'
import { recognizeCaptcha } from './cloudOcr.js'
import { getAdapter } from './schools/registry.js'
import { progress } from './util.js'

const SESSION_TTL_MS = 20 * 60 * 1000
const RETRY_ON_EXPIRED_ONCE = 1

export function loadSession() {
  try {
    const raw = fs.readFileSync(sessionPath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || !parsed.cookie) return null
    return parsed
  } catch {
    return null
  }
}

export function saveSession(adapter, cookie, userInfo) {
  fs.mkdirSync(configDir(), { recursive: true })
  const payload = {
    school: adapter.id,
    cookie,
    userInfo: userInfo || {},
    savedAt: new Date().toISOString(),
    expiresAt: Date.now() + SESSION_TTL_MS,
  }
  fs.writeFileSync(sessionPath(), JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 })
  try {
    fs.chmodSync(sessionPath(), 0o600)
  } catch {
    /* 非 POSIX 文件系统时忽略 */
  }
  return payload
}

export function touchSession(session) {
  if (!session) return
  session.expiresAt = Date.now() + SESSION_TTL_MS
  try {
    fs.writeFileSync(sessionPath(), JSON.stringify(session, null, 2) + '\n', { mode: 0o600 })
  } catch {
    /* 续期失败不影响本次请求 */
  }
}

export function clearSession() {
  const file = sessionPath()
  if (fs.existsSync(file)) fs.rmSync(file)
}

export function isSessionUsable(session) {
  return !!(session && session.cookie && Date.now() < session.expiresAt - 60_000)
}

/** 强制登录（忽略现有 session），成功后落盘 */
export async function login(adapter, config) {
  const recognize = (imageBase64) => recognizeCaptcha(config.apiBase, imageBase64)
  const { cookie, userInfo } = await adapter.login(
    { userId: config.userId, password: config.password, recognizeCaptcha: recognize },
    { onProgress: progress }
  )
  return saveSession(adapter, cookie, userInfo)
}

/**
 * 状态机主入口：保证 fn 在有效 session 下执行。
 * @param {object} config resolveConfig() 的结果
 * @param {(adapter, session) => Promise<any>} fn 业务函数
 */
export async function withSession(config, fn) {
  const adapter = getAdapter(config.school)
  let session = loadSession()
  if (!isSessionUsable(session)) {
    progress('教务 session 缺失或已过期，自动登录...')
    session = await login(adapter, config)
  }

  let expiredRetries = RETRY_ON_EXPIRED_ONCE
  while (true) {
    try {
      const result = await fn(adapter, session)
      touchSession(session)
      return result
    } catch (err) {
      if (err && err.isJwLoginExpired && expiredRetries > 0) {
        expiredRetries -= 1
        progress('教务 session 中途失效，自动重登后重试...')
        session = await login(adapter, config)
        continue
      }
      throw err
    }
  }
}

/** status 命令用：带本地判定与远端探活的完整状态 */
export async function inspectSession(config) {
  const adapter = getAdapter(config.school)
  const session = loadSession()
  const local = {
    hasSession: !!session,
    expiresAt: session ? new Date(session.expiresAt).toISOString() : null,
    expired: session ? !isSessionUsable(session) : null,
    userInfo: session?.userInfo || null,
  }
  let remote = null
  if (session && isSessionUsable(session)) {
    try {
      const userInfo = await adapter.probeSession(session.cookie)
      remote = { alive: true, userInfo }
      touchSession(session)
    } catch (err) {
      if (err && err.isJwLoginExpired) {
        remote = { alive: false }
      } else {
        remote = { alive: null, error: err.message }
      }
    }
  }
  return { local, remote }
}

export { SESSION_TTL_MS }
