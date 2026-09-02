# linke-cli

林课教务 CLI：把山财教务（强智教务 Kingosoft）的只读查询能力封装为本机命令行
工具，供人类与 AI agent（Claude Code / ZCode 等）通过 shell 调用。

**CLI 承载全部复杂度，skill 保持极薄**。随包分发一份
skill 说明书（`skills/linke/SKILL.md`），一条命令装入 agent 的 skills 目录。

## 安装与初始化

```bash
npm install -g linke-cli   # 或 npx linke-cli <命令>
linke login                # 首选配置：本机起登录页，自动打开浏览器（手机填写加 --qr）
linke schedule             # 直接用，登录全自动
```

要求 Node.js ≥ 18.14。除自有共享包 `linke-sdufe`（教务适配器，T24
抽包与本 CLI 同仓库开发）外零第三方依赖。

`linke login` 的登录页由本机 CLI 提供（仅绑 127.0.0.1 随机端口，页面
随 npm 包分发可审计）；**提交后在网页内完成教务登录验证**——验证中
动效 → 结果回显（成功显示姓名与教学周，凭据此时才落盘 0600；密码错
误页内提示并可重试，含教务锁号警示）。尝试上限 3 次、5 分钟超时，
任一终结即自动关闭服务。`--qr` 模式额外在终端展示局域网 URL 二维码
（含会话令牌），手机同 Wi-Fi 扫码填写、全程手机端闭环，凭据不经任
何云端。`linke config` 保留为非 TTY / SSH 场景的终端兜底。

## 命令

| 命令 | 说明 |
|---|---|
| `linke login [--qr]` | 网页配置凭据（首选）；`--qr` 出局域网二维码供手机填写 |
| `linke config [--clear]` | 终端录入/清除凭据（非 TTY 兜底；存 `~/.linke-cli/`，权限 600） |
| `linke verify` | 验证已存凭据（自动登录教务并显示身份） |
| `linke status` | 配置与会话状态（JSON） |
| `linke scores [--term 2025-2026-1]` | 成绩（缺省全部学期，JSON） |
| `linke schedule [--term ...] [--week 3]` | 课表（缺省当前学期全部周，JSON） |
| `linke schools` | 列出学校适配器 |
| `linke skill install [--path DIR]` | 安装 skill 说明书到 agent skills 目录 |
| `linke logout` | 清除本机 session（保留凭据） |

stdout 只输出业务 JSON；进度与错误走 stderr。exit code 契约见
`src/errors.js` 与 `skills/linke/SKILL.md`。

## 安全设计

- **凭据不出现在命令行参数、shell 历史与任何日志**：只经 `linke config`
  交互式录入（密码不回显），落盘 `~/.linke-cli/config.json`（0600，目录 0700）。
- **登录请求从用户本机直发教务系统**，不经云服务器代理转发。
- **云端只做无状态验证码识别**（传图返文字，`App.Captcha.Recognize`），
  学号/密码/cookie 不离开本机。
- **鉴权状态机内建于每个命令**：session 有效直接用、过期自动重登、
  凭据失效才报错（exit 2）提示重新 `linke config`。
- **一期只读**：不提供选课/退课/评教等有副作用的接口。

## 学校适配器分层

核心命令框架（`src/bin.js`、`src/session.js`）不含任何学校特有逻辑；
山财全部逻辑收在共享包 `linke-sdufe`（`packages/sdufe/`，与 Linke App
同源引用）：登录流程、页面解析、密码加密，经其 registry 暴露统一接口。
适配器核心不触碰宿主 API（fetch/base64 等经 env 注入，Node 用
`nodeEnv()`，uni-app 用 `uni.request` 垫片）——CLI 与 App 共用同一份
教务交互代码。新增学校 = 新增包内 `src/<id>/` 适配器目录并注册。

## 已知问题与排障

- **登录页提交报「Failed to fetch」**：提交未送达本机登录服务。
  常见原因是本机代理 / TUN 工具（Clash、Stash、Surge 等）劫持了
  localhost 请求——为 localhost 加直连规则或暂时关闭代理后重试。
  本次提交未送达，不会占用教务尝试次数。
- **CLI 运行在远程机器（远程桌面 / SSH）**：`linke login` 打印的
  127.0.0.1 地址只在**那台机器**的浏览器可用。远程操作时请在被控
  机器本机打开浏览器；手机填写用 `linke login --qr`（局域网地址）。
- **怀疑装到旧版本**：若走 npmmirror 等镜像源安装，镜像同步有延迟，
  可能装到旧版。用 `npm ls -g linke-cli` 核对版本，或
  `npm install -g linke-cli --registry https://registry.npmjs.org` 指定官方源。

## 开发

```bash
git clone <repo> && cd linke-cli
npm link          # 本地注册 linke 命令
npm test          # 解析器/加密对拍与行为测试
```

解析器正则与现役实现同源（`linke_PHP` Model 层 + uni-app 端本机直连
实现），教务页面改版时以两处现役代码为准回灌。
