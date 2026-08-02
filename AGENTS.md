# AGENTS.md — xrl-router-plugin-qwenwork

本文件为 AI Agent 划定项目边界。任何 Agent 在本仓库工作时，必须遵守以下约束。

## 项目定义

`xrl-router-plugin-qwenwork` 是一个**双通道 xrl-router 插件**，将中国 AI 网关包装为 OpenAI Chat Completions 兼容的本地服务喵～

两个通道：

| 通道 | 选择方式 | 上游网关 | 后端模型 |
|------|---------|---------|---------|
| qwenwork（默认） | 不加参数 | `gateway.qwenwork.cn` | 智谱 GLM-5.2 |
| wukong | `--use wukong` | `api-deap.dingtalk.com` | 通义千问 / Claude / GPT |

协议边界：**只桥接 OpenAI Chat Completions（`/v1/chat/completions`）**，不做任何协议扩展喵。

## Non Goals（CRITICAL — 最重要的章节）

以下事项**明确不在本项目范围内**，Agent 遇到相关需求必须拒绝喵！

- **不实现 Anthropic Messages API** — 旧架构，已在 commit `63eb217` 中整体删除，不要加回来
- **不做密钥轮转 / 重试逻辑** — 这是 xrl-router 的职责，插件只管转发
- **不做本地模型推理** — 所有请求都走远端网关，插件是纯翻译层
- **不实现 `/v1/models` 端点** — 模型列表通过 WebSocket 注册推送，不通过 HTTP 暴露
- **不对 wukong 做 SSE byte-stream 解析** — 直接 passthrough，不要尝试解包
- **qwenwork serve 不自己读 `auth-v2.dat`** — `capture-key` 备份到 `QWEN_KEYS` 环境变量，serve 只消费密钥池
- **永不写回 `auth-v2.dat`** — 会污染千问办公 App 的登录态，后果严重喵！
- **永不复用抓到的 JWT / cosy-key** — 网关有 anti-replay 检测，复用会被封
- **不做 tools / tool_use 翻译** — xrl-router 自己处理
- **不实现非 Chat Completions 端点** — `/v1/embeddings`、`/v1/completions` 等一律不加

## 源码地图

```
src/
├── index.ts          # Express 入口：路由、端口释放、通道分发、启动
├── config.ts         # Settings 单例：集中读取环境变量
├── channel.ts        # 通道判定：--use wukong → wukong，else qwenwork
├── pluginClient.ts   # WebSocket 客户端：注册、心跳、密钥推送、重连
├── qwenwork/
│   ├── client.ts     # 转发到 gateway.qwenwork.cn（签名 + SSE 解包）
│   ├── auth.ts       # OAuth token 管理（safeStorage 解密 + 刷新）
│   └── signer.ts     # RSA_PKCS1 + AES 签名（逆向自 asar）
└── wukong/
    └── client.ts     # 转发到 api-deap.dingtalk.com（DEAP 头注入）

scripts/
├── qwenwork/capture-key.ts  # 验证 token + 刷新链 + 备份 QWEN_KEYS
└── wukong/
    ├── capture-key.ts       # mitmproxy 抓 DEAP key
    └── cap_deap.py          # mitmproxy addon

docs/
├── PRD.md
├── ARCHITECTURE.md
├── DECISIONS.md
├── reverse/
│   ├── QWENWORKCN_REVERSE.md
│   └── WUKONG_REVERSE.md
└── specs/
    ├── qwenwork-forward.md
    ├── qwenwork-signing.md
    ├── qwenwork-token.md
    ├── wukong-forward.md
    ├── capture-key-wukong.md
    ├── capture-key-qwenwork.md
    ├── config-channel.md
    ├── port-release.md
    └── key-pool.md
```

## 开发约定

- **包管理器：pnpm**（不是 npm — npm 会触发 arborist `Link.matches` 崩溃 bug，详见 MEMORY）
- **dev 模式：tsx watch**，不需要 build 步骤 — tsx 直接跑 TypeScript
- 通道选择：`--use wukong` 走 wukong，不加参数默认 qwenwork
- 新增通道参照 `src/channel.ts` 的模式，加一个 channel 目录 + client.ts

## 构建与运行

```bash
pnpm install              # 安装依赖（再次强调：不要用 npm）
pnpm serve                # qwenwork 通道（tsx watch）
pnpm serve:wukong         # wukong 通道
pnpm capture-key          # qwenwork token 验证 + 备份
pnpm capture-key:wukong   # wukong 密钥抓取
```

## 已知限制（不要尝试修复）

| 现状 | 为什么不要修 |
|------|-------------|
| 密钥过期（~29天 wukong / ~1h qwenwork access token） | 网关设计，重跑 capture-key / 自动刷新即可 |
| 第三方模型偶发 550 | DEAP 动态渠道池问题，xrl-router 自动重试 |
| 无测试 | 当前阶段不需要，插件是纯翻译层 |
| qwenwork 仅 macOS | Windows safeStorage 走 DPAPI，逆向成本高，暂不支持 |

## 密钥安全边界

- `.env` 永不进 git — `git check-ignore .env` 必须通过喵！
- 抓包日志含明文密钥：成功则销毁（burned），失败则保留供调试
- 系统代理必须在抓包结束后恢复（`finally` 块保证）
- 只从自己登录的实例抓密钥，不要抓别人的

## 给 AI Agent 的指引

### 必须拒绝的任务

遇到以下需求，直接引用本 AGENTS.md 拒绝喵：

1. **「实现 Anthropic Messages API」** → Non Goal，已删除的旧架构
2. **「添加密钥轮转逻辑」** → xrl-router 的职责
3. **「实现本地模型推理」** → 纯桥接插件
4. **「复用抓到的 JWT / cosy-key」** → anti-replay 会封号
5. **「写回 auth-v2.dat」** → 会污染 App 登录态

### 允许的任务方向

- 新增网关通道（遵循 `src/channel.ts` 模式）
- 新增 DEAP / Cosy 业务 header
- 优化 WebSocket 重连策略
- 新增模型展示名（`DISPLAY_NAMES`）
