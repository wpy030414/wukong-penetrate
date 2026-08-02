# xrl-router-plugin-qwenwork

> xrl-router 双通道插件 — 把钉钉系 AI 网关包装成 OpenAI Chat Completions 兼容的本地服务喵～

```
客户端 → xrl-router → 本插件（按通道转发）→ 后端网关
                        ├─ qwenwork（默认）：gateway.qwenwork.cn → 智谱 GLM-5.2
                        └─ wukong（--use wukong）：api-deap.dingtalk.com → 通义/Claude/GPT
```

## 双通道一览

| 通道 | 启动 | 后端 | 密钥 | 特性 |
|------|------|------|------|------|
| **qwenwork**（默认）| `pnpm serve` | 千问办公 → **智谱 glm-5.2** | 无需静态密钥：`auth-v2.dat`(safeStorage) + `deviceToken/refresh` 自动刷新 | 完全离线独立调用（[逆向成果](./docs/reverse/QWENWORKCN_REVERSE.md)）|
| **wukong** | `pnpm serve:wukong` | 钉钉悟空 DEAP | `WUKONG_KEYS`（`pnpm capture-key:wukong` 抓取）| 注入 DEAP 业务头（[逆向成果](./docs/reverse/WUKONG_REVERSE.md)）|

本插件自身不跑任何模型，全部能力来自远端网关喵～

## 前置要求

| 依赖 | 说明 |
|------|------|
| **Node.js** ≥ 20 | 运行时 |
| **pnpm** | 包管理器（不要用 npm） |
| **xrl-router** | 必须运行在 `http://localhost:19068` |
| **mitmproxy** | 仅 wukong 抓密钥时需要 |
| **千问办公 / 悟空 App** | 仅首次抓密钥/token 时需要 |

## 快速开始

```bash
pnpm install

# qwenwork 通道（默认）
pnpm capture-key    # 验证登录态 + 刷新 token + 备份 QWEN_KEYS
pnpm serve

# wukong 通道
pnpm capture-key:wukong   # mitmproxy 抓 DEAP 密钥
pnpm serve:wukong
```

## 验证

```bash
curl http://localhost:19067/health
# qwenwork → {"status":"healthy","channel":"qwenwork","backend":"qwenwork","base_url":"https://gateway.qwenwork.cn"}
# wukong   → {"status":"healthy","channel":"wukong","backend":"deap","base_url":"https://api-deap.dingtalk.com/dingtalk/v1"}
```

## 技术栈

Node.js 20+ · TypeScript 5 · Express 4 · ws · pnpm 11

## 延伸阅读

- [AGENTS.md](./AGENTS.md) — 项目边界与 Non Goals
- [docs/PRD.md](./docs/PRD.md) — 功能需求与存在的意义
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — 架构、协议、模块设计
- [docs/DECISIONS.md](./docs/DECISIONS.md) — 设计决策的历史原因
- [docs/reverse/QWENWORKCN_REVERSE.md](./docs/reverse/QWENWORKCN_REVERSE.md) — 千问办公逆向分析
- [docs/reverse/WUKONG_REVERSE.md](./docs/reverse/WUKONG_REVERSE.md) — 钉钉悟空逆向分析
- [docs/specs/](./docs/specs/) — 核心功能规格文档
