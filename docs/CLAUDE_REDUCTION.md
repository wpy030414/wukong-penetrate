# Claude Code / Anthropic Messages API 还原度总表

> **说明**：本表仅对比 **Anthropic 官方原生支持的特性**，不包含项目自研的适配层。

| 重要性 | 特性 | 描述 | 还原情况 |
|--------|------|------|----------|
| ⭐️⭐️⭐️⭐️⭐️ | SSE 流式响应 | Anthropic `/v1/messages` 支持 `stream: true`，产出标准 SSE 事件序列（`message_start` → `content_block_delta`×N → `message_delta` → `message_stop`） | **100%** ✅ 完整实现（`src/index.ts:98-124`, `src/adapter.ts:350-468`） |
| ⭐️⭐️⭐️⭐️⭐️ | Function Calling / Tool Use | 支持 `tools[]` 定义、`tool_choice` 控制、`tool_use` / `tool_result` blocks 双向映射 | **100%** ✅ 完整实现（`src/adapter.ts:27-38, 121-137, 148-200`） |
| ⭐️⭐️⭐️⭐️⭐️ | Prompt Caching（Cache Control） | 在 system / message content / tools 数组里加 `cache_control: { type: 'ephemeral' }` 标记，触发缓存命中 | **100%** ✅ 完整实现（`src/adapter.ts:44-119`, `src/types.ts:69-71`） |
| ⭐️⭐️⭐️⭐️⭐️ | Extended Thinking（思考链） | 支持 `thinking: { type: 'enabled'\|'disabled' }`，透传 deap `reasoning_content`，流式产出 `thinking_delta` | **100%** ✅ 完整实现（`src/adapter.ts:261-266`, `src/deapClient.ts:251-254, 332-335`） |
| ⭐️⭐️⭐️⭐️ | Structured Content Blocks | message content 可是 `{ type: 'text'\|'tool_use'\|'thinking', ... }[]` 结构化数组 | **60%** ⚠️ 部分实现：支持 text / tool_use / thinking；❌ image / document 静默丢弃（`src/adapter.ts:148-167, 174-200`） |
| ⭐️⭐️⭐️⭐️ | Pre-filling（末尾 assistant 续写） | 允许最后一条消息是 `role: assistant`，模型接着其内容续写 | **80%** ⚠️ 模拟实现：靠末尾 assistant 消息原样透传（`src/adapter.ts:223-233`）；未使用独立 `prefill` 参数 |
| ⭐️⭐️⭐️⭐️ | Usage 统计 | 返回 `input_tokens`, `output_tokens`, `total_tokens`, `cache_read_input_tokens` | **80%** ⚠️ 部分实现：缺 `cache_creation_input_tokens`（deap 不返回该字段）（`src/adapter.ts:313-327, 457-460`） |
| ⭐️⭐️⭐️ | Stop Sequences | 支持 `stop_sequences: string[]` 参数，`stop_reason` 可为 `end_turn` / `max_tokens` / `stop_sequence` / `tool_use` | **0%** ❌ 未实现：未透传 `stop` 给 deap；`stop_reason` 硬编码（`src/adapter.ts:335`） |
| ⭐️⭐️⭐️ | Image / Vision 输入 | 支持 `type: 'image'` content block（base64 编码 + `media_type` + `detail`） | **0%** ❌ 未实现：遇到 image 块静默丢弃（`src/adapter.ts:148-167`） |
| ⭐️⭐️⭐️ | Metadata / User ID 追踪 | 支持 `metadata: { user_id, ... }` 用于计费/审计 | **20%** ⚠️ 定义但未使用（`src/types.ts:37-40` 定义了字段，实际代码从未读取或透传） |
| ⭐️⭐️ | Document / PDF 上传 | 支持 `type: 'document'` block（base64 编码 PDF/TXT + `filename`） | **0%** ❌ 未实现 |
| ⭐️⭐️ | System 结构化数组 | system 可是 `{ type: 'text'\|'image', text: ..., cache_control?: ... }[]` | **40%** ⚠️ 只提取 text 拼成字符串；❌ image 或其他类型会被静默丢弃（`src/adapter.ts:44-66`） |
| ⭐️ | Batch API | 异步批量接口 `/v1/messages/batches` | **0%** ❌ 未实现（本代理面向实时交互，批量场景极少） |
| ⭐️⭐️⭐️⭐️⭐️ | Computer Use / Local Tool Execution | Claude Code 可在沙箱里执行 shell / Python / 文件操作，并把结果回传 | **0%** ❌ 不执行任何本地工具（架构限制：本代理只做协议翻译，工具执行在 deap 后端） |
