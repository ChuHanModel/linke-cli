/**
 * 解析器测试：HTML 样例按正方页面真实怪癖手工构造
 * （含 </td></td> 双闭合、<td align=> 清洗后变 <tdalign= 等），
 * 正则口径移植自 linke_PHP Model 层与 uni-app 端现役实现。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseUserData,
  hasAuthenticatedProfileMarkers,
  parseCurrentTerm,
  parseScheduleHtml,
  parseScoresHtml,
} from '../src/schools/sdufe/parsers.js'
import { isJwLoginExpired } from '../src/util.js'

// ---------- isJwLoginExpired ----------

test('登录页判定：短页 + </html> 判为过期', () => {
  assert.equal(isJwLoginExpired('<html><body>用户登录</body></html>'), true)
  assert.equal(isJwLoginExpired('<html>请先登录</html>'), true)
})

test('登录页判定：正常业务长页不误判', () => {
  const long = '<html><body>' + '课表内容'.repeat(2000) + '</body></html>'
  assert.equal(isJwLoginExpired(long), false)
})

// ---------- parseUserData / 登录标记 ----------

test('parseUserData 提取姓名/单位/专业/班级', () => {
  const html = `
    <div><span class="blue f16 b">张三</span></div>
    <div class="middletopdwxxcont">山东财经大学会计学院</div>
    <div class="middletopdwxxcont">会计学</div>
    <div class="middletopdwxxcont">会计2401</div>
  `
  const info = parseUserData(html)
  assert.equal(info.name, '张三')
  assert.equal(info.unit, '山东财经大学会计学院')
  assert.equal(info.discipline, '会计学')
  assert.equal(info.class, '会计2401')
  assert.equal(hasAuthenticatedProfileMarkers(html, info), true)
})

test('parseUserData 登录页 HTML 无特征', () => {
  const html = '<html><input name="userAccount"><input name="RANDOMCODE"></html>'
  const info = parseUserData(html)
  assert.equal(info.name, '')
  assert.equal(hasAuthenticatedProfileMarkers(html, info), false)
})

// ---------- parseCurrentTerm ----------

test('parseCurrentTerm 优先 selected 项', () => {
  const html = `
    <select><option value="2023-2024-2">2023-2024-2</option>
    <option value="2025-2026-1" selected="selected">2025-2026-1</option></select>
  `
  assert.equal(parseCurrentTerm(html), '2025-2026-1')
})

test('parseCurrentTerm 无 selected 时取第一项；无 option 返回 null', () => {
  assert.equal(parseCurrentTerm('<select><option value="2024-2025-1">a</option></select>'), '2024-2025-1')
  assert.equal(parseCurrentTerm('<select></select>'), null)
  assert.equal(parseCurrentTerm(''), null)
})

// ---------- parseScheduleHtml ----------

function scheduleCell(course, teacher, time, location) {
  return `kbcontent">${course}<font title='老师'>${teacher}</font><font title='周次(第1-16周)'>${time}</font><font title='教室'>${location}</font></div>`
}

function buildScheduleHtml(fillerCount) {
  let html = '<table>'
  for (let i = 0; i < fillerCount; i++) {
    if (i === 0) html += `<td>${scheduleCell('高等数学', '李老师', '1-16周', 'A101')}</td>`
    else html += '<td>kbcontent">&nbsp;</div>'
  }
  html += '</table>'
  return html
}

test('parseScheduleHtml：35 格分组为 5 行 × 7 天，空格子字段为空', () => {
  const result = parseScheduleHtml(buildScheduleHtml(35))
  assert.equal(result.weeks.length, 5)
  assert.equal(result.weeks[0].length, 7)
  const first = result.weeks[0][0]
  assert.equal(first.course, '高等数学')
  assert.equal(first.teacher, '李老师')
  assert.equal(first.time, '1-16周')
  assert.equal(first.location, 'A101')
  const empty = result.weeks[0][1]
  assert.deepEqual(empty, { course: '', teacher: '', time: '', location: '' })
})

test('parseScheduleHtml：格数不足 35 抛 PARSE 错误', () => {
  assert.throws(() => parseScheduleHtml(buildScheduleHtml(34)), (err) => err.code === 'PARSE')
})

test('parseScheduleHtml：登录页 HTML 抛 isJwLoginExpired', () => {
  try {
    parseScheduleHtml('<html>用户登录</html>')
    assert.fail('应抛错')
  } catch (err) {
    assert.equal(err.isJwLoginExpired, true)
  }
})

// ---------- parseScoresHtml ----------

/** 构造一行成绩（原始带空格 HTML，模拟正方 cjcx_list 真实怪癖：成绩列 </td></td> 双闭合） */
function scoreRow({ seq = '1', term = '2024-2025-1', code = 'GS0001', col3 = '马克思主义基本原理', score = '88', jd = '3.8', xf = '3', nature = '通选', extra1 = '', extra2 = '' }) {
  return (
    `<tr><td>${seq}</td><td>${term}</td><td align="left">${code}</td><td align="left">${col3}</td>` +
    `<!--控制成绩显示--><td style="display:none"><a href="#">${score}</a></td></td><td>${xf}</td>` +
    `<!--控制绩点显示--><td>${jd}</td><td>${xf}</td><td>${nature}</td><td>${extra1}</td><td>${extra2}</td></tr>`
  )
}

test('parseScoresHtml：withLeading 变体整行解析（含课程名列）', () => {
  const html = '<table>' + scoreRow({}) + scoreRow({ seq: '2', code: 'GS0002', col3: '大学英语', score: '92', nature: '必修' }) + '</table>'
  const rows = parseScoresHtml(html)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], {
    term: '2024-2025-1',
    courseCode: 'GS0001',
    courseName: '马克思主义基本原理',
    scoreText: '88',
    score: 88,
    nature: '通选',
  })
  assert.equal(rows[1].courseCode, 'GS0002')
  assert.equal(rows[1].score, 92)
})

test('parseScoresHtml：等级制成绩 score=null、scoreText 保留', () => {
  const html = '<table>' + scoreRow({ score: '优', nature: '必修' }) + '</table>'
  const rows = parseScoresHtml(html)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].score, null)
  assert.equal(rows[0].scoreText, '优')
})

test('parseScoresHtml：无效占位文本与超界数字被丢弃', () => {
  const html =
    '<table>' +
    scoreRow({ score: '暂无' }) +
    scoreRow({ score: '-' }) +
    scoreRow({ score: '120' }) +
    scoreRow({ score: '95' }) +
    '</table>'
  const rows = parseScoresHtml(html)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].score, 95)
})

test('parseScoresHtml：学期列与课程号列顺序互换也可解析（PHP col1/col2 分支）', () => {
  // 构造：第二个 td 是课程号，第三个才是学期
  const row =
    `<tr><td>1</td><td>GS0009</td><td align="left">2024-2025-2</td><td align="left">体育</td>` +
    `<!--控制成绩显示--><td style="x"><a href="#">良</a></td></td><td>1</td>` +
    `<!--控制绩点显示--><td></td><td>1</td><td>必修</td><td></td><td></td></tr>`
  const rows = parseScoresHtml('<table>' + row + '</table>')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].term, '2024-2025-2')
  assert.equal(rows[0].courseCode, 'GS0009')
  assert.equal(rows[0].scoreText, '良')
})

test('parseScoresHtml：legacy 变体兜底（无学期列，课程号在前）', () => {
  const row =
    `<td align="left">GS0100</td><td align="left">2023-2024-1</td>` +
    `<!--控制成绩显示--><td style="x"><a href="#">76</a></td></td><td>2</td>` +
    `<!--控制绩点显示--><td>2.6</td><td>2</td><td>通选</td><td></td><td></td>`
  const rows = parseScoresHtml('<table><tr>' + row + '</tr></table>')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].courseCode, 'GS0100')
  assert.equal(rows[0].term, '2023-2024-1')
  assert.equal(rows[0].score, 76)
})

test('parseScoresHtml：整页零命中抛 PARSE 错误', () => {
  assert.throws(() => parseScoresHtml('<table><tr><td>无关页面</td></tr></table>'), (err) => err.code === 'PARSE')
})
