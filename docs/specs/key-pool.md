# key-pool: 密钥池管理（.env 轮询推送）

## 目标

定期轮询 `.env` 文件中的密钥列表，检测变化后通过 WebSocket 推送给 xrl-router，实现密钥池热更新喵～

## 输入输出

**输入：**
- `.env` 文件（`process.cwd()/.env`）
- 密钥环境变量：`QWEN_KEYS`（qwenwork 通道）或 `WUKONG_KEYS`（wukong 通道），由 `KEYS_ENV_KEY` 常量决定
- xrl-router WebSocket 端点：`ws://{xrlRouterUrl}/ws/plugin`

**输出：**
- WebSocket 消息：`{ type: "keys_update", keys: string[] }`（仅当密钥列表变化且 WS 已连接时）
- 注册消息：`{ type: "register", plugin_id, provider, models, keys }`（连接时发送，含初始密钥列表）

## 关键约束

### 轮询机制

- **间隔**：`ENV_POLL_INTERVAL_MS = 5000`（5 秒）
- **定时器**：`setInterval(() => this.checkEnvChanges(), ENV_POLL_INTERVAL_MS)`
- **构造时启动**：`constructor()` → `startEnvPolling()`

### 密钥解析（`checkEnvChanges`）

```typescript
const envContent = fs.readFileSync(envPath, 'utf-8');
const parsed = dotenv.parse(envContent);
const keysStr = parsed[KEYS_ENV_KEY] || '';
const currentKeys = keysStr.split(',').map(s => s.trim()).filter(Boolean);
```

1. 读取 `.env` 文件
2. `dotenv.parse()` 解析为键值对
3. 取 `KEYS_ENV_KEY` 对应值
4. 逗号分隔 → trim → 过滤空字符串

### 变化检测

```typescript
const changed =
  currentKeys.length !== this.lastKeys.length ||
  currentKeys.some((k, i) => k !== this.lastKeys[i]);
```

- 长度比较 + 逐元素比较
- 变化 → 更新 `this.lastKeys` → 推送 `keys_update`

### WebSocket 推送

```typescript
if (this.connected) {
  this.send({ type: 'keys_update', keys: currentKeys });
}
```

- **仅连接时推送**：`this.connected === false` → 跳过（不缓存、不重试）
- `send()` 内部检查 `ws.readyState === WebSocket.OPEN`

### 初始加载（`loadCurrentKeys`）

- `constructor()` 最先调用
- 读 `.env` → 解析 → 填充 `this.lastKeys`
- 用于 `sendRegister()` 注册消息的 `keys` 字段

### 完整 WebSocket 生命周期

| 参数 | 值 |
|---|---|
| 心跳间隔 | `HEARTBEAT_INTERVAL_MS = 30000`（30s） |
| 重连基准延迟 | `RECONNECT_BASE_MS = 1000`（1s） |
| 重连最大延迟 | `RECONNECT_MAX_MS = 60000`（60s） |
| 退避策略 | `min(1000 * 2^attempts, 60000)` |
| 连接成功 | 重置 `reconnectAttempts = 0`，发送 register，启动心跳 |
| 连接断开 | 停心跳，计划重连 |

### 注册消息

```typescript
{
  type: 'register',
  plugin_id: PLUGIN_ID,
  provider: { kind: 'openai', base_url: `http://localhost:${port}`, api_path: '/v1/chat/completions' },
  models: [{ model_id, display_name, tier }],
  keys: this.lastKeys
}
```

- `tier`：统一为 `'custom'`
- `display_name`：qwenwork 通道调用 `qwenDisplayName()`（有 DISPLAY_NAMES 映射）；wukong 通道直接用 `model_id`（无映射）

### close()

- 停心跳定时器
- 停 env 轮询定时器
- 清重连定时器
- 关闭 WebSocket

## 验收标准

- [ ] .env 中 QWEN_KEYS/WUKONG_KEYS 变化 → 5s 内推送 `keys_update`
- [ ] .env 未变化 → 不推送（避免无意义消息）
- [ ] WS 未连接 → 检测到变化但不推送（不报错）
- [ ] .env 不存在 → `loadCurrentKeys` 静默处理，`lastKeys = []`
- [ ] .env 解析失败 → 静默忽略，不中断轮询
- [ ] WS 断开 → 指数退避重连，最大 60s
- [ ] WS 重连成功 → 重新发送 register（含最新 keys）
- [ ] 进程退出（SIGTERM/SIGINT）→ `close()` 清理所有定时器和连接

## 已知边界

- `.env` 文件不存在 → `fs.existsSync` 返回 false → `checkEnvChanges` 直接 return（不报错）
- `dotenv.parse()` 抛异常 → catch 静默忽略（lastKeys 不变，下次轮询重试）
- 密钥列表中的空项（`sk-1,,sk-2`）被 `filter(Boolean)` 过滤 — 不会推送空字符串
- 逗号分隔不支持引号转义 — `QWEN_KEYS="sk-1,sk-2"` 的引号会被 dotenv.parse 去掉
- `lastKeys` 初始为 `[]`，首次 `checkEnvChanges` 发现密钥 → 触发推送
- WS `send()` 在 `readyState !== OPEN` 时静默丢弃（不缓存、不排队）
- `KEYS_ENV_KEY` 在模块加载时确定（`isQwenwork() ? 'QWEN_KEYS' : 'WUKONG_KEYS'`），运行期不可切换
