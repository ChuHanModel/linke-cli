# linke-cli

林课教务 CLI：把山财教务（正方 jsxsd）的只读查询能力封装为本机命令行
工具，供人类与 AI agent（Claude Code / ZCode 等）通过 shell 调用。

架构对标 lark-cli：**CLI 承载全部复杂度，skill 保持极薄**。随包分发一份
skill 说明书（`skills/linke/SKILL.md`），一条命令装入 agent 的 skills 目录。

## 安装与初始化

```bash
npm install -g linke-cli   # 或 npx linke-cli <命令>
linke config               # 交互式录入学号/密码（输入不回显）
linke schedule             # 直接用，登录全自动
```

要求 Node.js ≥ 18.14，零运行时依赖。

## 命令

| 命令 | 说明 |
|---|---|
| `linke config [--clear]` | 录入/清除教务凭据（存 `~/.linke-cli/config.json`，权限 600） |
| `linke status` | 配置与会话状态（JSON） |
| `linke login` | 强制重登（平时自动，排障用） |
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
山财全部逻辑收在 `src/schools/sdufe/`（登录流程、页面解析、密码加密），
经 `src/schools/registry.js` 暴露统一接口。新增学校 = 新增
`src/schools/<id>/` 适配器目录并注册。

## 开发

```bash
git clone <repo> && cd linke-cli
npm link          # 本地注册 linke 命令
npm test          # 解析器/加密对拍与行为测试
```

解析器正则与现役实现同源（`linke_PHP` Model 层 + uni-app 端本机直连
实现），教务页面改版时以两处现役代码为准回灌。
