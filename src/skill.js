/**
 * skill 说明书分发（T3 验收 5）：把随包分发的 SKILL.md 安装进
 * 用户 agent 的 skills 目录。skill 保持极薄——只描述如何 shell 调用
 * CLI，复杂度全部在 CLI 内。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_DIR_NAME = 'linke'

function packagedSkillDir() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  // src/ → 包根；npm 安装后 skills/ 随 files 字段一起分发
  return path.join(path.dirname(here), 'skills', SKILL_DIR_NAME)
}

/** 常见 agent 的 skills 根目录（存在才视为目标；--path 可显式指定） */
function detectSkillRoots() {
  const home = os.homedir()
  return [
    path.join(home, '.agents', 'skills'),
    path.join(home, '.claude', 'skills'),
    path.join(home, '.zcode', 'skills'),
  ].filter((dir) => fs.existsSync(path.dirname(dir)))
}

export function installSkill(explicitPath) {
  const source = packagedSkillDir()
  if (!fs.existsSync(path.join(source, 'SKILL.md'))) {
    throw new Error(`随包 skill 说明书缺失：${source}/SKILL.md（安装包不完整）`)
  }
  const targets = explicitPath ? [explicitPath] : detectSkillRoots()
  if (targets.length === 0) {
    throw new Error(
      '未探测到已安装 agent 的 skills 目录；用 --path <目录> 显式指定，' +
        '例如: linke skill install --path ~/.agents/skills'
    )
  }
  const installed = []
  for (const root of targets) {
    const dest = path.join(root, SKILL_DIR_NAME)
    fs.mkdirSync(dest, { recursive: true })
    for (const file of fs.readdirSync(source)) {
      fs.copyFileSync(path.join(source, file), path.join(dest, file))
    }
    installed.push(dest)
  }
  return installed
}

export function skillSourceDir() {
  return packagedSkillDir()
}
