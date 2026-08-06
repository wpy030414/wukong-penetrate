# DECISIONS — 设计决策记录

> 本文件记录 wukong-penetrate 项目关键设计决策背后的**历史原因**，防止架构漂移。
> 每条决策回答的是「为什么」而非「怎么做」。

版本：0.3.0 | 最后更新：2026-08-06

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

## D-3: 为什么 serve 现在自行管理 token 而非只消费密钥池？

**背景**：最初设计是 `capture-key` 负责提取 refresh token 写入 `.env`，serve 只从 `Authorization` 头消费 xrl-router 下发的 token。每请求都 refresh 一次。

**问题**：
- 每请求 refresh → refresh token 轮换互踩 → 不到 1 小时就断链，需频繁重新登录
- 插件和千问 App 同时持有 refresh token，各自刷新会导致对方的 token 失效

**决策**：serve 自行管理 token 生命周期（`getToken()` 缓存 + 按需刷新 + auth-v2.dat 文件监听）。

**收益**：
- **按需刷新**：5 分钟缓冲期内零网络请求，平均 1 小时才刷新 1 次（之前每请求都刷）
- **双向同步**：refresh 后写回 auth-v2.dat，千问 App 下次读取时拿到新 token，不互踩
- **文件监听**：千问 App 自己刷新时，插件自动拾取新值，只要 App 在后台就几乎不用重新登录

**证据**：`src/qwenwork/auth.ts`（`getToken()` / `startAuthFileWatch()` / `encryptAuthFile()`）、`src/qwenwork/client.ts`（`forwardChatCompletions` 改用 `getToken()`）

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

## D-8: 为什么现在写回 auth-v2.dat？（推翻旧决策）

**旧决策（已废弃）**：插件绝不写回 `auth-v2.dat`，只写 `.env QWEN_KEYS`。

**旧原因**：担心外部写入会污染千问 App 的登录态。

**问题**：
- refresh token 采用轮换（rotation）策略，每次刷新产生新 token 并作废旧 token
- 插件刷新后 `.env` 拿到新 token，但 `auth-v2.dat` 里的旧 token 已失效
- 千问 App 下次用旧 token 刷新 → 链断 → 用户被迫重新登录
- 实际测试：千问 App 不做文件完整性校验，写回加密格式正确即可

**新决策**：refresh 成功后用 `encryptAuthFile()` 写回 `auth-v2.dat`（与解密完全对称的加密方式）。

**收益**：
- 插件和千问 App 持有相同的 refresh token，不再轮换互踩
- 只要 App 保持后台运行，token 链可以持续续命

**证据**：`src/qwenwork/auth.ts`（`encryptAuthFile()` 第 133-154 行、`refreshDeviceToken()` 写回逻辑第 176-186 行）

---

## D-9: 为什么移除模型别名映射并精简默认模型列表？

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

---

## D-10: 为什么 wukong 流式从纯字节透传改为按行拆分 + 逐行 flush？

**背景**：D-2 决策是「直接透传字节流」，`reader.read()` → `res.write()` 不做任何处理喵～

**问题**：
- 上游 DEAP 网关的 TCP 层会把多个 SSE chunk 合并在一个 TCP segment 里发送
- 客户端收到一大块数据后才拆分 SSE event，导致流式输出「一块一块出」而非逐字输出
- 用户体验严重退化，看起来像非流式

**决策**：按 `\n` 拆分每个 `reader.read()` 的结果，逐行 `res.write(line + '\n')` + `flush()`。

**收益**：
- 客户端每收到一行就立即渲染，流式输出平滑
- `flush()` 确保 Express/compression 中间件不缓冲
- 用 `TextDecoder({ stream: true })` + buffer 拼接处理跨 chunk 的不完整行

**证据**：`src/wukong/client.ts` 第 97-119 行（buffer + split + flush 逻辑）

---

## D-11: 为什么 qwenwork 重新引入多模型列表？（部分推翻 D-9）

**背景**：D-9 决策将 qwenwork 默认模型精简为仅 `qwork-advanced`，认为只有一个可用模型喵～

**问题**：
- 实际上 qwenwork 网关已支持多个模型：`qwork-auto`（Qwen3.7-plus）、`qwork-lite`（DeepSeek-V4-flash）、`qmodel_latest`（Qwen3.8-max）
- 只暴露一个模型限制了用户选择

**决策**：重新扩展默认模型列表为 4 个，同时保留 `DISPLAY_NAMES` 映射给 xrl-router 展示用。wukong 通道则删除 `DISPLAY_NAMES`（model_id 本身就是展示名）。

**收益**：用户可以通过 xrl-router 选择不同的模型，灵活性更高喵。

**证据**：`src/config.ts` 第 89-90 行（默认模型列表）、`src/qwenwork/client.ts` 第 19-22 行（DISPLAY_NAMES 新增 3 项）

---

## D-12: 为什么 serve 去掉了 tsx watch？

**背景**：`pnpm serve` 原先用 `tsx watch` 自动监听文件变更重启喵～

**问题**：
- `auth-v2.dat` 文件监听（`fs.watch`）已经覆盖了 token 自动拾取需求
- `tsx watch` 监听整个 `src/` 目录，开发时频繁重启反而干扰调试
- watch 模式的进程管理与 `fs.watch` 的 watcher 生命周期可能冲突

**决策**：`serve` 和 `serve:wukong` 改为 `tsx`（无 watch），文件变更需手动重启。

**证据**：`package.json` scripts 字段

---

## D-13: 为什么两通道默认端口不同（19067 / 19066）？

**背景**：最初两通道共用 `PORT`（默认 19067），且 `startServer()` 启动前会 `killPortProcess()` 强杀占用该端口的进程喵～

**问题**：
- 双通道同时运行时，后启动的通道会杀掉先启动的通道（共用端口 + kill 前置逻辑）
- xrl-router 收到两份指向同一端口的注册，但实际只有一个通道存活，请求分发到已死通道

**决策**：按通道分配默认端口 —— qwenwork `19067`（保持向后兼容）、wukong `19066`。各通道只读专用键 `QWEN_PORT` / `WUKONG_PORT`，**不再支持共用 `PORT`**（避免两通道取到同一端口冲突）；`killPortProcess()` 剔除 `process.pid` 防止自杀喵。

**收益**：`pnpm serve` 与 `pnpm serve:wukong` 可同时运行、各自向 xrl-router 注册独立 `base_url`，互不干扰喵。

**证据**：`src/config.ts`（`resolvePort()`）、`src/index.ts`（`killPortProcess` 排除自身 PID + 启动日志）
