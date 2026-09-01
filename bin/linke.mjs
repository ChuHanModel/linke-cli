#!/usr/bin/env node
/**
 * linke-cli 入口。参数解析与命令分发，业务逻辑在 src/。
 */
import { runCli } from '../src/bin.js'

runCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code ?? 0
  },
  (err) => {
    // runCli 内部已负责分类报错；这里是最后的兜底，避免裸栈打到 stdout
    console.error(`[linke] 未预期错误：${err && err.message ? err.message : err}`)
    process.exitCode = 1
  }
)
