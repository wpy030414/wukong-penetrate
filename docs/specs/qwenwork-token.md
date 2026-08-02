# qwenwork-token: OAuth Token 生命周期管理

## 目标

管理千问办公 OAuth token 的获取、缓存、自动刷新和灾备，为签名模块提供有效的 access token + refresh token 喵～

## 输入输出

**输入：**
- `getToken()`：无参，返回当前有效 `QwenTokenState`
- `refreshDeviceToken(refreshToken)`：接受 ory_rt_ 前缀的 refresh token，返回新 `QwenTokenState`
- `forceRefresh()`：无参，强制刷新一次（capture-key 验证用）

**输出：**
- `QwenTokenState`：`{ token, refreshToken, user: { uid, name, email }, expiresAt, raw? }`

## 关键约束

### Token 来源优先级

按以下顺序尝试，成功即返回喵：

1. **内存缓存**（`cached`）：`Date.now() < cached.expiresAt - 5 * 60_000`（5 分钟缓冲）→ 直接返回
2. **缓存中的 refresh token**：`cached.refreshToken` → `refreshDeviceToken()` 刷新
3. **auth-v2.dat 文件**：safeStorage 解密（macOS Keychain）→ 直接返回解密结果
4. **.env QWEN_KEYS**：`loadRefreshTokenFromEnv()` → `refreshDeviceToken()` 自举刷新

### safeStorage 解密（`decryptAuthFile`）

1. **Keychain 取密码**：`security find-generic-password -s "QwenWorkCN Safe Storage" -a "QwenWorkCN Key" -w`
   - 输出末尾换行需去掉（`.replace(/\n$/, '')`）
2. **PBKDF2 派生 AES key**：`pbkdf2Sync(pw, "saltysalt", 1003, 16, "sha1")`
3. **IV**：`Buffer.alloc(16, 0x20)` — 16 个空格字符（0x20）
4. **文件头检查**：前 3 字节必须是 `v10`，否则报错
5. **AES-128-CBC 解密**：跳过前 3 字节（v10 头），解密剩余内容
6. **JSON 解析**：必须含 `token`（string）和 `refreshToken`（string）

### deviceToken/refresh API

- **URL**：`{qwenBaseUrl}{qwenDeviceRefreshPath}`（默认 `https://gateway.qwenwork.cn/api/v1/deviceToken/refresh`）
- **Body**：`{ "refresh_token": "<ory_rt_...>", "target": "c" }`
- **响应**：`{ device_token, refresh_token（轮换后的新值）, expires_at }`
- **字段兼容**：`j.device_token ?? j.token`
- **过期时间**：`expires_at` 为 ISO 字符串 → `Date.parse()`；缺失则 `Date.now() + 3600_000`

### .env 同步（`syncEnvRefreshToken`）

- **只写 QWEN_KEYS**，**绝不写 auth-v2.dat**（那是千问办公 App 的登录态，轮换会污染它）
- 查找现有 `QWEN_KEYS=` 行则替换，否则追加
- 文件 mode 600

### 单飞防并发

- `refreshing` promise 变量：有正在刷新的则直接返回该 promise
- `.finally(() => { refreshing = null })` 确保清理

### forceRefresh

- 先 `getToken()` 获取当前 state → 用其 `refreshToken` 刷新 → 更新缓存
- capture-key 脚本用来验证刷新链完整性

## 验收标准

- [ ] 首次调用 `getToken()`，auth-v2.dat 存在 → 解密返回
- [ ] 首次调用 `getToken()`，auth-v2.dat 不存在，QWEN_KEYS 有值 → 自举刷新返回
- [ ] access token 临近过期（< 5min 缓冲）→ 自动用 refresh token 刷新
- [ ] 并发调用 `getToken()` → 只触发一次网络刷新（单飞）
- [ ] `refreshDeviceToken` 成功后，.env QWEN_KEYS 已更新为新 refresh token
- [ ] auth-v2.dat 文件不被修改（只读）
- [ ] `forceRefresh()` 返回新的 token + 新的 refresh token（已轮换）

## 已知边界

- **仅 macOS**：safeStorage 依赖 Keychain，Windows 走 DPAPI 暂未实现（auth.ts 会因 `security` 命令不存在而报错）
- Keychain 首次访问会弹系统授权对话框，用户需点「允许」
- `.env` 不存在时 `loadRefreshTokenFromEnv` 返回 null（不报错）
- `syncEnvRefreshToken` 失败只 `console.warn`，不抛异常（不影响主流程）
- `cached.user` 在自举刷新时为空 `{ uid: '' }`（.env 无用户信息），后续从 JWT 解出
- auth-v2.dat 的 `raw` 字段保留原始 JSON（含 `loginDeviceId` 等千问办公内部字段）
