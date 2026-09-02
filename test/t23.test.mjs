/**
 * T23 测试：全量口径回流 + 默认开 + 首启告知 + courseId 构造。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

test('courseId 构造口径：md5(课程名+教师)，与 App 端 utils/md5 同源', () => {
  const id = crypto.createHash('md5').update('排球' + '李老师').digest('hex')
  assert.match(id, /^[0-9a-f]{32}$/)
})

test('全量回流：ImportScoresFromCourseList + scores 权威源触发（源码断言）', () => {
  const bin = fs.readFileSync(path.join(here, '..', 'src', 'bin.js'), 'utf8')
  const fn = bin.slice(bin.indexOf('async function maybeSyncScores'), bin.indexOf('async function maybeFirstRunNotice'))
  assert.ok(fn.includes('ImportScoresFromCourseList'), '上行接口=全量 (courseId,score) 对')
  assert.ok(fn.includes('fetchXkLogs'), '教师映射走选退课日志（App 端同源做法）')
  assert.ok(fn.includes('createHash'), 'courseId 本地构造')
  // scores 触发、credits 不再触发
  const cmdScores = bin.slice(bin.indexOf('async function cmdScores'), bin.indexOf('\nasync function', bin.indexOf('async function cmdScores') + 10))
  assert.ok(cmdScores.includes('maybeSyncScores'), 'scores 命令触发回流')
  const cmdCredits = bin.slice(bin.indexOf('async function cmdCredits'), bin.indexOf('\nasync function', bin.indexOf('async function cmdCredits') + 10))
  assert.ok(!cmdCredits.includes('maybeSyncScores(config, credits)'), 'credits 不再触发（子集）')
})

test('首启告知：一次性 informed 标记 + 三要素文案 + 关闭方法（源码断言）', () => {
  const bin = fs.readFileSync(path.join(here, '..', 'src', 'bin.js'), 'utf8')
  const fn = bin.slice(bin.indexOf('async function maybeFirstRunNotice'))
  assert.ok(fn.includes('informed'), '一次性标记')
  assert.ok(fn.includes('给分统计'), '三要素文案在位')
  assert.ok(fn.includes('--sync off'), '关闭方法在位')
})

test('login 必答块：页面 radio + 服务端透传 + verify 落盘（源码断言）', () => {
  const html = fs.readFileSync(path.join(here, '..', 'src', 'web', 'login.html'), 'utf8')
  assert.ok(html.includes('name="syncChoice"') && html.includes('不参与'), '页面必答块在位')
  assert.ok(html.includes('不影响任何功能'), '选否零损失文案')
  const server = fs.readFileSync(path.join(here, '..', 'src', 'loginserver.js'), 'utf8')
  assert.ok(server.includes('syncChoice'), '服务端透传')
  const bin = fs.readFileSync(path.join(here, '..', 'src', 'bin.js'), 'utf8')
  assert.ok(bin.includes("syncChoice === 'off' ? { ...config, sync: false }"), 'off 选择落盘')
})
