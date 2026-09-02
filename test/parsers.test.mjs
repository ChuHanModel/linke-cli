/**
 * 解析器测试：HTML 样例按强智教务页面真实怪癖手工构造
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
  parseCreditsHtml,
  parseCoursesHtml,
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
  assert.equal(info.week, null)
  assert.equal(hasAuthenticatedProfileMarkers(html, info), true)
})

test('parseUserData 提取当前教学周（T7 成功页确认信息口径）', () => {
  const html = `
    <span class="blue f16 b">张三</span>
    <span class="main_text main_color">第3周</span>/20周
    <div class="middletopdwxxcont">a</div>
    <div class="middletopdwxxcont">b</div>
    <div class="middletopdwxxcont">c</div>
  `
  const info = parseUserData(html)
  assert.deepEqual(info.week, { now: '3', all: '20' })
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

/** 构造一行成绩（原始带空格 HTML，模拟强智 cjcx_list 真实怪癖：成绩列 </td></td> 双闭合） */
function scoreRow({ seq = '1', term = '2024-2025-1', code = 'GS0001', col3 = '马克思主义基本原理', score = '88', jd = '3.8', xf = '3', nature = '通选', extra1 = '', extra2 = '' }) {
  return (
    `<tr><td>${seq}</td><td>${term}</td><td align="left">${code}</td><td align="left">${col3}</td>` +
    `<!--控制成绩显示--><td style="display:none"><a href="#">${score}</a></td></td><td>${xf}</td>` +
    `<!--控制绩点显示--><td>${jd}</td><td>${xf}</td><td>${nature}</td><td>${extra1}</td><td>${extra2}</td></tr>`
  )
}

test('parseScoresHtml：withLeading 变体整行解析（含课程名与学分列，T10 口径）', () => {
  const html = '<table>' + scoreRow({}) + scoreRow({ seq: '2', code: 'GS0002', col3: '大学英语', score: '92', nature: '必修' }) + '</table>'
  const rows = parseScoresHtml(html)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], {
    term: '2024-2025-1',
    courseCode: 'GS0001',
    courseName: '马克思主义基本原理',
    credit: '3',
    scoreText: '88',
    score: 88,
    nature: '通选',
  })
  assert.equal(rows[1].courseCode, 'GS0002')
  assert.equal(rows[1].score, 92)
  assert.equal(rows[1].credit, '3')
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

// ---------- parseCreditsHtml（T10：真实页双表结构）----------

function creditsPage() {
  return `
  <div class="Nsb_layout_r title">通选课修读情况</div>
  <table width="100%" class="Nsb_r_list Nsb_table">
    <tr><th class="Nsb_r_list_thb" scope="col">类别</th>
        <th class="Nsb_r_list_thb" scope="col">要求学分（大于等于）</th>
        <th class="Nsb_r_list_thb" scope="col">已修学分</th>
        <th class="Nsb_r_list_thb" scope="col">正在修读</th></tr>
    <tr><td align="center">安全教育类</td><td align="center"></td><td align="center">1</td><td align="center"></td></tr>
    <tr><td align="center">财经特色类</td><td align="center">2</td><td align="center">4</td><td align="center">3</td></tr>
  </table>
  <table width="100%" class="Nsb_r_list Nsb_table">
    <tr><th>课程编号</th><th>课程名称</th><th>学分</th><th>总成绩</th><th>通选课类别</th></tr>
    <tr><td></td><td></td><td></td><td></td><td></td></tr>
    <tr><td>41100661</td><td>排球</td><td>1</td><td>91</td><td>体育保健类</td></tr>
    <tr><td>41100903</td><td>劳动与劳动关系管理</td><td>1</td><td>92</td><td>劳动教育类</td></tr>
  </table>`
}

test('parseCreditsHtml：类别统计 + 通选课明细双表解析（真实页结构）', () => {
  const result = parseCreditsHtml(creditsPage())
  assert.equal(result.categories.length, 2)
  assert.deepEqual(result.categories[0], {
    category: '安全教育类',
    required: '',
    earned: '1',
    inProgress: '',
  })
  assert.deepEqual(result.categories[1], {
    category: '财经特色类',
    required: '2',
    earned: '4',
    inProgress: '3',
  })
  assert.equal(result.courses.length, 2) // 空编号行跳过
  assert.deepEqual(result.courses[0], {
    courseCode: '41100661',
    courseName: '排球',
    credit: '1',
    score: '91',
    type: '体育保健类',
  })
})

test('parseCreditsHtml：登录页 HTML 抛 isJwLoginExpired；无表抛 PARSE', () => {
  try {
    parseCreditsHtml('<html>用户登录</html>')
    assert.fail('应抛错')
  } catch (err) {
    assert.equal(err.isJwLoginExpired, true)
  }
  assert.throws(() => parseCreditsHtml('<table><tr><td>无关</td></tr></table>'), (err) => err.code === 'PARSE')
})

// ---------- parseCoursesHtml（T10：kbxx_kc_ifr 数据网格）----------

function courseRow(cells) {
  // 真实口径：单元格 &nbsp; 包裹 + 属性齐全
  return '<tr>' + cells.map((c) => `<td width="123" height="28" align="center" valign="top"> &nbsp;${c}&nbsp; </td>`).join('') + '</tr>'
}

function coursesPage() {
  const headers = ['校区', '上课学院', '上课班级', '课程编号', '课程名称', '上课周次', '上课时间', '上课地点', '授课教师', '教工号', '课程性质', '学分', '上课人数']
  return (
    '<table>' +
    '<tr>' + headers.map((h) => `<th height="28" align="center" >${h}</th>`).join('') + '</tr>' +
    '<tr>' + headers.map(() => '<td></td>').join('') + '</tr>' + // 真实页存在的整行空行
    courseRow(['舜耕校区', '保险学院', '临班46', '41100096', '个人理财学', '1-11', '1091011', '1106(舜耕)', '王琳', '20028553', '通选', '2', '180']) +
    courseRow(['舜耕校区', '工商管理学院', '工商1班', '41100097', '市场营销学', '1-16', '30405', 'A303(舜耕)', '赵强', '20028554', '通选', '2', '95']) +
    '</table>'
  )
}

test('parseCoursesHtml：13 列网格按表头映射（&nbsp; 清洗、空行跳过）', () => {
  const result = parseCoursesHtml(coursesPage())
  assert.equal(result.total, 2)
  assert.deepEqual(result.courses[0], {
    campus: '舜耕校区',
    department: '保险学院',
    className: '临班46',
    courseCode: '41100096',
    courseName: '个人理财学',
    weeks: '1-11',
    time: '1091011',
    location: '1106(舜耕)',
    teacher: '王琳',
    teacherCode: '20028553',
    nature: '通选',
    credit: '2',
    capacity: '180',
  })
  assert.equal(result.courses[1].courseName, '市场营销学')
})

test('parseCoursesHtml：缺上课人数列时不输出 capacity；登录页抛 isJwLoginExpired', () => {
  const noCapacity =
    '<table>' +
    '<tr><th>课程编号</th><th>课程名称</th><th>授课教师</th><th>学分</th></tr>' +
    courseRow(['GS0001', '个人理财学', '王琳', '2']) +
    '</table>'
  const result = parseCoursesHtml(noCapacity)
  assert.equal(result.total, 1)
  assert.equal(result.courses[0].courseCode, 'GS0001')
  assert.equal(result.courses[0].credit, '2')
  assert.ok(!('capacity' in result.courses[0]))
  try {
    parseCoursesHtml('<html>用户登录</html>')
    assert.fail('应抛错')
  } catch (err) {
    assert.equal(err.isJwLoginExpired, true)
  }
})
