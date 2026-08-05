# wukong-forward: 悟空通道 DEAP 桥接

## 目标

将标准 OpenAI Chat Completions 请求透传到 api-deap.dingtalk.com DEAP 网关，注入必需的 12 个业务头 + 请求体清洗，使上游钉钉 DEAP 对调用方表现为标准 OpenAI 兼容端点喵～

## 输入输出

**输入：**
- HTTP POST `/v1/chat/completions`（完整 `req` 对象，含 `req.headers` + `req.body`）
- Body：标准 OpenAI Chat Completions JSON
- Header：`Authorization: Bearer <sk-...>`（xrl-router 密钥池透传的 DEAP key）

**输出：**
- 流式（`stream: true`）：按行拆分后逐行 flush 透传上游 SSE（解决 TCP 合包问题）
- 非流式：直接透传上游 JSON 响应

## 关键约束

### buildDeapHeaders — 12 个业务头

缺一任何 `x-dingtalk-*` 都会被上游拒 400 喵：

| 头名 | 来源 |
|---|---|
| `Authorization` | `Bearer ${deapKey}` |
| `Content-Type` | `application/json` |
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

**关键禁忌**：**绝不设 `Accept: text/event-stream`** — DEAP 网关会因此返回 406喵！

### buildDeapBody — 请求体清洗

1. **注入默认值**：`max_tokens ?? 4096`、`temperature ?? 0.6`、`enable_thinking ?? true`、`enable_search: true`
2. **流式额外**：`stream_options: { include_usage: true }`（仅 `stream: true` 时）
3. **extra_body 注入**：
   - `enable_thinking`：同顶层
   - `user_query`：从 `messages` 中提取最后一条 `role: "user"` 的 `content`（string 类型）
   - `enable_search: true`
   - 合并调用方传入的 `body.extra_body`（spread 覆盖）

### 流式透传（按行拆分 + 逐行 flush）

- `reader.read()` → `TextDecoder` 解码 → 按 `\n` 拆分 → 逐行 `res.write(line + '\n')` + `flush()`
- 用 buffer 拼接跨 chunk 的不完整行（`lines.pop()` 留给下次）
- 流结束后刷出 buffer 中剩余内容
- 设置 4 个 SSE 响应头：`Content-Type`、`Cache-Control`、`Connection`、`X-Accel-Buffering`
- `res.socket.setNoDelay(true)`
- **原因**：上游 TCP 批量合包导致客户端「一块一块出」，按行 flush 确保流式输出平滑（D-10）

### 非流式透传

- `resp.json()` → `res.json(data)` — 直接 JSON 透传，不修改结构

### 错误处理

- 无 `Authorization` 头 → 401
- 上游非 2xx → 透传 status code + body 文本给 xrl-router（由 xrl-router 处理重试逻辑）
- fetch 异常 → 502 + `Upstream error: ${message}`

## 验收标准

- [ ] 传入有效 `sk-` key，返回 200 + DEAP 响应
- [ ] 不传 Authorization → 401
- [ ] 流式：客户端逐行收到 SSE 数据（不是一块一块出）
- [ ] 非流式：客户端收到的 JSON 与上游 DEAP 返回完全一致
- [ ] 请求头包含全部 12 个 DEAP 业务头
- [ ] 请求头不含 `Accept: text/event-stream`
- [ ] body 含 `extra_body.user_query`（从最后一条 user message 提取）
- [ ] body 含 `enable_thinking`、`enable_search`、`max_tokens`、`temperature` 默认值
- [ ] 上游 4xx/5xx → 原样透传 status + body

## 已知边界

- DEAP key 格式为 `sk-` + 32 字符 `[0-9a-z]`（非 hex），有效期约 29 天
- `user_query` 提取逻辑：只取 `content` 为 string 的最后一条 user message；若所有 user message 的 content 都非 string → 空字符串
- 上游 `resp.body` 为 null 时直接 `res.end()`（不报错）
- 模型展示名：wukong 通道不再做别名映射，model_id 即 display_name（默认 `qwen3.7-max`、`qwen3.7-plus`）
- 不做 token 刷新、签名、SSE 解包 — 与 qwenwork 通道的根本区别
