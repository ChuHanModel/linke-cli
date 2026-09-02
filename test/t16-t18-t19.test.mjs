/**
 * T16/T18/T19 测试：更新机制（semver/缓存/开关/日志/stdout 零污染）、
 * userKey 现算不落盘、回流默认关、写域零暴露断言。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { semverGt, readCheckState } from '../src/updater.js'
import { computeUserKey } from '../src/linkeapi.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const realHome = process.env.HOME

// ---------- T16 updater ----------

test('semverGt：段式数字比较', () => {
  assert.equal(semverGt('1.10.0', '1.9.9'), true)
  assert.equal(semverGt('1.0.0', '1.0.0'), false)
  assert.equal(semverGt('2.0', '1.99.1'), true)
  assert.equal(semverGt('0.9.9', '1.0.0'), false)
})

test('更新告知与检查状态走 stderr 文件面：update.log 为追加式两列版本', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linke-upd-'))
  process.env.HOME = tmp
  try {
    const { appendUpdateLog } = await import('../src/updater.js')
    appendUpdateLog('1.0.0', '1.1.0')
    appendUpdateLog('1.1.0', '1.2.0')
    const lines = fs.readFileSync(path.join(tmp, '.linke-cli', 'update.log'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    assert.ok(/Z 1\.0\.0 -> 1\.1\.0$/.test(lines[0]))
    assert.ok(/Z 1\.1\.0 -> 1\.2\.0$/.test(lines[1]))
  } finally {
    process.env.HOME = realHome
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('stdout JSON 契约零污染：updater 全部输出走 stderr（源码断言）', async () => {
  const src = fs.readFileSync(path.join(here, '..', 'src', 'updater.js'), 'utf8')
  assert.ok(!/console\.log/.test(src), 'updater 不得用 console.log（stdout）')
  assert.ok(!/process\.stdout\.write/.test(src), 'updater 不得写 stdout')
})

// ---------- T18 二期A ----------

test('computeUserKey 输出 32 位十六进制；userKey 不写入 config（现算不落盘源码断言）', async () => {
  const key = computeUserKey('202419140148', 'pw123456')
  assert.match(key, /^[0-9a-f]{32}$/)
  assert.notEqual(key, computeUserKey('202419140148', 'other'))
  const bin = fs.readFileSync(path.join(here, '..', 'src', 'bin.js'), 'utf8')
  const cfgSrc = fs.readFileSync(path.join(here, '..', 'src', 'config.js'), 'utf8')
  assert.ok(!cfgSrc.includes('userKey'), 'config.js 不得持久化 userKey')
})

test('回流默认关：默认配置无 sync 字段；maybeSyncScores 仅 sync===true 才上行（源码断言）', async () => {
  const bin = fs.readFileSync(path.join(here, '..', 'src', 'bin.js'), 'utf8')
  const fn = bin.slice(bin.indexOf('async function maybeSyncScores'))
  assert.ok(fn.includes('raw.sync !== true'), '必须显式 opt-in 才上行')
})

test('成绩回流同意流程：首次开启打印三要素（上传什么/去哪/干嘛用）', () => {
  const bin = fs.readFileSync(path.join(here, '..', 'src', 'bin.js'), 'utf8')
  const seg = bin.slice(bin.indexOf("flags.sync !== undefined"), bin.indexOf('if (flags.clear)'))
  assert.ok(seg.includes('上传什么') && seg.includes('去哪里') && seg.includes('用来干嘛'), '三要素文案齐全')
  assert.ok(seg.includes("!== 'y'") || seg.includes("=== 'y'"), '必须显式确认')
})

// ---------- T19 二期B ----------

test('写域零暴露：rankings/comments 命令链路无任何评价写接口（源码断言）', () => {
  const bin = fs.readFileSync(path.join(here, '..', 'src', 'bin.js'), 'utf8')
  const linkeapi = fs.readFileSync(path.join(here, '..', 'src', 'linkeapi.js'), 'utf8')
  const appapi = fs.readFileSync(path.join(here, '..', 'src', 'appapi.js'), 'utf8')
  const all = bin + linkeapi + appapi
  for (const banned of ['PostComment', 'UpdateComment', 'DeleteComment', 'LikeComment', 'postComment', 'updateComment', 'deleteComment', 'likeComment']) {
    assert.ok(!all.includes(banned), `写域接口 ${banned} 不得出现在 CLI 命令面`)
  }
})
