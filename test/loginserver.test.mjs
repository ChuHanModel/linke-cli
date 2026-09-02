/**
 * 本地登录服务测试（T7：网页内验证闭环）：
 * - 凭据仅验证通过后落盘（0600 不变式），失败/重试不留半成品
 * - 令牌会话化：会话内多次提交有效；成功/超时/达上限即失效
 * - 尝试上限 3 次（提交即计数，保守口径防教务锁号）
 * - 失败分类：credential（页内重试）与 service（稍后再试）分开
 * - Host/Origin 防护与绑定模式不回归（T6 安全语义）
 * HOME 隔离避免污染真实环境。
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

/** 原生 http GET（可控制 Host 头——fetch/undici 忽略 forbidden header） */
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

/** 提交凭据并轮询结果直到终结（或超时兜底） */
async function submitAndAwait(handle, userId, password, { timeoutMs = 5000 } = {}) {
  const base = `http://127.0.0.1:${handle.port}`
  const res = await fetch(`${base}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: handle.token, userId, password }),
  })
  const submitted = await res.json()
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const r = await fetch(`${base}/result?t=${handle.token}`)
    if (r.status === 403) return { submitted, result: { status: 'forbidden' } }
    const data = await r.json()
    if (data.status === 'done') return { submitted, result: data }
    await delay(50)
  }
  throw new Error('轮询结果超时')
}

test('提交不落盘：验证未完成前 config.json 不存在', async () => {
  await withTempHome(async () => {
    let releaseVerify
    const gate = new Promise((r) => (releaseVerify = r))
    await withServer(
      { verify: () => gate.then(() => ({ ok: true, summary: {} })) },
      async (handle) => {
        const base = `http://127.0.0.1:${handle.port}`
        const res = await fetch(`${base}/submit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: handle.token, userId: 'u1', password: 'p1' }),
        })
        const submitted = await res.json()
        assert.equal(submitted.ok, true)
        assert.equal(submitted.attempts, 1)
        assert.equal(submitted.remaining, 2)
        const { configPath } = await import('../src/config.js')
        assert.equal(fs.existsSync(configPath()), false, '验证未完成不应有凭据文件')
        const mid = await (await fetch(`${base}/result?t=${handle.token}`)).json()
        assert.equal(mid.status, 'verifying')
        releaseVerify()
        // 排空验证结果，避免句柄滞留
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    )
  })
})

test('验证成功才落盘（0600）且结果可在网页轮询取得', async () => {
  await withTempHome(async () => {
    const events = []
    const { saveConfig, configPath } = await import('../src/config.js')
    await withServer(
      {
        // 与生产 bin.js 的 verifyCredentials 同构：成功路径内完成落盘
        verify: async (userId, password) => {
          saveConfig({ school: 'sdufe', userId, password, apiBase: 'https://x' })
          return { ok: true, summary: { name: '张三', weekNow: '2' } }
        },
        onEvent: (e) => events.push(e.type),
      },
      async (handle) => {
        const { submitted, result } = await submitAndAwait(handle, '202401140207', 'right-pw')
        assert.equal(submitted.ok, true)
        assert.equal(result.type, 'success')
        assert.equal(result.summary.name, '张三')
        const { loadConfig } = await import('../src/config.js')
        assert.equal(loadConfig().password, 'right-pw')
        assert.equal(fs.statSync(configPath()).mode & 0o777, 0o600)
        assert.ok(events.includes('submitted') && events.includes('success'))
      }
    )
  })
})

test('凭据错误：页内可重试（同令牌会话内有效），重试成功后落盘', async () => {
  await withTempHome(async () => {
    let calls = 0
    await withServer(
      {
        verify: async (userId, password) => {
          calls += 1
          if (calls === 1) return { ok: false, kind: 'credential', message: '账号或密码错误' }
          const { saveConfig } = await import('../src/config.js')
          saveConfig({ school: 'sdufe', userId, password, apiBase: 'https://x' })
          return { ok: true, summary: { name: '李四' } }
        },
      },
      async (handle) => {
        const first = await submitAndAwait(handle, 'u1', 'wrong')
        assert.equal(first.result.type, 'credential')
        assert.equal(first.result.remaining, 2)
        assert.equal(first.result.final, false)
        const { loadConfig } = await import('../src/config.js')
        assert.equal(loadConfig(), null, '凭据错误不得落盘')
        // 同令牌重试（令牌会话化：非一次性）
        const page = await fetch(handle.urls.local)
        assert.equal(page.status, 200)
        const second = await submitAndAwait(handle, 'u1', 'right')
        assert.equal(second.result.type, 'success')
        assert.equal(loadConfig().password, 'right')
      }
    )
  })
})

test('尝试上限 3 次：第三次仍错则终结、令牌失效、服务关闭', async () => {
  await withTempHome(async () => {
    const events = []
    const handle = await (await import('../src/loginserver.js')).startLoginServer({
      verify: async () => ({ ok: false, kind: 'credential', message: '账号或密码错误' }),
      onEvent: (e) => events.push(e.type),
    })
    try {
      for (let i = 1; i <= 3; i++) {
        const { submitted, result } = await submitAndAwait(handle, 'u', 'wrong')
        assert.equal(submitted.attempts, i)
        assert.equal(result.type, 'credential')
        assert.equal(result.remaining, 3 - i)
        assert.equal(result.final, i === 3)
      }
      assert.ok(events.includes('attempts-exhausted'))
      // 第四次提交：令牌已失效或达上限，拒绝
      const fourth = await fetch(`http://127.0.0.1:${handle.port}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: handle.token, userId: 'u', password: 'p' }),
      })
      assert.ok(fourth.status === 403 || fourth.status === 429)
      const body = await fourth.json()
      assert.equal(body.ok, false)
      // 登录页随会话结束失效
      assert.equal((await fetch(handle.urls.local)).status, 403)
      // 终结性结果被取走后服务自动收摊
      await delay(1500)
      await assert.rejects(() =>
        fetch(handle.urls.local, { signal: AbortSignal.timeout(1000) })
      )
    } finally {
      handle.close()
    }
  })
})

test('失败分类：service 类错误（网络/识别）与 credential 分开呈现', async () => {
  await withTempHome(async () => {
    await withServer(
      {
        verify: async () => ({ ok: false, kind: 'service', message: '云端识别返回错误' }),
      },
      async (handle) => {
        const { result } = await submitAndAwait(handle, 'u', 'whatever')
        assert.equal(result.type, 'service')
        assert.equal(result.message, '云端识别返回错误')
        assert.equal(result.final, false) // 非第 3 次，可再试
        const { loadConfig } = await import('../src/config.js')
        assert.equal(loadConfig(), null)
      }
    )
  })
})

test('验证中并发提交被拒（409）', async () => {
  await withTempHome(async () => {
    let releaseVerify
    const gate = new Promise((r) => (releaseVerify = r))
    await withServer(
      { verify: () => gate.then(() => ({ ok: false, kind: 'service', message: 'x' })) },
      async (handle) => {
        const base = `http://127.0.0.1:${handle.port}`
        const first = await fetch(`${base}/submit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: handle.token, userId: 'u', password: 'p' }),
        })
        assert.equal((await first.json()).ok, true)
        const second = await fetch(`${base}/submit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: handle.token, userId: 'u', password: 'p' }),
        })
        assert.equal(second.status, 409)
        releaseVerify()
        await submitAndAwait(handle, 'u2', 'p2') // 排空验证结果
      }
    )
  })
})

test('GET / 无令牌或错令牌 403；带令牌返回登录页（会话内）', async () => {
  await withTempHome(async () => {
    await withServer({ verify: async () => ({ ok: false, kind: 'service', message: 'x' }) }, async (handle) => {
      const base = `http://127.0.0.1:${handle.port}`
      assert.equal((await fetch(`${base}/`)).status, 403)
      assert.equal((await fetch(`${base}/?t=deadbeef`)).status, 403)
      const ok = await fetch(handle.urls.local)
      assert.equal(ok.status, 200)
      assert.ok((await ok.text()).includes('linke CLI'))
    })
  })
})

test('防 DNS rebinding：域名 Host 被拒（原生 http 控制 Host 头）', async () => {
  await withTempHome(async () => {
    await withServer({ verify: async () => ({ ok: false, kind: 'service', message: 'x' }) }, async (handle) => {
      const status = await rawGet(handle.urls.local, { Host: 'evil.example.com' })
      assert.equal(status, 403)
    })
  })
})

test('防跨站提交：异源 Origin 被拒', async () => {
  await withTempHome(async () => {
    await withServer({ verify: async () => ({ ok: false, kind: 'service', message: 'x' }) }, async (handle) => {
      const base = `http://127.0.0.1:${handle.port}`
      const evil = await fetch(`${base}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
        body: JSON.stringify({ token: handle.token, userId: 'u', password: 'p' }),
      })
      assert.equal(evil.status, 403)
    })
  })
})

test('超时自动关闭并回调 timeout', async () => {
  await withTempHome(async () => {
    let submitted = null
    const handle = await (await import('../src/loginserver.js')).startLoginServer({
      timeoutMs: 300,
      verify: async () => ({ ok: false, kind: 'service', message: 'x' }),
      onEvent: (e) => {
        if (e.type === 'timeout') submitted = e.type
      },
    })
    await delay(450)
    assert.equal(submitted, 'timeout')
    await assert.rejects(() =>
      fetch(handle.urls.local, { signal: AbortSignal.timeout(1000) })
    )
  })
})

test('默认模式仅绑 127.0.0.1；二维码模式绑 0.0.0.0', async () => {
  await withTempHome(async () => {
    await withServer({ verify: async () => ({ ok: false, kind: 'service', message: 'x' }) }, async (handle) => {
      assert.equal(handle.urls.lan.length, 0)
      assert.equal((await fetch(handle.urls.local)).status, 200)
    })
    await withServer({ qr: true, verify: async () => ({ ok: false, kind: 'service', message: 'x' }) }, async (handle) => {
      assert.ok(handle.urls.local.includes('127.0.0.1'))
      assert.equal((await fetch(handle.urls.local)).status, 200)
    })
  })
})
