/**
 * CLI 错误层。适配器层错误分类（LinkeError/EXIT/工厂）自 linke-sdufe
 * 共享包单一实现（T24 抽包），这里 re-export 保持既有 import 兼容，
 * 并补充 CLI 专属错误。exit code 契约同时写进了 skill 说明书
 * （skills/linke/SKILL.md），改动必须同步。
 */
import { LinkeError, EXIT } from 'linke-sdufe'

export { LinkeError, EXIT, credentialInvalid, loginRetryExhausted, networkError, parseError } from 'linke-sdufe'

export function configMissing() {
  return new LinkeError('CONFIG_MISSING', '尚未配置教务账号凭据', {
    exitCode: EXIT.NOT_CONFIGURED,
    hint: '请先运行: linke config （交互式录入学号与密码，凭据只存本机 ~/.linke-cli/，权限 600）',
  })
}
