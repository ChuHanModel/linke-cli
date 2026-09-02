/**
 * T17 测试：① notices 链路零后端依赖断言（验收 1 可验证形式）；
 * ② jwc 公告解析；③ makeups 空态；④ 补考/联动构造样例。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseJwcNotices, parseMakeupsHtml } from '../src/schools/sdufe/parsers.js'

const here = path.dirname(fileURLToPath(import.meta.url))

test('notices 链路零后端依赖：cmdNotices 代码及其依赖不含 api.linketeam.com / appapi 引用（T17 验收 1）', async () => {
  const bin = fs.readFileSync(path.join(here, '..', 'src', 'bin.js'), 'utf8')
  const noticeFn = bin.slice(bin.indexOf('async function cmdNotices'), bin.indexOf('function str(v)'))
  assert.ok(noticeFn.length > 200, '应能定位 cmdNotices 函数体')
  assert.ok(!noticeFn.includes('linketeam'), 'notices 不得请求 api.linketeam.com')
  assert.ok(!noticeFn.includes('appapi'), 'notices 不再使用后端客户端 appapi.js')
  assert.ok(!noticeFn.includes('App.JwNotice'), 'notices 不再调用后端 JwNotice 接口')
})

test('appapi.js 保留 + 教务查询链路零后端：notices 与全部教务数据命令函数体不引用后端客户端', () => {
  assert.ok(fs.existsSync(path.join(here, '..', 'src', 'appapi.js')), 'appapi.js 应保留在仓库')
  const bin = fs.readFileSync(path.join(here, '..', 'src', 'bin.js'), 'utf8')
  // 教务数据命令函数体逐一断言（二期命令 course-*/rankings/comments/linkeAccount 探测是合法后端交互面）
  const guarded = ['cmdNotices', 'cmdScores', 'cmdSchedule', 'cmdCredits', 'cmdCourses', 'cmdGpa', 'cmdXj', 'cmdPlan', 'cmdPyfa', 'cmdExams', 'cmdProgress', 'cmdSimplePage', 'cmdFormPage']
  for (const fn of guarded) {
    const start = bin.indexOf('async function ' + fn)
    if (start === -1) continue
    const end = bin.indexOf('\nasync function', start + 20)
    const body = bin.slice(start, end === -1 ? undefined : end)
    assert.ok(!body.includes('appapi') && !body.includes('linketeam'), `${fn} 是教务查询链路，不得引用后端客户端`)
  }
})

test('parseJwcNotices：相对链接转绝对 + 窗口日期（真实页形态）', () => {
  const html = `
    <ul>
      <li><a href="../info/1043/5965.htm" target="_blank">关于智慧树网络课程的通知</a><span>2026-09-01</span></li>
      <li><a href="../info/1043/5945.htm">优秀学士论文评选</a></li>
    </ul>`
  const list = parseJwcNotices(html)
  assert.equal(list.length, 2)
  assert.equal(list[0].url, 'https://jwc.sdufe.edu.cn/info/1043/5965.htm')
  assert.equal(list[0].date, '2026-09-01')
  assert.equal(list[0].title, '关于智慧树网络课程的通知')
  assert.equal(list[1].date, '') // 无日期窗口
})

test('parseMakeupsHtml：非报名期文案 → 语义空态（先于登录过期判据）', () => {
  const html = '<html><body>补考报名 当前不在报名时间范围内或未启用报名！</body></html>'
  const result = parseMakeupsHtml(html)
  assert.deepEqual(result.makeups, [])
  assert.ok(result.note.includes('不在补考报名时间'))
})
