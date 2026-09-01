/**
 * 山财正方教务（jsxsd）页面解析器。
 * 正则全部移植自现役实现，脱节时以仓库真实代码为准回灌：
 * - 课表：linke_PHP/Api/src/app/Model/UserSchedule.php getSchedule()
 *         + linke_App/utils/scheduleLoader.js（周循环抓取版）
 * - 成绩：linke_PHP/Api/src/app/Model/UserScore.php reloadUserScoreRows()
 * - 主页：linke_App/services/auth/jwLoginService.js parseUserData()
 * - 学期：linke_App/utils/scheduleLoader.js fetchScheduleTerm()
 */
import { stripSpaces, isJwLoginExpired } from '../../util.js'
import { parseError } from '../../errors.js'

/** 解析个人主页：姓名/单位/专业/班级（用于登录确认与 status 展示） */
export function parseUserData(html) {
  if (!html || typeof html !== 'string') {
    return { name: '', unit: '', discipline: '', class: '' }
  }
  const nameMatch = html.match(/<span class="blue f16 b">(.*?)<\/span>/)
  const name = nameMatch ? nameMatch[1] : ''
  const userMatches = html.matchAll(/middletopdwxxcont">(.*?)<\/div>/g)
  const userData = Array.from(userMatches).map((m) => m[1])
  if (userData.length < 3) {
    return { name: name || '', unit: '', discipline: '', class: '' }
  }
  return {
    name: name || '',
    unit: userData[0] || '',
    discipline: userData[1] || '',
    class: userData[2] || '',
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

/**
 * 解析成绩页 HTML → 行数组 [{ term, courseCode, courseName, scoreText, score, nature }]
 * 口径与 PHP reloadUserScoreRows 一致：数值成绩限 0-100 记入 score，
 * 等级制成绩保留 scoreText、score 为 null；无效占位文本丢弃。
 * courseName 取成绩行内紧邻成绩的列（现役页面为课程名，列序变化时可能为空，
 * 以 courseCode 为准）。
 */
export function parseScoresHtml(html) {
  if (isJwLoginExpired(html)) {
    const err = new Error('jw login expired')
    err.isJwLoginExpired = true
    throw err
  }
  const cleaned = stripSpaces(html)
  const rows = []
  const addRow = (term, courseCode, courseName, scoreText, nature) => {
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
      scoreText,
      score,
      nature: String(nature ?? '').trim(),
    })
  }

  // 变体一：行首带学期列（现役主口径，PHP matchesWithLeading）
  const withLeading = Array.from(
    cleaned.matchAll(
      /<tr><td>.*?<\/td><td>(.*?)<\/td><tdalign=.*?>(.*?)<\/td><tdalign=.*?>(.*?)<\/td><!--控制成绩显示--><tdstyle=.*?><ahref=.*?>(.*?)<\/a><\/td><\/td><td>.*?<\/td><!--控制绩点显示--><td>.*?<\/td><td>.*?<\/td><td>(.*?)<\/td><td>.*?<\/td><td>.*?<\/td><\/tr>/g
    )
  )
  for (const m of withLeading) {
    const col1 = m[1] ?? ''
    const col2 = m[2] ?? ''
    if (TERM_RE.test(col1)) {
      addRow(col1, col2, m[3], m[4], m[5])
    } else if (TERM_RE.test(col2)) {
      addRow(col2, col1, m[3], m[4], m[5])
    }
  }

  // 变体二：legacy 无前导学期列（PHP matchesLegacy，仅在变体一整页零命中时启用）
  if (rows.length === 0) {
    const legacy = Array.from(
      cleaned.matchAll(
        /<tdalign=.*?>(.*?)<\/td><tdalign=.*?>(.*?)<\/td><!--控制成绩显示--><tdstyle=.*?><ahref=.*?>(.*?)<\/a><\/td><\/td><td>.*?<\/td><!--控制绩点显示--><td>.*?<\/td><td>.*?<\/td><td>(.*?)<\/td><td>.*?<\/td><td>.*?<\/td>/g
      )
    )
    for (const m of legacy) {
      addRow(m[2], m[1], '', m[3], m[4])
    }
  }

  if (rows.length === 0) {
    throw parseError('成绩（整页未命中任何成绩行）')
  }
  return rows
}
