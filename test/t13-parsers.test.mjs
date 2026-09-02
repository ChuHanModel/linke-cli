/**
 * T13 通用简表解析器测试：表头自说明输出、空态、dropFirst、
 * tableIndex、行截齐补空、非法访问/登录过期分类。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { parsers } from 'linke-sdufe'
const { parseSimpleTable } = parsers

function page(tablesHtml, { empty = false } = {}) {
  return `<html><body>${tablesHtml}${empty ? '未查询到数据' : ''}</body></html>`
}

function table(headers, rows) {
  const head = '<tr>' + headers.map((h) => `<th>${h}</th>`).join('') + '</tr>'
  const body = rows.map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('')
  return `<table>${head}${body}</table>`
}

test('parseSimpleTable：表头自说明 + 行截齐补空', () => {
  const html = page(
    table(['序号', '名称', '学分'], [
      ['1', '排球', '1'],
      ['2', '短行'], // 缺一格 → 补空
      ['3', '长行', '2', '多余'], // 多一格 → 截断
    ])
  )
  const result = parseSimpleTable(html)
  assert.deepEqual(result.headers, ['序号', '名称', '学分'])
  assert.equal(result.rows.length, 3)
  assert.deepEqual(result.rows[1], ['2', '短行', ''])
  assert.deepEqual(result.rows[2], ['3', '长行', '2'])
})

test('parseSimpleTable：重复表头原样保留（levels 双「笔试/机试/总成绩」列位对应）', () => {
  const headers = ['序号', '考级课程(等级)', '笔试', '机试', '总成绩', '笔试', '机试', '总成绩']
  const html = page(table(headers, [['1', '大学英语四级', '500', '', '', '', '', '']]))
  const result = parseSimpleTable(html)
  assert.deepEqual(result.headers, headers)
  assert.equal(result.rows[0][2], '500') // 第一组笔试
})

test('parseSimpleTable：空数据页返回表头+空数组；dropFirst 丢展开图标列', () => {
  const html = page(
    table(['原班级', '新学院'], [
      ['+', '2024美术学类1班', '艺术学院'], // 首列图标 + 右移
    ])
  )
  const result = parseSimpleTable(html, { dropFirst: true })
  assert.deepEqual(result.rows[0], ['2024美术学类1班', '艺术学院'])

  const emptyHtml = page(table(['预警学期'], []), { empty: true })
  assert.deepEqual(parseSimpleTable(emptyHtml), { headers: ['预警学期'], rows: [] })
})

test('parseSimpleTable：tableIndex 取第二张表（social 考级成绩）', () => {
  const html = page(
    table(['序号', '考级课程名称'], [['1', '四级']]) + table(['考级等级名称', '考级时间'], [['CET4', '2025-06']])
  )
  const t1 = parseSimpleTable(html, { tableIndex: 1 })
  assert.deepEqual(t1.headers, ['考级等级名称', '考级时间'])
  assert.deepEqual(t1.rows[0], ['CET4', '2025-06'])
})

test('parseSimpleTable：加载中壳页返回空表；非法访问抛 PARSE；登录页抛过期', () => {
  assert.deepEqual(
    parseSimpleTable('<html><body>正在拼命加载中，请稍后...</body></html>'),
    { headers: [], rows: [] }
  )
  // 回归守卫：正常空数据页也带加载占位文案，不能被当壳页
  const withLoadingText =
    '<html><body>正在拼命加载中，请稍后...<table><tr><th>序号</th></tr></table>未查询到数据</body></html>'
  assert.deepEqual(
    parseSimpleTable(withLoadingText),
    { headers: ['序号'], rows: [] }
  )
  assert.throws(
    () => parseSimpleTable('<html><h3>提示：非法访问！</h3></html>'),
    (err) => err.code === 'PARSE'
  )
  try {
    parseSimpleTable('<html><input name="RANDOMCODE"><input name="userAccount"></html>')
    assert.fail('应抛错')
  } catch (err) {
    assert.equal(err.isJwLoginExpired, true)
  }
})

test('parseSimpleTable：无表格无加载标记抛 PARSE', () => {
  // 长内容页（避免落入登录过期的短页判据）
  const longText = '<html><body>' + 'x'.repeat(6000) + '</body></html>'
  assert.throws(
    () => parseSimpleTable(longText),
    (err) => err.code === 'PARSE'
  )
})
