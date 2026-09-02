/**
 * 本地登录服务（T6）：`linke login` 在用户本机起内置登录页。
 *
 * 安全口径（T6 验收 1-4）：
 * - 本地模式仅绑 127.0.0.1 随机端口；二维码模式（--qr）绑 0.0.0.0
 *   供局域网手机访问，URL 强制携带一次性令牌；
 * - 令牌一次性：提交成功（无论凭据是否有效）立即失效；
 * - 凭据只经 POST /submit 进入本进程 → saveConfig 落盘（0600），
 *   不写任何日志、不打印；
 * - Host 头必须是 IP 字面量（防 DNS rebinding）；Origin 头存在时
 *   必须同源（防跨站提交）；页面为随包分发的静态文件（可审计），
 *   不从云端拉取任何内容；
 * - 服务在提交成功或超时（默认 5 分钟）后自动关闭。
 */
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { saveConfig, DEFAULT_SCHOOL, DEFAULT_API_BASE } from './config.js'
import { clearSession } from './session.js'

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const MAX_BODY_BYTES = 64 * 1024

function loginPageHtml() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return fs.readFileSync(path.join(here, 'web', 'login.html'), 'utf8')
}

/** 枚举本机局域网 IPv4（排除回环/内网虚拟网段由调用方展示时全列） */
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
 * @param {(result: {ok: boolean, userId?: string, error?: string}) => void} options.onSubmit 凭据落盘回调
 * @param {number} options.timeoutMs 超时自动关闭
 * @returns {Promise<{server, port, token, urls: {local: string, lan: string[]}, close: () => void}>}
 */
export function startLoginServer({ qr = false, timeoutMs = DEFAULT_TIMEOUT_MS, onSubmit } = {}) {
  return new Promise((resolve, reject) => {
    const token = crypto.randomBytes(16).toString('hex')
    const pageHtml = loginPageHtml()
    let tokenUsed = false
    let closed = false

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://placeholder')
      const sendJson = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json;charset=utf-8' })
        res.end(JSON.stringify(payload))
      }

      // 防 DNS rebinding：Host 必须是 IP 字面量
      if (!isIpLiteralHost(req.headers.host)) {
        sendJson(403, { ok: false, error: '非法 Host' })
        return
      }

      if (req.method === 'GET' && url.pathname === '/') {
        if (tokenUsed || url.searchParams.get('t') !== token) {
          res.writeHead(403, { 'Content-Type': 'text/html;charset=utf-8' })
          res.end('<meta charset="utf-8"><p>链接无效或已使用：请回到终端重新运行 linke login。</p>')
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' })
        res.end(pageHtml)
        return
      }

      if (req.method === 'POST' && url.pathname === '/submit') {
        // 防 CSRF：浏览器提交必带 Origin，存在则必须同源
        const origin = req.headers.origin
        if (origin) {
          const host = req.headers.host
          if (origin !== `http://${host}`) {
            sendJson(403, { ok: false, error: '非法来源' })
            return
          }
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
          if (tokenUsed) {
            sendJson(403, { ok: false, error: '令牌已使用，请重新运行 linke login' })
            return
          }
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
          if (!userId || !password) {
            sendJson(400, { ok: false, error: '学号与密码均不能为空' })
            return
          }
          // 令牌一次性：无论后续结果如何，本令牌立即作废
          tokenUsed = true
          saveConfig({
            school: DEFAULT_SCHOOL,
            userId,
            password,
            apiBase: DEFAULT_API_BASE,
          })
          clearSession() // 凭据变更后旧 session 作废
          // 注意：此处不打印/记录 body 任何内容（凭据红线）
          sendJson(200, { ok: true })
          onSubmit && onSubmit({ ok: true, userId })
          closeServer()
        })
        return
      }

      sendJson(404, { ok: false, error: 'Not Found' })
    })

    const closeServer = () => {
      if (closed) return
      closed = true
      clearTimeout(timeoutHandle)
      // keep-alive 空闲连接会阻止 close 生效，强制断开
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
      server.close()
    }

    const timeoutHandle = setTimeout(() => {
      closeServer()
      onSubmit && onSubmit({ ok: false, error: 'timeout' })
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
      })
    })
  })
}
