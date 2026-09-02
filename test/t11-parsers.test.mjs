/**
 * T11 解析器测试：pyfa（畸形标记流式解析+rowspan）/ exams（xsksap_list）/
 * progress（方案入口表单+数据页双表）——样例按真实页形态手工构造。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { parsers } from 'linke-sdufe'
const { parsePyfaHtml, parseExamsHtml, parseProgressPlansHtml, parseProgressDetailHtml } = parsers

// ---------- parsePyfaHtml ----------

/** 复刻真实页怪癖：TH 用 </TD> 闭合、体系列 rowspan、两层表头、小计行、总学时「-->」 */
function pyfaPage() {
  return `
  <table>
    <TR><TD>一、培养目标 培养德智体美全面发展的人才。</TD></TR>
    <TR><TD>三、课程设置总表</TD></TR>
    <TR>
      <TH align=center>体系</TH><TH align=center>选课组</TH><TH align=center>课号</TH>
      <TH align=center>课程名称</TH><TH align=center>类别</TH><TH align=center>学分</TH>
      <TH align=center>学时分类</TH><TH align=center>开设学期</TH>
    </TR>
    <TR><TH align=center>讲课学时</TH><TH align=center>实践学时</TH><TH align=center>讲座学时</TH>
      <TH align=center>实验学时</TH><TH align=center>上机学时</TH><TH align=center>总学时</TH></TR>
    <TR>
      <TD align="center" rowspan="2">实践选修课&nbsp;</TD><TD align="center">&nbsp;</TD>
      <TD align="center">19300602&nbsp;</TD><TD align="center">鉴定实践&nbsp;</TD>
      <TD align="center">实践选修&nbsp;</TD><TD align="center">1&nbsp;</TD>
      <TD align="center">17&nbsp;</TD><TD align="center">0&nbsp;</TD><TD align="center">0&nbsp;</TD>
      <TD align="center">0&nbsp;</TD><TD align="center">0&nbsp;</TD><TD align="center">17 --></TD>
      <TD align="center">6&nbsp;</TD>
    </TR>
    <TR>
      <TD align="center">&nbsp;</TD><TD align="center">19300742&nbsp;</TD>
      <TD align="center">行书临摹&nbsp;</TD><TD align="center">实践选修&nbsp;</TD>
      <TD align="center">2&nbsp;</TD><TD align="center">0&nbsp;</TD><TD align="center">34&nbsp;</TD>
      <TD align="center">0&nbsp;</TD><TD align="center">0&nbsp;</TD><TD align="center">0&nbsp;</TD>
      <TD align="center">34 --></TD><TD align="center">4&nbsp;</TD>
    </TR>
    <TR><TD>小计</TD><TD>3</TD><TD>17</TD><TD>51</TD></TR>
  </table>`
}

test('parsePyfaHtml：畸形标记流式解析 + rowspan 体系沿用 + 小计跳过', () => {
  const result = parsePyfaHtml(pyfaPage())
  assert.ok(result.objectives.includes('培养德智体美'))
  assert.equal(result.courses.length, 2)
  assert.deepEqual(result.courses[0], {
    system: '实践选修课',
    group: '',
    courseCode: '19300602',
    courseName: '鉴定实践',
    category: '实践选修',
    credit: '1',
    hours: { lecture: '17', practice: '0', seminar: '0', lab: '0', computer: '0', total: '17' },
    term: '6',
  })
  assert.equal(result.courses[1].system, '实践选修课', '续行体系应沿用上一行')
  assert.equal(result.courses[1].hours.total, '34', '总学时 --> 尾缀清洗')
})

test('parsePyfaHtml：登录页抛 isJwLoginExpired；无表头抛 PARSE', () => {
  try {
    parsePyfaHtml('<html>用户登录</html>')
    assert.fail('应抛错')
  } catch (err) {
    assert.equal(err.isJwLoginExpired, true)
  }
  assert.throws(() => parsePyfaHtml('<table><tr><td>无关</td></tr></table>'), (err) => err.code === 'PARSE')
})

// ---------- parseExamsHtml ----------

function examsEmptyPage() {
  return '<html><body><table><tr><th>序号</th><th>考试场次</th><th>课程编号</th><th>课程名称</th><th>考试时间</th><th>考场</th><th>座位号</th><th>准考证号</th><th>操作</th></tr></table>未查询到数据</body></html>'
}

function examsDataPage() {
  return `
  <table>
    <tr><th>序号</th><th>考试场次</th><th>课程编号</th><th>课程名称</th><th>考试时间</th><th>考场</th><th>座位号</th><th>准考证号</th><th>操作</th></tr>
    <tr><td>1</td><td>期末考试</td><td>19300742</td><td>行书临摹</td><td>2026-06-20 14:00~16:00</td><td>A101</td><td>12</td><td>24370112300216001</td><td><a href="#">注意事项</a></td></tr>
  </table>`
}

test('parseExamsHtml：未查询到数据返回空数组不抛错', () => {
  assert.deepEqual(parseExamsHtml(examsEmptyPage()), { exams: [] })
})

test('parseExamsHtml：9 列考试行按表头映射', () => {
  const result = parseExamsHtml(examsDataPage())
  assert.equal(result.exams.length, 1)
  assert.deepEqual(result.exams[0], {
    session: '期末考试',
    courseCode: '19300742',
    courseName: '行书临摹',
    time: '2026-06-20 14:00~16:00',
    location: 'A101',
    seat: '12',
    admissionTicket: '24370112300216001',
  })
})

// ---------- parseProgressPlansHtml ----------

function plansPage() {
  return `
  <div class="Nsb_layout_r title">学业完成情况查看</div>
  <table>
    <form action="/jsxsd/xxwcqk/xxwcqkOnkcxz.do" name="Form1" method="post">
      <tr><td>修读方案：</td><td>2024 美术学(艺术金融方向) </td><td>
        <input type="hidden" name="ndzydm" value="8FEB5E5EFD7F472BB02EBD970D5818AD"/>
        <input type="hidden" name="jx0301zxjhid" value=""/>
        <input type="submit" value="查看完成情况" class="button el-button"/></td></tr>
    </form>
    <form action="/jsxsd/xxwcqk/xxwcqkOnkcxz.do" name="Form1" method="post">
      <tr><td>修读方案：</td><td>2025 会计学(辅修)</td><td>
        <input type="hidden" name="fxzydm" value="068B93FC1DA04FEBA5224BB6CB3820C8"/>
        <input type="hidden" name="jx0301zxjhid" value=""/>
        <input type="submit" value="查看完成情况" class="button el-button"/></td></tr>
    </form>
  </table>`
}

test('parseProgressPlansHtml：主修/辅修方案与隐藏码抽取（双按钮机制口径）', () => {
  const { plans } = parseProgressPlansHtml(plansPage())
  assert.equal(plans.length, 2)
  assert.deepEqual(plans[0], {
    type: '主修',
    name: '2024 美术学(艺术金融方向)',
    code: '8FEB5E5EFD7F472BB02EBD970D5818AD',
    codeField: 'ndzydm',
  })
  assert.deepEqual(plans[1], {
    type: '辅修',
    name: '2025 会计学(辅修)',
    code: '068B93FC1DA04FEBA5224BB6CB3820C8',
    codeField: 'fxzydm',
  })
})

test('parseProgressPlansHtml：非法访问页抛 PARSE', () => {
  assert.throws(
    () => parseProgressPlansHtml('<html><h3>提示：非法访问！</h3></html>'),
    (err) => err.code === 'PARSE'
  )
})

// ---------- parseProgressDetailHtml ----------

function progressDetailPage() {
  return `
  <div class="Nsb_layout_r title">学业完成情况查看</div>
  <table>
    <tr><th>课程性质</th><th>要求学分</th><th>已修学分</th><th>正修读学分</th><th>还需学分</th></tr>
    <tr><td>必修</td><td>85.0</td><td>69.0</td><td>12.0</td><td>4.0</td></tr>
    <tr><td>实践必修</td><td>23.0</td><td>10.0</td><td>2.0</td><td>11.0</td></tr>
  </table>
  <table>
    <tr><th>课程编号</th><th>课程名称</th><th>学分</th><th>课程类别</th><th>课程性质</th><th>修读情况</th></tr>
    <tr><td>必修</td></tr>
    <tr><td>00200001</td><td>人工智能概论</td><td>2</td><td>通识必修课</td><td>必修</td><td>通过</td></tr>
    <tr><td>19300602</td><td>鉴定实践</td><td>1</td><td>实践选修课</td><td>实践必修</td><td>在读</td></tr>
  </table>`
}

test('parseProgressDetailHtml：汇总+明细双表，分组标题行跳过', () => {
  const result = parseProgressDetailHtml(progressDetailPage())
  assert.equal(result.summary.length, 2)
  assert.deepEqual(result.summary[0], { nature: '必修', required: '85.0', earned: '69.0', inProgress: '12.0', remaining: '4.0' })
  assert.equal(result.courses.length, 2)
  assert.equal(result.courses[0].status, '通过')
  assert.equal(result.courses[1].nature, '实践必修')
})
