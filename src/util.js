/**
 * CLI 输出辅助：stderr 进度、stdout JSON（agent 解析契约）。
 * 教务纯函数（stripSpaces/isJwLoginExpired/extractCookieHeader）已随
 * linke-sdufe 共享包走（T24 抽包），这里 re-export 保持既有 import 兼容。
 */
export { stripSpaces, isJwLoginExpired, extractCookieHeader } from 'linke-sdufe'

/** 进度信息走 stderr，保证 stdout 只有结构化 JSON（agent 解析契约） */
export function progress(msg) {
  process.stderr.write(`[linke] ${msg}\n`)
}

/** stdout 输出 JSON 结果 */
export function emitJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n')
}
