# TSD — xrl-router-plugin-wukong

> **技术规格文档** — 钉钉 DEAP 协议桥接插件

| 字段 | 内容 |
|------|------|
| 产品名称 | xrl-router-plugin-wukong |
| 版本 | 0.1.0 |
| 最后更新 | 2026-08-01 |

---

## 1. 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                      xrl-router (上游)                           │
│   密钥轮转 · 请求分发 · 重试 · /v1/models · /v1/chat/completions │
└──────────────────┬──────────────────────────────────────────────┘
                   │ HTTP POST (Authorization: Bearer <key>)
                   ▼
┌─────────────────────────────────────────────────────────────────┐
│              xrl-router-plugin-wukong (本插件)                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  Express     │  │  PluginClient│  │  DEAP 头/体注入       │  │
│  │  HTTP Server │  │  (WebSocket) │  │  buildDeapHeaders()   │  │
│  │  :19067      │  │  心跳/重连   │  │  buildDeapBody()      │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘  │
│         │                 │                     │               │
└─────────┼─────────────────┼─────────────────────┼───────────────┘
          │                 │                     │ HTTPS
          │                 │                     ▼
          │                 │        ┌────────────────────────┐
          │                 │        │  api-deap.dingtalk.com │
          │                 │        │  /dingtalk/v1/chat/    │
          │                 │        │  completions           │
          │                 │        └────────────────────────┘
          │                 │
          │                 └── ws://localhost:19068/ws/plugin
          │
          └── OpenAI Chat Completions 协议
```

### 1.1 设计原则

| 原则 | 说明 |
|------|------|
| **纯翻译层** | 插件只做协议翻译（OpenAI → DEAP），不管密钥、不管轮换、不管 Anthropic 翻译 — 这些全部由 xrl-router 负责 |
| **无状态** | 插件不缓存任何请求状态，每次请求独立处理 |
| **透传字节流** | 流式响应直接透传 DEAP 返回的 SSE 字节流，不做任何解析 |
| **自动恢复** | WebSocket 断线自动重连（指数退避），端口占用自动释放 |

---

## 2. 源码结构

```
src/
├── index.ts          # Express 入口：路由、DEAP 头/体注入、端口释放、服务启动
├── config.ts         # 配置：集中读取环境变量 → 导出单例 settings
└── pluginClient.ts   # WebSocket 客户端：连接 xrl-router、心跳、重连、密钥推送

scripts/
├── capture-key.ts    # 一键抓密钥（跨平台：macOS + Windows）
└── cap_deap.py       # mitmproxy addon：捕获 DEAP 请求头，提取 Bearer Key
```

依赖关系：`index` → `pluginClient` → `config`

---

## 3. 模块设计

### 3.1 `config.ts` — 配置单例

唯一读取 `process.env` 的地方，导出不可变的 `settings` 对象喵～

```typescript
export interface Settings {
  port: number;                           // HTTP 端口，默认 19067
  availableModels: string[];              // 注册给 xrl-router 的模型列表
  baseUrl: string;                        // DEAP 网关 base url
  deapUserType: string;                   // DEAP 业务头
  deapScenarioCode: string;               // DEAP 业务头
  deapProductCode: string;                // DEAP 业务头
  deapAbilityCode: string;                // DEAP 业务头
  deapWukongClientVersion: string;        // 悟空客户端版本（动态检测）
  deapWukongDeviceType: string;           // DEAP 业务头
  deapAgentLoopVersion: string;           // DEAP 业务头
  deapBizParam: string;                   // DEAP 业务头
  xrlRouterUrl: string;                   // xrl-router 地址
}
```

**关键设计：**
- `deapWukongClientVersion` 动态检测：Windows 从 `C:\Program Files\Wukong\<version>\` 目录名推断，兜底 `0.9.65-26061702`
- 所有 DEAP 业务头都有默认值（来自对真实 App 请求的反汇编抓取），可通过环境变量覆盖

### 3.2 `pluginClient.ts` — WebSocket 客户端

连接 xrl-router 的 WebSocket 客户端，负责注册、心跳、密钥推送喵～

```typescript
export class PluginClient {
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private envPollTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastKeys: string[] = [];
  private connected = false;

  constructor() {
    this.loadCurrentKeys();   // 加载 .env 中的密钥池
    this.connect();           // 连接 xrl-router
    this.startEnvPolling();   // 启动 .env 轮询
  }
}
```

#### 3.2.1 注册消息

连接成功后发送 `register` 消息：

```json
{
  "type": "register",
  "plugin_id": "xrl-router-plugin-wukong",
  "provider": {
    "kind": "openai",
    "base_url": "http://localhost:19067",
    "api_path": "/v1/chat/completions"
  },
  "models": [
    { "model_id": "dingtalk-auto", "display_name": "qwen3.7-plus", "tier": "custom" },
    { "model_id": "claude-opus-4-8", "display_name": "claude-opus-4-8", "tier": "opus" },
    { "model_id": "gpt-4o", "display_name": "gpt-4o", "tier": "custom" }
  ],
  "keys": ["sk-xxxx", "sk-yyyy", ...]
}
```

#### 3.2.2 心跳保活

每 30s 发送心跳：

```json
{ "type": "heartbeat", "timestamp": 1722508800000 }
```

#### 3.2.3 密钥推送

每 5s 轮询 `.env`，检测 `WUKONG_KEYS` 变化后推送：

```json
{ "type": "keys_update", "keys": ["sk-xxxx", "sk-yyyy", ...] }
```

#### 3.2.4 断线重连

指数退避策略：

```
delay = min(1000ms * 2^attempts, 60000ms)
```

| attempts | delay |
|----------|-------|
| 0 | 1s |
| 1 | 2s |
| 2 | 4s |
| 3 | 8s |
| 4 | 16s |
| 5 | 32s |
| 6+ | 60s (cap) |

### 3.3 `index.ts` — HTTP 服务器

Express 服务器，负责接收 xrl-router 转发的请求并注入 DEAP 协议喵～

#### 3.3.1 路由表

| 路由 | 方法 | 说明 |
|------|------|------|
| `/` | GET | 服务信息（版本、后端、模式） |
| `/health` | GET | 健康检查（轻量级，不发请求到 DEAP） |
| `/v1/chat/completions` | POST | **核心端点**，OpenAI Chat Completions API |

#### 3.3.2 DEAP 头注入

`buildDeapHeaders(deapKey)` 组装 DEAP 要求的一整套请求头：

```typescript
{
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${deapKey}`,
  'x-litellm-session-id': randomUUID(),
  'x-dingtalk-ability-call-session-id': randomUUID(),
  'x-dingtalk-biz-id': randomUUID(),
  'x-dingtalk-user-type': settings.deapUserType,
  'x-dingtalk-scenario-code': settings.deapScenarioCode,
  'x-dingtalk-product-code': settings.deapProductCode,
  'x-dingtalk-ability-code': settings.deapAbilityCode,
  'x-wukong-client-version': settings.deapWukongClientVersion,
  'x-wukong-device-type': settings.deapWukongDeviceType,
  'x-wukong-agent-loop-version': settings.deapAgentLoopVersion,
  'x-dingtalk-biz-param': settings.deapBizParam,
}
```

> ⚠️ **绝不能设 `Accept: text/event-stream`** — DEAP 会因该头返回 406 喵～

#### 3.3.3 DEAP 体注入

`buildDeapBody(body)` 注入 DEAP 特有字段：

```typescript
{
  ...body,
  max_tokens: body.max_tokens ?? 4096,
  temperature: body.temperature ?? 0.6,
  enable_thinking: body.enable_thinking ?? true,
  enable_search: true,
  ...(isStream ? { stream_options: { include_usage: true } } : {}),
  extra_body: {
    enable_thinking: body.enable_thinking ?? true,
    user_query: userQuery,  // 从 messages 中提取最后一条 user 消息
    enable_search: true,
    ...(body.extra_body || {}),
  },
}
```

> 💡 DEAP 要求流式请求必须带 `stream_options` / `temperature` / `enable_thinking` / `extra_body`，否则返回 406 喵～

#### 3.3.4 请求处理流程

```
POST /v1/chat/completions
  ↓
1. 提取 Authorization 头中的 DEAP 密钥
  ↓
2. buildDeapBody(req.body) — 注入 DEAP 特有字段
  ↓
3. buildDeapHeaders(deapKey) — 组装 DEAP 业务头
  ↓
4. fetch(`${settings.baseUrl}/chat/completions`, { method: 'POST', headers, body })
  ↓
5a. 流式（stream: true）：
    - 设置 SSE 响应头（Content-Type: text/event-stream）
    - 透传 DEAP 返回的字节流（reader.read() → res.write()）
    - 调用 res.flush() 确保立即推送
  ↓
5b. 非流式：
    - 解析 JSON 响应
    - res.json(data)
  ↓
6. 错误处理：
    - DEAP 返回非 2xx：直接返回给 xrl-router（xrl-router 的 retry loop 会换 key 重试）
    - 网络异常：返回 502 { error: { message: "Upstream error: ..." } }
```

#### 3.3.5 端口释放

`killPortProcess(port)` 启动前自动检测并释放被占用的端口：

```typescript
async function killPortProcess(port: number): Promise<void> {
  if (process.platform === 'win32') {
    // Windows: netstat -ano → 找 PID → taskkill /F /PID
  } else {
    // macOS/Linux: lsof -ti :port → kill -9
  }
}
```

---

## 4. 协议细节

### 4.1 OpenAI Chat Completions → DEAP

本插件接收的 OpenAI 协议请求（由 xrl-router 转发）：

```json
POST /v1/chat/completions
Authorization: Bearer sk-xxxx
Content-Type: application/json

{
  "model": "claude-opus-4-8",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "你好" }
  ],
  "stream": true,
  "max_tokens": 4096,
  "temperature": 0.6
}
```

插件注入 DEAP 业务头后转发：

```json
POST https://api-deap.dingtalk.com/dingtalk/v1/chat/completions
Authorization: Bearer sk-xxxx
Content-Type: application/json
x-dingtalk-user-type: vip
x-dingtalk-scenario-code: com.dingtalk.scenario.wukong
x-dingtalk-product-code: AI_WUKONG
x-dingtalk-ability-code: M_AI_WUKONG
x-wukong-client-version: 0.9.65-26061702
x-wukong-device-type: 2
x-wukong-agent-loop-version: V2
x-dingtalk-biz-param: {"taskDes":"5L2g5aW9"}
x-litellm-session-id: 550e8400-e29b-41d4-a716-446655440000
x-dingtalk-ability-call-session-id: 550e8400-e29b-41d4-a716-446655440001
x-dingtalk-biz-id: 550e8400-e29b-41d4-a716-446655440002

{
  "model": "claude-opus-4-8",
  "messages": [...],
  "stream": true,
  "max_tokens": 4096,
  "temperature": 0.6,
  "enable_thinking": true,
  "enable_search": true,
  "stream_options": { "include_usage": true },
  "extra_body": {
    "enable_thinking": true,
    "user_query": "你好",
    "enable_search": true
  }
}
```

### 4.2 DEAP 响应透传

#### 4.2.1 流式响应（SSE）

DEAP 返回的 SSE 字节流直接透传给 xrl-router：

```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1722508800,"model":"claude-opus-4-8","choices":[{"index":0,"delta":{"role":"assistant","content":"你好"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1722508800,"model":"claude-opus-4-8","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}

data: [DONE]
```

#### 4.2.2 非流式响应（JSON）

DEAP 返回的 JSON 直接透传给 xrl-router：

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1722508800,
  "model": "claude-opus-4-8",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "你好！" },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15 }
}
```

---

## 5. WebSocket 协议

### 5.1 连接

插件启动时连接 `ws://<xrl-router-host>/ws/plugin`喵～

### 5.2 消息类型

#### 5.2.1 插件 → xrl-router

| 类型 | 说明 | 示例 |
|------|------|------|
| `register` | 注册插件 | `{ "type": "register", "plugin_id": "...", "provider": {...}, "models": [...], "keys": [...] }` |
| `heartbeat` | 心跳保活 | `{ "type": "heartbeat", "timestamp": 1722508800000 }` |
| `keys_update` | 密钥池更新 | `{ "type": "keys_update", "keys": [...] }` |

#### 5.2.2 xrl-router → 插件

| 类型 | 说明 | 处理 |
|------|------|------|
| `registered` | 注册成功 | 静默 |
| `reconnected` | 重连成功 | 静默 |
| `keys_ack` | 密钥更新确认 | 静默 |
| `activated` | 插件激活 | 静默 |

> 💡 插件对 xrl-router 的消息均静默处理（无需动作）喵～

---

## 6. 部署与运维

### 6.1 部署步骤

```bash
# 1. 克隆仓库
git clone <repo-url>
cd wukong-penetrate

# 2. 安装依赖
pnpm install

# 3. 抓取 DEAP 密钥
pnpm capture-key

# 4. 启动服务
pnpm serve
```

### 6.2 环境变量

见 [README.md](./README.md#配置环境变量) 喵～

### 6.3 日志

插件日志直接输出到 stdout：

```
[PluginClient] Connected to xrl-router
[PluginClient] Disconnected from xrl-router
[PluginClient] Reconnecting in 1000ms (attempt 1)
[PluginClient] WebSocket error: ...
```

### 6.4 监控

| 指标 | 说明 | 获取方式 |
|------|------|----------|
| 服务状态 | 是否运行 | `curl http://localhost:19067/health` |
| WebSocket 连接 | 是否连接 xrl-router | 查看日志 `[PluginClient] Connected to xrl-router` |
| 密钥池 | 当前密钥数量 | 查看 `.env` 中 `WUKONG_KEYS` |

---

## 7. 故障排查

### 7.1 插件无法连接 xrl-router

**现象：** 日志显示 `[PluginClient] WebSocket error: connect ECONNREFUSED`

**原因：** xrl-router 未运行或地址配置错误

**处置：**
1. 检查 xrl-router 是否运行在 `http://localhost:19068`
2. 检查 `XRL_ROUTER_URL` 环境变量是否正确
3. 检查防火墙是否阻止 WebSocket 连接

### 7.2 DEAP 返回 406

**现象：** 流式请求返回 `406 Not Acceptable`

**原因：** DEAP 网关的特殊行为 — 流式请求不能带 `Accept: text/event-stream` 头

**处置：** 代码里已处理（不设该头），正常调用不会遇到；自己改 `src/index.ts:buildDeapHeaders()` 时注意别加这个头喵～

### 7.3 DEAP 返回 400

**现象：** 请求返回 `400 Bad Request`

**原因：** DEAP 业务头缺失

**处置：** 检查 `src/config.ts` 中的 DEAP 业务头配置是否完整喵～

### 7.4 密钥过期

**现象：** DEAP 返回 `401 unauthorized`

**原因：** `.env` 中的密钥过期（约 29 天有效）

**处置：** 重跑 `pnpm capture-key` 追加新密钥喵～

---

## 8. 设计决策

### 8.1 为什么作为 xrl-router 插件而不是独立服务？

旧版架构是独立的 Anthropic Messages API 代理（adapter.ts + deapClient.ts），但存在以下问题：
- 密钥管理逻辑重复（xrl-router 已有密钥池轮转）
- Anthropic 协议翻译复杂（tools / tool_use / tool_result 双向翻译）
- 无法复用 xrl-router 的重试逻辑

重构为 xrl-router 插件后：
- 插件只做协议翻译（OpenAI → DEAP），职责单一
- 密钥管理、重试逻辑全部由 xrl-router 负责
- 插件无状态，更易维护和扩展

### 8.2 为什么流式请求直接透传字节流？

DEAP 返回的 SSE 字节流已经是标准 OpenAI 格式，无需解析和翻译，直接透传可以：
- 减少延迟（不解析 JSON）
- 减少内存占用（不缓存响应）
- 降低复杂度（不处理 SSE 事件边界）

### 8.3 为什么 .env 轮询间隔是 5s？

- 太短（< 1s）：频繁读磁盘，增加 I/O 负担
- 太长（> 30s）：密钥更新延迟，用户体验差
- 5s 是平衡点：既能及时检测变化，又不会造成明显负担

### 8.4 为什么心跳间隔是 30s？

- 太短（< 10s）：增加网络负担
- 太长（> 60s）：可能被中间件（如 Nginx）断开空闲连接
- 30s 是 WebSocket 心跳的常见实践

---

## 9. 已知限制

| 现状 | 说明 |
|------|------|
| 密钥过期 | 约 29 天有效，需重跑 `pnpm capture-key` |
| 第三方模型偶发 550 | claude/gpt 依赖 DEAP 动态渠道池，偶发 `No available channel`，由 xrl-router 自动重试 |
| 无测试 | 当前无单元测试 / 集成测试 |

---

## 10. 附录

### 10.1 DEAP 业务头说明

| 头 | 说明 | 默认值 |
|---|---|---|
| `x-dingtalk-user-type` | 用户类型 | `vip` |
| `x-dingtalk-scenario-code` | 场景码 | `com.dingtalk.scenario.wukong` |
| `x-dingtalk-product-code` | 产品码 | `AI_WUKONG` |
| `x-dingtalk-ability-code` | 能力码 | `M_AI_WUKONG` |
| `x-wukong-client-version` | 悟空客户端版本 | 动态检测 |
| `x-wukong-device-type` | 设备类型 | `2` |
| `x-wukong-agent-loop-version` | Agent Loop 版本 | `V2` |
| `x-dingtalk-biz-param` | 业务参数 | `{"taskDes":"5L2g5aW9"}` |
| `x-litellm-session-id` | 会话 ID（随机 UUID） | 每次请求生成 |
| `x-dingtalk-ability-call-session-id` | 能力调用会话 ID（随机 UUID） | 每次请求生成 |
| `x-dingtalk-biz-id` | 业务 ID（随机 UUID） | 每次请求生成 |

### 10.2 参考资料

- [README.md](./README.md) — 快速开始与使用指南
- [PRD.md](./PRD.md) — 产品需求文档
