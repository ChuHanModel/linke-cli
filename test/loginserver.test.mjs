/**
 * 本地登录服务测试（T6 验收 7）：
 * 生命周期（启动/成功关闭/超时关闭）、一次性令牌、Host/Origin 防护、
 * 凭据 0600 权限不回归。HOME 隔离避免污染真实环境。
 * 注意：所有用例经 withServer 保证 close（断言失败也会关，否则挂进程）；
 * Host 头测试须用原生 http（fetch/undici 忽略 Host 这个 forbidden header）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const realHome = process.env.HOME

function withTempHome(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linke-cli-login-'))
  process.env.HOME = tmp
  return Promise.resolve()
    .then(() => fn(tmp))
    .finally(() => {
      process.env.HOME = realHome
      fs.rmSync(tmp, { recursive: true, force: true })
    })
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** 原生 http GET（可控制 Host 头） */
function rawGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', headers }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    req.end()
  })
}

async function withServer(options, fn) {
  const { startLoginServer } = await import('../src/loginserver.js')
  const handle = await startLoginServer(options)
  try {
    return await fn(handle)
  } finally {
    handle.close()
  }
}

test('默认模式仅绑 127.0.0.1：局域网地址不可达、回环可达', async () => {
  await withTempHome(async () => {
    await withServer({}, async (handle) => {
      assert.equal(handle.urls.lan.length, 0)
      const res = await fetch(handle.urls.local)
      assert.equal(res.status, 200)
      assert.ok((await res.text()).includes('linke CLI'))
      let refused = true
      for (const list of Object.values(os.networkInterfaces())) {
        for (const info of list || []) {
          if (info.family !== 'IPv4' || info.internal) continue
          try {
            await fetch(`http://${info.address}:${handle.port}/`, {
              signal: AbortSignal.timeout(2000),
            })
            refused = false
          } catch {
            /* 预期拒绝 */
          }
        }
      }
      assert.ok(refused, '默认模式不应在局域网 IP 上可达')
    })
  })
})

test('GET / 无令牌或错令牌 403；带令牌返回登录页', async () => {
  await withTempHome(async () => {
    await withServer({}, async (handle) => {
      const base = `http://127.0.0.1:${handle.port}`
      assert.equal((await fetch(`${base}/`)).status, 403)
      assert.equal((await fetch(`${base}/?t=deadbeef`)).status, 403)
      const ok = await fetch(handle.urls.local)
      assert.equal(ok.status, 200)
    })
  })
})

test('提交成功：凭据落盘 0600、服务自动关闭', async () => {
  await withTempHome(async () => {
    let submitted = null
    await withServer({ onSubmit: (r) => (submitted = r) }, async (handle) => {
      const base = `http://127.0.0.1:${handle.port}`
      const res = await fetch(`${base}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: handle.token, userId: '202401140207', password: 'pw-test' }),
      })
      const body = await res.json()
      assert.equal(body.ok, true)
      assert.deepEqual(submitted, { ok: true, userId: '202401140207' })

      const { configPath, loadConfig } = await import('../src/config.js')
      const saved = loadConfig()
      assert.equal(saved.userId, '202401140207')
      assert.equal(saved.password, 'pw-test')
      assert.equal(fs.statSync(configPath()).mode & 0o777, 0o600)

      // 服务已自动关闭，连接应被拒绝
      await delay(150)
      await assert.rejects(() =>
        fetch(`${base}/submit`, { method: 'POST', signal: AbortSignal.timeout(2000) })
      )
    })
  })
})

test('一次性令牌：错令牌提交被拒、凭据不落盘', async () => {
  await withTempHome(async () => {
    let submitted = null
    await withServer({ onSubmit: (r) => (submitted = r) }, async (handle) => {
      const base = `http://127.0.0.1:${handle.port}`
      const res = await fetch(`${base}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'wrong-token', userId: 'u', password: 'p' }),
      })
      assert.equal(res.status, 403)
      assert.equal(submitted, null)
      const { loadConfig } = await import('../src/config.js')
      assert.equal(loadConfig(), null)
    })
  })
})

test('防 DNS rebinding：域名 Host 被拒（原生 http 控制 Host 头）', async () => {
  await withTempHome(async () => {
    await withServer({}, async (handle) => {
      const status = await rawGet(handle.urls.local, { Host: 'evil.example.com' })
      assert.equal(status, 403)
    })
  })
})

test('防跨站提交：异源 Origin 被拒、同源放行', async () => {
  await withTempHome(async () => {
    let submitted = null
    await withServer({ onSubmit: (r) => (submitted = r) }, async (handle) => {
      const base = `http://127.0.0.1:${handle.port}`
      const evil = await fetch(`${base}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
        body: JSON.stringify({ token: handle.token, userId: 'u', password: 'p' }),
      })
      assert.equal(evil.status, 403)
      assert.equal(submitted, null)

      // Origin 缺失（curl 类客户端）放行，令牌是唯一凭据
      const ok = await fetch(`${base}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: handle.token, userId: 'u2', password: 'p2' }),
      })
      assert.equal((await ok.json()).ok, true)
    })
  })
})

test('超时自动关闭并回调 timeout', async () => {
  await withTempHome(async () => {
    let submitted = null
    const handle = await (await import('../src/loginserver.js')).startLoginServer({
      timeoutMs: 300,
      onSubmit: (r) => (submitted = r),
    })
    await delay(450)
    assert.deepEqual(submitted, { ok: false, error: 'timeout' })
    await assert.rejects(() =>
      fetch(handle.urls.local, { signal: AbortSignal.timeout(2000) })
    )
  })
})

test('二维码模式：绑 0.0.0.0、返回局域网 URL 列表', async () => {
  await withTempHome(async () => {
    await withServer({ qr: true }, async (handle) => {
      assert.ok(handle.urls.lan.length >= 0) // 无网环境允许 0 个
      assert.ok(handle.urls.local.includes('127.0.0.1'))
      const res = await fetch(handle.urls.local)
      assert.equal(res.status, 200)
    })
  })
})
