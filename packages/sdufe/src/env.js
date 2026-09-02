/**
 * 运行环境能力注入（宿主适配层）。
 *
 * 适配器核心不直接触碰 Node 专有 API；宿主通过 env 提供四件能力：
 *
 *   env.fetch(url, { method, headers, body, redirect, timeoutMs, expect })
 *     → Promise<Response-like>
 *       Response-like: { status:number, ok:boolean,
 *                        headers:{ getSetCookie():string[] },
 *                        text():Promise<string>, arrayBuffer():Promise<ArrayBuffer> }
 *     expect='buffer' 表示适配器将调用 arrayBuffer()（uni.request 一次只能
 *     一种 responseType，垫片据此选择；标准 fetch 宿主可忽略 expect）。
 *     超时由 timeoutMs 表达（毫秒），宿主负责实现（Node 用 AbortSignal.timeout）。
 *     请求失败（网络层）应 reject——适配器统一转 networkError。
 *
 *   env.toBase64(bytes:Uint8Array) → string   验证码图片上行（云端识别入参）
 *   env.bytesToText(bytes:Uint8Array) → string 前 200 字节嗅探（判定教务返回
 *     了 HTML 错误页而非图片），宽松实现即可（ASCII 特征判定）
 *   env.progress(msg:string) → void           进度输出（Node 走 stderr；
 *     App 端注入 console/log 回调，缺省为 no-op）
 */

/** Node 宿主默认 env（Node >= 18.14：全局 fetch + getSetCookie）。全惰性，模块顶层零 Node 触碰 */
export function nodeEnv() {
  return {
    async fetch(url, { method, headers, body, redirect, timeoutMs } = {}) {
      return fetch(url, {
        method,
        redirect,
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs || 20000),
      })
    },
    toBase64(bytes) {
      return Buffer.from(bytes).toString('base64')
    },
    bytesToText(bytes) {
      return Buffer.from(bytes).toString('utf8')
    },
    progress(msg) {
      process.stderr.write(`[linke] ${msg}\n`)
    },
  }
}

const REQUIRED = ['fetch', 'toBase64', 'bytesToText']

/** 校验宿主 env 缺件（progress 可缺省，其余三件必须） */
export function validateEnv(env) {
  if (!env || typeof env !== 'object') {
    throw new Error('createSdufeAdapter 需要 env 对象（见 linke-sdufe README 环境契约）')
  }
  for (const key of REQUIRED) {
    if (typeof env[key] !== 'function') {
      throw new Error(`env.${key} 缺失或不是函数（linke-sdufe 环境契约四件之一）`)
    }
  }
  return env
}
