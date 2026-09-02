#!/usr/bin/env node
/**
 * T16 后台自更新脚本（detached 运行，无 stdio）：
 * npm i -g linke-cli@<target> → update.log 追加 → skill 重装 →
 * 写 pendingNotify（下次命令调用时 stderr 告知）。
 */
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const [, , fromVersion, toVersion] = process.argv
const OFFICIAL = 'https://registry.npmjs.org'
const dir = path.join(os.homedir(), '.linke-cli')

const child = spawn('npm', ['install', '-g', `linke-cli@${toVersion}`, '--registry', OFFICIAL], {
  stdio: 'ignore',
})
child.on('exit', (code) => {
  if (code !== 0) process.exit(0) // 失败静默：不影响当次命令，下次再试
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'update.log'), `${new Date().toISOString()} ${fromVersion} -> ${toVersion}\n`)
    const statePath = path.join(dir, 'update-check.json')
    let state = {}
    try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')) } catch {}
    state.pendingNotify = { from: fromVersion, to: toVersion }
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2))
    execFileSync(process.execPath, [process.argv[1] || 'linke', 'skill', 'install'], { stdio: 'ignore' })
  } catch {}
  process.exit(0)
})
