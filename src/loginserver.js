/**
 * 本地登录服务（T7：网页内验证闭环）：
 *
 * 流程：页面提交凭据 → 服务立即应答并进入「验证中」→ CLI 侧执行
 * 完整教务登录验证（由 verify 回调注入，复用 session 状态机的登录
 * 实现）→ 页面轮询 GET /result 获取结果 → 成功才由 verify 回调落盘。
 *
 * 令牌语义（T7 验收 3，会话化折中）：URL 令牌在会话内有效——
 * 成功 / 超时 / 达尝试上限即失效。尝试上限默认 3 次（保守值：
 * 教务锁定阈值无档案记录，按卡文口径取 3），既防本机令牌爆破，
 * 更防教务系统因连续错密码锁定账号。
 *
 * 安全口径（T6 不回归）：Host 必须 IP 字面量（防 DNS rebinding）、
 * Origin 存在须同源（防跨站）、POST/结果内容零日志；页面随包分发。
 */
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const MAX_BODY_BYTES = 64 * 1024
const DEFAULT_MAX_ATTEMPTS = 3
// 终结性结果（成功/上限耗尽）发出后留给页面的收尾窗口
const RESULT_LINGER_MS = 10 * 1000

function loginPageHtml() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return fs.readFileSync(path.join(here, 'web', 'login.html'), 'utf8')
}

/** 枚举本机局域网 IPv4（虚拟网段在内，展示侧由调用方取舍） */
export function lanAddresses() {
  const result = []
  const interfaces = os.networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    for (const info of interfaces[name] || []) {
      if (info.family !== 'IPv4' || info.internal) continue
      result.push({ name, address: info.address })
    }
  }
  return result
}

function isIpLiteralHost(host) {
  const hostname = String(host || '').split(':')[0]
  if (!hostname) return false
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname) || hostname === '[::1]' || hostname === '::1'
}

/**
 * 起本地登录服务。
 * @param {object} options
 * @param {boolean} options.qr 二维码模式：绑 0.0.0.0（含 127.0.0.1）；默认仅 127.0.0.1
 * @param {number} options.timeoutMs 超时自动关闭（会话最长时长）
 * @param {number} options.maxAttempts 提交尝试上限（默认 3）
 * @param {(userId: string, password: string) => Promise<{ok: true, summary: object} | {ok: false, kind: 'credential'|'service', message: string}>} options.verify
 *   验证回调：执行完整教务登录验证；成功路径内完成凭据落盘（0600），
 *   失败路径不得写任何凭据文件。kind 区分「凭据错误」（页内重试）
 *   与「网络/识别服务失败」（稍后再试）。
 * @param {(event: {type: string, [k: string]: any}) => void} options.onEvent
 *   终端汇报事件：submitted / success / credential-error / service-error /
 *   attempts-exhausted / timeout
 * @returns {Promise<{server, port, token, urls, close: () => void, done: Promise<{type: string}>, attempts: () => number}>}
 */
export function startLoginServer({
  qr = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  verify,
  onEvent = () => {},
} = {}) {
  return new Promise((resolve, reject) => {
    const token = crypto.randomBytes(16).toString('hex')
    const pageHtml = loginPageHtml()
    let sessionOpen = true // 令牌会话有效性：成功/超时/上限耗尽即 false
    let attempts = 0
    let verifying = false
    let lastResult = null // {type:'success'|'credential'|'service', ...}
    let resultAcked = false
    let closed = false
    let doneResolve
    const done = new Promise((r) => {
      doneResolve = r
    })

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://placeholder')
      const sendJson = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json;charset=utf-8' })
        res.end(JSON.stringify(payload))
      }

      if (!isIpLiteralHost(req.headers.host)) {
        sendJson(403, { ok: false, error: '非法 Host' })
        return
      }

      const tokenOk = () => sessionOpen && url.searchParams.get('t') === token

      if (req.method === 'GET' && url.pathname === '/') {
        if (!tokenOk()) {
          res.writeHead(403, { 'Content-Type': 'text/html;charset=utf-8' })
          res.end('<meta charset="utf-8"><p>链接无效或已失效：请回到终端重新运行 linke login。</p>')
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' })
        res.end(pageHtml)
        return
      }

      if (req.method === 'GET' && url.pathname === '/result') {
        // 结果轮询只校验令牌匹配：成功/上限后令牌会话已结束，但结果
        // 仍须让页面取走（提交路径此时已被 sessionOpen 拒绝，无重放面）
        if (url.searchParams.get('t') !== token) {
          sendJson(403, { ok: false, error: '令牌错误' })
          return
        }
        if (lastResult) {
          const terminal =
            lastResult.type === 'success' ||
            (lastResult.type !== 'success' && lastResult.final)
          const payload = { status: 'done', ...lastResult }
          if (terminal && !resultAcked) {
            resultAcked = true
            // 页面已收到终结性结果：短暂延迟后收摊
            setTimeout(closeServer, 1000)
          }
          sendJson(200, payload)
          return
        }
        sendJson(200, { status: verifying ? 'verifying' : 'idle' })
        return
      }

      if (req.method === 'GET' && url.pathname === '/state') {
        // 页面刷新后恢复上下文用（T7 打回验收 11/12）：报告已提交次数
        // 与剩余额度，让用户在重复提交前看到教务锁号警示。
        // 与 /result 同口径：终结性结果未被取走前仍可查询。
        if (url.searchParams.get('t') !== token) {
          sendJson(403, { ok: false, error: '令牌错误' })
          return
        }
        sendJson(200, {
          status: lastResult ? 'done' : verifying ? 'verifying' : 'idle',
          attempts,
          remaining: Math.max(0, maxAttempts - attempts),
          maxAttempts,
          result: lastResult,
        })
        return
      }

      if (req.method === 'POST' && url.pathname === '/submit') {
        const origin = req.headers.origin
        if (origin && origin !== `http://${req.headers.host}`) {
          sendJson(403, { ok: false, error: '非法来源' })
          return
        }
        // 令牌经请求体传递（页面为相对路径提交，URL 无 query），
        // 此处只先校验会话有效性，令牌匹配在解析 body 后校验
        if (!sessionOpen) {
          sendJson(403, { ok: false, error: '会话已结束，请重新运行 linke login' })
          return
        }
        if (verifying) {
          sendJson(409, { ok: false, error: '正在验证上一次提交，请稍候' })
          return
        }
        if (attempts >= maxAttempts) {
          sendJson(429, { ok: false, error: `已达尝试上限（${maxAttempts} 次）` })
          return
        }
        const chunks = []
        let size = 0
        req.on('data', (chunk) => {
          size += chunk.length
          if (size > MAX_BODY_BYTES) {
            req.destroy()
            return
          }
          chunks.push(chunk)
        })
        req.on('end', () => {
          let body
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {
            sendJson(400, { ok: false, error: '请求体不是合法 JSON' })
            return
          }
          if (body.token !== token) {
            sendJson(403, { ok: false, error: '令牌错误' })
            return
          }
          const userId = String(body.userId || '').trim()
          const password = String(body.password || '')
          const syncChoice = body.syncChoice === 'off' ? 'off' : 'on' // T23 首启必答
          if (!userId || !password) {
            sendJson(400, { ok: false, error: '学号与密码均不能为空' })
            return
          }
          // 计数在任何验证发生前完成：提交即视为一次教务尝试（保守口径）
          attempts += 1
          const remaining = maxAttempts - attempts
          verifying = true
          lastResult = null
          resultAcked = false
          sendJson(200, { ok: true, attempts, remaining })
          onEvent({ type: 'submitted', attempts, remaining, userId })
          // 注意：此处不打印/记录凭据（红线）
          Promise.resolve()
            .then(() => verify(userId, password, syncChoice))
            .then((outcome) => {
              verifying = false
              if (outcome && outcome.ok) {
                sessionOpen = false // 令牌会话结束（验收 3）
                lastResult = {
                  type: 'success',
                  summary: outcome.summary || {},
                  maxAttempts,
                }
                onEvent({ type: 'success', summary: outcome.summary, userId })
              } else {
                const kind = outcome && outcome.kind === 'credential' ? 'credential' : 'service'
                const final = remaining <= 0
                lastResult = {
                  type: kind,
                  message: (outcome && outcome.message) || '验证失败',
                  remaining,
                  final,
                  maxAttempts,
                }
                onEvent({ type: kind === 'credential' ? 'credential-error' : 'service-error', message: lastResult.message, remaining, final, userId })
                if (final) {
                  sessionOpen = false
                  scheduleForceClose()
                  onEvent({ type: 'attempts-exhausted', attempts })
                }
              }
            })
            .catch((err) => {
              verifying = false
              const final = remaining <= 0
              lastResult = {
                type: 'service',
                message: (err && err.message) || '验证过程异常',
                remaining,
                final,
                maxAttempts,
              }
              onEvent({ type: 'service-error', message: lastResult.message, remaining, final, userId })
              if (final) {
                sessionOpen = false
                scheduleForceClose()
                onEvent({ type: 'attempts-exhausted', attempts })
              }
            })
        })
        return
      }

      sendJson(404, { ok: false, error: 'Not Found' })
    })

    let lingerHandle = null
    let timeoutHandle = null

    const closeServer = () => {
      if (closed) return
      closed = true
      clearTimeout(timeoutHandle)
      clearTimeout(lingerHandle)
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
      server.close()
      sessionOpen = false
      doneResolve({ type: 'closed' })
    }

    // 终结性失败结果若始终无人来取（页面已关等），超窗强制收摊
    const scheduleForceClose = () => {
      clearTimeout(lingerHandle)
      lingerHandle = setTimeout(closeServer, RESULT_LINGER_MS)
    }

    timeoutHandle = setTimeout(() => {
      onEvent({ type: 'timeout' })
      sessionOpen = false
      closeServer()
    }, timeoutMs)

    server.on('error', reject)
    server.listen(0, qr ? '0.0.0.0' : '127.0.0.1', () => {
      const port = server.address().port
      const urls = {
        local: `http://127.0.0.1:${port}/?t=${token}`,
        lan: qr ? lanAddresses().map((i) => `http://${i.address}:${port}/?t=${token}`) : [],
      }
      resolve({
        server,
        port,
        token,
        urls,
        close: closeServer,
        done,
        attempts: () => attempts,
      })
    })
  })
}
