# DECISIONS — 设计决策记录

> 本文件记录 wukong-penetrate 项目关键设计决策背后的**历史原因**，防止架构漂移。
> 每条决策回答的是「为什么」而非「怎么做」。

版本：0.1.0 | 最后更新：2026-08-02

---

## D-1: 为什么从独立 Anthropic 代理重构为 xrl-router 插件？

**背景**：旧架构包含 `adapter.ts`（Anthropic ↔ OpenAI 格式翻译）和 `deapClient.ts`（DEAP 协议头构造），作为独立的 Anthropic Messages API 代理运行。

**问题**：
- 密钥管理与 xrl-router 重复，两套 key pool 同步困难喵～
- Anthropic `tools` / `tool_use` 格式翻译复杂且易出错，边界情况多
- 无法复用 xrl-router 已有的重试、限流、分发逻辑

**决策**：纯协议桥接插件。插件只做 OpenAI → 网关协议的转换，密钥管理、重试策略、请求分发全部交给 xrl-router 处理喵。

**证据**：commit `63eb217` 删除了 `adapter.ts`、`deapClient.ts`、`types.ts`、`search.ts`，仅保留协议桥接层喵～

---

## D-2: 为什么 wukong 流式直接透传字节流？

**背景**：DEAP 网关返回的 SSE 格式已经与标准 OpenAI 流式格式一致。

**决策**：不做任何解析，`reader.read()` → `res.write()` 直接透传原始字节流喵～

**收益**：
- 更低延迟——每个 chunk 无需 JSON parse
- 更少内存——无缓冲
- 更低复杂度——无需处理 SSE 边界（分帧、合并）

**对比**：qwenwork 通道必须解包外层 SSE envelope 再重组为 OpenAI 格式，无法直接透传喵。

**证据**：`src/wukong/client.ts` 第 99-121 行（`reader.read()` → `res.write()` 直传）

---

## D-3: 为什么 qwenwork serve 不自行读取 auth-v2.dat？

**背景**：`capture-key` 脚本负责从千问办公 App 提取 refresh token 并写入 `.env` 的 `QWEN_KEYS`。serve 进程只从 `Authorization` 头接收 `ory_rt_` 前缀的 token。

**决策**：serve 进程**不**直接读取 `auth-v2.dat`，只消费 xrl-router 下发的 refresh token喵。

**原因**：
- **职责分离**：`capture-key` 负责验证、刷新、备份；serve 只消费密钥池
- **可移植性**：拷贝项目 + `.env` 到新机器即可自举，无需迁移 App 的登录态文件
- **避免竞争**：多实例部署时不会争抢 `auth-v2.dat` 的读写

**证据**：`src/qwenwork/client.ts` 第 75-78 行（仅接受 `Authorization: Bearer <ory_rt_...>`，否则返回 401）喵～

---

## D-4: 为什么 .env 轮询 5s / 心跳 30s？

**背景**：插件通过轮询 `.env` 文件检测密钥池变更，通过 WebSocket 心跳维持与 xrl-router 的连接喵～

**决策**：`ENV_POLL_INTERVAL_MS = 5000`，`HEARTBEAT_INTERVAL_MS = 30000`。

**原因**：
- **5s**：在密钥检测及时性与 I/O 负担之间取平衡（`.env` 通常 < 1KB）
- **30s**：WebSocket 最佳实践，避免中间件空闲断连（典型超时 60s）

**拒绝的方案**：
- `fs.watch`——跨平台行为不一致（Linux inotify vs macOS FSEvents vs Windows ReadDirectoryChangesW）
- WebSocket push——引入额外 IPC 通道，增加部署复杂度

**证据**：`src/pluginClient.ts` 第 21-23 行喵。

---

## D-5: 为什么 qwenwork 用 RSA_PKCS1 而不是 RSA_OAEP？

**背景**：qwenwork 通道需要用公钥加密 cosyKey 参数喵～

**决策**：使用 `RSA_PKCS1_PADDING` 而非 `RSA_OAEP_PADDING`。

**原因**：逆向工程发现 asar 代码中显式使用 PKCS1_PADDING。实验验证：OAEP 返回 `101 Signature invalid`，PKCS1 返回 HTTP 200喵。

**证据**：`src/qwenwork/signer.ts` 第 69 行（`crypto.constants.RSA_PKCS1_PADDING`，注释标注「PKCS1 非 OAEP」）

---

## D-6: 为什么 DEAP 流式不能带 Accept: text/event-stream？

**背景**：标准 SSE 协议通常携带 `Accept: text/event-stream` 头喵～

**决策**：DEAP 网关请求**不**设置该头，即使流式模式也不设。

**原因**：DEAP 网关在检测到该头时会返回 HTTP 406 Not Acceptable。抓包验证悟空 App 自身也不设此头喵。

**证据**：`src/wukong/client.ts` 第 25 行注释（「流式也【不要】设 `Accept: text/event-stream` —— deap 会因该头返回 406」）

---

## D-7: 为什么 qwenwork 非流式需要聚合 chunk？

**背景**：qwenwork 网关无论 `stream` 参数如何，始终返回 SSE 流喵～

**决策**：当客户端请求非流式模式时，插件在本地聚合所有 chunk，返回完整的 JSON 响应。

**原因**：
- OpenAI 客户端在非流式模式下期望收到完整的 JSON 对象
- 插件需要聚合 `delta.content` + `delta.reasoning_content` + `delta.tool_calls` 等字段

**证据**：`src/qwenwork/client.ts` 第 221-268 行（chunk 聚合逻辑）喵。

---

## D-8: 为什么绝不写回 auth-v2.dat？

**背景**：`auth-v2.dat` 是千问办公 App 的登录态文件，`capture-key` 从中提取 refresh token 后，只将结果写入 `.env` 的 `QWEN_KEYS`喵～

**决策**：插件**绝不**写回 `auth-v2.dat`。

**原因**：
- `auth-v2.dat` 属于千问办公 App，写回会污染其登录态
- App 可能校验文件完整性，外部写入会导致 App 异常
- `QWEN_KEYS`（`.env`）是插件自己的密钥池，与 App 的登录态完全隔离

**证据**：`src/qwenwork/auth.ts` 第 93-96 行注释（「只同步 `.env QWEN_KEYS`（密钥池闭环）。绝不写回 `auth-v2.dat`——那是千问办公 App 的登录态，轮换会污染它。」）喵～

---

## D-9: 为什么 qwenwork 通道仅支持 macOS？

**背景**：`capture-key` 脚本需要解密千问办公 App 使用 Electron `safeStorage` 加密的凭据喵～

**决策**：`capture-key` 仅在 macOS 上运行。

**原因**：`safeStorage` 的加密实现因平台而异：
- **macOS**：Keychain + PBKDF2 + AES-128-CBC
- **Windows**：DPAPI（需要单独逆向）

每个平台的解密逻辑完全不同，当前仅完成了 macOS 的逆向。密钥池引导（`QWEN_KEYS` 直接写入 `.env`）在任意平台均可工作，不受此限制喵。

**证据**：`scripts/qwenwork/capture-key.ts` 第 57 行（平台检查）喵～

---

## D-10: 为什么移除模型别名映射并精简默认模型列表？

**背景**：早期 `qwenwork/client.ts` 维护了 `MODEL_ALIASES`（`glm-5.2` → `qwork-advanced`）和 `resolveModel()`，`config.ts` 的默认 `AVAILABLE_MODELS` 包含 `claude-opus-4-8,gpt-4o`，注册消息中按 model_id 含 `opus` 判断 `tier`。

**问题**：
- qwenwork 通道实际上只有 `qwork-advanced` 一个可用模型，别名映射让客户端误以为可以发 `glm-5.2` 请求
- `claude-opus-4-8` 和 `gpt-4o` 从未在 qwenwork/wukong 通道真正可用，默认列出会误导用户
- `tier` 按 `opus` 关键字判断是脆弱的启发式逻辑

**决策**：
- 删除 `MODEL_ALIASES` 和 `resolveModel()`：客户端发什么 model 就透传什么，缺省默认 `qwork-advanced`
- 默认 `AVAILABLE_MODELS` 精简为 `qwork-advanced`（qwenwork）/ `dingtalk-auto`（wukong）
- `tier` 统一硬编码为 `'custom'`

**收益**：消除多模型假象，减少用户配置错误；插件注册信息与实际能力一致喵。

**证据**：`src/config.ts` 第 66-67 行（默认值）、`src/pluginClient.ts` 第 100 行（`tier: 'custom'`）、`src/qwenwork/client.ts`（无 MODEL_ALIASES）
