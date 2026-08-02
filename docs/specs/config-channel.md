# config-channel: 通道检测与配置

## 目标

根据启动参数判定当前通道（qwenwork / wukong），加载环境变量生成全局 `settings` 对象，为所有模块提供统一配置源喵～

## 输入输出

**输入：**
- `process.argv`：命令行参数（`--use wukong` 判定通道）
- `process.env`：环境变量（`.env` 文件通过 `dotenv.config()` 加载）
- 文件系统：Windows 下 `C:\Program Files\Wukong\` 目录（动态版本号检测）

**输出：**
- `CHANNEL`：`'qwenwork'` | `'wukong'`
- `PLUGIN_ID`：`'xrl-router-plugin-qwenwork'` | `'xrl-router-plugin-wukong'`
- `isWukong()` / `isQwenwork()`：布尔判定函数
- `settings`：`Settings` 对象，含所有配置项

## 关键约束

### channel.ts — 通道判定

```typescript
function parseChannel(): Channel {
  const i = process.argv.indexOf('--use');
  if (i >= 0 && process.argv[i + 1] === 'wukong') return 'wukong';
  return 'qwenwork'; // 默认
}
```

- 无 `--use` 参数 → `qwenwork`（默认通道）
- `--use wukong` → `wukong`
- `PLUGIN_ID` 按通道生成：`xrl-router-plugin-{channel}`

### config.ts — Settings 接口

`dotenv.config()` 在模块顶层调用，加载 `.env` 到 `process.env` 喵。

#### 通用变量

| 环境变量 | 字段 | 默认值 |
|---|---|---|
| `PORT` | `port` | `19067` |
| `AVAILABLE_MODELS` | `availableModels` | qwenwork: `qwork-advanced`；wukong: `dingtalk-auto` |
| `XRL_ROUTER_URL` | `xrlRouterUrl` | `http://localhost:19068` |

#### Qwenwork 通道变量

| 环境变量 | 字段 | 默认值 |
|---|---|---|
| `QWEN_KEYS` | （auth.ts 读取） | — |
| `QWEN_OAUTH_TOKEN_PATH` | `qwenOauthTokenPath` | `~/Library/Application Support/QwenWorkCN/auth-v2.dat` |
| `QWEN_KEYCHAIN_SERVICE` | `qwenKeychainService` | `QwenWorkCN Safe Storage` |
| `QWEN_KEYCHAIN_ACCOUNT` | `qwenKeychainAccount` | `QwenWorkCN Key` |
| `QWEN_BASE_URL` | `qwenBaseUrl` | `https://gateway.qwenwork.cn` |
| `QWEN_DEVICE_REFRESH_PATH` | `qwenDeviceRefreshPath` | `/api/v1/deviceToken/refresh` |
| `QWEN_REFRESH_INTERVAL_MS` | `qwenRefreshIntervalMs` | `600000`（10min） |
| `QWEN_RSA_PUBLIC_KEY_PATH` | `qwenRsaPublicKeyPath` | `''`（空 = 用内嵌） |
| `QWEN_TARGET` | `qwenTarget` | `c` |

#### Wukong 通道变量

| 环境变量 | 字段 | 默认值 |
|---|---|---|
| `WUKONG_KEYS` | （pluginClient 读取） | — |
| `DEAP_BASE_URL` | `deapBaseUrl` | `https://api-deap.dingtalk.com/dingtalk/v1` |
| `DEAP_USER_TYPE` | `deapUserType` | `vip` |
| `DEAP_SCENARIO_CODE` | `deapScenarioCode` | `com.dingtalk.scenario.wukong` |
| `DEAP_PRODUCT_CODE` | `deapProductCode` | `AI_WUKONG` |
| `DEAP_ABILITY_CODE` | `deapAbilityCode` | `M_AI_WUKONG` |
| `DEAP_WUKONG_CLIENT_VERSION` | `deapWukongClientVersion` | 动态检测（见下） |
| `DEAP_WUKONG_DEVICE_TYPE` | `deapWukongDeviceType` | `2` |
| `DEAP_AGENT_LOOP_VERSION` | `deapAgentLoopVersion` | `V2` |
| `DEAP_BIZ_PARAM` | `deapBizParam` | `{"taskDes":"5L2g5aW9"}` |

#### 动态版本号检测（`detectWukongClientVersion`）

优先级：
1. `DEAP_WUKONG_CLIENT_VERSION` 环境变量
2. Windows：`C:\Program Files\Wukong\` 下匹配 `/^\d+\.\d+\.\d+-.+$/` 的目录名，降序取最新
3. 兜底：`0.9.65-26061702`

### env() 工具函数

```typescript
function env(key: string, fallback: string): string {
  const v = process.env[key];
  return v !== undefined && v !== '' ? v : fallback;
}
```

空字符串视为未设置 → 使用 fallback 喵。

## 验收标准

- [ ] `pnpm serve`（无参数）→ `CHANNEL === 'qwenwork'`
- [ ] `pnpm serve -- --use wukong` → `CHANNEL === 'wukong'`
- [ ] `settings.port` 为数字类型（`parseInt`）
- [ ] `settings.availableModels` 为去空格的字符串数组
- [ ] 设置 `DEAP_BASE_URL=https://custom.api` → `settings.deapBaseUrl` 为该值
- [ ] 未设 `DEAP_BASE_URL` → 默认 `https://api-deap.dingtalk.com/dingtalk/v1`
- [ ] Windows + 悟空已安装 → `deapWukongClientVersion` 从目录名推断
- [ ] 非 Windows 且未设环境变量 → `deapWukongClientVersion` 为兜底值

## 已知边界

- `channel.ts` 只检查 `--use` 后紧跟 `wukong`；`--use=qwenwork` 这种等号形式不识别
- `AVAILABLE_MODELS` split 后 `filter(Boolean)` 去掉空项（尾部逗号不会产空元素）
- `QWEN_OAUTH_TOKEN_PATH` 默认用 `os.homedir()` 拼接，依赖运行用户 HOME 正确
- Windows 版本号检测：`readdirSync` 失败（目录不存在/无权限）静默 catch → 用兜底值
- `env()` 不区分 `undefined` 和空字符串 — 两者都走 fallback
