---
name: capture-deap-key
description: >-
  通过 mitmproxy 中间人抓包，从本机已登录的钉钉悟空 daemon 截获 deap 网关的临时 API Key
  （sk- 前缀、约 29 天有效），并写入本项目的 .env。当 .env 里的 DEAP_API_KEYS 全部失效
  （代理对 deap 返回 401/unauthorized）或首次配置时使用。
---

# 抓取 deap API Key（MITM）

> **首选方式：直接跑一键脚本 `pnpm capture-key`**（见下「快速开始」），它会自动完成
> 本文档描述的全部流程。本文档保留作为**原理说明**与**脚本失效时的手动排错参考**。

## 快速开始（推荐）

```bash
pnpm capture-key
```

脚本会自动：自检 → 起 mitmdump → 开系统代理 → 触发 daemon 发请求 →
抓到 key → 直连校验 → **询问备注名** → 追加到 `.env` 的 `DEAP_API_KEYS` 池 →
**还原系统代理** → 清理现场。

你需要做：
1. **保持悟空 daemon 已登录运行**（脚本会检测，不会擅自重启悟空）。
2. 输入备注名（回车默认为"无"），方便在密钥池表格里辨认。
3. 首次可能需要输一次 `sudo` 密码（CA 信任 / 开系统代理）。

> 主用网络接口默认 `Wi-Fi`，若不是可用 `CAPTURE_NET_SERVICE=<接口名> pnpm capture-key` 覆盖
> （用 `networksetup -listallnetworkservices` 查你的接口名）。

---

## 原理（为什么这样做才有效）

悟空 daemon（`DingTalkReal`）发往 `api-deap.dingtalk.com` 的 chat 请求**直连**，
它**无视 `HTTPS_PROXY` 等环境变量**（无论 shell `nohup` 注入还是 LaunchAgent plist 注入都没用），
**但认 macOS 的系统级 HTTP 代理设置**（`networksetup -setwebproxy` 写进 `scutil --proxy` 的那套）。

所以唯一可靠的拦截面是：
```
开系统级 HTTP/HTTPS 代理 → 127.0.0.1:8888
  → daemon 的 /chat/completions 被迫经过 mitmdump
  → mitmdump 抓到带完整 Authorization: Bearer sk-... 的请求
  → 用完立刻关系统代理还原
```

TLS 能被中间人是因为 daemon 用 `rustls_platform_verifier`（信任系统钥匙串、无证书锁定），
且 mitmproxy 的 CA 已被加入系统钥匙串信任。

> ⚠️ **历史教训**：曾以为「改 LaunchAgent plist 注 `EnvironmentVariables`」可行，实测 daemon 的
> chat 客户端根本不读代理 env，那条路走不通。只有系统级代理有效。
> ⚠️ **历史教训（daemon 没就绪 —— 最常见、最易误判的失败点）**：2026-07-23 抓不到 key，
> 一度误判为「Clash 抢系统代理」，实测根因是 **`.real` daemon 服务没起来**：`~/.real/daemon.sock`
> 不存在、`wukong-cli service status` 报 `not running`、`wukong-cli -p` 报
> `daemon did not start in time` —— CLI 连不上 daemon，**根本不发 chat**，mitmdump 自然抓不到。
> **跟系统代理、跟 Clash 都无关**。「App 进程在跑」≠「daemon 就绪」（`--app-relaunched` 后台实例不含完整 daemon）。
> 脚本 preflight 现在检 **`service status` 退出码 + 文本**（而非 `pgrep DingTalkReal`），未就绪则先尝试 `service start`。
>
> ⚠️ **次要教训（Clash 抢代理）**：本机若装了 Clash Verge / Surge / Stash 等并开了「System Proxy」开关，
> 它们会持续把 macOS 系统代理改写成自己的端口（如 `7897`），与本脚本设的 `8888` 竞态。这属**次要防御**：
> 脚本开代理后**校验 `server=127.0.0.1 & port=8888`**（不只看 `Enabled`），被抢占立即中止；cleanup **还原原始 server:port**；
> 失败保留 `/tmp/deap_{capture,mitm,cli}.log` 供排查。**抓不到时先确认 daemon 就绪，再排查代理**。

## 前置条件（一次性）

| 项 | 检查 | 处理 |
|---|---|---|
| mitmproxy 已装 | `mitmdump --version` | `brew install mitmproxy` |
| CA 已生成 | `ls ~/.mitmproxy/mitmproxy-ca-cert.pem` | 裸跑一次 `mitmdump` 再退出 |
| CA 被系统信任（**唯一 sudo，一劳永逸**） | `security verify-cert -c ~/.mitmproxy/mitmproxy-ca-cert.pem` | 见下 |
| **.real daemon 就绪（关键）** | `wukong-cli service status` 应 running（exit 0），`~/.real/daemon.sock` 存在 | 正常打开 Wukong App（完整界面+登录），或 `wukong-cli service start` |
| 悟空 App 已登录运行 | `pgrep -f DingTalkReal` | 打开悟空扫码登录（注意：App 在跑 ≠ daemon 就绪） |

**信任 CA（首次唯一要做的 sudo 操作）：**
```bash
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain ~/.mitmproxy/mitmproxy-ca-cert.pem
```

## 手动流程（脚本失效时的兜底）

<details><summary>点开展开手动步骤</summary>

```bash
# 1. 起 mitmdump
rm -f /tmp/deap_capture.log
nohup mitmdump -p 8888 -s scripts/cap_deap.py > /tmp/mitm.out 2>&1 &
sleep 3 && lsof -ti :8888   # 确认监听

# 2. 开系统级代理（要 sudo）
sudo networksetup -setwebproxy "Wi-Fi" 127.0.0.1 8888
sudo networksetup -setsecurewebproxy "Wi-Fi" 127.0.0.1 8888
sudo networksetup -setwebproxystate "Wi-Fi" on
sudo networksetup -setsecurewebproxystate "Wi-Fi" on

# 3. 触发 daemon 发一次 chat（daemon 须已登录运行）
/Applications/Wukong.app/Contents/MacOS/wukong-cli -p "在" --output-format json --quiet

# 4. 提取 key（注意字符集是 [0-9a-z] 不是 [0-9a-f]，真实 key 含 w/x/y）
KEY=$(grep -oE "Bearer sk-[0-9a-z]{32}" /tmp/deap_capture.log | tail -1 | awk '{print $2}')
echo "${KEY:0:10}…${KEY: -4}"

# 5. 校验（带完整 x-dingtalk-* 头，见 src/deapClient.ts buildHeaders）
curl -s -m 30 https://api-deap.dingtalk.com/dingtalk/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "x-dingtalk-user-type: vip" -H "x-dingtalk-scenario-code: com.dingtalk.scenario.wukong" \
  -H "x-dingtalk-product-code: AI_WUKONG" -H "x-dingtalk-ability-code: M_AI_WUKONG" \
  -d '{"model":"dingtalk-auto","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}'

# 6. 写入 .env 的 DEAP_API_KEYS（逗号分隔多密钥），并同步 KEYS_NAME，chmod 600

# 7. 还原（必做）：关系统代理 + 停 mitm + 焚日志
sudo networksetup -setwebproxystate "Wi-Fi" off
sudo networksetup -setsecurewebproxystate "Wi-Fi" off
lsof -ti :8888 | xargs kill -9
rm -f /tmp/deap_capture.log
```

</details>

## 排错速查

| 现象 | 原因 | 处置 |
|---|---|---|
| **抓不到 key（最常见）** | **`.real` daemon 没就绪**：CLI 连不上 daemon，不发 chat | `wukong-cli service status` 查；正常打开 Wukong App（完整界面+登录）或 `service start`。App 在跑 ≠ daemon 就绪 |
| 抓不到 key，且 mitm 完全无流量 | daemon 没发请求（上一条）/ 复用 keep-alive 旧连接 / 没走 deap | 先看 `/tmp/deap_mitm.log` 有无 CONNECT；确认 daemon 就绪 |
| 系统代理被抢占（脚本立即中止） | Clash/Surge/Stash 等开了 System Proxy，把 8888 改成自己端口 | 关掉该客户端的系统代理开关（或临时退出），再重跑 |
| 抓到 key 但校验 401 | key 过期 / 截断 / 抓到旧值 | 重抓；正则用 `sk-[0-9a-z]{32}` |
| 抓到 key 但校验 **402 quotaExceeded** | **账号配额超限，不是 key 失效** | 重抓大概率仍 402；等账号配额重置或换登录账号 |
| 代理 406 | 给流式加了 `Accept: text/event-stream` | 删该头（deap 会因它 406），见 `src/deapClient.ts` |
| 用完悟空上不了网 | 系统代理忘关 / server:port 被写成 8888 未还原 | `networksetup -setwebproxystate "Wi-Fi" off` + secure 同理（新版 cleanup 已自动还原原值） |
| sudo 密码错 | — | 重新输入；脚本不存密码 |

## 安全红线

1. **`.env` 与 key 永不进 git**——写前 `git check-ignore .env` 必须过；抓包日志含明文 key，用完即焚。
2. **用完必关系统代理**（脚本在 finally 里保证；手动时务必执行第 7 步），否则全局流量持续走代理。
3. **仅对本机、本人已登录悟空**——这是授权的本地分析。
4. **sudo 只用于信任 CA（一次性）与开/关系统代理**；密码运行时手动输入、不落盘。
