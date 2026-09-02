/**
 * 适配器层统一错误分类。exit code 契约同时写进了 linke-cli 的
 * skill 说明书（skills/linke/SKILL.md），改动这里必须同步改说明书。
 * linke-cli 的 src/errors.js re-export 本文件并补充 CLI 专属错误
 * （configMissing）——单一实现，双端同源。
 */
export class LinkeError extends Error {
  /**
   * @param {string} code 机器可读错误码
   * @param {string} message 人类可读信息（不得包含密码等凭据）
   * @param {object} options
   * @param {number} options.exitCode
   * @param {string} options.hint 自救提示（给 agent / 用户看）
   * @param {boolean} options.isLoginExpired 内部标记：教务 session 失效，可重登重试
   */
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'LinkeError'
    this.code = code
    this.exitCode = options.exitCode ?? 1
    this.hint = options.hint ?? ''
    this.isLoginExpired = options.isLoginExpired ?? false
    this.cause = options.cause
  }
}

export const EXIT = {
  OK: 0,
  GENERAL: 1,
  CREDENTIAL_INVALID: 2,
  LOGIN_RETRY_EXHAUSTED: 3,
  NETWORK: 4,
  PARSE: 5,
  NOT_CONFIGURED: 6,
}

export function credentialInvalid(detail = '') {
  return new LinkeError('CREDENTIAL_INVALID', `教务账号或密码错误${detail ? `（${detail}）` : ''}`, {
    exitCode: EXIT.CREDENTIAL_INVALID,
    hint: '请重新运行: linke config 录入正确凭据',
  })
}

export function loginRetryExhausted(attempts) {
  return new LinkeError('LOGIN_RETRY_EXHAUSTED', `验证码自动识别连续 ${attempts} 次未通过，登录未完成`, {
    exitCode: EXIT.LOGIN_RETRY_EXHAUSTED,
    hint: '稍后重试同一命令即可（会自动重登）；若持续失败，可能是云端识别服务或教务系统异常，运行 linke status 检查',
  })
}

export function networkError(action, cause) {
  return new LinkeError('NETWORK', `${action}失败：网络不可达或服务异常`, {
    exitCode: EXIT.NETWORK,
    hint: '检查本机网络（教务系统为校内可达的 http://jw.sdufe.edu.cn，云端识别为 https://api.linketeam.com）后重试',
    cause,
  })
}

export function parseError(what) {
  return new LinkeError('PARSE', `解析${what}失败：教务页面结构可能已变化`, {
    exitCode: EXIT.PARSE,
    hint: '这是适配器正则与教务页面脱节，请到 linke-cli 仓库提 issue 注明发生时间',
  })
}
