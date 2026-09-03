/**
 * T32 CLI 全行为遥测（用户拍板 2026-09-03 二次确认：默认上报、
 * 不可关闭；凭据仍不出本机——仅上传 userKey 摘要与命令元数据）。
 *
 * 事件字段：命令名 / CLI 版本 / exit code / 耗时 / 身份摘要
 * （md5(学号+密码)，未配置标 configured:false——这本身是需求信号）/
 * 随机设备标识（首次运行生成的随机 UUID，存 ~/.linke-cli/device-id
 * 0600，与学号无任何关联——免登录命令的设备归因用，T33）。
 * 参数与关键词不入遥测。异步 best-effort：≤2 秒超时静默失败，
 * 不打断输出、不改退出码、离线跳过不排队。README/SKILL 如实披露。
 */
import fsSync from 'node:fs'
import pathSync from 'node:path'
import { fileURLToPath as urlToPath } from 'node:url'
import { computeUserKey } from './linkeapi.js'

const REGISTRY_OFFICIAL = 'https://registry.npmjs.org'

function cliVersion() {
  try {
    return JSON.parse(
      fsSync.readFileSync(
        pathSync.join(pathSync.dirname(urlToPath(import.meta.url)), '..', 'package.json'),
        'utf8'
      )
    ).version
  } catch {
    return '0'
  }
}

/** 设备标识：首次运行生成随机 UUID 落 device-id（0600），此后复用（T33） */
let __deviceIdCache = ''
export async function getDeviceId() {
  if (__deviceIdCache) return __deviceIdCache
  try {
    const fs = await import('node:fs/promises')
    const { configDir } = await import('./config.js')
    const file = pathSync.join(configDir(), 'device-id')
    try {
      const existing = (await fs.readFile(file, 'utf8')).trim()
      if (/^[0-9a-f-]{36}$/i.test(existing)) {
        __deviceIdCache = existing
        return __deviceIdCache
      }
    } catch {}
    const crypto = await import('node:crypto')
    __deviceIdCache = crypto.randomUUID()
    await fs.mkdir(pathSync.dirname(file), { recursive: true })
    await fs.writeFile(file, __deviceIdCache + '\n', { mode: 0o600 })
  } catch {
    /* 设备标识失败不阻塞遥测本身——该条按旧版匿名口径上报 */
    __deviceIdCache = ''
  }
  return __deviceIdCache
}

/**
 * 上报一次命令事件（await 使用；内部 2s 超时静默）。
 * @param {object} event { command, exitCode, durationMs, configured, userId, password }
 * @param {string} apiBase 后端入口
 */
export async function reportCommandEvent(event, apiBase) {
  try {
    const crypto = await import('node:crypto')
    const t = Math.floor(Date.now() / 1000)
    const signMain = crypto
      .createHash('md5')
      .update('Linke' + 'App.CliTelemetry.Report' + String(t))
      .digest('hex')
    const query = new URLSearchParams({ signMain, signTime: String(t) })
    const deviceId = (await getDeviceId()).slice(0, 64)
    const body = new URLSearchParams({
      deviceId,
      command: String(event.command || '').slice(0, 40),
      version: cliVersion().slice(0, 16),
      exitCode: String(Number.isInteger(event.exitCode) ? event.exitCode : 1),
      durationMs: String(Math.max(0, Math.min(600000, Number(event.durationMs) || 0))),
      configured: event.configured ? '1' : '0',
      userKey: event.configured ? computeUserKey(event.userId, event.password) : '',
    })
    await fetch(`${apiBase.replace(/\?.*$/, '')}?service=App.CliTelemetry.Report&${query}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': `linke-cli/${cliVersion()}`,
      },
      body: body.toString(),
      signal: AbortSignal.timeout(2000),
    })
  } catch {
    /* 静默：不打断命令、不改退出码、离线跳过不排队 */
  }
}
