# ARCHITECTURE.md — wukong-penetrate 架构地图

> Version: 0.2.0 | Last updated: 2026-08-05
>
> 本文档描述稳定的结构关系，半年至一年不变。代码改动若偏离此处描述，需同步更新。

---

## 1. 架构概览

```
┌────────────┐     OpenAI API      ┌──────────────┐    channel dispatch    ┌─────────────────────┐
│  Client    │ ──────────────────> │  xrl-router  │ ───────────────────> │  wukong-penetrate   │
│ (Claude    │  /v1/chat/          │  (DEAP 协议   │   WS register +      │  (Express plugin)   │
│  Code etc) │  completions        │   桥接路由)   │   keys_update        │                     │
└────────────┘                     └──────────────┘                      └─────────┬───────────┘
                                                                                   │
                                                              ┌────────────────────┴────────────────────┐
                                                              │                                         │
                                                     ┌────────▼────────┐                    ┌──────────▼──────────┐
                                                     │   qwenwork      │                    │     wukong           │
                                                     │   (default)     │                    │   (--use wukong)     │
                                                     └────────┬────────┘                    └──────────┬──────────┘
                                                              │                                         │
                                                  OAuth+Cosy签名                              DEAP 头注入
                                                  SSE 外层解包                                 字节流透传
                                                              │                                         │
                                                     ┌────────▼────────┐                    ┌──────────▼──────────┐
                                                     │ gateway.        │                    │ api-deap.           │
                                                     │ qwenwork.cn     │                    │ dingtalk.com        │
                                                     │ → 智谱 GLM-5.2  │                    │ → Qwen3.7-max/plus  │
                                                     │   Qwen3.7-plus  │                    └─────────────────────┘
                                                     │   DeepSeek-V4   │
                                                     │   Qwen3.8-max   │
                                                     └─────────────────┘
```

### 设计原则

| 原则 | 说明 |
|------|------|
| **纯翻译层** | 只做 OpenAI ↔ 上游协议转换，不引入业务逻辑、不做 prompt engineering |
| **无状态** | 每个请求独立签名（qwenwork）或独立注入头（wukong），无 session 存储（token 缓存是性能优化，非业务状态） |
| **字节透传** | wukong 通道 SSE 按行拆分 + 逐行 flush（解决上游 TCP 合包导致客户端「一块一块出」）；qwenwork 通道仅解包外层 SSE wrapper，内层 chunk 原样转发 |
| **通道隔离** | `src/qwenwork/` 与 `src/wukong/` 目录完全独立，共享骨架仅在 `src/index.ts` |
| **自动恢复** | WS 断线指数退避重连（max 60s）；token 过期按需刷新 + auth-v2.dat 文件监听自动拾取；端口占用自动 kill |

---

## 2. 源码结构

```
src/
├── index.ts              # Express 入口：路由 + 端口释放 + 优雅退出
├── channel.ts            # 通道判定：解析 --use argv，导出 CHANNEL / PLUGIN_ID
├── config.ts             # 配置单例：env 读取 + wukong 版本动态检测
├── pluginClient.ts       # WebSocket 客户端：注册 / 心跳 / env 轮询 / 重连
├── qwenwork/
│   ├── client.ts         # qwenwork 通道转发：签名 + SSE 解包 + tool_calls 标准化
│   ├── auth.ts           # token 管理：safeStorage 解密/加密（Keychain/DPAPI）/ refresh / 文件监听 / 三源 fallback
│   └── signer.ts         # 请求签名：AES-128-CBC + RSA_PKCS1 + MD5
└── wukong/
    └── client.ts         # wukong 通道转发：DEAP 头注入 + body 清洗 + 按行 flush
```

### 依赖图

```
index.ts
├── config.ts ← channel.ts
├── pluginClient.ts ← config.ts, channel.ts
│   └── qwenwork/client.ts (displayName)
├── qwenwork/client.ts ← config.ts, qwenwork/auth.ts, qwenwork/signer.ts
│   ├── auth.ts ← config.ts
│   └── signer.ts ← config.ts, auth.ts (types)
└── wukong/client.ts ← config.ts
```

---

## 3. 模块设计

### 3.1 channel.ts — 通道判定

启动时一次性解析 `process.argv`，此后不可变。

```typescript
// --use wukong → 'wukong'，否则 'qwenwork'（默认）
export type Channel = 'qwenwork' | 'wukong';
export const CHANNEL: Channel = parseChannel();
export const PLUGIN_ID: string = CHANNEL === 'wukong'
  ? 'xrl-router-plugin-wukong'
  : 'xrl-router-plugin-qwenwork';
export const isWukong = (): boolean => CHANNEL === 'wukong';
export const isQwenwork = (): boolean => CHANNEL === 'qwenwork';
```

`PLUGIN_ID` 用于 WS 注册时告知 xrl-router 本插件身份。

### 3.2 config.ts — 配置单例

导出 `settings: Settings` 单例，进程启动时一次性从 `process.env` 读取，此后不再重新加载。

**Settings 接口**包含两个通道的全部字段：

| 分组 | 字段 | 说明 |
|------|------|------|
| 通用 | `port`, `availableModels`, `channel` | 监听端口（按通道默认：qwenwork 19067 / wukong 19066，可同时启动）、可用模型列表、当前通道 |
| wukong | `deapBaseUrl`, `deapUserType`, `deapScenarioCode`, `deapProductCode`, `deapAbilityCode`, `deapWukongClientVersion`, `deapWukongDeviceType`, `deapAgentLoopVersion`, `deapBizParam` | DEAP 网关地址 + 12 个业务头参数 |
| qwenwork | `qwenBaseUrl`, `qwenOauthTokenPath`, `qwenKeychainService`, `qwenKeychainAccount`, `qwenDeviceRefreshPath`, `qwenRsaPublicKeyPath`, `qwenRefreshIntervalMs`, `qwenTarget` | 推理网关地址 + OAuth/签名参数 |
| xrl-router | `xrlRouterUrl` | WS 连接地址 |

**wukong 版本动态检测**：`detectWukongClientVersion()` 优先读 `DEAP_WUKONG_CLIENT_VERSION` 环境变量；Windows 平台从 `C:\Program Files\Wukong\<version>\` 目录名推断（取最高版本号）；兜底为 `0.9.65-26061702`。

### 3.3 pluginClient.ts — WS 客户端

`PluginClient` 类，构造时立即执行三个动作：

1. **加载密钥**：从 `.env` 读 `QWEN_KEYS`（qwenwork）或 `WUKONG_KEYS`（wukong），逗号分隔解析为数组
2. **连接 xrl-router**：`ws://{host}/ws/plugin`
3. **启动 env 轮询**

#### 注册消息格式

```json
{
  "type": "register",
  "plugin_id": "xrl-router-plugin-qwenwork",
  "provider": {
    "kind": "openai",
    "base_url": "http://localhost:19067",
    "api_path": "/v1/chat/completions"
  },
  "models": [
    { "model_id": "qwork-advanced", "display_name": "glm-5.2", "tier": "custom" },
    { "model_id": "qwork-auto", "display_name": "qwen3.7-plus", "tier": "custom" },
    { "model_id": "qwork-lite", "display_name": "deepseek-v4-flash", "tier": "custom" },
    { "model_id": "qmodel_latest", "display_name": "qwen3.8-max", "tier": "custom" }
  ],
  "keys": ["ory_rt_xxx"]
}
```

#### 定时任务

| 任务 | 间隔 | 说明 |
|------|------|------|
| 心跳 | 30s | `{ type: "heartbeat", timestamp }` |
| env 轮询 | 5s | 读 `.env`，密钥列表变化时推送 `keys_update` |

#### 重连策略

指数退避：`delay = min(1000ms * 2^attempts, 60000ms)`。每次 `open` 事件重置 `reconnectAttempts = 0`。

### 3.4 qwenwork/client.ts — 签名转发

`forwardChatCompletions(body, res, authHeader)` 处理流程：

```
  getToken()              ← 缓存管理（5min 缓冲，按需刷新 + 文件监听自动拾取）
        │
        │ 缓存全失效？灾备 ↓
  extractRefreshToken(authHeader) ← 从 xrl-router 透传的 Authorization 头取 ory_rt_
        │
        ▼
  extractUidFromToken(jwt)  ← 解 JWT payload.sub / .uid / .user_id
        │
        ▼
  buildSignMaterial(token)  ← 随机 16B AES key → Cosy-Key + info
        │
        ▼
  buildAuthHeaders(m, url, body) ← MD5 签名 → Authorization: Bearer COSY.xxx.sig
        │
        ▼
  fetch(gateway.qwenwork.cn/algo/api/v2/service/pro/sse/agent_chat_generation)
        │
        ▼
  ┌─ stream=true:  外层 SSE 解包 → 内层 OpenAI chunk 透传
  └─ stream=false: delta 聚合 → 完整 chat.completion JSON
```

**Token 策略（方案 A）**：不再每请求都 refresh（避免插件与千问 App 轮换互踩导致 refresh token 快速失效）。`getToken()` 维护内存缓存，access token 剩余 > 5 分钟时直接返回，零网络开销。refresh 成功后写回 `auth-v2.dat`（双向同步），千问 App 下次读取时拿到同一个 refresh token，避免轮换互踩。

**静态头**：12 个固定值（`Cosy-Business-Product: qoder_work`, `Cosy-Scene: qwork`, `Cosy-Version: 1.0.47` 等；其中 `Login-Version`、`x-model-source` 非 `Cosy-*` 前缀）。

**展示名映射**：`qwork-advanced` → `glm-5.2`、`qwork-auto` → `qwen3.7-plus`、`qwork-lite` → `deepseek-v4-flash`、`qmodel_latest` → `qwen3.8-max`（注册给 xrl-router 的 display_name）。请求方向无别名映射——客户端发送什么 `model` 就透传什么，缺省时默认 `qwork-advanced`。

**流式 tool_calls 标准化**（适配 xrl-router 的转换逻辑）：
- xrl-router 把「某 index 的首个 chunk」解析为 `content_block_start`（input 字段），其余分片作为 `input_json_delta` 处理
- 因此首 chunk 必须发空 `arguments`（避免 `"{"` 被提前消耗），所有 arguments 片段（含首 chunk 的 `"{"`）原样发出，保证 `partial_json` 序列以 `"{"` 开头、拼接后是完整 JSON
- 用 `seenToolCallIndex` 集合跟踪每个 index 的首 chunk

**非流式聚合**：读取所有 SSE chunk，拼接 `choices[0].delta` 的 `content` / `reasoning_content`（空值时字段不存在），`tool_calls` 按 `index` 分组拼接 `arguments`。`finish_reason` 从上游最后一个 chunk 透传（默认 `stop`）。

### 3.5 qwenwork/auth.ts — token 管理

#### decryptAuthFile — safeStorage 解密（按平台分派）

```
macOS（Keychain）                      Windows（DPAPI → AES-256-GCM）
Keychain ("QwenWorkCN Safe Storage" /  Local State 的 os_crypt.encrypted_key
 "QwenWorkCN Key")                     → base64 解码 → 去 "DPAPI\0" 前缀
    ▼ password (去尾换行)                → CryptUnprotectData(entropy=NULL)
PBKDF2(password, "saltysalt", 1003, 16, sha1)   ▼ 32B AES key
    ▼ aesKey (16 bytes)                v10 头后 = 12B nonce + 密文 + 16B tag
AES-128-CBC(key=aesKey, iv=0x20×16)    aes-256-gcm 解密
    ▼ 解密 auth-v2.dat (跳过 "v10" 3字节头)
JSON → QwenTokenState { token, refreshToken, user, expiresAt, raw }
```

macOS（Keychain + PBKDF2 + AES-128-CBC）与 Windows（Local State 取 key → DPAPI 解包 → AES-256-GCM）均支持；按 `process.platform` 分派，Windows 依赖系统自带 powershell.exe（零新依赖）。

#### refreshDeviceToken

`POST {qwenBaseUrl}/api/v1/deviceToken/refresh`，body `{ refresh_token, target: "c" }`。响应包含 `device_token`（新 access token）+ `refresh_token`（轮换后的新 refresh token）。刷新成功后：
1. `encryptAuthFile()` 写回 `auth-v2.dat`（双向同步，千问 App 下次读取时拿到新 refresh token）
2. `syncEnvRefreshToken()` 写回 `.env` QWEN_KEYS

写回 `auth-v2.dat` 使用与解密完全对称的加密方式（Windows: AES-256-GCM / macOS: AES-128-CBC），复用已有 AES key。

#### initTokenManager — 启动初始化

启动时调用 `startAuthFileWatch()`：

```
fs.watch(auth-v2.dat)
    │ 文件变化 ↓
  debounce 1s + mtime 去重
    │
    ▼
  decryptAuthFile() → 更新 cached → syncEnvRefreshToken()
```

千问 App 自己刷新 token 时，文件监听自动拾取新值并更新内存缓存。Windows `fs.watch` 同一文件可能重复触发，靠 debounce + mtime 去重。watcher 异常时自动重启（5s 后重试）。

#### getToken — 三源 fallback

```
  缓存有效？（expiresAt > now + 5min）→ 直接返回，零网络请求
     │ 无效 ↓
  ① 内存缓存 refresh token → refreshDeviceToken()
     │ 失败 ↓ 重读 auth-v2.dat
  ② auth-v2.dat 解密 → token 有效直接用 / refresh token 刷新
     │ 失败 ↓
  ③ .env QWEN_KEYS → refreshDeviceToken()
     │ 失败 ↓
  throw Error
```

缓存检查：`Date.now() < expiresAt - 5 * 60_000`（提前 5 分钟刷新）。并发防重：`refreshing` Promise 单飞。

#### syncEnvRefreshToken

写 `.env` 的 `QWEN_KEYS` 行 + 写回 `auth-v2.dat`。双向同步确保插件和千问 App 持有相同的 refresh token，避免轮换互踩。

### 3.6 qwenwork/signer.ts — 请求签名

#### buildSignMaterial — encryptUserInfo 等价物

```
e = randomUUID().replace(/-/g, '').substring(0, 16)   // 随机 16 字节 AES key

userInfo = { uid, aid: "", name, email, security_oauth_token: accessToken }

info    = base64(AES-128-CBC(key=e, iv=e, JSON.stringify(userInfo)))
cosyKey = base64(RSA_PKCS1_PADDING(publicKey, e))
```

RSA 公钥：asar 硬编码（modulus 头 `c0f223…`），可通过 `QWEN_RSA_PUBLIC_KEY_PATH` 环境变量覆盖。注意使用 **PKCS1** 而非 OAEP padding。

#### buildAuthHeaders — generateAuthToken 等价物

```
header = { version: "v1", requestId: UUID, info, cosyVersion: "1.0.0", ideVersion: "1.0.0" }
o      = base64(JSON.stringify(header))

path   = URL.pathname（去掉 query string；若以 /algo 开头则去掉该前缀）
signStr = `${o}\n${cosyKey}\n${timestamp}\n${body}\n${path}`
sig    = md5(signStr)

Authorization = "Bearer COSY." + o + "." + sig
```

签名绑定 body + path + 时间戳，天然防重放。

### 3.7 wukong/client.ts — DEAP 头注入

#### buildDeapHeaders — 12 个必需头

| Header | 值来源 |
|--------|--------|
| `Content-Type` | `application/json` |
| `Authorization` | `Bearer {deapKey}` |
| `x-litellm-session-id` | `randomUUID()` |
| `x-dingtalk-ability-call-session-id` | `randomUUID()` |
| `x-dingtalk-biz-id` | `randomUUID()` |
| `x-dingtalk-user-type` | `settings.deapUserType` |
| `x-dingtalk-scenario-code` | `settings.deapScenarioCode` |
| `x-dingtalk-product-code` | `settings.deapProductCode` |
| `x-dingtalk-ability-code` | `settings.deapAbilityCode` |
| `x-wukong-client-version` | `settings.deapWukongClientVersion` |
| `x-wukong-device-type` | `settings.deapWukongDeviceType` |
| `x-wukong-agent-loop-version` | `settings.deapAgentLoopVersion` |
| `x-dingtalk-biz-param` | `settings.deapBizParam` |

缺少任何一个 `x-dingtalk-*` 头 → 400。

#### buildDeapBody — 请求体清洗

注入字段：
- `max_tokens`（默认 4096）、`temperature`（默认 0.6）
- `enable_thinking`（默认 true）、`enable_search`（固定 true）
- 流式时追加 `stream_options: { include_usage: true }`
- `extra_body: { enable_thinking, user_query, enable_search, ...原始 extra_body }`

`user_query` 从 `messages` 中取最后一条 `role === "user"` 的 `content`。

> **WARNING**: 流式请求**不要**设置 `Accept: text/event-stream`。DEAP 网关会因该头返回 406 Not Acceptable。

### 3.8 index.ts — Express 入口

#### 路由

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/` | 健康探针：返回 version / channel / backend / endpoints |
| `GET` | `/health` | 健康检查：返回 status / channel / base_url |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions：按通道分发到 `forwardQwenChat` 或 `forwardWukongChat` |

#### killPortProcess — 跨平台端口释放

启动前自动释放目标端口，避免 `EADDRINUSE`：

- **macOS/Linux**：`lsof -ti :{port}` → `kill -9 {pids}`
- **Windows**：`netstat -ano` 过滤 `:{port}.*LISTENING` → `taskkill /F /PID {pids}`

#### 优雅退出

`SIGTERM` / `SIGINT` → `pluginClient.close()` → `process.exit(0)`。`close()` 清理心跳定时器、env 轮询定时器、重连定时器、WS 连接。

---

## 4. 协议细节

### 4.1 OpenAI → qwenwork 映射

**请求头**：

```
Content-Type:  application/json
Accept:        text/event-stream
Authorization: Bearer COSY.{base64(header)}.{md5(sig)}
Cosy-Key:      {base64(RSA_PKCS1(pub, aesKey))}
Cosy-Date:     {unix_timestamp}
Cosy-User:     {uid}
x-model-key:   {model_id}
+ 12 个静态头（10 个 Cosy-* + Login-Version + x-model-source）
```

**请求体**：明文 JSON（**不**使用 `Encode=1`），自动补 `request_id` / `session_id`（UUID），删除 `encode` / `extra_body` 字段。

**响应**：

qwenwork 网关返回**双层 SSE**：
```
data: {"headers":{...},"body":"<内层 OpenAI chunk JSON>","statusCodeValue":200}
```

插件解包外层，取出 `body` 字段作为标准 OpenAI SSE chunk 透传：
```
data: {"id":"chatcmpl-xxx","choices":[{"delta":{"content":"..."}}]}
```

非流式时聚合所有 delta 为完整 `chat.completion` 对象。

### 4.2 OpenAI → DEAP 映射

**请求头**：12 个 DEAP 业务头（见 §3.7），无签名机制。

**请求体**：注入 `extra_body` / `enable_thinking` / `enable_search` / `stream_options`，其余字段原样透传。

**响应**：直接字节透传（非流式 JSON 原样透传；流式 SSE 按行拆分 + 逐行 `flush()`，避免上游 TCP 合包导致客户端一块一块出）。

---

## 5. WebSocket 协议

插件与 xrl-router 之间通过 WebSocket (`/ws/plugin`) 通信。

### 消息类型

| 方向 | 类型 | 说明 |
|------|------|------|
| plugin → router | `register` | 启动时注册插件身份、模型列表、初始密钥池 |
| plugin → router | `heartbeat` | 每 30s 保活 |
| plugin → router | `keys_update` | env 轮询检测到密钥变化时推送新列表 |
| router → plugin | `registered` | 注册确认（静默） |
| router → plugin | `reconnected` | 重连确认（静默） |
| router → plugin | `keys_ack` | 密钥更新确认（静默） |
| router → plugin | `activated` | 激活通知（静默） |

当前插件对 router → plugin 的所有消息均静默处理（`handleMessage` 为空实现），仅依赖发送侧逻辑。

### 注册消息示例

```json
{
  "type": "register",
  "plugin_id": "xrl-router-plugin-wukong",
  "provider": {
    "kind": "openai",
    "base_url": "http://localhost:19066",
    "api_path": "/v1/chat/completions"
  },
  "models": [
    { "model_id": "qwen3.7-max", "display_name": "qwen3.7-max", "tier": "custom" },
    { "model_id": "qwen3.7-plus", "display_name": "qwen3.7-plus", "tier": "custom" }
  ],
  "keys": ["sk-xxx", "sk-yyy"]
}
```

---

## 6. 部署与运维

### 环境变量

#### 通用

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `QWEN_PORT` / `WUKONG_PORT` | qwenwork: `19067`；wukong: `19066` | 按通道的 HTTP 监听端口（默认不同 → 两通道可同时启动；不再支持共用 `PORT`） |
| `AVAILABLE_MODELS` | 按通道默认（qwenwork: `qwork-advanced,qwork-auto,qwork-lite,qmodel_latest`；wukong: `qwen3.7-max,qwen3.7-plus`） | 逗号分隔的可用模型列表 |
| `XRL_ROUTER_URL` | `http://localhost:19068` | xrl-router WS 连接地址 |

#### qwenwork 通道

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `QWEN_BASE_URL` | `https://gateway.qwenwork.cn` | 推理网关地址 |
| `QWEN_OAUTH_TOKEN_PATH` | `~/Library/Application Support/QwenWorkCN/auth-v2.dat` | OAuth token 文件路径 |
| `QWEN_KEYCHAIN_SERVICE` | `QwenWorkCN Safe Storage` | macOS Keychain service 名 |
| `QWEN_KEYCHAIN_ACCOUNT` | `QwenWorkCN Key` | macOS Keychain account 名 |
| `QWEN_DEVICE_REFRESH_PATH` | `/api/v1/deviceToken/refresh` | token 刷新接口 |
| `QWEN_RSA_PUBLIC_KEY_PATH` | *(空，用内嵌公钥)* | RSA 公钥 PEM 文件路径（可选覆盖） |
| `QWEN_REFRESH_INTERVAL_MS` | `600000` | token 自动刷新检查间隔（10min） |
| `QWEN_TARGET` | `c` | deviceToken/refresh 的 target 参数 |
| `QWEN_KEYS` | *(空)* | 密钥池 refresh token（逗号分隔） |

#### wukong 通道

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DEAP_BASE_URL` | `https://api-deap.dingtalk.com/dingtalk/v1` | DEAP 网关地址 |
| `DEAP_USER_TYPE` | `vip` | 用户类型 |
| `DEAP_SCENARIO_CODE` | `com.dingtalk.scenario.wukong` | 场景码 |
| `DEAP_PRODUCT_CODE` | `AI_WUKONG` | 产品码 |
| `DEAP_ABILITY_CODE` | `M_AI_WUKONG` | 能力码 |
| `DEAP_WUKONG_CLIENT_VERSION` | *(动态检测)* | 客户端版本号 |
| `DEAP_WUKONG_DEVICE_TYPE` | `2` | 设备类型 |
| `DEAP_AGENT_LOOP_VERSION` | `V2` | Agent loop 版本 |
| `DEAP_BIZ_PARAM` | `{"taskDes":"5L2g5aW9"}` | 业务参数（base64 编码） |
| `WUKONG_KEYS` | *(空)* | 密钥池 API key（逗号分隔） |

### 日志格式

所有日志输出到 stdout/stderr，前缀标识模块：

```
[PluginClient] Connected to xrl-router
[PluginClient] Reconnecting in 2000ms (attempt 2)
[qwenwork] token 已刷新（有效期至 2026-08-02T15:30:00.000Z）
[qwenwork] QWEN_KEYS 同步失败（不影响运行）: EACCES
[qwenwork] 流读取失败: network timeout
```

### 监控指标

| 指标 | 来源 | 说明 |
|------|------|------|
| HTTP 状态码 | Express 路由 | 401 = token 问题, 400 = 缺头, 406 = DEAP Accept 头 |
| WS 连接状态 | `[PluginClient]` 日志 | Connected / Disconnected / Reconnecting |
| token 刷新成功率 | `[qwenwork]` 日志 | 失败时降级到下一源 |
| 密钥池变化 | `[PluginClient]` keys_update | env 轮询检测到的密钥列表变更 |

---

## 7. 故障排查

### 401 Unauthorized

**qwenwork 通道**：
- 原因：请求 Authorization 头缺少 `ory_rt_` 前缀的 refresh token，或 token 已失效
- 排查：确认 xrl-router 密钥池 `QWEN_KEYS` 有有效的 refresh token
- 修复：重新运行 `pnpm capture-key` 抓取新 token，或通过千问办公 App 重新登录触发 `auth-v2.dat` 更新

**wukong 通道**：
- 原因：xrl-router 未透传 Authorization 头，或 API key 过期
- 排查：确认 `WUKONG_KEYS` 中有有效的 DEAP API key

### 406 Not Acceptable (wukong)

- 原因：请求头包含 `Accept: text/event-stream`，DEAP 网关拒绝该值
- 修复：确认 `wukong/client.ts` 的 `buildDeapHeaders()` 中**不包含** Accept 头（当前实现已正确排除）

### 400 Bad Request (wukong)

- 原因：缺少必需的 `x-dingtalk-*` 业务头
- 排查：检查 `buildDeapHeaders()` 输出的 12 个头是否完整；DEAP 网关对缺少任何 `x-dingtalk-` 头的请求返回 400
- 常见缺失：`x-dingtalk-biz-param`、`x-dingtalk-ability-code`

### 550 动态通道池 (wukong)

- 原因：DEAP 后端动态通道池繁忙或无可用实例
- 表现：间歇性 550 响应
- 修复：由 xrl-router 层自动重试；若持续出现，检查 DEAP 服务端状态

### WebSocket 连接失败

- 表现：`[PluginClient] WebSocket error` + 指数退避重连日志
- 排查：
  1. 确认 `XRL_ROUTER_URL` 指向运行中的 xrl-router 实例
  2. 检查 xrl-router 的 `/ws/plugin` 端点是否可达
  3. 重连间隔最大 60s，连续失败时检查网络/firewall

### 系统代理问题 (wukong capture)

- 表现：`pnpm capture-key` 抓取 wukong 通道密钥时超时或返回异常数据
- 原因：钉钉悟空客户端走系统代理，抓包工具（如 mitmproxy）未正确配置证书信任
- 修复：
  1. 确认系统代理指向抓包工具
  2. 安装并信任抓包工具的 CA 证书
  3. 钉钉客户端可能需要额外的证书注入（Electron 的 `--ignore-certificate-errors` 不适用）

### auth-v2.dat 解密失败 (qwenwork, macOS)

- 表现：`[qwenwork] auth-v2.dat 解密失败: auth 文件头不是 v10`
- 原因：千问办公 App 未登录（文件不存在）或文件格式变更
- 修复：打开千问办公 App 登录，触发 `auth-v2.dat` 重新生成；或依赖 `.env QWEN_KEYS` 自举

### token 所有源均失败

- 表现：`无可用 token 源（auth-v2.dat 缺失/失效且 QWEN_KEYS 为空）`
- 排查顺序：
  1. 千问办公 App 是否已登录（`auth-v2.dat` 存在？）
  2. `.env` 中 `QWEN_KEYS` 是否有值
  3. macOS Keychain 中 `QwenWorkCN Safe Storage` 条目是否存在（`security find-generic-password -s "QwenWorkCN Safe Storage" -a "QwenWorkCN Key"`）
