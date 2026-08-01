# xrl-router-plugin-wukong

> **xrl-router 的 DEAP 协议桥接插件** — 把钉钉悟空背后的 DEAP 大模型网关，包装成 OpenAI Chat Completions 兼容的本地服务喵～

任何能调 OpenAI API 的客户端（Claude Code、Cursor、各类 IDE 插件……）通过 xrl-router 转发的请求，会被本插件注入 DEAP 业务头并透传到钉钉 DEAP 网关，直接驱动悟空背后的通义千问/Claude/GPT 模型喵！

```
你的客户端 → xrl-router → 本插件（注入 DEAP 业务头）→ api-deap.dingtalk.com
                              ↓
                         密钥池轮转 + 自动重试
```

**核心认知**：本插件自身不跑任何模型，全部能力来自远端 DEAP 网关（鉴权靠 `CAPTURED_KEYS`）喵～ 悟空 App 不在运行链路里，只在抓密钥时用到喵～

---

## 它能做什么

- 作为 xrl-router 插件运行，接收转发的 OpenAI Chat Completions 请求
- 注入 DEAP 业务头（`x-dingtalk-*` 等十几个头）并转发到 DEAP 网关
- 支持流式（SSE）和非流式两种模式
- 密钥池管理：支持多个 `CAPTURED_KEYS` 轮转，自动检测 `.env` 变化并推送给 xrl-router
- WebSocket 心跳 + 断线自动重连（指数退避，最大间隔 60s）
- 跨平台支持：macOS + Windows

---

## 前置要求

| 依赖 | 说明 |
|------|------|
| **Node.js** | ≥ 20 |
| **pnpm** | 包管理器（`npm i -g pnpm`） |
| **xrl-router** | 必须运行在 `http://localhost:19068`（可通过 `XRL_ROUTER_URL` 覆盖） |
| **mitmproxy** | 仅抓密钥时需要（`brew install mitmproxy`） |
| **钉钉悟空 App** | 仅用于抓取 `CAPTURED_KEYS`，须已在本机登录 |

---

## 快速开始

```bash
pnpm install        # 安装依赖
pnpm capture-key    # 抓取 CAPTURED_KEYS 写入 .env（首次 / 密钥过期时）
pnpm serve          # 启动服务（热重载：tsx watch）
```

服务默认运行在 **`http://localhost:19067`**，启动时会自动连接 xrl-router（`ws://localhost:19068/ws/plugin`）并注册为插件喵～

> 💡 `pnpm serve` 启动时会自动检测并释放被占用的端口（`lsof`+`kill`），重复启动不会报 `EADDRINUSE` 喵～

验证：

```bash
curl http://localhost:19067/health
# => {"status":"healthy","backend":"deap","plugin_mode":true,"base_url":"https://api-deap.dingtalk.com/dingtalk/v1"}
```

---

## 配置（环境变量）

通过项目根目录 `.env` 或环境变量配置：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CAPTURED_KEYS` | *空（必填）* | 密钥池（逗号分隔多个密钥），直连 DEAP 用；`pnpm capture-key` 自动追加 |
| `AVAILABLE_MODELS` | `dingtalk-auto,claude-opus-4-8,gpt-4o` | 注册给 xrl-router 的候选模型列表 |
| `PORT` | `19067` | HTTP 服务监听端口 |
| `XRL_ROUTER_URL` | `http://localhost:19068` | xrl-router 的地址（用于 WebSocket 连接） |
| `DEAP_USER_TYPE` | `vip` | DEAP 业务头 |
| `DEAP_SCENARIO_CODE` | `com.dingtalk.scenario.wukong` | DEAP 业务头 |
| `DEAP_PRODUCT_CODE` | `AI_WUKONG` | DEAP 业务头 |
| `DEAP_ABILITY_CODE` | `M_AI_WUKONG` | DEAP 业务头 |
| `DEAP_WUKONG_CLIENT_VERSION` | *自动检测* | 悟空客户端版本（Windows 从安装目录推断，兜底 `0.9.65-26061702`） |
| `DEAP_WUKONG_DEVICE_TYPE` | `2` | DEAP 业务头 |
| `DEAP_AGENT_LOOP_VERSION` | `V2` | DEAP 业务头 |
| `DEAP_BIZ_PARAM` | `{"taskDes":"5L2g5aW9"}` | DEAP 业务头 |

`.env` 示例（`pnpm capture-key` 会自动生成）：

```env
CAPTURED_KEYS=sk-xxxx,sk-yyyy
```

---

## 🔑 如何拿到密钥

本��务的密钥池由 `CAPTURED_KEYS` 环境变量管理，每枚 key 是本机已登录的悟空 daemon 调 DEAP 时挂在请求头里的临时密钥（`sk-` + 32 位小写字母数字，约 **29 天**有效）喵～

**一键抓取：`pnpm capture-key`** — 它会：
1. 自检（daemon 是否就绪、mitmproxy 是否安装）
2. 起 mitmdump（端口 8888）
3. 开系统代理（需输一次 sudo 密码）
4. 触发 daemon 发请求（`wukong-cli -p "在"`）
5. 抓到 key 并直连校验
6. 询问备注名（方便在密钥池表格里辨认）
7. 追加到 `.env` 的 `CAPTURED_KEYS` 池
8. 还原系统代理 + 清理现场

### 前置条件

| 项 | 检查 | 处理 |
|---|---|---|
| mitmproxy 已装 | `mitmdump --version` | macOS: `brew install mitmproxy`；Windows: `pip install mitmproxy` |
| CA 已生成 | `ls ~/.mitmproxy/mitmproxy-ca-cert.pem` | 裸跑一次 `mitmdump` 再退出 |
| CA 被系统信任 | macOS: `security verify-cert -c ~/.mitmproxy/mitmproxy-ca-cert.pem` | 首次需 sudo 信任 CA |
| daemon 就绪 | `wukong-cli service status` 应 running | 正常打开 Wukong App 或 `service start` |
| 悟空 App 已登录 | macOS: `pgrep -f DingTalkReal` | 打开悟空扫码登录 |
| 管理员权限（Windows） | `net session` 应成功 | 右键终端 → 「以管理员身份运行」 |

### 信任 CA（首次唯一要做的 sudo 操作）

**macOS：**
```bash
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain ~/.mitmproxy/mitmproxy-ca-cert.pem
```

**Windows（以管理员身份运行）：**
```cmd
certutil -addstore -f "Root" "%USERPROFILE%\.mitmproxy\mitmproxy-ca-cert.pem"
```

### 排错速查

| 现象 | 原因 | 处置 |
|---|---|---|
| **抓不到 key（最常见）** | **daemon 没就绪**：CLI 连不上 daemon，不发 chat | `wukong-cli service status` 查；正常打开 Wukong App 或 `service start` |
| 系统代理被抢占 | Clash/Surge/Stash 等开了 System Proxy | 关掉该客户端的系统代理开关，再重跑 |
| 抓到 key 但校验 401 | key 过期 / 截断 | 重抓；正则用 `sk-[0-9a-z]{32}` |
| 抓到 key 但校验 402 | 账号配额超限 | 等账号配额重置或换登录账号 |
| macOS：用完悟空上不了网 | 系统代理忘关 | `networksetup -setwebproxystate "Wi-Fi" off` |

### 安全红线

1. **`.env` 与 key 永不进 git** — 写前 `git check-ignore .env` 必须过；抓包日志含明文 key，用完即焚
2. **用完必关系统代理**（脚本在 finally 里保证；手动时务必执行还原步骤）
3. **仅对本机、本人已登录悟空** — 这是授权的本地分析
4. **sudo / 管理员权限**只用于信任 CA（一次性）与开/关系统代理；密码运行时手动输入、不落盘

---

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/` | GET | 服务信息（版本、后端、模式） |
| `/health` | GET | 健康检查（轻量级，不发请求到 DEAP） |
| `/v1/chat/completions` | POST | **核心端点**，OpenAI Chat Completions API，支持 `stream` |

> 💡 本插件不直接对外暴露 `/v1/models` — 模型列表通过 WebSocket 注册时推送给 xrl-router 喵～

### 关于模型选择

DEAP 是**多模型网关**：
- `dingtalk-auto` → 通义千问 `qwen3.7-plus`
- `claude-opus-4-8` → 真 Claude
- `gpt-4o` → 真 GPT

插件信任客户端请求里的 `model` 字段直接透传给 DEAP；若 DEAP 返回 403（模型不可用），由 xrl-router 负责换 key 重试喵～

---

## 常见问题

**Q：返回 `401 Invalid API key`（DEAP 侧）？**
A：`.env` 里的密钥过期了。重跑 `pnpm capture-key` 追加新密钥。

**Q：流式返回 `406`？**
A：这是 DEAP 网关的特殊行为 — **流式请求不能带 `Accept: text/event-stream` 头**（带了反而 406）。代码里已处理，正常调用不会遇到喵～

**Q：`/health` 显示 `unhealthy`？**
A：说明直连 DEAP 失败 — 检查 `CAPTURED_KEYS` 是否有有效密钥、网络是否通。

**Q：插件无法连接 xrl-router？**
A：检查 xrl-router 是否运行在 `http://localhost:19068`（或 `XRL_ROUTER_URL` 配置的地址）。插件会自动重连（指数退避，最大间隔 60s）喵～

**Q：密钥池如何轮转？**
A：插件每 5s 轮询 `.env` 文件，检测 `CAPTURED_KEYS` 变化。若有变化，通过 WebSocket 推送 `keys_update` 消息给 xrl-router。xrl-router 负责在请求时轮转密钥（放在 `Authorization: Bearer <key>` 头），插件只是透传喵～

---

## 技术栈

Node.js 20+ · TypeScript 5 · Express 4 · ws · pnpm 11

想了解**内部是怎么实现的**（架构、协议细节、数据流），请阅读 **[TSD.md](./TSD.md)** 喵～
