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

/** 在整页里按表头特征找表（返回 { headers, rows } 或 null） */
function findTableByHeaders(html, mustInclude) {
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
