/**
 * linke-sdufe 包级测试：env 契约 + 注入式适配器行为（mock env，零网络）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { nodeEnv, validateEnv } from '../src/env.js'
import { createSdufeAdapter } from '../src/adapter.js'
import { initSdufe, getAdapter, registerAdapter, listAdapters } from '../src/registry.js'
import { computeEncoded } from '../src/encoding.js'
import { extractCookieHeader, isJwLoginExpired } from '../src/util.js'

/** 构造 mock env：fetch 按 URL 前缀路由固定响应，记录调用史 */
function makeMockEnv(routes) {
  const calls = []
  const enc = new TextEncoder()
  const env = {
    async fetch(url, opts = {}) {
      calls.push({ url, opts })
      for (const [prefix, handler] of routes) {
        if (url.includes(prefix)) return handler(url, opts)
      }
      throw new Error(`mock env: 未路由的 URL ${url}`)
    },
    toBase64(bytes) {
      let bin = ''
      for (const b of bytes) bin += String.fromCharCode(b)
      return btoa(bin)
    },
    bytesToText(bytes) {
      let out = ''
      for (const b of bytes) out += String.fromCharCode(b)
      return out
    },
    progress() {},
  }
  return { env, calls }
}

function textResponse(text, setCookies = []) {
  return {
    status: 200,
    ok: true,
    headers: { getSetCookie: () => setCookies },
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  }
}

test('nodeEnv 提供契约四件（fetch/toBase64/bytesToText/progress）', () => {
  const env = nodeEnv()
  assert.equal(typeof env.fetch, 'function')
  assert.equal(typeof env.toBase64, 'function')
  assert.equal(typeof env.bytesToText, 'function')
  assert.equal(typeof env.progress, 'function')
  assert.equal(env.toBase64(new TextEncoder().encode('abc')), 'YWJj')
  assert.equal(env.bytesToText(new TextEncoder().encode('<html>x</html>')), '<html>x</html>')
})

test('validateEnv：缺任一必需件即抛错并点名缺失字段', () => {
  assert.throws(() => validateEnv(null), /env 对象/)
  assert.throws(() => validateEnv({ toBase64() {}, bytesToText() {} }), /env\.fetch/)
  assert.throws(() => validateEnv({ fetch() {}, bytesToText() {} }), /env\.toBase64/)
  assert.throws(() => validateEnv({ fetch() {}, toBase64() {} }), /env\.bytesToText/)
  // progress 可缺省（静默）
  const env = { fetch() {}, toBase64() {}, bytesToText() {} }
  assert.doesNotThrow(() => validateEnv(env))
})

test('createSdufeAdapter：request 提取 set-cookie 为 Cookie 头形态', async () => {
  const { env, calls } = makeMockEnv([
    ['/Logon.do?method=logon&flag=sess', () => textResponse('scode123#6543', ['JSESSIONID=abc123; Path=/'])],
  ])
  const adapter = createSdufeAdapter(env)
  const res = await adapter.request(`${adapter.baseUrl}/Logon.do?method=logon&flag=sess`, 'POST')
  assert.equal(res.nextCookie, 'JSESSIONID=abc123')
  assert.equal(res.text, 'scode123#6543')
  // 伪装 UA 与超时经 env 传递
  assert.equal(calls[0].opts.headers['User-Agent'], 'Apifox/1.0.0 (https://apifox.com)')
  assert.equal(calls[0].opts.timeoutMs, 20000)
})

test('fetchSeed：解析 scode#sxh 与初始 cookie', async () => {
  const { env } = makeMockEnv([
    ['flag=sess', () => textResponse('AAAABBBB#12345', ['JSESSIONID=seed9; Path=/'])],
  ])
  const adapter = createSdufeAdapter(env)
  const seed = await adapter.fetchSeed()
  assert.equal(seed.seedScode, 'AAAABBBB')
  assert.equal(seed.seedSxh, '12345')
  assert.equal(seed.cookie, 'JSESSIONID=seed9')
})

test('fetchCaptcha：expect=buffer 走 env.toBase64；HTML 错误页被嗅探拦截', async () => {
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
  let toBase64CalledWith = null
  const { env } = makeMockEnv([['verifycode.servlet', () => ({
    status: 200, ok: true,
    headers: { getSetCookie: () => [] },
    text: async () => '',
    arrayBuffer: async () => pngBytes.buffer,
  })]])
  env.toBase64 = (bytes) => { toBase64CalledWith = bytes; return 'BASE64PNG' }
  const adapter = createSdufeAdapter(env)
  assert.equal(await adapter.fetchCaptcha('JSESSIONID=x'), 'BASE64PNG')
  assert.ok(toBase64CalledWith instanceof Uint8Array)

  const { env: env2 } = makeMockEnv([['verifycode.servlet', () => textResponse('<html></html>')]])
  const adapter2 = createSdufeAdapter(env2)
  await assert.rejects(() => adapter2.fetchCaptcha('JSESSIONID=x'), /页面而非图片/)
})

test('submitLogin：验证码错误 → isCaptchaError；密码错误 → isPasswordError', async () => {
  const cases = [
    ['验证码错误', 'isCaptchaError'],
    ['密码错误', 'isPasswordError'],
  ]
  for (const [bodyText, marker] of cases) {
    const { env } = makeMockEnv([['Logon.do?method=logon', () => textResponse(bodyText)]])
    const adapter = createSdufeAdapter(env)
    await assert.rejects(
      () => adapter.submitLogin({ userId: 'u', password: 'p', captcha: 'ab', cookie: 'c', seedScode: 's', seedSxh: '1234' }),
      (err) => err[marker] === true
    )
  }
})

// 样例长度须 > 5000：真实 xsMain_new.jsp 是大页面，避开 isJwLoginExpired 短页兜底
const PROFILE_HTML = `
<html><body>
<span class="blue f16 b">张三</span>
<div class="middletopdwxxcont">经济学院</div>
<div class="middletopdwxxcont">金融学</div>
<div class="middletopdwxxcont">金融2101</div>
<span class="main_text main_color">第3周</span>/20周
<div>${'菜单与通知占位'.repeat(800)}</div>
</body></html>`

test('login 全链（mock）：识别回调 → 提交 → 主页确认 → { cookie, userInfo }', async () => {
  let captchaFetched = false
  const { env, calls } = makeMockEnv([
    ['flag=sess', () => textResponse('SC#11', ['JSESSIONID=full1; Path=/'])],
    ['verifycode.servlet', () => {
      captchaFetched = true
      return { status: 200, ok: true, headers: { getSetCookie: () => [] }, text: async () => '', arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer }
    }],
    ['Logon.do?method=logon', (url, opts) => {
      assert.ok(opts.body.includes('RANDOMCODE=ok1'), '识别结果应进入登录表单')
      return textResponse('登录成功跳转')
    }],
    ['xsMain_new.jsp', () => textResponse(PROFILE_HTML)],
  ])
  const adapter = createSdufeAdapter(env)
  const recognized = []
  const { cookie, userInfo } = await adapter.login(
    { userId: '2024010101', password: 'secret', recognizeCaptcha: async (b64) => { recognized.push(b64); return 'ok1' } },
    { maxRetries: 2 }
  )
  assert.equal(cookie, 'JSESSIONID=full1')
  assert.equal(userInfo.name, '张三')
  assert.equal(userInfo.class, '金融2101')
  assert.ok(captchaFetched)
  assert.deepEqual(recognized, ['AQIDBA=='])
})

test('probeSession：登录过期页 → isJwLoginExpired 错误', async () => {
  const { env } = makeMockEnv([
    ['xsMain_new.jsp', () => textResponse('<html><form><input name="userAccount"><input name="RANDOMCODE"></form></html>')],
  ])
  const adapter = createSdufeAdapter(env)
  await assert.rejects(() => adapter.probeSession('c'), (err) => err.isJwLoginExpired === true)
})

test('registry：initSdufe 幂等注册；未初始化的 getAdapter 给出注入指引', () => {
  const { env } = makeMockEnv([])
  const a1 = initSdufe(env)
  const a2 = initSdufe(env)
  assert.equal(getAdapter('sdufe'), a2)
  assert.notEqual(getAdapter('sdufe'), a1, '重复 init 覆盖前实例')
  assert.throws(() => getAdapter('nonexistent'), /未初始化或未知/)
  registerAdapter({ id: 'fake', name: 'Fake', baseUrl: 'http://x' })
  assert.equal(listAdapters().length, 2)
})

test('computeEncoded 与 extractCookieHeader/isJwLoginExpired 随包导出可用', () => {
  // 与 CLI 既有 encoding.test 对拍同源样例
  assert.equal(computeEncoded('20240001', 'pass', 'abcdefghij', '1234567890').length > 0, true)
  assert.equal(extractCookieHeader({ headers: { getSetCookie: () => ['A=1; Path=/', 'B=2; HttpOnly'] } }), 'A=1; B=2')
  assert.equal(isJwLoginExpired('<html><input name="RANDOMCODE"><input name="userAccount"></html>'), true)
})
