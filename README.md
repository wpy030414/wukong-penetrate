# wukong-penetrate

> **钉钉悟空模型穿透为 Anthropic 服务** —— 把钉钉悟空背后的 deap 大模型，包装成一个 **Anthropic Messages API 兼容**的本地 HTTP 代理。

任何能调 Anthropic API 的客户端（官方 SDK、LangChain、Claude Code、各类 IDE 插件……）都可以**零改造地改指到本地**，直接驱动悟空背后的通义千问模型，并**完整支持 function calling（tools）**。

```
你的客户端  --(Anthropic /v1/messages)-->  本代理  --(HTTPS)-->  deap 多模型网关
                                              (dingtalk-auto→qwen3.7-plus / claude-opus-4-8 / gpt-4o)
```

悟空 App 在这条链里**只在「抓密钥」那一刻用到**，运行时代理完全不碰悟空。

---

## 它能做什么

- 暴露标准 Anthropic `/v1/messages` 端点（JSON 与 SSE 流式）。
- **支持 tools / function calling**：把 Anthropic 的 `tools` / `tool_use` / `tool_result` 透传给 deap（OpenAI 兼容），再把 deap 的 `tool_calls` 翻译回 Anthropic 的 `tool_use` block，包括流式 `input_json_delta`。这让 Claude Code 等客户端能真实读写文件、执行命令。
- 直连 deap 网关，延迟低，不依赖 `wukong-cli` 子进程。

对你而言：**改个 `base_url`，就能用熟悉的 Anthropic SDK 驱动悟空模型了。**

---

## 前置要求

| 依赖 | 说明 |
|------|------|
| **Node.js** | ≥ 20 |
| **pnpm** | 包管理器（`npm i -g pnpm`） |
| **mitmproxy** | 仅抓密钥时需要（`brew install mitmproxy`）；运行代理时不需要 |
| **钉钉悟空 App** | 仅用于抓取 `DEAP_API_KEY`，须已在本机登录 |

---

## 快速开始

### 🎨 使用 CC Switch（推荐）

请查看 **[docs/WITH_CC_SWITCH.md](./docs/WITH_CC_SWITCH.md)** 🐾

### 💻 命令行方式

```bash
pnpm install        # 安装依赖
pnpm capture-key    # 抓取 DEAP_API_KEY 写入 .env（首次 / 密钥过期时，需输一次 sudo）
pnpm serve          # 启动服务（热重载：tsx watch）
```

服务默认运行在 **`http://localhost:19067`**。

> `pnpm serve` 启动时会自动检测并释放被占用的端口（`lsof`+`kill`），重复启动不会报 `EADDRINUSE`。

验证：

```bash
curl http://localhost:19067/health
# => {"status":"healthy","backend":"deap","deap_available":true}
```

---

## 配置（环境变量）

通过项目根目录 `.env` 或环境变量配置：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DEAP_API_KEY` | *空（必填）* | 直连 deap 用的临时密钥（`sk-…`），见下 |
| `DEAP_BASE_URL` | `https://api-deap.dingtalk.com/dingtalk/v1` | deap 网关地址 |
| `WUKONG_MODEL` | `dingtalk-auto` | 兜底模型（模型不可用时回退；`dingtalk-auto`→`qwen3.7-plus`） |
| `AVAILABLE_MODELS` | `dingtalk-auto,claude-opus-4-8,gpt-4o` | `/v1/models` 展示的候选模型（实际可用性由 deap 运行时验证） |
| `ENABLE_EXTENDED_THINKING` | `false` | 请求未显式声明时，是否默认开启 Extended Thinking |
| `CHANNEL_RETRY_MAX` | `3` | 第三方模型 `550` 无可用渠道时的重试次数 |
| `CHANNEL_RETRY_BASE_MS` | `400` | 重试退避基数（毫秒，指数增长） |
| `MODEL_AVAILABILITY_TTL_MS` | `600000` | 失效模型名缓存 TTL（默认 10 分钟，过期重新验证） |
| `HOST` | `0.0.0.0` | 监听地址 |
| `PORT` | `19067` | 监听端口 |
| `API_KEY` | *空* | 设置后，所有 `/v1/*` 请求必须带匹配的 `x-api-key` 头 |

另有 8 个 `DEAP_*` 业务头变量（`DEAP_USER_TYPE`、`DEAP_SCENARIO_CODE` 等，缺一会被 deap 拒），默认值来自真实 App 抓包，一般不用改。

`.env` 示例（`pnpm capture-key` 会自动生成）：

```env
BACKEND=deap
DEAP_API_KEY=sk-你的密钥
DEAP_BASE_URL=https://api-deap.dingtalk.com/dingtalk/v1
WUKONG_MODEL=dingtalk-auto
AVAILABLE_MODELS=dingtalk-auto,claude-opus-4-8,gpt-4o
PORT=19067
```

### 🔑 如何拿到 `DEAP_API_KEY`

这枚 key 是本机已登录的悟空 daemon 调 deap 时挂在请求头里的临时密钥（约 **29 天**有效）。

**一键抓取：`pnpm capture-key`**——它会起 mitmdump、请你输入一次 sudo 密码开系统代理、触发 daemon 发请求、抓到 key 并写进 `.env`（git-ignored），最后自动还原系统代理。原理与手动排错见 **[docs/CAPTURE_DEAP_KEY.md](./docs/CAPTURE_DEAP_KEY.md)**。

key 过期（约 29 天）后再跑一次 `pnpm capture-key` 续期即可。

---

## 怎么用

### 1. Python（Anthropic 官方 SDK）

```python
from anthropic import Anthropic

client = Anthropic(
    api_key="any-string",                 # 若服务端没设 API_KEY，这里随便填
    base_url="http://localhost:19067"      # 注意：不要加 /v1，SDK 会自动补
)

# 非流式
msg = client.messages.create(
    model="claude-3-5-sonnet-20241022",
    max_tokens=1024,
    messages=[{"role": "user", "content": "你好，介绍一下你自己"}],
)
print(msg.content[0].text)

# 流式
with client.messages.stream(
    model="claude-3-5-sonnet-20241022",
    max_tokens=1024,
    messages=[{"role": "user", "content": "写一首关于秋天的短诗"}],
) as stream:
    for text in stream.text_stream:
        print(text, end="", flush=True)
```

### 2. Node.js（@anthropic-ai/sdk）

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: "any-string", baseURL: "http://localhost:19067" });

const msg = await client.messages.create({
  model: "claude-3-5-sonnet-20241022",
  max_tokens: 1024,
  messages: [{ role: "user", content: "你好" }],
});
console.log(msg.content[0].text);
```

### 3. cURL

```bash
# 非流式
curl http://localhost:19067/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "你好"}]
  }'

# 流式（stream: true，返回 SSE）
curl -N http://localhost:19067/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 1024,
    "stream": true,
    "messages": [{"role": "user", "content": "写一首诗"}]
  }'
```

> 若服务端设置了 `API_KEY`，每个请求都要加上请求头 `-H "x-api-key: <你的key>"`。

---

## API 端点一览

| 端点 | 方法 | 鉴权 | 说明 |
|------|------|------|------|
| `/` | GET | 否 | 服务信息（版本、后端、tools 支持） |
| `/health` | GET | 否 | 健康检查，会实际向 deap 发一句「你好」探测 |
| `/v1/messages` | POST | 是 | **核心端点**，Anthropic Messages API，支持 `stream` 与 `tools` |
| `/v1/models` | GET | 是 | 返回候选模型列表（默认 `dingtalk-auto` / `claude-opus-4-8` / `gpt-4o`） |
| `/user/balance` | GET | 否 | 「余额查询」彩蛋 mock，供某些客户端探活 |

### 关于模型选择

deap 是**多模型网关**：`dingtalk-auto` 路由到通义千问 `qwen3.7-plus`，而 `claude-opus-4-8` / `gpt-4o` 分别走**真 Claude / 真 GPT**（实测可用）。代理**信任客户端请求里的 `model` 字段**直接透传给 deap；若 deap 返回 `403 model not available`（模型名失效），自动兜底到 `WUKONG_MODEL`（`dingtalk-auto`）并短期缓存。`/v1/models` 返回 `AVAILABLE_MODELS` 配置的候选列表供客户端发现。

> ⚠️ 第三方模型（claude/gpt）依赖 deap 的动态渠道池，偶发 `550 No available channel`——代理会自动带退避重试（`CHANNEL_RETRY_MAX` 次），通常 1-2 次内恢复。

### 关于 tools

代理透传 Anthropic 的 `tools` 定义与 `tool_use` / `tool_result` 消息块，deap 走标准 OpenAI function calling，返回的 `tool_calls` 会被翻译回 Anthropic 格式。Claude Code 等客户端因此能真实调用工具（读写文件、执行命令等）。

---

## 常见问题

**Q：返回 `401 Invalid API key`（deap 侧）？**
A：`.env` 里的 `DEAP_API_KEY` 过期了。重跑 `pnpm capture-key` 抓新 key。

**Q：返回 `401 Invalid API key`（本代理侧）？**
A：服务端设了 `API_KEY`，而你的请求没带 `x-api-key` 头，或值不匹配。

**Q：流式返回 `406`？**
A：这是 deap 网关的特殊行为——**流式请求不能带 `Accept: text/event-stream` 头**（带了反而 406）。代码里已处理，正常调用不会遇到；自己改 `src/deapClient.ts` 时注意别加这个头。

**Q：`/health` 显示 `unhealthy`？**
A：说明直连 deap 失败——检查 `DEAP_API_KEY` 是否过期、网络是否通。

**Q：支持 Prompt Caching 吗？**
A：**协议层面完全支持**，但实际缓存效果取决于 deap 后端的能力。
- 本代理已实现 Anthropic Prompt Caching 协议的完整透传（`cache_control: {type: "ephemeral"}`）
- 支持在 system、messages、tools 定义中标记缓存点
- deap 后端会返回 `prompt_tokens_details.cached_tokens` 字段
- 当前 deap 后端的 liteLLM 网关尚未启用真正的缓存命中（`cached_tokens` 始终为 0）
- 一旦 deap 后端启用缓存，代理层无需改动即可自动透传命中数据

---

## 技术栈

Node.js 20+ · TypeScript 5 · Express 4 · pnpm 11

想了解**内部是怎么实现的**（模块划分、调用链、tools 翻译、设计取舍），请阅读 **[AGENTS.md](./AGENTS.md)**。
