/**
 * T32 遥测测试：全命令挂钩（runCli 出口）、无关闭开关、字段边界、
 * 静默不伤体验、UA 携带。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

test('全命令挂钩：runCli 正常与异常路径都上报（源码断言）', () => {
  const bin = fs.readFileSync(path.join(here, '..', 'src', 'bin.js'), 'utf8')
  assert.ok(bin.includes('reportCommandEvent'), 'runCli 出口挂钩在位')
  const seg = bin.slice(bin.indexOf('export async function runCli'))
  const normalCount = (seg.match(/reportCommandEvent/g) || []).length
  assert.ok(normalCount >= 2, '正常与异常路径均上报（失败尝试是需求信号）')
})

test('无关闭开关：telemetry.js 无 sync/off/config 条件分支（源码断言）', () => {
  const src = fs.readFileSync(path.join(here, '..', 'src', 'telemetry.js'), 'utf8')
  assert.ok(src.includes('AbortSignal.timeout(2000)'), '≤2s 超时')
  assert.ok(/catch/.test(src), '静默失败')
  const noSwitch = src.replace(/event\.configured|configured:|apiBase/g, '')
  assert.ok(!/--off|optout|opt-out|sync.{0,6}false|disable/i.test(noSwitch), '无开关分支')
})

test('字段边界与 UA：command 40 截断、UA linke-cli/ 前缀、签名进 query（源码断言）', () => {
  const src = fs.readFileSync(path.join(here, '..', 'src', 'telemetry.js'), 'utf8')
  assert.ok(src.includes(".slice(0, 40)"), 'command 截断')
  assert.ok(src.includes('linke-cli/'), 'UA 前缀')
  assert.ok(/service=App\.CliTelemetry\.Report&\$\{query\}/.test(src), '签名在 URL query（T18 口径）')
  assert.ok(src.includes('computeUserKey'), '身份摘要=md5(学号+密码)（T28 口径沿用）')
})

test('如实披露：README 与 SKILL 均写明遥测内容与不可关闭', () => {
  const readme = fs.readFileSync(path.join(here, '..', 'README.md'), 'utf8')
  assert.ok(readme.includes('不可关闭'), 'README 披露不可关闭')
  assert.ok(readme.includes('身份摘要'), 'README 披露字段')
  const skill = fs.readFileSync(path.join(here, '..', 'skills', 'linke', 'SKILL.md'), 'utf8')
  assert.ok(skill.includes('遥测披露'), 'SKILL 披露段在位')
})

test('遥测与回流互不联动：telemetry 不引用 sync 开关；回流断言不涉 telemetry', () => {
  const src = fs.readFileSync(path.join(here, '..', 'src', 'telemetry.js'), 'utf8')
  assert.ok(!/--sync/.test(src), '遥测无 sync 开关引用')
})
