/**
 * T21 林课写操作（白名单 + 两段式确认制）。
 *
 * 边界（用户拍板红线）：教务系统写操作永久不接（学校系统不可逆）；
 * 林课写仅限本文件白名单（评课发布/修改/删除、收藏增删、点赞、
 * 改昵称）；注销（cancel）不进白名单；管理域接口不碰。
 *
 * 两段式：无 --confirm 一律拒绝执行，只输出预览（完整内容+后果
 * 说明「将公开发布，全校可见」）；--confirm 才提交；执行后审计行
 * （时间/命令/目标）追加 ~/.linke-cli/ops.log（0600）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function opsLogPath() {
  return path.join(os.homedir(), '.linke-cli', 'ops.log')
}

export function appendOpsLog(op, target) {
  fs.mkdirSync(path.dirname(opsLogPath()), { recursive: true })
  fs.appendFileSync(opsLogPath(), `${new Date().toISOString()} ${op} ${target}\n`)
  try {
    fs.chmodSync(opsLogPath(), 0o600)
  } catch {
    /* 非 POSIX 忽略 */
  }
}

/**
 * 写操作统一入口：两段式确认。
 * @param {string} op 命令名
 * @param {object} view { service, params, previewText[], target }
 * @param {boolean} hasConfirm
 * @param {Function} call 真实提交函数 (service, params) => Promise
 * @param {Function} notify stderr 输出
 * @returns {Promise<number>} exit code
 */
export async function runWriteOp(op, view, hasConfirm, call, notify) {
  if (!hasConfirm) {
    notify('—— 写操作预览（尚未执行）——')
    for (const line of view.previewText) notify('  ' + line)
    notify('  后果：' + view.consequence)
    notify('确认无误后加 --confirm 重新执行（将公开发布/生效，请再次核对内容）')
    return 1
  }
  const result = await call(view.service, view.params)
  appendOpsLog(op, view.target)
  return { result }
}
