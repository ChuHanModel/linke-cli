---
name: linke
version: 0.3.1
description: "林课教务查询 CLI（山东财经大学正方教务）：查课表、查成绩、看教务登录状态。当用户问「我这学期课表」「今天有什么课」「我的成绩/绩点」「挂了什么课」「教务登录状态」等教务只读信息时使用。登录全自动（验证码云端识别），无需用户介入。"
metadata:
  requires:
    bins: ["linke"]
  cliHelp: "linke help"
---

# 林课教务查询（linke-cli skill）

linke 是装在用户本机的教务只读查询工具（山东财经大学，正方 jsxsd 系统）。
复杂度全在 CLI 内；本 skill 只教你如何在 shell 里调用它。

## 前置检查

```bash
linke status
```

- `configured: false` → 用户还没配置凭据。**引导用户本人**在终端运行
  `linke login`（本机起登录页并自动打开浏览器，手机填写加 `--qr` 出
  局域网二维码；验证在网页内完成——通过才保存，失败页内重试，全程
  无需看终端；凭据只存本机 `~/.linke-cli/`）。**你不代输密码、
  不把密码写进任何命令**——凭据只经用户本人的网页/终端进入本机。
- `configured: true` 即可用，无需关心登录：每个命令内置鉴权状态机，
  session 过期自动重登，只有凭据失效才需要人介入。

## 命令

| 需求 | 命令 |
|---|---|
| 配置凭据（用户本人执行） | `linke login`（网页输入；`--qr` 手机扫码填写） |
| 终端配置（非 TTY / SSH 兜底） | `linke config` |
| 验证已存凭据 | `linke verify` |
| 本学期课表（全部周） | `linke schedule` |
| 指定学期课表 | `linke schedule --term 2025-2026-1` |
| 单周课表 | `linke schedule --week 3` |
| 全部成绩 | `linke scores` |
| 指定学期成绩 | `linke scores --term 2025-2026-1` |
| 登录/配置状态 | `linke status` |

## 输出契约

- **stdout 只有 JSON**（进度与提示都在 stderr），直接解析 stdout 即可。
- 课表：`{ term, week, weeks: [[7 个格子] × 节次], remark? }`；每格
  `{ course, teacher, time, location }`，空格子四字段全空串。`weeks` 外层
  下标 = 节次-1，内层下标 = 星期-1（周一=0）。
- 成绩：行数组 `[{ term, courseCode, courseName, scoreText, score, nature }]`；
  数值成绩 `score` 为 0-100 整数，等级制（优/良/合格等）`score` 为 null、
  看 `scoreText`。`courseName` 取自成绩行内紧邻成绩的列，个别页面列序
  不同时可能为空，以 `courseCode` 为准。

## 报错自救（exit code）

| exit code | 含义 | 你的动作 |
|---|---|---|
| 0 | 成功 | 解析 stdout |
| 2 | 凭据失效（教务报密码错误） | 引导用户本人重新运行 `linke login`，不要自行重试 |
| 3 | 验证码自动识别连续未通过 | 直接重试一次同一命令；仍失败告知用户稍后再试 |
| 4 | 网络不可达（教务或云端识别） | 告知用户检查网络后重试 |
| 5 | 解析失败（教务页面改版） | 告知用户到 linke-cli 仓库提 issue，不要反复重试 |
| 6 | 未配置凭据 | 引导用户本人运行 `linke login`（网页输入；SSH 场景 `linke config`） |

stderr 末行「提示:」是面向用户的自救说明，可直接转述。

## 使用纪律

1. **只读**：本 CLI 只提供课表/成绩/状态查询。选课、退课、评教提交等
   有副作用的操作一律不提供——用户提出此类需求时说明超出能力范围，
   不要尝试用任何方式绕过。
2. **凭据纪律**：密码只存在于用户本机 `~/.linke-cli/`（权限 600）。
   不询问、不存储、不转发用户密码；需要录入时只引导用户本人跑
   `linke login`（或 SSH 场景 `linke config`）。`linke login` 起的
   网页服务只绑本机/局域网且带一次性令牌，凭据不经过任何云端。
3. **频次纪律**：教务系统对高频请求有风控，连续查询之间保持间隔，
   不做轮询；一次问答内同一命令不重复执行超过 2 次。
4. 数据口径：成绩/课表数据实时来自教务系统，如与预期不符先用
   `linke status` 确认登录身份（返回的 userInfo 含姓名/学院/专业/班级）。
