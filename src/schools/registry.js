/**
 * 学校适配器注册表。核心命令框架只依赖本文件暴露的接口，
 * 不 import 任何学校特有模块——新增学校 = 新增 schools/<id>/ 目录
 * 并在此注册（T3 验收 7：多学校扩展地基）。
 */
import { sdufeAdapter } from './sdufe/adapter.js'

const adapters = new Map([[sdufeAdapter.id, sdufeAdapter]])

/**
 * 适配器接口契约（核心框架只调用这些成员）：
 *   id, name, baseUrl
 *   login({ userId, password, recognizeCaptcha }, { maxRetries, onProgress })
 *     → { cookie, userInfo }
 *   probeSession(cookie) → userInfo（过期抛 err.isJwLoginExpired）
 *   fetchCurrentTerm(cookie) → string | null
 *   fetchSchedule(cookie, { term, week }) → { weeks, remark? }
 *   fetchScores(cookie, { term }) → rows[]
 */
export function getAdapter(schoolId) {
  const adapter = adapters.get(schoolId)
  if (!adapter) {
    throw new Error(
      `未知的学校适配器: ${schoolId}（当前支持: ${Array.from(adapters.keys()).join(', ')}）`
    )
  }
  return adapter
}

/** 注册适配器（新学校接入入口；测试也用它注入 fake 适配器） */
export function registerAdapter(adapter) {
  if (!adapter || !adapter.id) throw new Error('适配器缺少 id')
  adapters.set(adapter.id, adapter)
}

export function listAdapters() {
  return Array.from(adapters.values()).map((a) => ({ id: a.id, name: a.name, baseUrl: a.baseUrl }))
}
