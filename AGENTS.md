# AGENTS.md — 实现原理与开发指南

> 本文档面向**要改这个仓库代码的开发者 / AI Agent**，讲清楚「它是怎么实现的」。
> 如果你只想**用**这个服务，请看 [README.md](./README.md)。

---

## 🔑 先拿到 deap API Key（运维前置）

直连 deap 网关需要一枚 `DEAP_API_KEY`——它是本机已登录的悟空 daemon 调 deap 时挂在请求头里的
临时密钥（`sk-` + 32 位小写字母数字，约 **29 天**有效）。

**获取方式：`pnpm capture-key`**（[scripts/capture-key.ts](./scripts/capture-key.ts)，用 `tsx` 跑）。
该脚本自动完成「起 mitmdump → 开系统代理（需输一次 sudo 密码）→ 触发 daemon 发请求 →
抓 key → 校验 → 写 `.env` → 还原系统代理」。当 `.env` 里的 key 失效（代理对 deap 返回
`401 unauthorized`）或首次配置时跑一次即可。原理见 [docs/CAPTURE_DEAP_KEY.md](./docs/CAPTURE_DEAP_KEY.md)，
抓包脚本固定在 [scripts/cap_deap.py](./scripts/cap_deap.py)（mitmproxy addon，必需）。

> 关键点：daemon 的 chat 客户端**无视代理环境变量，只认 macOS 系统级代理**，所以脚本用
> `networksetup` 开系统代理来拦截（用完务必还原，脚本 finally 已保证）。
> 红线：`.env` 与 key 永不进 git；抓完必须还原系统代理并焚毁含明文 key 的抓包日志。

---

## 一句话架构

这是一个**协议翻译代理**：对外说 Anthropic 协议，对内直连钉钉 deap 网关（OpenAI 兼容），
在两种格式之间双向转换，并完整透传 function calling（tools）。

```
 Anthropic /v1/messages
   ─▶  Express (本仓库)  ─▶ HTTPS + DEAP_API_KEY ─▶ api-deap.dingtalk.com (多模型网关)
   index → adapter → deapClient        (OpenAI 协议, tools / tool_calls 双向翻译)
   dingtalk-auto→qwen3.7-plus · claude-opus-4-8→真Claude · gpt-4o→真GPT
```

**核心认知**：本服务自身不跑任何模型，全部能力来自远端 deap 网关（鉴权靠 `DEAP_API_KEY`）。
悟空 App 不在运行链路里，只在抓 key 时用到。

---

## 源码结构

```
src/
├── index.ts         # Express 入口：路由、API 鉴权、跨平台端口释放、服务启动
├── config.ts        # 配置：集中读取环境变量 → 导出单例 settings
├── types.ts         # 类型：Anthropic 请求/响应/工具块 的 TS 接口
├── adapter.ts       # 适配器：Anthropic ⇄ deap(OpenAI) 双向翻译（含 tools）
└── deapClient.ts    # deap 客户端：直连网关，拼头/拼体，解析 JSON/SSE
```

依赖关系：`index` →（`adapter` + `deapClient`）→（`config` + `types`）。
另有 `scripts/capture-key.ts`（一键抓 key）+ `scripts/cap_deap.py`（mitmproxy addon）。

---

## 一次请求的完整生命周期

以 `POST /v1/messages`（`src/index.ts`）为例：

1. **鉴权**：`verifyApiKey` 中间件（`index.ts`）。仅当 `settings.apiKey` 非空时校验 `x-api-key` 头，不匹配返回 401。
2. **分支**：
   - **流式**（`request.stream === true`）：设置 SSE 响应头，`for await` 消费 `AnthropicAdapter.streamResponse(request, deapClient)`，逐个 `res.write` 事件。
   - **非流式**：`AnthropicAdapter.chat(request, deapClient)` 拿 `AnthropicResponse` JSON 返回。
3. **错误处理**：异常被 catch；流式且 headers 已发送则写一个 `event: error` SSE 再 `end`，否则返回 `500 { error }`。

---

## 模块逐一拆解

### 1. `config.ts` — 配置单例

唯一读取 `process.env` 的地方，导出不可变的 `settings`。关键项：

```typescript
deapApiKey:      process.env.DEAP_API_KEY           // sk-...，必填
deapBaseUrl:     'https://api-deap.dingtalk.com/dingtalk/v1'
wukongModel:     'dingtalk-auto'                     // 兜底模型（不可用时回退）
availableModels: ['dingtalk-auto','claude-opus-4-8','gpt-4o']  // /v1/models 展示候选
enableExtendedThinking / channelRetryMax / modelAvailabilityTtlMs  // thinking、重试、缓存 TTL
// + 8 个 deap_* 业务头（user-type/scenario-code/product-code/ability-code/...）
```

> 💡 模型路由：adapter 信任客户端请求里的 `model` 直传 deap；deap 返回 403（模型不可用）时由
> deapClient 自动兜底到 `wukongModel` 并短期缓存。deap 是多模型网关：`dingtalk-auto`→`qwen3.7-plus`、
> `claude-opus-4-8`→真 Claude、`gpt-4o`→真 GPT。`availableModels` 仅用于 `/v1/models` 展示，不参与路由。

### 2. `types.ts` — 类型定义

`AnthropicRequest` / `AnthropicResponse` / `Message` / `Usage` 等。**重点**：`AnthropicTool`、
`ToolUseBlock`（响应里的工具调用块）、`ThinkingBlock`（扩展思考块，透传 deap 的 `reasoning_content`）。
`AnthropicRequest.thinking` 控制 Extended Thinking 开关；`Message.content` 是 `string | ContentBlock[]`
（`ContentBlock` 为透传用的宽泛类型），适配器对两种形态都兼容。

### 3. `deapClient.ts` — deap 客户端（核心）

封装对 deap 网关的一切调用。

#### 3.1 `buildHeaders()` — 必带的一整套业务头
`Authorization: Bearer <key>` + `Content-Type` + 一组会话/追踪 id（随机 UUID）+ 8 个 `x-dingtalk-*` / `x-wukong-*` 业务头（从 `settings` 取，缺一会被 deap 拒 400）。
> ⚠️ **绝不能设 `Accept: text/event-stream`**——deap 会因该头返回 406。

#### 3.2 `buildBody()` — 请求体形态
`{model, stream, max_tokens, temperature, enable_thinking:false, stream_options?, extra_body:{user_query}, messages, tools?, tool_choice?}`。流式必须带 `stream_options`/`temperature`/`enable_thinking`/`extra_body`，否则 406。

#### 3.3 `chat()` — 非流式（`deapClient.ts`）
返回 `DeapChatResult`：`{text, reasoning?, toolCalls, finishReason, usage}`。从 `choices[0].message` 取正文文本（兼容 string 与数组形态）、`reasoning_content`（思考链）与 `tool_calls[]`，**真实 usage**（prompt/completion tokens）。通过 `fetchWithRetry` 统一处理 403 模型兜底 + 550 渠道重试。

#### 3.4 `chatStream()` — 流式（`deapClient.ts`）
解析 SSE，产出事件：`{kind:'thinking', thinking}`（思考增量，仅 `enable_thinking=true`）、
`{kind:'text', text}`（正文增量）、`{kind:'tool_call_start', index, id, name}`、
`{kind:'tool_call_args', index, args}`（arguments 逐块增量）、`{kind:'done', finishReason, usage}`。
这是上层 adapter 翻译成 Anthropic SSE 的原料。通过 `fetchWithRetry` 统一处理 550 渠道重试 + 403 模型兜底（首字节前可安全切换）。

#### 3.5 `healthCheck()`
发一句「你好」非流式，拿到非空文本即健康。

### 4. `adapter.ts` — Anthropic ⇄ deap(OpenAI) 翻译

全是静态方法。核心职责：把 Anthropic 的 `tools`/`tool_use`/`tool_result` 与 deap 的 `tools`/`tool_calls`/`role:tool` 互相翻译。

#### 4.1 入向：`buildDeapMessages()` + `buildDeapTools()`
- `buildDeapMessages`：`system` 提升为第一条 system 消息；逐条翻译 user/assistant。
  assistant 的 `tool_use` 块 → `message.tool_calls[]`；user 的 `tool_result` 块 → 独立的 `role:'tool'` 消息（带 `tool_call_id`）。末尾 assistant 消息（Pre-filling）原样透传给 deap 续写。
- `buildDeapTools`：Anthropic `tools`（`input_schema`）→ deap `tools`（`function.parameters`）；`tool_choice` 也按 `auto/any/none/tool` 翻译。

#### 4.2 模型路由：`resolveModel()`
直接信任客户端请求里的 `model` 透传给 deap（空则用 `wukongModel`）；模型不可用的兜底由 deapClient 负责。

#### 4.3 出向非流式：`chat()`
调 `deapClient.chat`，把结果翻译成 `AnthropicResponse`：`reasoning` → `thinking` block，正文 → `text` block，`tool_calls` → `tool_use` block（arguments 反序列化成 `input`），`finish_reason:'tool_calls'` → `stop_reason:'tool_use'`。**usage 优先用 deap 返回的真实值**（`prompt_tokens`/`completion_tokens`），缺失时才 fallback 估算（消息数×100 / 文本长度÷4）。

#### 4.4 出向流式：`streamResponse()`
把 deap 的增量翻译成**标准 Anthropic SSE 序列**：
```
message_start
→ content_block_start(text) → content_block_delta(text_delta)×N → content_block_stop
→ content_block_start(tool_use) → content_block_delta(input_json_delta)×N → content_block_stop
→ message_delta(stop_reason, usage) → message_stop
```
关键：文本块与工具块各占一个 index，工具的 arguments 增量以 `input_json_delta` 的 `partial_json` 流式下发。每个事件必须 `event:<type>\ndata:<json>\n\n` 结尾。

### 5. `index.ts` — 服务器入口

#### 5.1 `killPortProcess()` — 启动前释放端口
`lsof -ti :port` 拿 PID 再 `kill -9`，避免 `EADDRINUSE`。

#### 5.2 路由表

| 路由 | 中间件 | 说明 |
|------|--------|------|
| `GET /` | — | 服务信息：`backend:deap`、`tools_supported:true` |
| `GET /health` | — | `deapClient.healthCheck()` |
| `POST /v1/messages` | `verifyApiKey` | 核心，流式/非流式 + tools 分流 |
| `GET /v1/models` | `verifyApiKey` | 返回候选模型列表（默认 dingtalk-auto/claude-opus-4-8/gpt-4o） |
| `GET /user/balance` | — | mock 彩蛋 `remaining:114514.1919`，供某些客户端探活 |

---

## 关键设计决策

**1. 为什么直连 deap 而不是 spawn wukong-cli？**
wukong-cli 路径只接受单段字符串 prompt，会丢掉 tools/结构化历史；且会引入子进程与会话目录的复杂度。直连 deap 网关（OpenAI 兼容）天然支持 function calling，延迟更低。

**2. 为什么 tools 要双向翻译？**
客户端说 Anthropic 协议（`tool_use`/`tool_result`），deap 说 OpenAI 协议（`tool_calls`/`role:tool`）。adapter 是唯一的翻译层，让 Claude Code 等客户端能真实调用工具。

**3. 为什么 deap 会 406 / 怎么避免？**
两个坑：(a) 流式不能带 `Accept: text/event-stream`；(b) 流式 body 必须带 `stream_options`/`temperature`/`enable_thinking`/`extra_body`。`buildHeaders`/`buildBody` 已处理。

**4. 为什么 Node + TypeScript + tsx？**
类型安全 + tsx 免编译热重载（`pnpm serve` 即 `tsx watch`）。脚本也统一 TS（`capture-key.ts`）。

---

## 已知限制

| 现状 | 说明 |
|------|------|
| 多模型网关 | `dingtalk-auto`→qwen3.7-plus；`claude-opus-4-8`/`gpt-4o` 走第三方渠道，能力随真模型 |
| 第三方渠道偶发 550 | claude/gpt 依赖 deap 动态渠道池，偶发 `No available channel`，代理自动重试（默认 3 次） |
| key 会过期 | 约 29 天，需重跑 `pnpm capture-key` |
| 无测试 | — |

---

## 本地开发速查

```bash
pnpm install        # 装依赖
pnpm serve          # 热重载开发（tsx watch）
pnpm capture-key    # 抓/续 deap key
```

调试 deap 原始返回（排查协议问题时）直接看 `src/deapClient.ts` 的解析逻辑；
若 SSE 客户端收不到事件，先检查 `src/adapter.ts:streamResponse` 每个事件是否以 `\n\n` 结尾。
