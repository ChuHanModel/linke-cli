/**
 * 交互式输入（TTY）。密码输入不回显——不依赖第三方库，
 * 用 readline + 自定义 output 实现（非 TTY 环境直接报错，
 * 拒绝从管道读密码以免凭据进入 shell 历史/日志链路）。
 */
import readline from 'node:readline'
import { Writable } from 'node:stream'
import { LinkeError, EXIT } from './errors.js'

export function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(String(answer || '').trim())
    })
  })
}

export function askPassword(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new LinkeError(
      'NO_TTY',
      '当前环境不是交互式终端，无法安全录入密码',
      { exitCode: EXIT.GENERAL, hint: '请在真实终端中运行: linke config' }
    )
  }
  // 提示写真实 stdout，回显走哑流：密码字符不落到终端，也就进不了终端回滚缓冲
  process.stdout.write(question)
  const devnull = new Writable({ write(_chunk, _enc, cb) { cb() } })
  const rl = readline.createInterface({ input: process.stdin, output: devnull })
  return new Promise((resolve) => {
    rl.question('', (answer) => {
      process.stdout.write('\n')
      rl.close()
      resolve(String(answer || ''))
    })
  })
}
