/**
 * T12 解析器测试：gpa（cjcx_avg 10 列）/xj（xsxx 标签值网格 + 敏感裁剪）/
 * plan（pyfa_query 11 列）——样例按真实页结构手工构造，不真打教务。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseGpaHtml, parseXjHtml, parsePlanHtml } from '../src/schools/sdufe/parsers.js'

// ---------- parseGpaHtml ----------

function gpaPage() {
  return `
  <table class="Nsb_r_list Nsb_table">
    <tr><th>学号</th><th>姓名</th><th>专业名称</th><th>班级名称</th><th>培养层次</th>
        <th>所修总学分</th><th>课程门数</th><th>平均分</th><th>平均学分绩</th><th>平均学分绩点</th></tr>
    <tr>
      <td>202419140148</td><td>王忆佳</td><td>会计学(辅修)</td><td>2024美术学(艺术金融方向)2班</td><td></td>
      <td>19</td><td>6</td><td>91.33</td><td>90.95</td><td>0</td>
    </tr>
    <tr>
      <td>202419140148</td><td>王忆佳</td><td>美术学(艺术金融方向)</td><td>2024美术学(艺术金融方向)2班</td><td>本科</td>
      <td>110</td><td>56</td><td>91.27</td><td>90.55</td><td>4.06</td>
    </tr>
  </table>
  <table><tr><td>正在拼命加载中，请稍后...</td></tr></table>`
}

test('parseGpaHtml：主修+辅修双行解析，majorType 判定不依赖行序', () => {
  const result = parseGpaHtml(gpaPage())
  assert.equal(result.rows.length, 2)
  assert.equal(result.rows[0].majorType, '辅修')
  assert.equal(result.rows[0].major, '会计学(辅修)')
  assert.equal(result.rows[0].totalCredits, '19')
  assert.equal(result.rows[1].majorType, '主修')
  assert.equal(result.rows[1].gpa, '4.06')
  assert.equal(result.rows[1].courseCount, '56')
})

test('parseGpaHtml：登录页抛 isJwLoginExpired；无表抛 PARSE', () => {
  try {
    parseGpaHtml('<html>用户登录</html>')
    assert.fail('应抛错')
  } catch (err) {
    assert.equal(err.isJwLoginExpired, true)
  }
  assert.throws(() => parseGpaHtml('<table><tr><td>空</td></tr></table>'), (err) => err.code === 'PARSE')
})

// ---------- parseXjHtml ----------

/** 按真实页形态构造学籍卡片（不规则标签值网格，含空值占位与敏感字段） */
function xjPage() {
  const td = (t) => `<td>${t}</td>`
  return `
  <table>
    <tr>${td('') * 0}${td('')}${td('')}${td('')}</tr>
    <tr>${td('学 籍 卡 片')}</tr>
    <tr>${td('院系：艺术学院')}${td('专业：美术学(艺术金融方向)')}${td('学制：4')}${td('班级：2024美术学(艺术金融方向)2班')}${td('学号：202419140148')}</tr>
    <tr>${td('姓名')}${td('王忆佳')}${td('性别')}${td('女')}${td('姓名拼音')}${td('WangYiJia')}${td('')}</tr>
    <tr>${td('出生日期')}${td('20050915')}${td('婚否')}${td('')}${td('本人电话')}${td('')}</tr>
    <tr>${td('专业方向')}${td('')}${td('政治面貌')}${td('群众')}</tr>
    <tr>${td('籍贯')}${td('')}</tr>
    <tr>${td('学习形式')}${td('')}${td('学习层次')}${td('本科')}${td('外语种类')}${td('')}</tr>
    <tr>${td('入学日期')}${td('20240831')}${td('毕业日期')}${td('')}</tr>
    <tr>${td('入学考号')}${td('24370112300216')}${td('身份证编号')}${td('370112200509150046')}</tr>
  </table>`
}

test('parseXjHtml：默认输出核心学籍字段（含空值标签不串位）', () => {
  const xj = parseXjHtml(xjPage())
  assert.equal(xj.studentId, '202419140148')
  assert.equal(xj.department, '艺术学院')
  assert.equal(xj.major, '美术学(艺术金融方向)')
  assert.equal(xj.duration, '4')
  assert.equal(xj.className, '2024美术学(艺术金融方向)2班')
  assert.equal(xj.level, '本科')
  assert.equal(xj.grade, '2024')
  assert.equal(xj.extra, undefined, '默认不带扩展字段')
})

test('parseXjHtml：空值标签不误吸下一标签（外语种类=空 而非 家庭现住址 类串位）', () => {
  const html = `
  <table>
    <tr><td>学号：202419140148</td></tr>
    <tr><td>学习形式</td><td></td><td>学习层次</td><td>本科</td><td>外语种类</td><td></td><td>籍贯</td><td>山东济南</td></tr>
  </table>`
  const xj = parseXjHtml(html, { full: true })
  assert.equal(xj.level, '本科')
  assert.equal(xj.extra['学习形式'], '')
  assert.equal(xj.extra['外语种类'], '')
  assert.equal(xj.extra['籍贯'], '山东济南')
})

test('parseXjHtml：--full 附白名单扩展，强敏感字段任何模式不输出', () => {
  const xjDefault = parseXjHtml(xjPage())
  const xjFull = parseXjHtml(xjPage(), { full: true })
  assert.equal(xjFull.extra['性别'], '女')
  assert.equal(xjFull.extra['政治面貌'], '群众')
  assert.equal(xjFull.extra['入学日期'], '20240831')
  // 强敏感字段裁剪（无论模式）
  const all = JSON.stringify(xjDefault) + JSON.stringify(xjFull)
  assert.ok(!all.includes('20050915'), '出生日期不得出现在任何输出')
  assert.ok(!all.includes('370112200509150046'), '身份证号不得出现在任何输出')
  assert.ok(!all.includes('24370112300216'), '入学考号不得出现在任何输出')
})

test('parseXjHtml：无学号抛 PARSE；登录页抛 isJwLoginExpired', () => {
  assert.throws(() => parseXjHtml('<table><tr><td>无关</td></tr></table>'), (err) => err.code === 'PARSE')
  try {
    parseXjHtml('<html>用户登录</html>')
    assert.fail('应抛错')
  } catch (err) {
    assert.equal(err.isJwLoginExpired, true)
  }
})

// ---------- parsePlanHtml ----------

function planPage() {
  return `
  <table>
    <tr><th>序号</th><th>开课学期</th><th>课程编号</th><th>课程名称</th><th>开课单位</th>
        <th>学分</th><th>总学时</th><th>考核方式</th><th>课程性质</th><th>是否考试</th><th>课程大纲</th></tr>
    <tr><td>1</td><td>2024-2025-1</td><td>00200001</td><td>人工智能概论</td><td>教务处</td>
        <td>2</td><td>32</td><td>考查</td><td>通识必修课</td><td>是</td><td><a href="#">查看</a></td></tr>
    <tr><td>2</td><td>2024-2025-2</td><td>11010001</td><td>微积分(一)</td><td>数学学院</td>
        <td>4</td><td>64</td><td>考试</td><td>学科基础课</td><td>是</td><td><a href="#">查看</a></td></tr>
  </table>`
}

test('parsePlanHtml：11 列执行计划按表头映射，空编号行跳过', () => {
  const html = planPage() + '<table><tr><td>正在拼命加载中...</td></tr></table>'
  const result = parsePlanHtml(html)
  assert.equal(result.total, 2)
  assert.deepEqual(result.courses[0], {
    term: '2024-2025-1',
    courseCode: '00200001',
    courseName: '人工智能概论',
    department: '教务处',
    credit: '2',
    hours: '32',
    examMethod: '考查',
    nature: '通识必修课',
    isExam: '是',
    syllabus: '查看',
  })
})

test('parsePlanHtml：登录页抛 isJwLoginExpired；无表抛 PARSE', () => {
  try {
    parsePlanHtml('<html>用户登录</html>')
    assert.fail('应抛错')
  } catch (err) {
    assert.equal(err.isJwLoginExpired, true)
  }
  assert.throws(() => parsePlanHtml('<table><tr><td>空</td></tr></table>'), (err) => err.code === 'PARSE')
})
