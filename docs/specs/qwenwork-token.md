# qwenwork-token: OAuth Token 生命周期管理

## 目标

管理千问办公 OAuth token 的获取、缓存、自动刷新和灾备，为签名模块提供有效的 access token + refresh token。支持 auth-v2.dat 文件监听自动拾取千问 App 的 token 刷新，双向同步避免轮换互踩喵～

## 输入输出

**输入：**
- `getToken()`：无参，返回当前有效 `QwenTokenState`（缓存 + 按需刷新）
- `refreshDeviceToken(refreshToken)`：接受 ory_rt_ 前缀的 refresh token，返回新 `QwenTokenState`
- `forceRefresh()`：无参，强制刷新一次（capture-key 诊断用）
- `initTokenManager()`：启动时调用，启动 auth-v2.dat 文件监听

**输出：**
- `QwenTokenState`：`{ token, refreshToken, user: { uid, name, email }, expiresAt, raw? }`

## 关键约束

### Token 缓存策略

```
  getToken() 调用
      │
  cached 存在且 expiresAt > now + 5min？
      │ 是 → 直接返回，零网络请求
      │ 否 ↓
  ① cached.refreshToken → refreshDeviceToken()
      │ 失败 ↓ 重读 auth-v2.dat
  ② decryptAuthFile() → token 有效直接用 / refresh token 刷新
      │ 失败 ↓
  ③ .env QWEN_KEYS → refreshDeviceToken()
      │ 失败 ↓
  throw Error('无可用 token 源')
```

缓存检查：`Date.now() < expiresAt - 5 * 60_000`（提前 5 分钟刷新）。并发防重：`refreshing` Promise 单飞。

### safeStorage 解密（`decryptAuthFile`，按平台分派）

**通用**：文件头检查——前 3 字节必须是 `v10`，否则报错（自动剥离 UTF-8 BOM 容错）喵。

**macOS（Keychain）**：
1. **Keychain 取密码**：`security find-generic-password -s "QwenWorkCN Safe Storage" -a "QwenWorkCN Key" -w`
   - 输出末尾换行需去掉（`.replace(/\n$/, '')`）
2. **PBKDF2 派生 AES key**：`pbkdf2Sync(pw, "saltysalt", 1003, 16, "sha1")`
3. **IV**：`Buffer.alloc(16, 0x20)` — 16 个空格字符（0x20）
4. **AES-128-CBC 解密**：跳过前 3 字节（v10 头），解密剩余内容
5. **JSON 解析**：必须含 `token`（string）和 `refreshToken`（string）

**Windows（AES-256-GCM，Electron ≥ 37 的 os_crypt 格式）**：
1. **取 AES key**：`getWindowsAesKey()` — 读 `{userDataDir}/Local State` 的 `os_crypt.encrypted_key`
   - base64 解码 → 去掉 `DPAPI` 前缀（5 字节）→ DPAPI blob
   - `dpapiUnprotect()`：PowerShell `System.Security` 的 `ProtectedData.Unprotect`（**entropy=NULL**，CurrentUser）
   - 输出 32 字节 AES key
2. **解 auth-v2.dat**：v10 头后 = `12B nonce + 密文 + 16B tag`
   - `aes-256-gcm`，`setAuthTag(tag)` → 解出明文 JSON
3. **JSON 解析**：同 macOS，必须含 `token` + `refreshToken`

### safeStorage 加密（`encryptAuthFile`，写回 auth-v2.dat）

与解密完全对称，复用已有 AES key（无需重新 DPAPI 解包）。千问 App 不做文件完整性校验，加密格式正确即可。

**macOS**：`AES-128-CBC(key=aesKey, iv=0x20×16, JSON)` → `v10 + 密文`
**Windows**：`AES-256-GCM(key=aesKey, nonce=randomBytes(12), JSON)` → `v10 + nonce + 密文 + tag`

### deviceToken/refresh API

- **URL**：`{qwenBaseUrl}{qwenDeviceRefreshPath}`（默认 `https://gateway.qwenwork.cn/api/v1/deviceToken/refresh`）
- **Body**：`{ "refresh_token": "<ory_rt_...>", "target": "c" }`
- **响应**：`{ device_token, refresh_token（轮换后的新值）, expires_at }`
- **字段兼容**：`j.device_token ?? j.token`
- **过期时间**：`expires_at` 为 ISO 字符串 → `Date.parse()`；缺失则 `Date.now() + 3600_000`
- **刷新后写回**：
  1. `encryptAuthFile()` → auth-v2.dat（双向同步，千问 App 下次读取拿到新 token）
  2. `syncEnvRefreshToken()` → `.env` QWEN_KEYS

### auth-v2.dat 文件监听（`initTokenManager` → `startAuthFileWatch`）

启动时调用 `initTokenManager()`：

```
fs.watch(settings.qwenOauthTokenPath)
    │ 文件变化 ↓
  debounce 1s（setTimeout）
    │
  mtime 去重（statSync().mtimeMs === lastKnownMtime → 跳过）
    │
    ▼
  decryptAuthFile() → 更新 cached → syncEnvRefreshToken()
```

- Windows `fs.watch` 同一文件可能重复触发，debounce + mtime 双重去重
- watcher 异常时自动重启（5s 后重试 `startAuthFileWatch()`）
- 千问 App 刷新 token 后文件变化被自动拾取

### syncEnvRefreshToken

写 `.env` 的 `QWEN_KEYS` 行。双向同步（`encryptAuthFile` + `syncEnvRefreshToken`）确保插件和千问 App 持有相同的 refresh token，避免轮换互踩。

### 单飞防并发

- `refreshing` promise 变量：有正在刷新的则直接返回该 promise
- `.finally(() => { refreshing = null })` 确保清理

### forceRefresh

- 先 `getToken()` 获取当前 state → 用其 `refreshToken` 刷新 → 更新缓存
- capture-key 脚本用来验证刷新链完整性

## 验收标准

- [ ] 首次调用 `getToken()`，auth-v2.dat 存在（macOS）→ Keychain 解密返回
- [ ] 首次调用 `getToken()`，auth-v2.dat 存在（Windows）→ DPAPI 解密返回
- [ ] 首次调用 `getToken()`，auth-v2.dat 不存在，QWEN_KEYS 有值 → 自举刷新返回
- [ ] access token 剩余 > 5 分钟 → 直接返回缓存，零网络请求
- [ ] access token 临近过期（< 5min 缓冲）→ 自动用 refresh token 刷新
- [ ] refresh 成功后 auth-v2.dat 已写回（双向同步）
- [ ] refresh 成功后 .env QWEN_KEYS 已更新
- [ ] 并发调用 `getToken()` → 只触发一次网络刷新（单飞）
- [ ] 千问 App 刷新 auth-v2.dat → 文件监听自动拾取新 token
- [ ] watcher 异常 → 5s 后自动重启
- [ ] `forceRefresh()` 返回新的 token + 新的 refresh token（已轮换）
- [ ] macOS + Windows 加密写回格式与解密对称

## 已知边界

- **macOS**：safeStorage 依赖 Keychain，首次访问会弹系统授权对话框，用户需点「允许」
- **Windows**：AES key 经 DPAPI 保护绑定当前 Windows 用户，auth-v2.dat + Local State 拷贝到其他机器/账户无法解密
- **Windows**：解密经 PowerShell `System.Security`（Windows 自带），powershell.exe 不可用时无法解密
- **Windows**：`encrypted_key` 需为 `DPAPI\0` 格式（App-Bound `APPB` 格式暂不支持）
- **文件头**：必须是 `v10`；自动剥离 UTF-8 BOM 容错
- `.env` 不存在时 `loadRefreshTokenFromEnv` 返回 null（不报错）
- `syncEnvRefreshToken` 失败只 `console.warn`，不抛异常（不影响主流程）
- `cached.user` 在自举刷新时为空 `{ uid: '' }`（.env 无用户信息），后续从 JWT 解出
- auth-v2.dat 的 `raw` 字段保留原始 JSON（含 `loginDeviceId` 等千问办公内部字段）
- 千问 App 如果采用原子写入（先写临时文件再 rename），`fs.watch` 可能在 rename 后丢失监听；watcher 异常重启机制会自愈
- refresh token 服务端可能有绝对过期时间（未逆向），到时间仍需重新登录千问 App
