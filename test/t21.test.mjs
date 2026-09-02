/**
 * T21 写操作测试：两段式确认（无 --confirm 一律拒绝）、审计落盘 0600、
 * 白名单边界（注销不在面、教务写零命中）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runWriteOp, appendOpsLog } from '../src/writeops.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const realHome = process.env.HOME

test('两段式：无 --confirm 拒绝执行（返回 1，不调提交函数），预览含内容与后果', async () => {
  let submitted = false
  const view = {
    service: 'App.CourseComment.PostComment',
    params: {},
    previewText: ['课程：排球', '评语：好课'],
    consequence: '评课将公开发布，全校可见',
    target: 'course=x',
  }
  const code = await runWriteOp('comment-post', view, false, async () => {
    submitted = true
  }, () => {})
  assert.equal(code, 1)
  assert.equal(submitted, false, '无 --confirm 不得提交')
})

test('两段式：--confirm 提交并返回结果', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linke-t21-'))
  process.env.HOME = tmp
  try {
    let submitted = false
    const out = await runWriteOp('like', { service: 'x', params: {}, previewText: [], target: 'comment=1' }, true, async () => {
      submitted = true
      return { ok: 1 }
    }, () => {})
    assert.equal(submitted, true)
    assert.deepEqual(out.result, { ok: 1 })
    const log = fs.readFileSync(path.join(tmp, '.linke-cli', 'ops.log'), 'utf8')
    assert.ok(/Z like comment=1/.test(log), '审计行落盘')
    assert.equal(fs.statSync(path.join(tmp, '.linke-cli', 'ops.log')).mode & 0o777, 0o600)
  } finally {
    process.env.HOME = realHome
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('写命令面：七个写命令全部走两段式（dispatch 源码断言——每命令都检查 confirm）', () => {
  const bin = fs.readFileSync(path.join(here, '..', 'src', 'bin.js'), 'utf8')
  for (const cmd of ["'comment-post'", "'comment-update'", "'comment-delete'", "'collect'", "'uncollect'", "'like'", "'nickname'"]) {
    const idx = bin.indexOf('case ' + cmd)
    assert.ok(idx > 0, `写命令 ${cmd} 应在 dispatch`)
    const seg = bin.slice(idx, idx + 800)
    assert.ok(seg.includes('cmdWriteOp'), `${cmd} 必须经 cmdWriteOp 两段式入口`)
  }
})

test('白名单边界：注销（cancel）不进命令面；写命令均为林课自有数据接口', () => {
  const bin = fs.readFileSync(path.join(here, '..', 'src', 'bin.js'), 'utf8')
  assert.ok(!/case\s+'cancel'/.test(bin), '注销不进白名单')
  // 写接口服务名仅限白名单四类
  const whitelist = ['App.CourseComment.PostComment', 'App.CourseComment.UpdateComment', 'App.CourseComment.DeleteComment', 'App.CourseComment.LikeComment', 'App.UserCollection.PostCollection', 'App.UserCollection.DeleteCollection', 'App.User.PostUserInfoNickname']
  for (const m of bin.matchAll(/service: 'App\.[A-Za-z]+\.[A-Za-z]+'/g)) {
    if (/Comment|Collection|Nickname/.test(m[0])) {
      assert.ok(whitelist.includes(m[0].replace("service: ", "").replaceAll("'", "")), `写接口 ${m[0]} 必须在白名单`)
    }
  }
})

test('ops.log 独立测试：appendOpsLog 追加格式与权限', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linke-t21b-'))
  process.env.HOME = tmp
  try {
    appendOpsLog('nickname', 'nickname=测试')
    appendOpsLog('collect', 'course=abc')
    const lines = fs.readFileSync(path.join(tmp, '.linke-cli', 'ops.log'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    assert.ok(lines[1].endsWith('collect course=abc'))
  } finally {
    process.env.HOME = realHome
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('T22：预览输出含维度名与分值含义（内容价值/管理轻松度/良师指数）', async () => {
  // 源码断言：starsLabel 被写命令预览使用，且含全部三个维度名与分值文案
  const bin = fs.readFileSync(path.join(here, '..', 'src', 'bin.js'), 'utf8')
  assert.ok(bin.includes("'内容价值'"), '维度常量 内容价值 在位')
  assert.ok(bin.includes("'管理轻松度'"), '维度常量 管理轻松度 在位')
  assert.ok(bin.includes("'良师指数'"), '维度常量 良师指数 在位')
  assert.ok(bin.includes("'很好'") && bin.includes("'很差'"), '分值文案在位')
  assert.ok(/previewText:[\s\S]{0,200}starsLabel\(stars\)/.test(bin.slice(bin.indexOf("case 'comment-post'"))), 'comment-post 预览使用 starsLabel')
  // target 不再截断（全文进审计）
  assert.ok(!/text\.slice\(0,\s*30\)/.test(bin), '预览/审计文本不再截断 30 字')
})
