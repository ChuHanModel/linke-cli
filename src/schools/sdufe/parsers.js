/**
 * 山财强智教务（Kingosoft）页面解析器。
 * 正则全部移植自现役实现，脱节时以仓库真实代码为准回灌：
 * - 课表：linke_PHP/Api/src/app/Model/UserSchedule.php getSchedule()
 *         + linke_App/utils/scheduleLoader.js（周循环抓取版）
 * - 成绩：linke_PHP/Api/src/app/Model/UserScore.php reloadUserScoreRows()
 * - 主页：linke_App/services/auth/jwLoginService.js parseUserData()
 * - 学期：linke_App/utils/scheduleLoader.js fetchScheduleTerm()
 */
import { stripSpaces, isJwLoginExpired } from '../../util.js'
import { parseError } from '../../errors.js'

/** 解析个人主页：姓名/单位/专业/班级 + 当前教学周（用于登录确认与 status/成功页展示） */
export function parseUserData(html) {
  if (!html || typeof html !== 'string') {
    return { name: '', unit: '', discipline: '', class: '', week: null }
  }
  const nameMatch = html.match(/<span class="blue f16 b">(.*?)<\/span>/)
  const name = nameMatch ? nameMatch[1] : ''
  const userMatches = html.matchAll(/middletopdwxxcont">(.*?)<\/div>/g)
  const userData = Array.from(userMatches).map((m) => m[1])
  // 周次（教务主页 xsMain_new.jsp 口径，交互文档 1.6）
  const weekMatch = html.match(/<span class="main_text main_color">第(.*?)周<\/span>\/(.*?)周/)
  const week = weekMatch ? { now: weekMatch[1] || '', all: weekMatch[2] || '' } : null
  if (userData.length < 3) {
    return { name: name || '', unit: '', discipline: '', class: '', week }
  }
  return {
    name: name || '',
    unit: userData[0] || '',
    discipline: userData[1] || '',
    class: userData[2] || '',
    week,
  }
}

/** 主页 HTML 是否具备已登录特征（防"假登录成功"，1.0.6/1.0.8 修复口径） */
export function hasAuthenticatedProfileMarkers(html, userInfo) {
  if (typeof html !== 'string') return false
  if (html.indexOf('middletopdwxxcont') !== -1) return true
  if (html.indexOf('blue f16 b') !== -1) return true
  if (html.indexOf('main_text main_color') !== -1) return true
  return !!(userInfo && (userInfo.name || userInfo.unit || userInfo.discipline || userInfo.class))
}

/** 从课表页 select 中解析当前学期（形如 2025-2026-1），失败返回 null */
export function parseCurrentTerm(html) {
  if (!html || typeof html !== 'string') return null
  const optionRegex = /<option\s+value="(\d{4}-\d{4}-\d)"(?:\s+selected="selected")?>(.*?)<\/option>/g
  const matches = Array.from(html.matchAll(optionRegex))
  if (matches.length === 0) return null
  for (const match of matches) {
    if (match[0].includes('selected="selected"')) return match[1]
  }
  return matches[0][1]
}

/**
 * 解析课表页 HTML → { weeks: [[cell x7] xN], remark?: string[] }
 * 单元格 { course, teacher, time, location }；空格为全空字段。
 */
export function parseScheduleHtml(html) {
  if (isJwLoginExpired(html)) {
    const err = new Error('jw login expired')
    err.isJwLoginExpired = true
    throw err
  }
  const cells = Array.from(html.matchAll(/kbcontent"\s?>(.*?)<\/div>/g)).map((m) => m[1])
  if (cells.length < 35) {
    throw parseError('课表（课程格不足 35，页面可能未正常返回）')
  }
  const parsed = cells.map((cell) => {
    if (cell === '&nbsp;') return { course: '', teacher: '', time: '', location: '' }
    const courseMatch = cell.match(/(.*?)<font title='老师'>/)
    const teacherMatch = cell.match(/<font title='老师'>(.*?)<\/font>/)
    const timeMatch = cell.match(/<font title='周次.*?'>(.*?)<\/font>/)
    const locationMatch = cell.match(/<font title='教室'>(.*?)<\/font>/)
    return {
      course: courseMatch ? courseMatch[1] : '',
      teacher: teacherMatch ? teacherMatch[1] : '',
      time: timeMatch ? timeMatch[1] : '',
      location: locationMatch ? locationMatch[1] : '',
    }
  })
  const remarks = Array.from(
    html.matchAll(/<\/th>.?<td.?colspan="7".?align="left">(.*?)<\/td>/g)
  ).map((m) => m[1])
  const weeks = []
  for (let i = 0; i < parsed.length; i += 7) {
    weeks.push(parsed.slice(i, i + 7))
  }
  const result = { weeks }
  if (remarks.length > 0) result.remark = remarks
  return result
}

const INVALID_SCORE_TEXTS = new Set(['-', '--', '---', '—', '暂无', '暂未录入', '未录入', '未公布', '无'])
const TERM_RE = /^\d{4}-\d{4}-\d$/

/** 单元格清洗：剥标签、&nbsp; 转空格、实体解码、收紧空白 */
function cleanCell(raw) {
  return String(raw ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/[\u00a0\u3000]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 按 th 表头解析一张 HTML 表 → { headers, rows }。
 * rows 为与表头等长的字符串数组（缺失列补空串，多余列丢弃），
 * 列序以 th 顺序为准——教务加列/换列位时解析仍对位。
 */
function parseTableByHeader(tableHtml) {
  const headers = Array.from(tableHtml.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi))
    .map((m) => cleanCell(m[1]))
  const rows = []
  for (const m of tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const tr = m[1]
    if (/<th\b/i.test(tr)) continue // 表头行
    const cells = Array.from(tr.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)).map((c) => cleanCell(c[1]))
    if (cells.length === 0) continue
    rows.push(headers.map((_, i) => cells[i] ?? ''))
  }
  return { headers, rows }
}

/** 在整页里按表头特征找表（返回 { headers, rows } 或 null）；导出供测试 */
export function findTableByHeaders(html, mustInclude) {
  for (const m of html.matchAll(/<table\b[\s\S]*?<\/table>/gi)) {
    const parsed = parseTableByHeader(m[0])
    if (parsed.headers.length === 0) continue
    if (mustInclude.every((h) => parsed.headers.some((x) => x.includes(h)))) {
      return parsed
    }
  }
  return null
}

/**
 * 解析成绩页 HTML → 行数组 [{ term, courseCode, courseName, credit, scoreText, score, nature }]
 * 口径与 PHP reloadUserScoreRows 一致：数值成绩限 0-100 记入 score，
 * 等级制成绩保留 scoreText、score 为 null；无效占位文本丢弃。
 * T10：补捕获学分列（真实页列序 序号/学期/编号/名称/成绩/学分/绩点/
 * 考试性质/课程性质/课程属性/辅修——学分紧跟成绩双闭合单元格后）。
 */
export function parseScoresHtml(html) {
  if (isJwLoginExpired(html)) {
    const err = new Error('jw login expired')
    err.isJwLoginExpired = true
    throw err
  }
  const cleaned = stripSpaces(html)
  const rows = []
  const addRow = (term, courseCode, courseName, credit, scoreText, nature) => {
    term = String(term ?? '').trim()
    courseCode = String(courseCode ?? '').trim()
    scoreText = String(scoreText ?? '').trim()
    if (!TERM_RE.test(term) || courseCode === '' || scoreText === '') return
    if (INVALID_SCORE_TEXTS.has(scoreText)) return
    let score = null
    if (/^\d+(\.\d+)?$/.test(scoreText)) {
      const numeric = Number(scoreText)
      if (numeric < 0 || numeric > 100) return
      score = Math.trunc(numeric)
    }
    rows.push({
      term,
      courseCode,
      courseName: String(courseName ?? '').trim(),
      credit: String(credit ?? '').trim(),
      scoreText,
      score,
      nature: String(nature ?? '').trim(),
    })
  }

  // 变体一：行首带序号列，第二列学期（现役主口径，PHP matchesWithLeading）
  const withLeading = Array.from(
    cleaned.matchAll(
      /<tr><td>.*?<\/td><td>(.*?)<\/td><tdalign=.*?>(.*?)<\/td><tdalign=.*?>(.*?)<\/td><!--控制成绩显示--><tdstyle=.*?><ahref=.*?>(.*?)<\/a><\/td><\/td><td>(.*?)<\/td><!--控制绩点显示--><td>.*?<\/td><td>.*?<\/td><td>(.*?)<\/td><td>.*?<\/td><td>.*?<\/td><\/tr>/g
    )
  )
  for (const m of withLeading) {
    const col1 = m[1] ?? ''
    const col2 = m[2] ?? ''
    if (TERM_RE.test(col1)) {
      addRow(col1, col2, m[3], m[5], m[4], m[6])
    } else if (TERM_RE.test(col2)) {
      addRow(col2, col1, m[3], m[5], m[4], m[6])
    }
  }

  // 变体二：legacy 无前导学期列（PHP matchesLegacy，仅在变体一整页零命中时启用）
  if (rows.length === 0) {
    const legacy = Array.from(
      cleaned.matchAll(
        /<tdalign=.*?>(.*?)<\/td><tdalign=.*?>(.*?)<\/td><!--控制成绩显示--><tdstyle=.*?><ahref=.*?>(.*?)<\/a><\/td><\/td><td>(.*?)<\/td><!--控制绩点显示--><td>.*?<\/td><td>.*?<\/td><td>(.*?)<\/td><td>.*?<\/td><td>.*?<\/td>/g
      )
    )
    for (const m of legacy) {
      addRow(m[2], m[1], '', m[4], m[3], m[5])
    }
  }

  if (rows.length === 0) {
    throw parseError('成绩（整页未命中任何成绩行）')
  }
  return rows
}

/**
 * 解析学分修读页（/jsxsd/xxwcqk/xstxkxdqk.do，GET 直出）。
 * 真实结构双表：
 *   汇总表 th=类别/要求学分（大于等于）/已修学分/正在修读
 *   明细表 th=课程编号/课程名称/学分/总成绩/通选课类别
 * → { categories: [{category, required, earned, inProgress}],
 *     courses: [{courseCode, courseName, credit, score, type}] }
 */
export function parseCreditsHtml(html) {
  if (isJwLoginExpired(html)) {
    const err = new Error('jw login expired')
    err.isJwLoginExpired = true
    throw err
  }
  const summary = findTableByHeaders(html, ['类别', '要求学分'])
  const detail = findTableByHeaders(html, ['课程编号', '总成绩'])
  if (!summary && !detail) {
    throw parseError('学分修读（未找到类别统计表或课程明细表）')
  }
  const categories = []
  if (summary) {
    const col = (h) => summary.headers.findIndex((x) => x.includes(h))
    const iCat = col('类别')
    const iReq = col('要求学分')
    const iEarn = col('已修学分')
    const iProg = col('正在修读')
    for (const row of summary.rows) {
      const category = row[iCat] ?? ''
      if (!category) continue
      categories.push({
        category,
        required: row[iReq] ?? '',
        earned: row[iEarn] ?? '',
        inProgress: row[iProg] ?? '',
      })
    }
  }
  const courses = []
  if (detail) {
    const col = (h) => detail.headers.findIndex((x) => x.includes(h))
    const iCode = col('课程编号')
    const iName = col('课程名称')
    const iCredit = col('学分')
    const iScore = col('总成绩')
    const iType = col('通选课类别')
    for (const row of detail.rows) {
      const courseCode = row[iCode] ?? ''
      if (!courseCode) continue
      courses.push({
        courseCode,
        courseName: row[iName] ?? '',
        credit: row[iCredit] ?? '',
        score: row[iScore] ?? '',
        type: iType >= 0 ? row[iType] ?? '' : '',
      })
    }
  }
  return { categories, courses }
}

/** kbxx_kc_ifr 课程网格表头 → 输出字段名（按表头名映射，列序变化不受影响） */
const COURSE_GRID_FIELDS = [
  ['校区', 'campus'],
  ['上课学院', 'department'],
  ['上课班级', 'className'],
  ['课程编号', 'courseCode'],
  ['课程名称', 'courseName'],
  ['上课周次', 'weeks'],
  ['上课时间', 'time'],
  ['上课地点', 'location'],
  ['授课教师', 'teacher'],
  ['教工号', 'teacherCode'],
  ['课程性质', 'nature'],
  ['学分', 'credit'],
  ['上课人数', 'capacity'],
]

/**
 * 解析课程课表查询网格（POST /jsxsd/kbcx/kbxx_kc_ifr）。
 * 真实结构单表 13 列（表头见 COURSE_GRID_FIELDS），579+ 数据行整齐 13 td，
 * 单元格 &nbsp; 包裹；另存在整行空行。
 * → { total, courses: [{campus, department, className, courseCode,
 *     courseName, weeks, time, location, teacher, teacherCode,
 *     nature, credit, capacity?}] }（capacity 仅在页面含该列时输出）
 */
export function parseCoursesHtml(html) {
  if (isJwLoginExpired(html)) {
    const err = new Error('jw login expired')
    err.isJwLoginExpired = true
    throw err
  }
  const table = findTableByHeaders(html, ['课程编号', '课程名称', '授课教师'])
  if (!table) {
    throw parseError('课程课表（未找到课程数据网格）')
  }
  const colMap = []
  for (const [headerName, field] of COURSE_GRID_FIELDS) {
    const idx = table.headers.findIndex((x) => x.includes(headerName))
    if (idx >= 0) colMap.push([idx, field])
  }
  const courses = []
  for (const row of table.rows) {
    const item = {}
    let courseCode = ''
    for (const [idx, field] of colMap) {
      const value = row[idx] ?? ''
      item[field] = value
      if (field === 'courseCode') courseCode = value
    }
    if (!courseCode) continue // 空行/表头重复行
    courses.push(item)
  }
  return { total: courses.length, courses }
}

/**
 * 解析平均学分绩点页（/jsxsd/kscj/cjcx_avg，GET 直出）。
 * 真实结构单表 10 列：学号/姓名/专业名称/班级名称/培养层次/所修总学分/
 * 课程门数/平均分/平均学分绩/平均学分绩点；一行主修 + N 行辅修
 * （辅修行以专业名称含「(辅修)」判定，行序不保证主修在前）。
 * → { rows: [{ studentId, name, major, className, level, totalCredits,
 *     courseCount, averageScore, averageGrade, gpa, majorType }] }
 */
export function parseGpaHtml(html) {
  if (isJwLoginExpired(html)) {
    const err = new Error('jw login expired')
    err.isJwLoginExpired = true
    throw err
  }
  const table = findTableByHeaders(html, ['学号', '平均学分绩点'])
  if (!table) {
    throw parseError('平均学分绩点（未找到数据表）')
  }
  const col = (h) => table.headers.findIndex((x) => x.includes(h))
  const idx = {
    studentId: col('学号'),
    name: col('姓名'),
    major: col('专业名称'),
    className: col('班级名称'),
    level: col('培养层次'),
    totalCredits: col('所修总学分'),
    courseCount: col('课程门数'),
    averageScore: col('平均分'),
    averageGrade: col('平均学分绩'),
    gpa: col('平均学分绩点'),
  }
  const rows = []
  for (const row of table.rows) {
    const item = {}
    for (const [key, i] of Object.entries(idx)) {
      item[key] = i >= 0 ? row[i] ?? '' : ''
    }
    if (!item.name && !item.major) continue
    item.majorType = /（辅修）|\(辅修\)/.test(item.major) ? '辅修' : '主修'
    rows.push(item)
  }
  if (rows.length === 0) {
    throw parseError('平均学分绩点（数据表零行）')
  }
  return { rows }
}

/**
 * 解析学籍卡片页（/jsxsd/grxx/xsxx，GET 直出，不规则标签值网格）。
 *
 * 敏感裁剪口径（T12 决策，devlog 在案）：默认只输出核心学籍字段
 * （院系/专业/学制/班级/学号/层次/年级）；--full 额外输出白名单内的
 * 非敏感学籍字段。身份证编号/出生日期/电话/考号/证书号/家庭住址/
 * 家庭成员等强敏感字段不进入任何输出（查询 CLI 的必要范围之外，
 * 避免身份信息流入 agent 上下文与终端日志）。
 *
 * → { studentId, department, major, duration, className, level, grade,
 *     extra?: {[label]: value} }
 */
const XJ_EXTRA_WHITELIST = new Set([
  '性别', '民族', '政治面貌', '学习形式', '学习层次', '外语种类',
  '专业方向', '姓名拼音', '入学日期', '毕业日期', '入党团时间', '籍贯',
])
const XJ_SENSITIVE_RE = /身份证|出生|电话|手机|考号|证书|住址|邮政|联系人|家庭成员|火车站|婚否/

export function parseXjHtml(html, { full = false } = {}) {
  if (isJwLoginExpired(html)) {
    const err = new Error('jw login expired')
    err.isJwLoginExpired = true
    throw err
  }
  // 收集全部单元格文本（保留空串——空值是模式 B 的值占位，
  // 跳过会让「外语种类」（空）误吸下一个标签格的文本）
  const texts = []
  for (const m of html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)) {
    texts.push(cleanCell(m[1]))
  }
  const fields = {}
  // 模式 A：一格内「标签：值」连写（真实页：院系：… /专业：… /学制：… /班级：… /学号：…）
  for (const text of texts) {
    if (!text) continue
    const m = text.match(/^([^：:]{2,8})[：:](.+)$/)
    if (m && !text.includes(' ')) {
      fields[m[1].trim()] = m[2].trim()
    }
  }
  // 模式 B：白名单标签独立成格，值在相邻格（相邻格是另一个标签 → 值为空）
  const LABEL_VALUE_RE = /^[^：:]{2,8}[：:].+$/
  for (let i = 0; i < texts.length; i++) {
    const label = texts[i]
    if (!XJ_EXTRA_WHITELIST.has(label) || label in fields) continue
    const next = texts[i + 1] ?? ''
    if (XJ_EXTRA_WHITELIST.has(next) || LABEL_VALUE_RE.test(next)) continue
    fields[label] = next
  }
  const studentId = fields['学号'] || ''
  if (!studentId) {
    throw parseError('学籍卡片（未找到学号字段）')
  }
  const className = fields['班级'] || ''
  const gradeMatch = className.match(/(20\d{2})/)
  const result = {
    studentId,
    department: fields['院系'] || '',
    major: fields['专业'] || '',
    duration: fields['学制'] || '',
    className,
    level: fields['学习层次'] || '',
    grade: gradeMatch ? gradeMatch[1] : '',
  }
  if (full) {
    const coreKeys = new Set(['学号', '院系', '专业', '学制', '班级', '学习层次'])
    result.extra = {}
    for (const [label, value] of Object.entries(fields)) {
      if (coreKeys.has(label)) continue
      if (XJ_SENSITIVE_RE.test(label)) continue // 强敏感：--full 也不出
      if (XJ_EXTRA_WHITELIST.has(label) || value.length <= 20) {
        result.extra[label] = value
      }
    }
  }
  return result
}

/**
 * 解析培养执行计划页（/jsxsd/pyfa/pyfa_query，GET 直出）。
 * 真实结构单表 11 列：序号/开课学期/课程编号/课程名称/开课单位/学分/
 * 总学时/考核方式/课程性质/是否考试/课程大纲。
 * → { total, courses: [{ term, courseCode, courseName, department,
 *     credit, hours, examMethod, nature, isExam, syllabus }] }
 */
export function parsePlanHtml(html) {
  if (isJwLoginExpired(html)) {
    const err = new Error('jw login expired')
    err.isJwLoginExpired = true
    throw err
  }
  const table = findTableByHeaders(html, ['课程编号', '课程名称', '开课学期'])
  if (!table) {
    throw parseError('执行计划（未找到课程数据表）')
  }
  const col = (h) => table.headers.findIndex((x) => x.includes(h))
  const idx = {
    term: col('开课学期'),
    courseCode: col('课程编号'),
    courseName: col('课程名称'),
    department: col('开课单位'),
    credit: col('学分'),
    hours: col('总学时'),
    examMethod: col('考核方式'),
    nature: col('课程性质'),
    isExam: col('是否考试'),
    syllabus: col('课程大纲'),
  }
  const courses = []
  for (const row of table.rows) {
    const item = {}
    for (const [key, i] of Object.entries(idx)) {
      item[key] = i >= 0 ? row[i] ?? '' : ''
    }
    if (!item.courseCode) continue
    courses.push(item)
  }
  return { total: courses.length, courses }
}

/**
 * 培养方案明细（/jsxsd/pyfa/topyfamx，GET 直出 75KB）。
 *
 * 页面怪癖（真实页实锤）：TH 开标签用 </TD> 闭合（畸形标记），
 * 配对正则全部失效——专用流式 tokenizer（按 <tr/<td 开标签切分，
 * 不依赖闭合配对）；课程表两层表头（「学时分类」分组头+6 子头）；
 * 体系列 rowspan 合并（首行 13 格、续行 12 格）；总学时列含
 * 「17 -->」尾缀；小计/合计行混在数据流中。
 *
 * → { objectives, courses: [{ system, group, courseCode, courseName,
 *     category, credit, hours: { lecture, practice, seminar, lab,
 *     computer, total }, term }] }
 */
export function parsePyfaHtml(html) {
  if (isJwLoginExpired(html)) {
    const err = new Error('jw login expired')
    err.isJwLoginExpired = true
    throw err
  }
  const clean = (s) =>
    String(s ?? '')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/g, '&')
      .replace(/[\u00a0\u3000]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()

  // 培养目标段（「一、培养目标」到「二、」之前）
  const plain = clean(html)
  let objectives = ''
  const objMatch = plain.match(/一、培养目标([\s\S]*?)(?=二、|$)/)
  if (objMatch) objectives = objMatch[1].trim().slice(0, 2000)

  // 流式切行
  const rows = []
  const rowRe = /<tr\b[^>]*>([\s\S]*?)(?=<tr\b|<\/table)/gi
  let m
  while ((m = rowRe.exec(html))) rows.push(m[1])
  // 找表头行（体系+课号 同行）
  const headerIdx = rows.findIndex(
    (r) => /体系/.test(clean(r)) && /课号/.test(clean(r))
  )
  if (headerIdx === -1) {
    throw parseError('培养方案明细（未找到课程设置总表表头）')
  }
  const cellsOf = (rowHtml) => {
    const cells = []
    const cellRe = /<t[hd]\b[^>]*>([\s\S]*?)(?=<t[hd]\b|<tr\b|<\/table|$)/gi
    let c
    while ((c = cellRe.exec(rowHtml))) {
      const text = clean(c[1])
      cells.push(text)
    }
    return cells
  }

  const courses = []
  let lastSystem = ''
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const cells = cellsOf(rows[i])
    if (cells.length === 0) continue
    // 两层表头的子头行（讲课/实践/讲座…）与汇总行跳过
    const joined = cells.join(' ')
    if (/^(讲课学时|实践学时)/.test(cells[0]) || cells[0] === '') {
      if (cells[0] === '' && cells.length < 10) continue
    }
    if (/^(小计|合计)/.test(cells[0])) continue
    // 数据行：12 格（体系沿用上一行）或 13 格（首列=体系）
    if (cells.length === 13) {
      lastSystem = cells[0] || lastSystem
      cells.shift() // 统一成 12 格处理
    } else if (cells.length !== 12) {
      continue
    }
    const [group, courseCode, courseName, category, credit, lecture, practice, seminar, lab, computer, totalRaw, term] = cells
    if (!/^\d{6,8}$/.test(courseCode)) continue // 非课程行（说明文字等）
    courses.push({
      system: lastSystem,
      group,
      courseCode,
      courseName,
      category,
      credit,
      hours: {
        lecture,
        practice,
        seminar,
        lab,
        computer,
        total: totalRaw.replace(/-->\s*$/, '').trim(),
      },
      term,
    })
  }
  if (courses.length === 0) {
    throw parseError('培养方案明细（课程总表零行）')
  }
  return { objectives, courses }
}

/**
 * 考试安排（POST /jsxsd/xsks/xsksap_list——真实端点由表单页 JS
 * queryKsap() 改写 action 而来，直 POST xsksap_query 只回表单页）。
 * 参数：xnxqid 学期 / xqlb 类别码(1 期初 2 期中 3 期末，空=全部) /
 * xqlbmc 类别名文本（JS 会在提交前填入选中项文本，重放须带上）。
 * 真实结构 9 列：序号/考试场次/课程编号/课程名称/考试时间/考场/
 * 座位号/准考证号/操作。考试未发布时整页仅「未查询到数据」。
 * → { exams: [{ session, courseCode, courseName, time, location,
 *     seat, admissionTicket }] }（无数据返回空数组，不抛错）
 */
export function parseExamsHtml(html) {
  if (isJwLoginExpired(html)) {
    const err = new Error('jw login expired')
    err.isJwLoginExpired = true
    throw err
  }
  if (html.includes('未查询到数据')) {
    return { exams: [] }
  }
  const table = findTableByHeaders(html, ['课程名称', '考试时间', '考场'])
  if (!table) {
    throw parseError('考试安排（未找到数据表且非空结果页）')
  }
  const col = (h) => table.headers.findIndex((x) => x.includes(h))
  const idx = {
    session: col('考试场次'),
    courseCode: col('课程编号'),
    courseName: col('课程名称'),
    time: col('考试时间'),
    location: col('考场'),
    seat: col('座位号'),
    admissionTicket: col('准考证号'),
  }
  const exams = []
  for (const row of table.rows) {
    const item = {}
    for (const [key, i] of Object.entries(idx)) {
      item[key] = i >= 0 ? row[i] ?? '' : ''
    }
    if (!item.courseName && !item.courseCode) continue
    exams.push(item)
  }
  return { exams }
}

/**
 * 完成情况方案入口页（GET /jsxsd/xxwcqk/xxwcqk_idxOnxz.do——真实
 * 菜单 URL 带 xxwcqk_ 前缀；全菜单树文档的 xstxkxdqk_ 前缀为误记）。
 * 页面形态：每个修读方案一个独立 form，POST /jsxsd/xxwcqk/xxwcqkOnkcxz.do，
 * 主修带隐藏码 ndzydm（专业代码）、辅修带 fxzydm（辅修专业代码），
 * 另有恒空 jx0301zxjhid；「查看完成情况」按钮即提交该 form。
 * → { plans: [{ type: '主修'|'辅修', name, code, codeField }] }
 */
export function parseProgressPlansHtml(html) {
  // 非法访问错误页（725B 无 table）会被登录过期判据误吞，先判
  if (typeof html === 'string' && html.includes('非法访问')) {
    throw parseError('完成情况方案入口（教务返回非法访问）')
  }
  if (isJwLoginExpired(html)) {
    const err = new Error('jw login expired')
    err.isJwLoginExpired = true
    throw err
  }
  const plans = []
  for (const m of html.matchAll(/<form\b[^>]*xxwcqkOnkcxz\.do[^>]*>([\s\S]*?)<\/form>/gi)) {
    const form = m[1]
    const codeField = /name="ndzydm"/i.test(form) ? 'ndzydm' : /name="fxzydm"/i.test(form) ? 'fxzydm' : ''
    if (!codeField) continue
    const code = (form.match(new RegExp(`name="${codeField}"[^>]*value="([^"]*)"`, 'i')) || [])[1] || ''
    const visible = cleanCell(form)
    // 方案名：form 可见文本去掉「修读方案：」与按钮文字
    const name = visible.replace(/修读方案[：:]?/, '').replace(/查看完成情况.*/, '').trim()
    if (!code) continue
    plans.push({ type: codeField === 'ndzydm' ? '主修' : '辅修', name, code, codeField })
  }
  if (plans.length === 0) {
    throw parseError('完成情况方案入口（未找到修读方案表单）')
  }
  return { plans }
}

/**
 * 完成情况数据页（POST xxwcqkOnkcxz.do 返回）。双表：
 *   汇总表 th=课程性质/要求学分/已修学分/正修读学分/还需学分
 *   明细表 th=课程编号/课程名称/学分/课程类别/课程性质/修读情况
 * → { summary: [{ nature, required, earned, inProgress, remaining }],
 *     courses: [{ courseCode, courseName, credit, category, nature, status }] }
 */
export function parseProgressDetailHtml(html) {
  if (isJwLoginExpired(html)) {
    const err = new Error('jw login expired')
    err.isJwLoginExpired = true
    throw err
  }
  const summaryTable = findTableByHeaders(html, ['课程性质', '要求学分', '还需学分'])
  const courseTable = findTableByHeaders(html, ['课程编号', '修读情况'])
  if (!summaryTable && !courseTable) {
    throw parseError('完成情况数据页（未找到汇总/明细表）')
  }
  const summary = []
  if (summaryTable) {
    for (const row of summaryTable.rows) {
      if (!row[0]) continue
      summary.push({ nature: row[0], required: row[1] ?? '', earned: row[2] ?? '', inProgress: row[3] ?? '', remaining: row[4] ?? '' })
    }
  }
  const courses = []
  if (courseTable) {
    for (const row of courseTable.rows) {
      if (!/^\d{5,8}$/.test(row[0] ?? '')) continue // 跳过分组标题行（如「必修」）
      courses.push({
        courseCode: row[0],
        courseName: row[1] ?? '',
        credit: row[2] ?? '',
        category: row[3] ?? '',
        nature: row[4] ?? '',
        status: row[5] ?? '',
      })
    }
  }
  return { summary, courses }
}

/**
 * T13 通用简表解析：整页第一张含 th 的数据表 → { headers, rows }。
 * rows 为字符串数组（与表头等长：短行补空、超长截断），表头保留
 * 原文（中文自说明，重复表头如 levels 的双「笔试/机试/总成绩」
 * 原样保留，按列位对应）。教务改版加列/换列序时输出仍自洽。
 * @param {object} options
 * @param {string} options.emptyText 空数据页特征文本（默认「未查询到数据」）
 * @param {boolean} options.dropFirst 数据行首列丢弃（changes 的「+」展开图标列）
 */
export function parseSimpleTable(html, { emptyText = '未查询到数据', dropFirst = false, tableIndex = 0 } = {}) {
  if (typeof html === 'string' && html.includes('非法访问')) {
    throw parseError('教务返回非法访问（接口未开放或入口受限）')
  }
  // 加载中壳页（如导师页）短小无表，会被登录过期判据误吞——先判
  if (
    typeof html === 'string' &&
    html.includes('正在拼命加载中') &&
    !/<th\b/i.test(html)
  ) {
    return { headers: [], rows: [] }
  }
  if (isJwLoginExpired(html)) {
    const err = new Error('jw login expired')
    err.isJwLoginExpired = true
    throw err
  }
  // 全页含 th 的表按序取第 tableIndex 张；dropFirst 须在截齐前生效，
  // 故自行展开 cells（parseTableByHeader 的 rows 已按表头截齐）
  const candidates = []
  for (const m of html.matchAll(/<table\b[\s\S]*?<\/table>/gi)) {
    const headers = Array.from(m[0].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi))
      .map((h) => cleanCell(h[1]))
    if (headers.length === 0) continue
    const rows = []
    for (const r of m[0].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      if (/<th\b/i.test(r[1])) continue
      let cells = Array.from(r[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)).map((c) => cleanCell(c[1]))
      if (cells.length === 0) continue
      if (dropFirst) cells = cells.slice(1)
      rows.push(headers.map((_, i) => cells[i] ?? ''))
    }
    candidates.push({ headers, rows })
  }
  const table = candidates[tableIndex] || null
  if (!table || table.headers.length === 0) {
    throw parseError('简表（未找到数据表）')
  }
  if (html.includes(emptyText)) {
    return { headers: table.headers, rows: [] }
  }
  return { headers: table.headers, rows: table.rows }
}

/**
 * jwc.sdufe.edu.cn 通知公告列表解析（T17 双源之公开源）。
 * 页面真实形态（zxdt/tzgg.htm）：相对链接
 *   <a href="../info/1043/5965.htm" target="_blank">标题</a>
 * 日期在 </a> 后约 120 字符窗口内（PHP Domain/JwNotice.php 备选
 * 模式同源）；URL 转 https://jwc.sdufe.edu.cn/info/… 绝对地址。
 * → [{ title, url, date }]
 */
export function parseJwcNotices(html, baseUrl = 'https://jwc.sdufe.edu.cn') {
  const list = []
  const linkRe = /<a\s+href="([^"]*\/info\/\d+\/\d+\.htm)"[^>]*>([^<]+)<\/a>/g
  let m
  while ((m = linkRe.exec(html))) {
    let url = m[1]
    if (!/^https?:/i.test(url)) {
      // "../info/x" 相对于 "/zxdt/tzgg.htm" → "/info/x"
      url = baseUrl + '/' + url.replace(/^(\.\.\/)+/, '')
    }
    const after = html.slice(m.index + m[0].length, m.index + m[0].length + 120)
    const date = (after.match(/\d{4}-\d{2}-\d{2}/) || [])[0] || ''
    list.push({ title: m[2].trim(), url, date })
  }
  return list
}

/**
 * 补考报名页（bkbm_query）形态解析：非报名时间返回文案页
 * 「当前不在报名时间范围内或未启用报名！」；报名期返回数据表。
 * → { makeups: [...], note? }（空态带语义注记）
 */
export function parseMakeupsHtml(html) {
  if (typeof html === 'string' && html.includes('非法访问')) {
    throw parseError('补考报名（教务返回非法访问）')
  }
  // 业务空态文案先于登录过期判据（短页无表会被误吞，T13 判例）
  if (typeof html === 'string' && html.includes('不在报名时间范围')) {
    return { makeups: [], note: '当前不在补考报名时间内（报名期开放后可查）' }
  }
  if (isJwLoginExpired(html)) {
    const err = new Error('jw login expired')
    err.isJwLoginExpired = true
    throw err
  }
  // 报名期：按通用简表解析
  try {
    const table = parseSimpleTable(html)
    if (table.headers.length === 0) {
      return { makeups: [], note: '暂无补考记录' }
    }
    return { makeups: table.rows, headers: table.headers }
  } catch {
    return { makeups: [], note: '暂无补考记录' }
  }
}
