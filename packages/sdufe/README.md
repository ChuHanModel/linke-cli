# linke-sdufe

山东财经大学强智教务（`jw.sdufe.edu.cn`）适配器共享包：登录流程、
教务查询与页面解析。`linke-cli`（Node）与 Linke App（uni-app）同源
引用同一份适配器代码（T24 抽包，源自 linke-cli `src/schools/`）。

## 链路纪律（不变式）

- 对 `jw.sdufe.edu.cn` 的所有请求**从用户设备直发**，本包不引入任何服务器代抓；
- 云端只收验证码图片 base64（识别回调由宿主注入，本包不感知识别实现）；
- 教务请求 UA 固定伪装值，不携带 CLI/App 客户端标记（客户端标记只用于
  林课自有 API，与 linke-cli 的静态断言口径一致）。

## 环境契约（env 四件）

适配器核心不触碰宿主专有 API，`createSdufeAdapter(env)` 注入：

| 能力 | 签名 | 说明 |
|---|---|---|
| fetch | `fetch(url, {method, headers, body, redirect, timeoutMs, expect}) → Promise<Response-like>` | `expect='buffer'` 表示将调 `arrayBuffer()`（uni.request 单 responseType 现实约束）；Response-like 需 `{status, ok, headers.getSetCookie(), text(), arrayBuffer()}`；网络层失败 reject |
| toBase64 | `(bytes:Uint8Array) → string` | 验证码图片上行 |
| bytesToText | `(bytes:Uint8Array) → string` | 前 200 字节嗅探（宽松实现即可，ASCII 特征判定） |
| progress | `(msg:string) → void`（可缺省） | 进度输出 |

Node 宿主（>= 18.14）直接用内置 `nodeEnv()`；uni-app 宿主自行实现
uni.request 垫片（Linke App 侧参考实现：`linke_App/services/sdufePilot/`）。

## 用法

```js
// Node（linke-cli 同款）
import { initSdufe, getAdapter, nodeEnv } from 'linke-sdufe'
initSdufe(nodeEnv())
const adapter = getAdapter('sdufe')
const { cookie, userInfo } = await adapter.login(
  { userId, password, recognizeCaptcha: (b64) => cloudRecognize(b64) },
  { maxRetries: 3 }
)
const schedule = await adapter.fetchSchedule(cookie, { term: '', week: '' })

// uni-app（垫片注入）
import { initSdufe } from 'linke-sdufe'
import { uniEnv } from '@/services/sdufePilot/uniEnv.js'
const adapter = initSdufe(uniEnv)
```

适配器无持久状态：cookie 由调用方逐次传入/传出（`request` 返回
`nextCookie`），会话持久化与过期重登状态机归宿主（linke-cli 的
`session.js` / App 的 storage 方案）。

## 包边界

只管教务交互与解析。linke-cli 的业务层（凭据落盘、userKey、回流、
自动更新、写命令、cloudOcr 客户端）**不随包走**；错误分类
（`LinkeError`/`EXIT`）由本包持有，linke-cli re-export 并补充 CLI 专属
错误，保持单一实现。

版本与发版随 linke-cli 仓库（monorepo workspaces，`packages/sdufe`），
发布名 `linke-sdufe`（npm public，代码本就随 linke-cli 开源，无新增暴露）。

## 测试

```bash
npm test -w linke-sdufe   # 或 cd packages/sdufe && npm test
```

env 契约与注入式适配器行为均以 mock env 测试，零网络依赖；页面解析器
的正则用例由 linke-cli 根测试套（`test/parsers*.test.mjs` 等）覆盖，
import 路径自 T24 起指向本包。
