/**
 * 鉴权状态机测试：注入 fake 适配器，验证
 * 「session 有效直接用 / 过期自动重登 / 业务中途失效重登重试一次 /
 * 凭据失效报错不吞」。HOME 隔离同 config 测试。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const realHome = process.env.HOME

function withTempHome(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linke-cli-session-'))
  process.env.HOME = tmp
  return Promise.resolve()
    .then(() => fn(tmp))
    .finally(() => {
      process.env.HOME = realHome
      fs.rmSync(tmp, { recursive: true, force: true })
    })
}

async function setup() {
  const { registerAdapter } = await import('linke-sdufe')
  const { saveConfig } = await import('../src/config.js')
  const session = await import('../src/session.js')
  saveConfig({ school: 'fake', userId: 'u1', password: 'p1', apiBase: 'https://fake' })

  const state = { log: [] }
  const fakeAdapter = {
    id: 'fake',
    name: 'fake',
    baseUrl: 'http://fake',
    async login() {
      state.log.push('login')
      return { cookie: 'JSESSIONID=fresh', userInfo: { name: 'fake-user' } }
    },
    async probeSession(cookie) {
      state.log.push(`probe:${cookie}`)
      return { name: 'fake-user' }
    },
    async fetchScores(cookie, { term }) {
      state.log.push(`scores:${cookie}:${term}`)
      return [{ term: term || 'all', courseCode: 'X', scoreText: '90', score: 90, credit: '', nature: '', courseName: '' }]
    },
  }
  registerAdapter(fakeAdapter)
  return { session, state, fakeAdapter }
}

test('无 session 时自动登录后执行业务', async () => {
  await withTempHome(async () => {
    const { session, state } = await setup()
    const rows = await session.withSession({ school: 'fake', userId: 'u1', password: 'p1', apiBase: 'https://fake' }, (adapter, s) =>
      adapter.fetchScores(s.cookie, { term: '' })
    )
    assert.equal(rows.length, 1)
    assert.deepEqual(state.log, ['login', 'scores:JSESSIONID=fresh:'])
  })
})

test('session 中途失效：自动重登一次并重试业务', async () => {
  await withTempHome(async () => {
    const { session, state } = await setup()
    let first = true
    const rows = await session.withSession({ school: 'fake', userId: 'u1', password: 'p1', apiBase: 'https://fake' }, (adapter, s) => {
      if (first) {
        first = false
        const err = new Error('jw login expired')
        err.isJwLoginExpired = true
        throw err
      }
      return adapter.fetchScores(s.cookie, { term: 'T' })
    })
    assert.equal(rows.length, 1)
    assert.deepEqual(state.log, ['login', 'login', 'scores:JSESSIONID=fresh:T'])
  })
})

test('登录抛凭据失效错误时冒泡（ LinkeError exit 2）', async () => {
  await withTempHome(async () => {
    const { registerAdapter } = await import('linke-sdufe')
    const { saveConfig } = await import('../src/config.js')
    const session = await import('../src/session.js')
    saveConfig({ school: 'bad', userId: 'u1', password: 'wrong', apiBase: 'https://fake' })
    registerAdapter({
      id: 'bad',
      name: 'bad',
      baseUrl: 'http://fake',
      async login() {
        const { credentialInvalid } = await import('../src/errors.js')
        throw credentialInvalid()
      },
    })
    await assert.rejects(
      session.withSession({ school: 'bad', userId: 'u1', password: 'wrong', apiBase: 'https://fake' }, () => {}),
      (err) => err.code === 'CREDENTIAL_INVALID' && err.exitCode === 2
    )
  })
})

test('session 文件过期判定与 touch 续期', async () => {
  await withTempHome(async () => {
    const { session } = await setup()
    const { loadSession, isSessionUsable, saveSession, touchSession } = session
    const fakeAdapter = { id: 'fake' }
    const saved = saveSession(fakeAdapter, 'JSESSIONID=abc', { name: 'n' })
    assert.equal(isSessionUsable(loadSession()), true)
    saved.expiresAt = Date.now() - 1000
    const loaded = loadSession()
    // loadSession 读盘，改动 saved 不影响盘上内容；用过期 payload 验证判定
    assert.equal(isSessionUsable({ ...loaded, expiresAt: Date.now() - 1000 }), false)
    touchSession({ ...loaded, expiresAt: Date.now() - 1000 })
    assert.equal(isSessionUsable(loadSession()), true)
  })
})
