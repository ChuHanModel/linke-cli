/**
 * verifyCredentials 真实接线测试（T7 验收 4/5/8）：
 * 通过 registry 注入 fake 适配器，验证「复用 session.login、成功才
 * 落盘、credential/service 分类」。HOME 隔离。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const realHome = process.env.HOME

function withTempHome(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linke-cli-verify-'))
  process.env.HOME = tmp
  return Promise.resolve()
    .then(() => fn(tmp))
    .finally(() => {
      process.env.HOME = realHome
      fs.rmSync(tmp, { recursive: true, force: true })
    })
}

async function setup(loginBehavior) {
  const { registerAdapter } = await import('../src/schools/registry.js')
  registerAdapter({
    id: 'fakev',
    name: 'fakev',
    baseUrl: 'http://fake',
    login: loginBehavior,
  })
  const { createVerifyCredentials } = await import('../src/bin.js')
  return { verify: createVerifyCredentials({ school: 'fakev' }) }
}

test('验证成功：复用 session.login 落 session，凭据落盘 0600，summary 含周次', async () => {
  await withTempHome(async () => {
    const { verify } = await setup(async () => ({
      cookie: 'JSESSIONID=ok',
      userInfo: { name: '王五', unit: '某学院', week: { now: '4', all: '20' } },
    }))
    const result = await verify('202401140207', 'right')
    assert.equal(result.ok, true)
    assert.equal(result.summary.name, '王五')
    assert.equal(result.summary.weekNow, '4')
    const { loadConfig, configPath, sessionPath } = await import('../src/config.js')
    assert.equal(loadConfig().password, 'right')
    assert.equal(fs.statSync(configPath()).mode & 0o777, 0o600)
    const session = JSON.parse(fs.readFileSync(sessionPath(), 'utf8'))
    assert.equal(session.cookie, 'JSESSIONID=ok')
  })
})

test('凭据错误：分类 credential，不落任何凭据文件', async () => {
  await withTempHome(async () => {
    const { verify } = await setup(async () => {
      const { credentialInvalid } = await import('../src/errors.js')
      throw credentialInvalid('教务返回密码错误')
    })
    const result = await verify('u', 'wrong')
    assert.equal(result.ok, false)
    assert.equal(result.kind, 'credential')
    assert.ok(result.message.includes('密码'))
    const { loadConfig } = await import('../src/config.js')
    assert.equal(loadConfig(), null)
  })
})

test('网络/识别类失败：分类 service，不落凭据', async () => {
  await withTempHome(async () => {
    const { verify } = await setup(async () => {
      const { networkError } = await import('../src/errors.js')
      throw networkError('请求教务系统', new Error('ECONNREFUSED'))
    })
    const result = await verify('u', 'p')
    assert.equal(result.ok, false)
    assert.equal(result.kind, 'service')
    const { loadConfig } = await import('../src/config.js')
    assert.equal(loadConfig(), null)
  })
})
