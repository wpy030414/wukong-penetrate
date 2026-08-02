# capture-key-qwenwork: 千问办公 Token 验证

## 目标

验证千问办公登录态有效性 + 刷新链完整性，并将新 refresh token 备份到 `.env` 的 `QWEN_KEYS` 喵～

## 输入输出

**输入：**
- macOS 环境（Keychain 可用）
- 千问办公 App 已登录（`auth-v2.dat` 存在）
- Keychain 中存有 safeStorage 密码

**输出：**
- 终端打印：登录用户信息、access token（脱敏）、refresh token（脱敏）、有效期
- `.env` 文件：`QWEN_KEYS=<ory_rt_...>` 行（新建或替换）

## 关键约束

### 主流程

1. **平台检查**：`process.platform !== 'darwin'` → 报错退出（仅 macOS）
2. **文件检查**：`settings.qwenOauthTokenPath`（默认 `~/Library/Application Support/QwenWorkCN/auth-v2.dat`）必须存在
3. **解密 auth-v2.dat**：调用 `getToken()` → 触发 safeStorage 解密链路（Keychain 授权弹窗）
   - 打印用户名、邮箱、access token 脱敏值、有效期
4. **强制刷新**：调用 `forceRefresh()` → `refreshDeviceToken(cached.refreshToken)`
   - 验证刷新链可用（refresh token 未过期）
   - 打印新 access token + 新 refresh token（已轮换）
5. **备份到 .env**：`writeEnvRefreshToken(next.refreshToken)`
   - 前置：`git check-ignore .env` 必须通过
   - 替换或追加 `QWEN_KEYS=` 行
   - 文件 mode 600 + `chmodSync(0o600)`

### 无网络拦截

与 wukong 通道的 `capture-key` 根本不同 — 无需 mitmproxy、无需系统代理。纯本地密码学操作 + 一次 API 调用喵。

### .env 安全检查

```typescript
execSync(`cd "${REPO_ROOT}" && git check-ignore .env`, { stdio: 'ignore' });
```
- 未通过 → 中止，打印「.env 未被 git 忽略」
- 防止 refresh token 泄露到 git 历史

### 脱敏输出

`mask(s)` 函数：长度 > 12 → 显示前 12 + `…` + 后 4；否则显示 `(无效)`

## 验收标准

- [ ] macOS + 千问办公已登录 → 成功打印用户信息 + 刷新成功 + QWEN_KEYS 写入
- [ ] 非 macOS → 报错「仅支持 macOS」
- [ ] auth-v2.dat 不存在 → 报错「请先在千问办公 App 登录」
- [ ] Keychain 拒绝授权 → 解密失败 → 报错 + 排查提示
- [ ] refresh token 已过期 → 刷新失败 → 报错「token 可能已失效」
- [ ] .env 未被 git 忽略 → 中止，不写入
- [ ] .env 写入后 mode 为 600

## 已知边界

- **仅 macOS**：Windows safeStorage 走 DPAPI，auth.ts 的 `decryptAuthFile` 暂不支持
- Keychain 首次弹窗：用户必须点「允许」，否则 `security find-generic-password` 报错
- `forceRefresh` 会轮换 refresh token — 旧的 ory_rt_ 立即失效，新值必须备份到 QWEN_KEYS
- 如果 auth-v2.dat 被千问办公 App 重新登录覆盖，其中的 refresh token 也会变
- `writeEnvRefreshToken` 会清理多余空行（`replace(/\n{3,}/g, '\n\n')`）
