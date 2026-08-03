# PRD — xrl-router 双通道插件

> **产品需求文档** — qwenwork（千问办公 → 智谱 GLM）+ wukong（钉钉悟空 → DEAP）

| 字段 | 内容 |
|------|------|
| 产品名称 | xrl-router-plugin-qwenwork（双通道） |
| 版本 | 0.1.0 |
| 状态 | 已发布 |
| 最后更新 | 2026-08-02 |

---

## 1. 背景与目标

### 1.1 背景

国内 AI 网关对外暴露的能力很强，但协议壁垒也很高，普通 OpenAI 客户端无法直接调用喵～

- **DEAP 网关**（钉钉悟空）：要求 12+ 业务头（`x-dingtalk-*`、`x-wukong-*`、`x-litellm-session-id` 等），缺任何一个都会 400；流式请求还不能带 `Accept: text/event-stream`（会 406）。标准 OpenAI 客户端根本凑不齐这套头喵～
- **QwenWorkCN 网关**（gateway.qwenwork.cn）：使用 Cosy 签名体系（RSA+AES+MD5），每个请求需要 `Cosy-Key`（RSA 加密的随机 AES key）、`Authorization`（MD5 签名绑定 body/path/时间戳）、`Cosy-User` 等头。签名算法逆向自 asar，普通客户端无法自行签名喵～
- **xrl-router** 是统一的 LLM 路由层，负责密钥管理、请求分发、重试逻辑，通过 WebSocket 插件协议扩展对不同后端的支持喵～

### 1.2 为什么需要双通道

两个通道各有优劣，互补覆盖喵～

| 维度 | wukong（DEAP） | qwenwork（QwenWorkCN） |
|------|---------------|----------------------|
| 后端模型 | 通义千问 / Claude / GPT（多模型） | 智谱 GLM-5.2（单模型） |
| 密钥类型 | 静态 `sk-` 密钥 | OAuth refresh token（`ory_rt_`） |
| 密钥有效期 | ~29 天，过期需重抓 | 自动刷新，无感知轮换 |
| 运行时依赖 | 需要 daemon 运行才能抓密钥 | 完全离线独立调用（逆向成果） |
| 签名复杂度 | 注入业务头即可 | RSA+AES+MD5 Cosy 签名 |
| 平台支持 | macOS + Windows | macOS（Keychain）+ Windows（DPAPI） |

两个通道共享 Express 骨架、xrl-router 集成、OpenAI 协议入口，代码复用率高喵～

### 1.3 目标

让任何能调 OpenAI API 的客户端（Claude Code、Cursor、各类 IDE 插件）通过 xrl-router 无缝访问国内 AI 网关，无需感知 DEAP 业务头或 Cosy 签名协议细节喵～

### 1.4 非目标

- 不实现 Anthropic Messages API 协议（旧版架构，已删除）
- 不管理密钥轮转逻辑（由 xrl-router 负责）
- 不运行任何本地模型

---

## 2. 用户画像

| 角色 | 描述 | 核心诉求 |
|------|------|----------|
| 开发者 | 使用 Claude Code / Cursor 等工具 | 无缝调用模型，无需改客户端代码 |
| 运维 | 负责密钥管理和部署 | 一键抓密钥、自动刷新、密钥池管理 |
| 终端用户 | 通过上层应用使用 AI 能力 | 稳定、低延迟 |
| 逆向工程师 | 分析 QwenWorkCN 协议 | 离线独立调用验证（不依赖官方 App） |

---

## 3. 用户故事

### US-1：开发者接入 DEAP（wukong 通道）

**作为** 使用 Claude Code 的开发者，
**我希望** 配置 xrl-router 指向本插件后能直接调用 DEAP 模型，
**以便** 我不需要修改任何客户端代码就能使用通义千问/Claude/GPT 喵～

**验收标准：**
- 客户端发送标准 OpenAI Chat Completions 请求（`stream: true` 或 `stream: false`）
- 插件自动注入 12 个 DEAP 业务头并转发到 `api-deap.dingtalk.com`
- 流式响应为 SSE 字节流透传，非流式响应为 JSON 透传
- 请求体自动注入 `extra_body`（`enable_thinking`、`user_query`、`enable_search`）

### US-2：密钥池管理（WUKONG_KEYS）

**作为** 运维人员，
**我希望** 能在 `.env` 中配置多个 DEAP 密钥，
**以便** xrl-router 能自动轮转，避免单密钥配额耗尽喵～

**验收标准：**
- `.env` 中 `WUKONG_KEYS` 支持逗号分隔多个 `sk-` 密钥
- 插件每 5s 轮询 `.env`，检测变化后通过 `keys_update` 推送给 xrl-router
- xrl-router 在请求时通过 `Authorization` 头透传密钥给插件

### US-3：一键抓密钥（wukong）

**作为** 首次使用的用户，
**我希望** 运行 `pnpm capture-key:wukong` 就能自动抓取 DEAP 密钥，
**以便** 我不需要手动配置 mitmproxy 和系统代理喵～

**验收标准：**
- 脚本自动完成完整流程：preflight → 起 mitmdump → 开系统代理（校验 server:port）→ 触发 daemon → 抓 key → 直连 DEAP 校验 → 写 `.env` → 还原代理
- 跨平台支持（macOS networksetup + Windows 注册表/netsh）
- 检测并提示 Clash Verge / Surge 等抢占系统代理的客户端
- 成功时焚毁含明文 key 的日志，失败时保留供排查
- `.env` 必须被 `.gitignore` 忽略，否则拒绝写入

### US-4：故障自动恢复（WebSocket 重连）

**作为** 运维人员，
**我希望** 插件与 xrl-router 断线后能自动重连，
**以便** 我不需要手动重启服务喵～

**验收标准：**
- WebSocket 断线后自动重连（指数退避：1s → 2s → 4s → … → 最大 60s）
- 心跳保活（每 30s 发送 `heartbeat` 消息）
- 重连成功后自动重新注册（推送模型列表 + 密钥池）

### US-5：开发者接入 GLM-5.2（qwenwork 通道）

**作为** 使用 Cursor 的开发者，
**我希望** 通过 qwenwork 通道访问智谱 GLM-5.2 模型，
**以便** 我可以使用国产大模型而无需担心密钥过期喵～

**验收标准：**
- 客户端发送标准 OpenAI Chat Completions 请求
- 插件自动完成 Cosy 签名（RSA 加密 AES key → `Cosy-Key`，MD5 签名 → `Authorization`）
- 流式响应：解包外层 SSE（`data:{"body":"<内层chunk>"}`）为标准 OpenAI SSE 透传
- 非流式响应：聚合所有 delta chunk 为完整 `chat.completion` JSON

### US-6：Token 自动刷新（qwenwork）

**作为** 运维人员，
**我希望** OAuth token 能自动刷新，
**以便** 服务可以长期运行而无需人工干预喵～

**验收标准：**
- access token 临近过期（提前 5 分钟）时自动调用 `deviceToken/refresh` 刷新
- refresh token 刷新后自动同步到 `.env` 的 `QWEN_KEYS`（密钥池闭环）
- 三源回退：内存缓存 → `auth-v2.dat`（macOS Keychain / Windows DPAPI 解密）→ `.env QWEN_KEYS`（自举）
- 单飞防并发（同一时刻只有一个刷新请求）

### US-7：离线独立调用验证（qwenwork）

**作为** 逆向工程师，
**我希望** 运行 `pnpm capture-key` 验证 token 解密和刷新链路，
**以便** 确认离线独立调用的可行性喵～

**验收标准：**
- 解密 `auth-v2.dat`（macOS Keychain → PBKDF2(1003, saltysalt) → AES-128-CBC(IV=0x20)；Windows Local State DPAPI 密钥 → AES-256-GCM）
- 强制刷新 token（验证刷新链 + refresh token 轮换）
- 备份新 refresh token 到 `.env QWEN_KEYS`（mode 600）
- 全程不依赖千问办公 App 运行（仅需 `auth-v2.dat` 文件存在）

---

## 4. 功能需求

### 4.1 核心功能（P0）

| 编号 | 功能 | 通道 | 描述 |
|------|------|------|------|
| F-1 | qwenwork Cosy 签名桥接 | qwenwork | 每请求生成随机 16B AES key → RSA 加密为 `Cosy-Key` → AES 加密 userInfo → MD5 签名 `Authorization`，转发到 `gateway.qwenwork.cn` |
| F-2 | wukong DEAP 头注入 | wukong | 注入 12 个业务头（`x-dingtalk-*`、`x-wukong-*`、`x-litellm-session-id`），转发到 `api-deap.dingtalk.com` |
| F-3 | 流式支持 | 双通道 | wukong：SSE 字节流直接透传；qwenwork：解包外层 SSE `{"body":"..."}` 为标准 OpenAI SSE |
| F-4 | 非流式支持 | 双通道 | wukong：JSON 直接透传；qwenwork：聚合所有 delta chunk 为完整 `chat.completion` JSON |
| F-5 | 密钥池推送 | 双通道 | 每 5s 轮询 `.env`（qwenwork 读 `QWEN_KEYS`，wukong 读 `WUKONG_KEYS`），变化时推送 `keys_update` 给 xrl-router |
| F-6 | WebSocket 注册/心跳/重连 | 双通道 | 启动时 `register`（plugin_id + 模型列表 + 密钥池），心跳 30s，断线指数退避重连（1s~60s） |

### 4.2 重要功能（P1）

| 编号 | 功能 | 通道 | 描述 |
|------|------|------|------|
| F-7 | 一键抓密钥 | wukong | `pnpm capture-key:wukong`：mitmproxy MITM 抓取 `sk-` 密钥，跨平台（macOS + Windows），含系统代理管理、daemon 检测、Clash 冲突检测 |
| F-8 | Token 验证与刷新 | qwenwork | `pnpm capture-key`：解密 `auth-v2.dat` + 强制刷新 + 备份 `QWEN_KEYS`，验证离线独立调用链路 |

### 4.3 辅助功能（P2）

| 编号 | 功能 | 通道 | 描述 |
|------|------|------|------|
| F-9 | 健康检查 | 双通道 | `GET /health` 返回 `{status, channel, backend, base_url}` |
| F-10 | 服务信息 | 双通道 | `GET /` 返回 `{version, service, channel, backend, endpoints}` |
| F-11 | 端口释放 | 双通道 | 启动前自动检测并 kill 占用目标端口的进程（macOS lsof / Windows netstat+taskkill） |

---

## 5. 非功能需求

### 5.1 性能

- 请求延迟：插件层增加延迟 < 10ms（不含网络传输和签名计算）
- 内存占用：单实例 < 100MB
- 并发能力：单实例支持 100+ 并发请求

### 5.2 可用性

- 断线自动重连（指数退避，最大间隔 60s）
- 心跳保活（每 30s 一次）
- 优雅退出（SIGTERM/SIGINT 时关闭 WebSocket 连接、停止心跳和轮询）

### 5.3 安全性

- `.env` 与密钥永不进 git（`.gitignore` 强制，`capture-key` 脚本预检）
- 抓包日志含明文 key：成功时即焚、失败时保留供排查
- 系统代理用完必还原（脚本在 `finally` 里保证，含原始 server:port 还原校验）
- `.env` 文件权限 600（仅属主可读写）
- 仅对本机、本人已登录的 App 抓密钥（授权的本地分析）

### 5.4 兼容性

- Node.js >= 20
- 跨平台：macOS（主要）+ Windows（wukong 通道；qwenwork 通道 macOS Keychain / Windows DPAPI）
- 协议兼容：OpenAI Chat Completions API（流式 + 非流式）

---

## 6. 约束与依赖

### 6.1 约束

- 本插件不管理密钥轮转逻辑（由 xrl-router 负责）
- 本插件不运行任何本地模型（全部能力来自远端网关）
- DEAP 网关流式请求不能带 `Accept: text/event-stream` 头（会 406）
- qwenwork 通道 token 解密支持 macOS（Keychain）与 Windows（Local State DPAPI 密钥 → AES-256-GCM）；AES key 绑定当前 Windows 用户，auth-v2.dat + Local State 不可跨机器/账户解密

### 6.2 依赖

| 依赖 | 用途 | 备注 |
|------|------|------|
| xrl-router | 上游路由层，密钥管理 + 请求分发 | 必须运行在 `http://localhost:19068` |
| DEAP 网关 | wukong 后端模型服务 | `https://api-deap.dingtalk.com/dingtalk/v1` |
| gateway.qwenwork.cn | qwenwork 后端推理网关 | `https://gateway.qwenwork.cn` |
| 千问办公 App | qwenwork token 来源 | 仅需 `auth-v2.dat` 文件（登录后生成） |
| 钉钉悟空 App | wukong 密钥来源 | 仅抓密钥时需要 daemon 运行 |
| mitmproxy | wukong 抓密钥 | `brew install mitmproxy` |

---

## 7. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| DEAP 密钥过期（~29 天） | wukong 通道不可用 | `capture-key:wukong` 一键重抓 + 密钥池多密钥轮转 |
| xrl-router 断线 | 插件无法注册 | 自动重连（指数退避 1s~60s）+ 心跳保活 30s |
| DEAP 网关返回 406 | wukong 流式请求失败 | 不设 `Accept: text/event-stream` 头（代码注释强调） |
| 系统代理未还原 | 全局流量走 mitmdump | `finally` 块保证还原 + 逐项校验 server:port |
| OAuth token 刷新失败 | qwenwork 通道不可用 | 三源回退：内存缓存 → `auth-v2.dat`（macOS Keychain / Windows DPAPI 解密）→ `.env QWEN_KEYS`（自举） |
| Clash/Surge 抢占系统代理 | 抓密钥失败 | preflight 检测 + 提示关闭 System Proxy 开关 |
| daemon 未就绪 | 抓不到 DEAP key | preflight 检测 `service status` + 自动尝试拉起 + Windows named pipe 兜底检测 |
| Keychain 授权拒绝（macOS） | qwenwork token 解密失败 | 脚本提示用户点「允许」，首次会弹 Keychain 授权对话框 |
| Windows DPAPI 解密失败 | qwenwork token 解密失败 | 检查 auth-v2.dat 是否来自同一 Windows 用户（DPAPI 绑定用户） |

---

## 8. 验收标准

### 8.1 qwenwork 通道

- [ ] `pnpm capture-key` 能解密 `auth-v2.dat` 并验证 token 刷新链
- [ ] `pnpm serve` 启动后 `/health` 返回 `channel: "qwenwork"`
- [ ] 插件成功连接 xrl-router 并注册（plugin_id: `xrl-router-plugin-qwenwork`）
- [ ] 客户端通过 xrl-router 能正常调用 GLM-5.2（流式 + 非流式）
- [ ] Cosy 签名正确（`Cosy-Key`、`Authorization`、`Cosy-Date`、`Cosy-User`）
- [ ] `.env` 中 `QWEN_KEYS` 变化后自动推送给 xrl-router
- [ ] Token 临近过期时自动刷新，refresh token 轮换后同步 `.env`

### 8.2 wukong 通道

- [ ] `pnpm capture-key:wukong` 能跨平台抓取 DEAP 密钥（macOS + Windows）
- [ ] `pnpm serve:wukong` 启动后 `/health` 返回 `channel: "wukong"`
- [ ] 插件成功连接 xrl-router 并注册（plugin_id: `xrl-router-plugin-wukong`）
- [ ] 客户端通过 xrl-router 能正常调用 DEAP 模型（流式 + 非流式）
- [ ] DEAP 12 个业务头完整注入（缺一 400）
- [ ] `.env` 中 `WUKONG_KEYS` 变化后自动推送给 xrl-router
- [ ] 断线后能自动重连并重新注册

### 8.3 共享骨架

- [ ] 端口释放：启动前自动 kill 占用 19067 端口的进程
- [ ] 优雅退出：SIGTERM/SIGINT 关闭 WebSocket + 停止心跳和轮询
- [ ] `GET /` 返回服务信息（version、channel、backend、endpoints）

---

## 9. 附录

### 9.1 术语表

| 术语 | 含义 |
|------|------|
| DEAP | 钉钉大模型网关（DingTalk Enterprise AI Platform），`api-deap.dingtalk.com` |
| xrl-router | 统一的 LLM 路由层，负责密钥管理、请求分发、重试逻辑，运行在 `localhost:19068` |
| daemon | 钉钉悟空后台服务（`DingTalkReal`），负责调用 DEAP 网关 |
| 密钥池 | `.env` 中 `WUKONG_KEYS`（逗号分隔的 `sk-` 密钥列表）或 `QWEN_KEYS`（refresh token） |
| Cosy | 千问办公网关的签名体系：RSA 加密随机 AES key + AES 加密 userInfo + MD5 请求签名 |
| safeStorage | Electron 的加密 API，macOS 走 Keychain + PBKDF2 + AES-128-CBC，Windows 走 DPAPI |
| auth-v2.dat | 千问办公的登录态文件，safeStorage 加密存储 OAuth token + refresh token |
| refresh token | `ory_rt_` 前缀的令牌，用于 `deviceToken/refresh` 换取新 access token（轮换式） |
| plugin_id | 插件在 xrl-router 中的注册标识：`xrl-router-plugin-qwenwork` 或 `xrl-router-plugin-wukong` |

### 9.2 通道选择速查

```bash
# qwenwork 通道（默认，推荐）
pnpm serve              # 启动
pnpm capture-key        # 验证 token

# wukong 通道
pnpm serve:wukong       # 启动
pnpm capture-key:wukong # 抓密钥
```

---

*版本 0.1.0 · 最后更新 2026-08-02*
