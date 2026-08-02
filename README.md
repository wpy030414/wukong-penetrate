# xrl-router-plugin-wukong

> **xrl-router 的双通道插件** — 把钉钉系 AI 网关包装成 OpenAI Chat Completions 兼容的本地服务喵～

```
你的客户端 → xrl-router → 本插件（按通道转发）→ 后端网关
                              ├─ qwenwork 通道（默认）：gateway.qwenwork.cn → 智谱 GLM-5.2
                              └─ wukong 通道（--wukong）：api-deap.dingtalk.com → 通义/Claude/GPT
```

## 双通道一览

| 通道 | 入口 | 后端 | 密钥 | 特性 |
|------|------|------|------|------|
| **qwenwork**（默认）| `pnpm serve` | 千问办公 `gateway.qwenwork.cn` → **智谱 glm-5.2** | 无需静态密钥：`auth-v2.dat`(safeStorage) + `deviceToken/refresh` 自动刷新 | 完全离线独立调用（逆向成果，见 `docs/QWENWORKCN_REVERSE.md`）|
| **wukong** | `pnpm serve:wukong` | 钉钉悟空 `api-deap.dingtalk.com` | `WUKONG_KEYS`（`pnpm capture-key:wukong` 抓取）| 注入 DEAP 业务头 |

**核心认知**：本插件自身不跑任何模型，全部能力来自远端网关。qwenwork 通道无需 App 常驻（OAuth token 自动管理）；wukong 通道仅抓密钥时用到悟空 App 喵～

---

## 它能做什么

- 作为 xrl-router 插件运行，接收转发的 OpenAI Chat Completions 请求
- 注入 DEAP 业务头（`x-dingtalk-*` 等十几个头）并转发到 DEAP 网关
- 支持流式（SSE）和非流式两种模式
- 密钥池管理：支持多个 `WUKONG_KEYS` 轮转，自动检测 `.env` 变化并推送给 xrl-router
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
| **钉钉悟空 App** | 仅用于抓取 `WUKONG_KEYS`，须已在本机登录 |

---

## 快速开始

```bash
pnpm install        # 安装依赖

# qwenwork 通道（默认）：token 由 auth-v2.dat 自动管理；capture-key 验证解密+刷新链
pnpm capture-key    # 验证 qwenwork 登录态 + 强制刷新 token + 备份 refresh token 到 QWEN_KEYS
pnpm serve

# wukong 通道（需先抓取 WUKONG_KEYS）
pnpm capture-key:wukong
pnpm serve:wukong
```

服务默认运行在 **`http://localhost:19067`**，启动时会自动连接 xrl-router（`ws://localhost:19068/ws/plugin`）并注册为插件喵～

验证：

```bash
curl http://localhost:19067/health
# qwenwork => {"status":"healthy","channel":"qwenwork","backend":"qwenwork","base_url":"https://gateway.qwenwork.cn"}
# wukong   => {"status":"healthy","channel":"wukong","backend":"deap","base_url":"https://api-deap.dingtalk.com/dingtalk/v1"}
```

---

## 配置（环境变量）

通过项目根目录 `.env` 或环境变量配置。**按通道区分**：qwenwork 用 `QWEN_*`，wukong 用 `DEAP_*` / `WUKONG_KEYS`。

### 通用

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `19067` | HTTP 服务监听端口 |
| `XRL_ROUTER_URL` | `http://localhost:19068` | xrl-router 地址（WebSocket 连接）|
| `AVAILABLE_MODELS` | 按通道不同 | 注册给 xrl-router 的候选模型列表 |

### qwenwork 通道（默认）

**无需静态密钥**：OAuth token 由 `auth-v2.dat`（safeStorage 解密）+ `deviceToken/refresh` 自动管理（逆向成果，见 `docs/QWENWORKCN_REVERSE.md` §6.8/§6.9）。

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `QWEN_KEYS` | *空（必填，serve 用）* | 密钥池：capture-key 备份的 **refresh token**（单元素密钥池），xrl-router 轮询后作为 Authorization 透传给本网关。**serve 只认这个来源**（无 Authorization / 非 `ory_rt_` 前缀 → 401），拷项目+.env 到新机器即可自举 |
| `QWEN_OAUTH_TOKEN_PATH` | `~/Library/Application Support/QwenWorkCN/auth-v2.dat` | 千问办公登录态文件（源①，缺失/失效时自动回退 `QWEN_KEYS` 自举）|
| `QWEN_KEYCHAIN_SERVICE` / `QWEN_KEYCHAIN_ACCOUNT` | `QwenWorkCN Safe Storage` / `QwenWorkCN Key` | safeStorage 解密用 Keychain 项 |
| `QWEN_BASE_URL` | `https://gateway.qwenwork.cn` | 推理网关 base |
| `QWEN_DEVICE_REFRESH_PATH` | `/api/v1/deviceToken/refresh` | token 自动刷新端点 |
| `QWEN_REFRESH_INTERVAL_MS` | `600000` | token 刷新检查间隔 |
| `QWEN_RSA_PUBLIC_KEY_PATH` | *内嵌* | asar 硬编码 RSA 公钥（一般无需覆盖）|
| `QWEN_TARGET` | `c` | deviceToken/refresh 的 target 参数 |

**前置**：千问办公已登录（生成 `auth-v2.dat`）+ macOS（Keychain 授权）。**serve 与 capture-key 职责分离**：capture-key 负责解密验证 + 刷新 + 备份 QWEN_KEYS；serve 只消费 xrl-router 透传的 QWEN_KEYS token，不自行读取 auth-v2.dat。

### wukong 通道（--wukong）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `WUKONG_KEYS` | *空（必填）* | 密钥池（逗号分隔），`pnpm capture-key:wukong` 自动追加 |
| `DEAP_USER_TYPE` | `vip` | DEAP 业务头 |
| `DEAP_SCENARIO_CODE` | `com.dingtalk.scenario.wukong` | DEAP 业务头 |
| `DEAP_PRODUCT_CODE` | `AI_WUKONG` | DEAP 业务头 |
| `DEAP_ABILITY_CODE` | `M_AI_WUKONG` | DEAP 业务头 |
| `DEAP_WUKONG_CLIENT_VERSION` | *自动检测* | 悟空客户端版本 |
| `DEAP_WUKONG_DEVICE_TYPE` | `2` | DEAP 业务头 |
| `DEAP_AGENT_LOOP_VERSION` | `V2` | DEAP 业务头 |
| `DEAP_BIZ_PARAM` | `{"taskDes":"5L2g5aW9"}` | DEAP 业务头 |

---

## 🔑 如何拿到密钥

本��务的密钥池由 `WUKONG_KEYS` 环境变量管理，每枚 key 是本机已登录的悟空 daemon 调 DEAP 时挂在请求头里的临时密钥（`sk-` + 32 位小写字母数字，约 **29 天**有效）喵～

**一键抓取：`pnpm capture-key`** — 它会：
1. 自检（daemon 是否就绪、mitmproxy 是否安装）
2. 起 mitmdump（端口 8888）
3. 开系统代理（需输一次 sudo 密码）
4. 触发 daemon 发请求（`wukong-cli -p "在"`）
5. 抓到 key 并直连校验
6. 询问备注名（方便在密钥池表格里辨认）
7. 追加到 `.env` 的 `WUKONG_KEYS` 池
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
A：说明直连 DEAP 失败 — 检查 `WUKONG_KEYS` 是否有有效密钥、网络是否通。

**Q：插件无法连接 xrl-router？**
A：检查 xrl-router 是否运行在 `http://localhost:19068`（或 `XRL_ROUTER_URL` 配置的地址）。插件会自动重连（指数退避，最大间隔 60s）喵～

**Q：密钥池如何轮转？**
A：插件每 5s 轮询 `.env` 文件，检测 `WUKONG_KEYS` 变化。若有变化，通过 WebSocket 推送 `keys_update` 消息给 xrl-router。xrl-router 负责在请求时轮转密钥（放在 `Authorization: Bearer <key>` 头），插件只是透传喵～

---

## 技术栈

Node.js 20+ · TypeScript 5 · Express 4 · ws · pnpm 11

想了解**内部是怎么实现的**（架构、协议细节、数据流），请阅读 **[TSD.md](./TSD.md)** 喵～
