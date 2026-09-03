---
name: linke
version: 1.6.0
description: "林课教务查询 CLI（山东财经大学强智教务）：查课表、查成绩、看教务登录状态。当用户问「我这学期课表」「今天有什么课」「我的成绩/绩点」「挂了什么课」「教务登录状态」等教务只读信息时使用。登录全自动（验证码云端识别），无需用户介入。"
metadata:
  requires:
    bins: ["linke"]
  cliHelp: "linke help"
---

# 林课教务查询（linke-cli skill）

linke 是装在用户本机的教务只读查询工具（山东财经大学，强智教务系统）。
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
| 学分修读（类别统计+通选课明细） | `linke credits` |
| 全校课程查询 | `linke courses --term 2025-2026-1 --type 通选`（可加 `--dept 院系代码 --name 课程名 --teacher 教师`） |
| 平均学分绩点（含辅修） | `linke gpa` |
| 学籍卡片（核心字段） | `linke xj`（`--full` 附非敏感扩展字段；身份证/联系方式等强敏感信息任何模式都不输出） |
| 培养执行计划 | `linke plan` |
| 培养方案明细（体系/学时） | `linke pyfa` |
| 考试安排 | `linke exams --term 2025-2026-2 --kind 期末`（kind 支持 期初|期中|期末，缺省全部；考试未发布时 exams 为空数组） |
| 学业完成情况 | `linke progress`（各修读方案的性质汇总+课程修读明细） |
| 长尾查询（表头自说明 JSON） | `linke levels`（等级考试）/ `innovation`（创新学分）/ `changes`（学籍异动）/ `warning`（学籍预警）/ `recognized`（成绩认定）/ `mentor`（导师，接口受限时为空）/ `thesis`（论文成绩，低年级空为正常）/ `social`（社会考试，含 records 考级成绩）/ `messages`（留言）/ `minor-plan`（辅修计划）/ `diversion`（专业方向分流）。通用 `--page N` 翻页；`rows` 空数组=教务无记录 |
| 当前登录身份 | `linke me` |
| 登录/配置状态 | `linke status` |

## 输出契约

- **stdout 只有 JSON**（进度与提示都在 stderr），直接解析 stdout 即可。
- 课表：`{ term, week, weeks: [[7 个格子] × 节次], remark? }`；每格
  `{ course, teacher, time, location }`，空格子四字段全空串。`weeks` 外层
  下标 = 节次-1，内层下标 = 星期-1（周一=0）。
- 成绩：行数组 `[{ term, courseCode, courseName, credit, scoreText, score, nature }]`；
  数值成绩 `score` 为 0-100 整数，等级制（优/良/合格等）`score` 为 null、
  看 `scoreText`。`courseName` 取自成绩行内紧邻成绩的列，个别页面列序
  不同时可能为空，以 `courseCode` 为准。
- 学分：`{ categories: [{ category, required, earned, inProgress }],
  courses: [{ courseCode, courseName, credit, score, type }] }`——分类别
  统计与通选课明细两块，空单元格为空串。
- 全校课程：`{ term, type, total, courses: [...] }`，每行 `{ campus,
  department, className, courseCode, courseName, weeks, time, location,
  teacher, teacherCode, nature, credit, capacity }`（同一课程多条记录 =
  多个教学班，按 courseCode+teacher 区分）。
- 绩点：`{ rows: [{ studentId, name, major, className, level,
  totalCredits, courseCount, averageScore, averageGrade, gpa,
  majorType }] }`，`majorType` 区分 主修/辅修。
- 学籍：`{ studentId, department, major, duration, className, level,
  grade, extra? }`——`extra` 仅 `--full` 时出现。
- 执行计划：`{ total, courses: [{ term, courseCode, courseName,
  department, credit, hours, examMethod, nature, isExam, syllabus }] }`。
- 培养方案：`{ objectives, courses: [{ system, group, courseCode,
  courseName, category, credit, hours: {...}, term }] }`。
- 考试：`{ term, kind, exams: [{ session, courseCode, courseName, time,
  location, seat, admissionTicket }] }`。
- 完成情况：`{ plans: [{ type, name, summary: [{ nature, required,
  earned, inProgress, remaining }], courses: [...] }] }`。
- 长尾命令：`{ label, page, headers: [中文表头…], rows: [[…]] }`——
  列含义以 headers 为准（教务列序变化时自洽），空数组=无记录。
- 教务公告（双源现场获取）：`linke notices [--source jwc|jw|all]
  [--keyword 关键词] [--page N]` → `{ total, list: [{ title, url,
  date, source }] }`。jwc=教务处网站公开页（无需登录）；jw=教务
  系统「已收公告」（需登录态）；条目带 source 标记。**数据面零
  后端依赖**——所有查询数据均用户端现场拉取。
- 补考：`linke makeups`（非报名期返回空态注记）。
- 选课轮次：`linke rounds`（只读列表；选课操作是写域不提供）。
- 班级目录/班级课表：`linke classes [--college 院系码] [--grade
  年级]` → 专业+样例班级（dm 码）；`linke class-schedule --class
  <班级dm>` → 该班课表网格。
- 完成情况视图：`linke progress [--by plan|nature|attr]`——plan=
  按修读方案（缺省）；nature=性质维度（已并入 plan 的 summary）；
  attr=属性视图（服务端拦截不可达，返回 plan 数据+注记）。
- 表单查询命令（同长尾输出形态）：`linke contests`（学科竞赛，
  `--name/--year`）、`calendar`（教学周历）、`xk-credits`（选课学分
  统计）、`xk-logs`（选退课日志，`--term/--round`）、`syllabus-query`
  （教学进度，`--term/--course/--teacher/--college`）、`teacher-schedule
  --teacher-id <教工号>`（教工号从 `linke courses` 的 teacherCode 取）、
  `room-schedule --campus 舜耕|燕山|章丘|明水|莱芜 [--week N]`（week
  缺省当前周）、`textbooks`/`textbook-orders`/`thesis-guide`
  （`--page` 翻页）。
- 身份：`{ userId, name, unit, discipline, class, week: { now, all } }`；
  `linke status` 另含 `linkeAccount.exists`（该学号是否在林课体系）。
- 林课自有数据（二期，22k 用户共建）：`linke course-search <关键词>`、
  `linke course-stats <课程名>`（人数/均分/箱线图五数/标准差/挂科率/
  分布）、`linke rankings [--by star|score]`、`linke comments <课程名>`
  （评论+综合评分，只读）。**数据来源说明**：给分统计与榜单来自林课
  用户贡献的成绩聚合。
- 更新：CLI 每日自动检查新版本并后台更新（透明告知走 stderr，可用
  `linke config --auto-update off` 关闭）；`linke update` 手动更新。
- 我的林课：`linke my-comments --course <课程名>`（我的评课）、
  `linke collections`（收藏）、`linke profile`（昵称/头像档案）、
  `linke pending-reviews [--term]`（已修读课程，评价页同源口径）。

## 写操作纪律（T21 白名单 + 两段式，agent 必读）

`linke comment-post/update/delete`、`collect/uncollect`、`like`、
`nickname` 是仅有的写命令（林课自有数据；**教务系统写操作永久
不存在于本 CLI**——选课/退课/教务评教一律拒绝用户）。

**评课三星维度**（引导用户评分与翻译预览时使用）：
`--stars a,b,c` 依次为 **内容价值 / 管理轻松度 / 良师指数**，
1-5 = 很差/较差/一般/较好/很好（如 5,4,3 = 内容价值很好、管理
较轻松、良师一般）。

**发布类操作铁律**：写命令不带 `--confirm` 只输出预览（完整文本/
星级维度翻译/目标课程 + 后果说明），**不执行**。你必须把预览的评语文本
**原样展示给用户**、获得用户明确同意后，才能携带 `--confirm`
重新执行。绝不由你自行决定发布内容。每次执行自动留审计行
（~/.linke-cli/ops.log）。

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

## 遥测披露（用户问起时如实说明）

CLI 每次命令会上报使用行为元数据（命令名/版本/结果/耗时/身份摘要 md5），默认开启不可关闭，用于产品改进分析；凭据与查询参数不上传，上报不拖慢命令。用户问「CLI 会收集什么」时引用本段如实回答；成绩回流是另一件事（有开关，见上文回流说明）。

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
5. **共享包边界**：1.5.0 起山财教务适配器抽为共享包 `linke-sdufe`
   （CLI 与 Linke App 同源引用）。对命令使用无任何变化；agent 无需
   直接调用该包——一切经 `linke` 命令。
6. **成绩回流（默认参与，可关闭）**：用户查询成绩时，CLI 会把
   全量成绩匿名汇总到林课服务器（课程成绩+学号标识 → 给分统计
   与排行榜），这是 course-stats/rankings 数据池的来源。用户不
   想参与：`linke config --sync off`（不影响任何功能）。用户问
   「我的数据被上传了吗」时如实说明此机制。
