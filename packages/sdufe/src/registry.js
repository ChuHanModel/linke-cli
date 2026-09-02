/**
 * 学校适配器注册表。核心命令框架只依赖本文件暴露的接口，
 * 不 import 任何学校特有模块——新增学校 = 新增包内 src/<id>/ 目录
 * 并在此注册（T3 验收 7：多学校扩展地基）。
 *
 * 适配器是环境注入产物（createSdufeAdapter(env)），因此注册表不预置
 * 实例：宿主启动时显式 initSdufe(env)（CLI 用 nodeEnv()，uni-app 用
 * uni.request 垫片 env）。getAdapter 在未初始化时给出明确指引。
 */
import { createSdufeAdapter } from './adapter.js'
import { nodeEnv } from './env.js'

const adapters = new Map()

/** 创建 sdufe 适配器（默认 nodeEnv）并注册；幂等（重复调用覆盖同 id） */
export function initSdufe(env = nodeEnv()) {
  const adapter = createSdufeAdapter(env)
  adapters.set(adapter.id, adapter)
  return adapter
}

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
      `适配器 ${schoolId} 未初始化或未知（当前已注册: ${Array.from(adapters.keys()).join(', ') || '无'}）。` +
        `宿主启动时需先 initSdufe(env)——Node 宿主可省参（默认 nodeEnv），uni-app 宿主需传 uni.request 垫片 env`
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
