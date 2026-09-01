/**
 * 本机配置与凭据存储。
 *
 * 安全口径（T3 验收 1）：
 * - 凭据只存 ~/.linke-cli/config.json，文件权限 0600、目录 0700；
 * - 凭据只经 `linke config` 交互式录入，不提供命令行参数传入，
 *   因此不会出现在 shell 历史与进程列表；
 * - 任何日志/错误输出不包含 password 字段。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_SCHOOL = 'sdufe'
export const DEFAULT_API_BASE = 'https://api.linketeam.com/Api/public/index.php'

export function configDir() {
  return path.join(os.homedir(), '.linke-cli')
}

export function configPath() {
  return path.join(configDir(), 'config.json')
}

export function sessionPath() {
  return path.join(configDir(), 'session.json')
}

function ensureDirPrivate(dir) {
  fs.mkdirSync(dir, { recursive: true })
  // 目录收紧为 0700（仅当权限过宽时）
  try {
    const mode = fs.statSync(dir).mode & 0o777
    if (mode !== 0o700) fs.chmodSync(dir, 0o700)
  } catch {
    /* 非 POSIX 文件系统时忽略 */
  }
}

/** 读取配置；不存在返回 null */
export function loadConfig() {
  const file = configPath()
  if (!fs.existsSync(file)) return null
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

/**
 * 写入配置。凭据字段落盘后立即收紧为 0600。
 * 返回写好的配置（不含明文密码的日志版本由 redactConfig 生成）。
 */
export function saveConfig(config) {
  ensureDirPrivate(configDir())
  const file = configPath()
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  fs.chmodSync(file, 0o600)
  return config
}

/** 用于展示/日志的脱敏配置（密码只留长度） */
export function redactConfig(config) {
  if (!config) return null
  return {
    school: config.school,
    userId: config.userId,
    passwordLength: config.password ? String(config.password).length : 0,
    apiBase: config.apiBase || DEFAULT_API_BASE,
  }
}

/** 解析生效配置：合并默认值；未配置返回 null */
export function resolveConfig() {
  const config = loadConfig()
  if (!config || !config.userId || !config.password) return null
  return {
    school: config.school || DEFAULT_SCHOOL,
    userId: config.userId,
    password: config.password,
    apiBase: config.apiBase || DEFAULT_API_BASE,
  }
}

/** 清除凭据配置文件 */
export function clearConfig() {
  const file = configPath()
  if (fs.existsSync(file)) fs.rmSync(file)
}
