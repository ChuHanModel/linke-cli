/**
 * 配置文件权限与 CLI 行为测试。
 * 通过临时改 HOME 隔离 ~/.linke-cli，避免污染真实环境。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const realHome = process.env.HOME

function withTempHome(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linke-cli-test-'))
  process.env.HOME = tmp
  return Promise.resolve()
    .then(() => fn(tmp))
    .finally(() => {
      process.env.HOME = realHome
      fs.rmSync(tmp, { recursive: true, force: true })
    })
}

test('saveConfig 落盘权限 600、目录 700，loadConfig 读回一致', async () => {
  await withTempHome(async (tmp) => {
    const { saveConfig, loadConfig, configPath, configDir } = await import('../src/config.js')
    saveConfig({ school: 'sdufe', userId: '202401140207', password: 'secret', apiBase: 'https://x' })
    const dirMode = fs.statSync(configDir()).mode & 0o777
    const fileMode = fs.statSync(configPath()).mode & 0o777
    assert.equal(dirMode, 0o700)
    assert.equal(fileMode, 0o600)
    const loaded = loadConfig()
    assert.equal(loaded.userId, '202401140207')
    assert.equal(loaded.password, 'secret')
    // redact 不泄密
    const { redactConfig } = await import('../src/config.js')
    const red = redactConfig(loaded)
    assert.equal(red.password, undefined)
    assert.ok(JSON.stringify(red).includes('passwordLength'))
  })
})

test('未配置时数据命令 exit 6 并提示 linke config', async () => {
  await withTempHome(async () => {
    const { runCli } = await import('../src/bin.js')
    const stderrChunks = []
    const origWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = (chunk) => {
      stderrChunks.push(String(chunk))
      return true
    }
    try {
      const code = await runCli(['scores'])
      assert.equal(code, 6)
      assert.ok(stderrChunks.join('').includes('linke config'))
    } finally {
      process.stderr.write = origWrite
    }
  })
})

test('未知命令打印用法并 exit 0（help 路径）', async () => {
  await withTempHome(async () => {
    const { runCli } = await import('../src/bin.js')
    const code = await runCli(['help'])
    assert.equal(code, 0)
  })
})

test('schools 命令输出适配器列表（stdout JSON）', async () => {
  await withTempHome(async () => {
    const { runCli } = await import('../src/bin.js')
    const stdoutChunks = []
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk) => {
      stdoutChunks.push(String(chunk))
      return true
    }
    try {
      const code = await runCli(['schools'])
      assert.equal(code, 0)
      // 遥测使 runCli 略变慢，node:test 的 IPC 消息（test:pass 等）可能
      // 撞进被替换的 stdout 窗口——emitJson 是单次 write，只取首块解析
      const parsed = JSON.parse(stdoutChunks[0] || '')
      assert.ok(Array.isArray(parsed))
      assert.ok(parsed.some((a) => a.id === 'sdufe'))
    } finally {
      process.stdout.write = origWrite
    }
  })
})
