# 钉钉悟空（DEAP）逆向分析

> **状态**：✅ **DEAP 协议已完全穿透**（静态 `sk-` 密钥 + 12 业务头，直连校验 200 + 推理成功）
> **最后更新**：2026-08-02
> **目标应用**：`Wukong.app`（钉钉悟空桌面客户端，BundleID / DingTalkReal.exe）

本文档是 `QWENWORKCN_REVERSE.md`（千问办公逆向）的姊妹篇，记录对钉钉悟空 DEAP 网关的协议探测与行为分析成果。

---

## 0. 一句话结论

钉钉悟空的推理请求由 `DingTalkReal` daemon 直连 `api-deap.dingtalk.com`，使用**静态 `sk-` 密钥**（约 29 天有效）+ **12 个业务头**鉴权。daemon 的 TLS 客户端使用 `rustls_platform_verifier`（信任系统钥匙串、无证书锁定），使得 mitmproxy MITM 抓包成为可行且唯一的密钥截取路径。与千问办公的「Cosy 签名（已破解）+ OAuth token 刷新」相比，DEAP 的独立复用难度**极低**——提取 `sk-` 密钥即可脱离悟空 App 直连推理。

---

## 1. 应用真身与架构

### 1.1 真身

| 维度 | 值 |
|------|-----|
| 应用 | `/Applications/Wukong.app`（macOS）/ `C:\Program Files\Wukong\`（Windows）|
| 内部代号 | 钉钉悟空 / DingTalk Wukong |
| 出品方 | DingTalk（阿里巴巴） |
| 登录体系 | 钉钉账号（扫码登录） |
| 与千问办公关系 | 共享 `~/.real` agent 运行时（bun/node/python/playwright/uv/dws），但 UI、网关、协议独立 |

### 1.2 进程架构

```
Wukong App（Electron 壳）
  └─ DingTalkReal（daemon 进程，常驻后台）
        ├─ chat 客户端（Rust reqwest，推理请求的真正发起者）
        ├─ 与 wukong-cli 通过 Unix socket / named pipe 通信
        │     macOS:  ~/.real/daemon.sock
        │     Windows: \\.\pipe\real-daemon
        └─ HTTPS → api-deap.dingtalk.com/dingtalk/v1/chat/completions
```

关键二进制：
- `DingTalkReal` — daemon 主进程（Rust 编译）
- `wukong-cli` — CLI 客户端，与 daemon 通过 IPC 通信
- `~/.real/` — 共享运行时目录（agent 环境）

---

## 2. 网关与推理协议

### 2.1 网关

```
POST https://api-deap.dingtalk.com/dingtalk/v1/chat/completions
```

DEAP（DingTalk Enterprise AI Platform）是钉钉的大模型网关，后端路由到多模型。

### 2.2 后端模型路由

| model 字段 | 实际后端 |
|------------|---------|
| `dingtalk-auto` | 通义千问 `qwen3.7-plus`（默认路由） |
| `claude-opus-4-8` | 真 Claude（Anthropic） |
| `gpt-4o` | 真 GPT-4o（OpenAI） |

DEAP 是**多模型网关**，通过 `model` 字段选择后端。第三方模型（Claude/GPT）依赖 DEAP 动态渠道池，偶发 `550 No available channel`（由 xrl-router 重试缓解）。

### 2.3 推理端点

标准 OpenAI Chat Completions 兼容协议：
- 输入：`{ model, messages, stream, max_tokens, temperature, ... }`
- 输出（非流式）：标准 `chat.completion` JSON
- 输出（流式）：标准 SSE `chat.completion.chunk`（`data: {...}\n\n` ... `data: [DONE]`）

DEAP 返回的 SSE 格式与标准 OpenAI 完全一致，无需翻译——这是 wukong 通道可以直接透传字节流的前提。

---

## 3. 鉴权体系

### 3.1 密钥格式

```
Authorization: Bearer sk-[0-9a-z]{32}
```

- 前缀 `sk-`，后接 32 位**小写字母 + 数字**（注意：是 `[0-9a-z]` 不是 `[0-9a-f]`，真实 key 含 w/x/y/z）
- 约 **29 天**有效
- 由钉钉 DEAP 后端签发，挂在本机 daemon 的请求头上

### 3.2 密钥获取方式

密钥只能从**本机已登录悟空 daemon 的实际请求**中截取——不存在公开的 API 端点可以签发密钥。抓取方式见 §5。

### 3.3 业务头（缺一 400）

DEAP 要求一整套业务头，缺少任何一个 `x-dingtalk-*` 头都会被拒 400：

| 头 | 默认值 | 来源 |
|---|---|---|
| `x-dingtalk-user-type` | `vip` | 用户等级 |
| `x-dingtalk-scenario-code` | `com.dingtalk.scenario.wukong` | 场景码 |
| `x-dingtalk-product-code` | `AI_WUKONG` | 产品码 |
| `x-dingtalk-ability-code` | `M_AI_WUKONG` | 能力码 |
| `x-wukong-client-version` | *动态检测* | 悟空版本号 |
| `x-wukong-device-type` | `2` | 设备类型 |
| `x-wukong-agent-loop-version` | `V2` | Agent Loop 版本 |
| `x-dingtalk-biz-param` | `{"taskDes":"5L2g5aW9"}` | 业务参数（base64 = "你好"） |
| `x-litellm-session-id` | *随机 UUID* | LiteLLM 会话追踪 |
| `x-dingtalk-ability-call-session-id` | *随机 UUID* | 能力调用会话 ID |
| `x-dingtalk-biz-id` | *随机 UUID* | 业务 ID |
| `Authorization` | `Bearer sk-...` | API 密钥 |

> 💡 这些头的值来自对真实 App 请求的 mitmproxy 抓包，通过 `src/config.ts` 硬编码为默认值。可通过 `DEAP_*` 环境变量覆盖。

### 3.4 请求体注入

DEAP 对请求体有额外要求：

```json
{
  "model": "dingtalk-auto",
  "messages": [...],
  "stream": true,
  "max_tokens": 4096,
  "temperature": 0.6,
  "enable_thinking": true,
  "enable_search": true,
  "stream_options": { "include_usage": true },
  "extra_body": {
    "enable_thinking": true,
    "user_query": "用户最后一条消息",
    "enable_search": true
  }
}
```

- `enable_thinking`：默认 true，启用思维链
- `enable_search`：固定 true
- `stream_options`：流式时必须带，否则 406
- `extra_body.user_query`：从 messages 中提取最后一条 user 消息

### 3.5 406 陷阱

**流式请求绝不能设 `Accept: text/event-stream` 头**——DEAP 网关会因该头返回 `406 Not Acceptable`。

这是 DEAP 网关的特殊行为（可能是实现 bug 或特殊校验），抓包验证悟空 App 自身也不设此头。

---

## 4. daemon 代理行为（核心发现）

### 4.1 代理环境变量无效

悟空 daemon（`DingTalkReal`）的 chat 客户端（Rust `reqwest`）**完全无视 `HTTPS_PROXY` / `HTTP_PROXY` 等环境变量**。

已验证的失败路径：
- Shell `nohup` 注入 env → 无效
- LaunchAgent plist `EnvironmentVariables` 注入 → 无效
- 进程级 env 注入 → 无效

> ⚠️ **历史教训**：曾以为「改 LaunchAgent plist 注 `EnvironmentVariables`」可行，实测 daemon 的 chat 客户端根本不读代理 env，那条路走不通。

### 4.2 系统级代理有效

daemon **认 macOS / Windows 的系统级 HTTP 代理设置**：

- **macOS**：`networksetup -setwebproxy` 写进 `scutil --proxy` 的那套
- **Windows**：WinINet（注册表 `HKCU:\...\Internet Settings`）+ WinHTTP（`netsh winhttp`）

这是唯一可靠的拦截面：
```
开系统级 HTTP/HTTPS 代理 → 127.0.0.1:8888
  → daemon 的 /chat/completions 被迫经过 mitmdump
  → mitmdump 抓到带完整 Authorization: Bearer sk-... 的请求
  → 用完立刻关系统代理还原
```

### 4.3 TLS 验证机制

daemon 使用 `rustls_platform_verifier`——信任系统钥匙串（macOS Keychain / Windows 证书存储区），**无证书锁定（certificate pinning）**。

这意味着：只要 mitmproxy 的 CA 被加入系统信任根，TLS 就能被中间人。

### 4.4 daemon 就绪判定

**最常见的抓包失败原因不是代理冲突，而是 daemon 没就绪。**

| 状态 | 含义 | 检测 |
|------|------|------|
| daemon 就绪 | `~/.real/daemon.sock` 存在，IPC 可用 | `wukong-cli service status` → running (exit 0) |
| App 进程在跑 | DingTalkReal 存在但不一定是完整 daemon | `pgrep -f DingTalkReal`（不可靠） |
| `--app-relaunched` | 后台重启实例，不含完整 daemon | 检查命令行参数 |

> ⚠️ **历史教训（2026-07-23）**：抓不到 key，一度误判为「Clash 抢系统代理」，实测根因是 `.real` daemon 服务没起来。CLI 连不上 daemon，**根本不发 chat**，mitmdump 自然抓不到。「App 进程在跑」≠「daemon 就绪」。

Windows 上 daemon 就绪可通过 named pipe `\\.\pipe\real-daemon` 检测（`Test-Path` 或 `NamedPipeClientStream.Connect`）。

---

## 5. 密钥截取方法（MITM）

### 5.1 原理

```
mitmdump -p 8888 -s scripts/wukong/cap_deap.py
  ↑
系统代理 → 127.0.0.1:8888 → daemon 流量经过 → 抓到 Authorization 头
```

`cap_deap.py`（mitmproxy addon）过滤 `api-deap` 域名请求，提取 `Authorization` 头写入 `/tmp/deap_capture.log`。

### 5.2 完整流程

1. **自检**：mitmdump 可用、CA 已生成且被信任、daemon 就绪、无 competing proxy
2. **起 mitmdump**（端口 8888，加载 cap_deap.py）
3. **开系统代理** → 127.0.0.1:8888（macOS: `networksetup` / Windows: 注册表+netsh）
4. **校验代理生效**：确认 server=127.0.0.1 & port=8888（不只看 Enabled）
5. **触发 daemon 发 chat**：`wukong-cli -p "在" --output-format json --quiet`
6. **提取 Bearer key**：从 `/tmp/deap_capture.log` 正则 `sk-[0-9a-z]{32}`
7. **直连校验**：带完整 DEAP 业务头调一次 /chat/completions
8. **写入 .env**：追加到 `WUKONG_KEYS`（逗号分隔多密钥池）
9. **还原系统代理** + 停 mitm + 焚日志（成功焚、失败保留供排查）

### 5.3 校验方法

```bash
curl -s -m 30 https://api-deap.dingtalk.com/dingtalk/v1/chat/completions \
  -H "Authorization: Bearer sk-..." -H "Content-Type: application/json" \
  -H "x-dingtalk-user-type: vip" \
  -H "x-dingtalk-scenario-code: com.dingtalk.scenario.wukong" \
  -H "x-dingtalk-product-code: AI_WUKONG" \
  -H "x-dingtalk-ability-code: M_AI_WUKONG" \
  -d '{"model":"dingtalk-auto","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}'
```

| 响应码 | 含义 | 处置 |
|--------|------|------|
| 200 | key 有效 | ✅ 写入 .env |
| 401 | key 过期 / 截断 | 重抓 |
| 402 | **账号配额超限** | 等配额重置或换账号（重抓无解） |
| 400 | 业务头缺失 | 检查完整头列表 |

---

## 6. 跨平台代理攻防

### 6.1 macOS

- 系统代理通过 `networksetup` 设置（`setwebproxy` / `setsecurewebproxy`）
- 接口名默认 `Wi-Fi`，可通过 `CAPTURE_NET_SERVICE` 环境变量覆盖
- CA 信任：`security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain`

### 6.2 Windows

Windows 有**双通道代理**，daemon 可能走任一条：

| 通道 | 设置方式 | 使用者 |
|------|---------|--------|
| WinINet | 注册表 `HKCU:\...\Internet Settings\ProxyEnable/ProxyServer` | 传统桌面应用（IE/Edge 等） |
| WinHTTP | `netsh winhttp set proxy` | Rust reqwest 等现代 HTTP 客户端 |

脚本**同时设置两条通道**以确保覆盖。

CA 信任：`certutil -addstore -f "Root" <cert>`（需管理员权限）

### 6.3 代理竞争（Clash / Surge / Stash 等）

Clash Verge / Surge / Stash 等代理客户端的「System Proxy」开关会**持续**把系统代理改写为自己的端口（如 `7897`），与脚本的 `8888` 竞态。

防御策略：
1. **preflight 检测** competing proxy 进程（`clash-verge` / `mihomo` / `Surge` / `Stash` / `sing-box` / `v2ray` / `xray`）
2. **开代理后校验** server=127.0.0.1 & port=8888（不只看 `Enabled`）
3. **被抢占立即中止**（而非盲目等待）
4. **cleanup 还原原始 server:port**（不只关闭，而是恢复到抓包前的值）

Windows 额外步骤：
- 停 Clash Verge 进程（防其抢回代理）
- 重启 daemon（让它读到新代理值）
- 抓包完后重启 Clash Verge

### 6.4 悟空版本号动态检测

**Windows**：从 `C:\Program Files\Wukong\<version>\` 目录名推断（`/^\d+\.\d+\.\d+-.+$/`），取最高版本号。

**macOS**：兜底硬编码 `0.9.65-26061702`。

可通过 `DEAP_WUKONG_CLIENT_VERSION` 环境变量覆盖。

---

## 7. 与千问办公（QwenWorkCN）对比

| 维度 | 悟空 DEAP | 千问办公 |
|------|-----------|----------|
| 后端模型 | 通义千问/Claude/GPT（DEAP 多模型） | **智谱 glm-5.2**（maas-glm） |
| 网关 | `api-deap.dingtalk.com` | `gateway.qwenwork.cn`（动态发现） |
| 密钥 | 静态 `sk-`（29 天） | 动态 `COSY.JWT`（短期刷新） |
| 请求签名 | **无**（仅 Bearer token + 业务头） | Cosy 签名（RSA_PKCS1 + MD5，**已破解**；不再需要 SecurityGuard） |
| 请求体 | 明文 JSON（+ DEAP 特有字段） | **明文 JSON**（~~Encode=1 加密~~ 网关接受明文，见 QWENWORKCN_REVERSE §6.8） |
| 设备风控 | **无** | `umid_token` + `x_mini_wua`（阿里 SecurityGuard） |
| TLS 验证 | `rustls_platform_verifier`（信任系统 CA，无 pinning） | 未知（qoderclicn bun 进程，默认不读 macOS keychain） |
| 独立复用难度 | **低**（提取 sk- 即可） | **中**（Cosy 签名已破解，需 safeStorage 解密 + token 刷新链） |
| 代理行为 | **认系统代理**（无视 env） | 认 `proxy.mode=manual` 设置（默认直连） |
| 密钥抓取 | mitmproxy MITM（系统代理劫持） | 本地解密 safeStorage + deviceToken/refresh |
| 密钥有效期 | ~29 天 | access token ~1h（refresh token 轮换） |

---

## 8. 安全边界

### 8.1 授权前提

- 仅对**本机、本人已登录**的悟空实例抓密钥——这是授权的本地分析
- 不攻击远端服务器、不绕过认证

### 8.2 密钥安全

- `.env` 与密钥永不进 git（`git check-ignore .env` 必须过）
- 抓包日志含明文 key：成功则焚毁、失败则保留供排查（排查后手动删除）
- 系统代理用完必还原（脚本 `finally` 块保证）
- sudo / 管理员权限只用于信任 CA（一次性）和开关系统代理

### 8.3 已知限制

| 现状 | 说明 |
|------|------|
| 密钥过期 | ~29 天，需重跑 `pnpm capture-key:wukong` |
| 第三方模型偶发 550 | DEAP 动态渠道池，由 xrl-router 自动重试 |
| 无协议加密 | DEAP 请求体明文 JSON，无签名机制（对比千问办公的 ChaCha20+RSA） |

---

## 9. 参考资料

- 抓包脚本：`scripts/wukong/cap_deap.py`（mitmproxy addon）
- 一键抓取：`scripts/wukong/capture-key.ts`（跨平台：macOS + Windows）
- 千问办公侧：[QWENWORKCN_REVERSE.md](./QWENWORKCN_REVERSE.md)
- 架构文档：[../ARCHITECTURE.md](../ARCHITECTURE.md)
- 设计决策：[../DECISIONS.md](../DECISIONS.md)
