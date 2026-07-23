# Claude Code / Anthropic Messages API 还原度总表

> **说明**：本表仅对比 **Anthropic 官方原生支持的特性**，不包含项目自研的适配层。

| 重要性 | 特性 | 描述 | 还原情况 |
|--------|------|------|----------|
| ⭐️⭐️⭐️⭐️⭐️ | SSE 流式响应 | Anthropic `/v1/messages` 支持 `stream: true`，产出标准 SSE 事件序列（`message_start` → `content_block_delta`×N → `message_delta` → `message_stop`） | **100%** ✅ 完整实现（`src/index.ts:98-124`, `src/adapter.ts:465-665`） |
| ⭐️⭐️⭐️⭐️⭐️ | Function Calling / Tool Use | 支持 `tools[]` 定义、`tool_choice` 控制、`tool_use` / `tool_result` blocks 双向映射 | **100%** ✅ 完整实现（`src/adapter.ts:30-52, 130-149, 150-216`） |
| ⭐️⭐️⭐️⭐️⭐️ | Prompt Caching（Cache Control） | 在 system / message content / tools 数组里加 `cache_control: { type: 'ephemeral' }` 标记，触发缓存命中 | **100%** ✅ 完整实现（`src/adapter.ts:50-131`, `src/types.ts:4-6, 27, 34`） |
| ⭐️⭐️⭐️⭐️⭐️ | Extended Thinking（思考链） | 支持 `thinking: { type: 'enabled'\|'disabled' }`，透传 deap `reasoning_content`，流式产出 `thinking_delta` | **100%** ✅ 完整实现（`src/adapter.ts:269-277`, `src/deapClient.ts:381-387, 429-430, 510-511`） |
| ⭐️⭐️⭐️⭐️ | Structured Content Blocks | message content 可是 `{ type: 'text'\|'tool_use'\|'thinking', ... }[]` 结构化数组 | **60%** ⚠️ 部分实现：支持 text / tool_use / thinking；❌ image / document 静默丢弃（`src/adapter.ts:159-183, 185-216`） |
| ⭐️⭐️⭐️⭐️ | Pre-filling（末尾 assistant 续写） | 允许最后一条消息是 `role: assistant`，模型接着其内容续写 | **80%** ⚠️ 模拟实现：靠末尾 assistant 消息原样透传（`src/adapter.ts:234-244`）；未使用独立 `prefill` 参数 |
| ⭐️⭐️⭐️⭐️ | Usage 统计 | 返回 `input_tokens`, `output_tokens`, `total_tokens`, `cache_read_input_tokens` | **80%** ⚠️ 部分实现：缺 `cache_creation_input_tokens`（deap 不返回该字段）（`src/adapter.ts:367-411, 654-662`） |
| ⭐️⭐️⭐️⭐️ | WebSearch（联网搜索） | server-side `web_search` tool（`type: web_search_20250305`），产出 `server_tool_use` + `web_search_tool_result` 块，客户端搜索计数 > 0 | **70%** ⚠️ **协议块兼容**（客户端可正常消费），但实现为**网关代办**而非 Anthropic 原生服务端搜索：甲路（deap `enable_search` 透传）已实测失败 → 走乙路：拦截 web_search → 注入内部 function → 模型 tool_call → 调 `cn.bing.com` 网页版（cheerio 解析）→ 伪造搜索块 → 喂回 deap 多轮续写（上限 3 轮），流式为真流式跨轮。**局限**：cn.bing.com 对时效性 query（天气/股价）结果质量弱、无真实 `encrypted_content`（用 snippet 替代）、有反爬/改版风险（`src/search.ts:41-76`, `src/adapter.ts:287-349, 353-463, 465-665`, `src/types.ts:81-107`, `src/config.ts:51-59`） |
