# qwenwork-signing: 请求签名算法

## 目标

为每个 qwenwork 网关请求生成 `Authorization`、`Cosy-Key`、`Cosy-Date`、`Cosy-User` 四个鉴权头，逆向自 QwenWorkCN asar 中的 `encryptUserInfo` + `generateAuthToken` 喵～

## 输入输出

**输入：**
- `QwenTokenState`：含 `token`（OAuth access token）、`user.uid`、`user.name`、`user.email`
- `opts.url`：完整请求 URL
- `opts.body`：请求 body 的 JSON 字符串（明文，非编码）
- `opts.timestamp`：可选，秒级 Unix 时间戳（默认 `Math.floor(Date.now() / 1000)`）

**输出：**
- `QwenSignMaterial`：`cosyKey`（RSA 加密的 AES key）、`info`（AES 加密的 userInfo）、`uid`、`key`（16B AES key）
- `QwenAuthHeaders`：`authorization`、`cosyKey`、`cosyDate`、`cosyUser`

## 关键约束

### encryptUserInfo（`buildSignMaterial`）

1. **生成 AES key**：`e = randomUUID().replace(/-/g, '').substring(0, 16)` — 16 字节随机字符串
2. **构造 userInfo JSON**：
   ```json
   { "uid": "...", "aid": "", "name": "...", "email": "...", "security_oauth_token": "<access_token>" }
   ```
3. **AES 加密**：`info = base64(AES-128-CBC(key=e, iv=e.slice(0,16), JSON(userInfo)))`
   - key 和 iv 都是 `e` 的 UTF-8 bytes（`Buffer.from(e, 'utf8')`）
4. **RSA 加密**：`cosyKey = base64(RSA_PKCS1(publicKey, e))`
   - **PKCS1 padding**（`RSA_PKCS1_PADDING`），不是 OAEP

### RSA 公钥

- 内嵌 PEM（MIGf 头，modulus `c0f223...`），QwenWorkCN 0.1.3 asar 硬编码
- 可通过 `QWEN_RSA_PUBLIC_KEY_PATH` 环境变量覆盖（文件存在则读取，否则用内嵌）
- `getRsaPublicKey()` 惰性初始化 + 缓存到 `rsaPublicKey` 模块变量

### generateAuthToken（`buildAuthHeaders`）

1. **构造 header JSON**：
   ```json
   { "version": "v1", "requestId": "<uuid>", "info": "<info>", "cosyVersion": "1.0.0", "ideVersion": "1.0.0" }
   ```
2. **编码**：`o = base64(JSON.stringify(header))`
3. **Path 归一化**：
   - 取 `new URL(url).pathname`
   - 去 query string（`?` 之后截断）
   - **去 `/algo` 前缀**（`p.startsWith('/algo')` → `p.slice(5)`）
4. **签名串拼接**：`signStr = "${o}\n${cosyKey}\n${ts}\n${body}\n${path}"`
5. **MD5 签名**：`sig = md5(signStr).hex()`
6. **Authorization**：`Bearer COSY.${o}.${sig}`

## 验收标准

- [ ] 相同输入（token + url + body + timestamp）生成确定性签名
- [ ] `cosyKey` 可被 RSA 私钥解密还原为 16 字节 AES key
- [ ] `info` 可被该 AES key 解密还原为 userInfo JSON
- [ ] `authorization` 格式为 `Bearer COSY.<base64>.<md5hex>`
- [ ] URL 含 `/algo` 前缀时，签名用的 path 去掉该前缀
- [ ] URL 含 query string 时，签名用的 path 不含 query
- [ ] body 为完整 JSON 字符串（非截断、非编码）

## 已知边界

- RSA 使用 PKCS1 v1.5 padding，非 OAEP — 千问办公 asar 原始实现如此，不可更改喵
- `e` 是 16 字节 UTF-8 字符串（非 hex、非 base64），`Buffer.from(e, 'utf8')` 直接作为 key/iv
- `cosyDate` 为秒级时间戳字符串（`String(ts)`），非毫秒
- `cosyUser` 直接取 `uid`，不做额外编码
- 模块内 `rsaPublicKey` 为惰性单例缓存，进程生命周期内不重新加载
- path 归一化失败（`new URL` 抛异常）时保留原始 url 字符串
