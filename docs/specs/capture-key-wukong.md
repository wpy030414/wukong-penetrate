# capture-key-wukong: 悟空 DEAP 密钥抓取

## 目标

通过 mitmproxy MITM 从本地悟空 daemon（DingTalkReal）捕获 DEAP `sk-` 密钥，写入 `.env` 的 `WUKONG_KEYS` 喵～

## 输入输出

**输入：**
- 本地已运行的悟空 daemon（DingTalkReal）
- mitmproxy（mitmdump）已安装
- mitmproxy CA 证书已被系统信任
- wukong-cli 可执行文件

**输出：**
- `.env` 文件中 `WUKONG_KEYS=<sk-...>` 行（追加或新建）
- 成功时删除所有临时日志；失败时保留日志供排查

## 关键约束

### 为什么用系统代理

daemon 的 chat 客户端**无视 `HTTPS_PROXY` 环境变量**，只认系统级 HTTP 代理。因此必须改写系统代理设置才能劫持流量喵。

### 主流程

1. **Preflight 自检**：
   - `mitmdump --version` 可用
   - CA 证书存在（`~/.mitmproxy/mitmproxy-ca-cert.pem`）且被系统信任
   - `cap_deap.py` 脚本存在
   - wukong-cli 可找到
   - daemon 就绪（`wukong-cli service status`）
   - 检测竞争代理客户端（Clash Verge / Surge / Stash / sing-box 等）

2. **启动 mitmdump**：`mitmdump -p 8888 -s cap_deap.py`，输出落 `MITM_LOG`

3. **设置系统代理**：
   - macOS：`networksetup -setwebproxy` + `-setsecurewebproxy` → 校验 server=127.0.0.1 port=8888
   - Windows：注册表 `HKCU\...\Internet Settings` + `netsh winhttp set proxy`
   - 每项最多重试 3 次

4. **触发 daemon chat**：`wukong-cli -p "在" --output-format json --quiet`，30s 超时 kill

5. **提取 key**：轮询 `/tmp/deap_capture.log`，正则 `/Bearer (sk-[0-9a-z]{32})/g`，取最后一个匹配
   - 等待上限 45s（`WAIT_MS`）
   - 每 5s 检查系统代理是否仍在 8888（被抢占则早停）
   - 每 10s 检查 mitmdump 是否收到流量（无流量则再触发一次）

6. **校验 key**：直连 DEAP `/chat/completions`（完整 12 业务头），验证响应有效
   - 401 → key 过期，重抓即可
   - 402 → 配额超限（quotaExceeded），重抓无用

7. **写入 .env**：
   - 前置检查：`git check-ignore .env` 必须通过
   - WUKONG_KEYS 已存在 → 追加（去重）
   - 不存在 → 新建行
   - 文件 mode 600

8. **Cleanup**（finally 必执行）：
   - 还原原始系统代理
   - kill mitmdump + kill 8888 端口
   - 成功 → 删除 LOG / MITM_LOG / CLI_LOG
   - 失败 → 保留日志 + 打印路径

### 跨平台差异

| 功能 | macOS | Windows |
|---|---|---|
| 系统代理读写 | `networksetup` | 注册表 `HKCU\...\Internet Settings` + `netsh winhttp` |
| 端口检测 | `lsof -ti :port` | PowerShell `Get-NetTCPConnection` |
| 进程杀 | `kill -9` | `taskkill /F /PID` |
| CA 信任 | `security add-trusted-cert` | `certutil -addstore -f "Root"` |
| CA 验证 | `security verify-cert` | `certutil -verifystore "Root"` |
| 可执行查找 | `command -v` | `where` |

### Windows 额外逻辑

- **停 Clash Verge**：`Get-CimInstance Win32_Process` 找进程 → `Stop-Process` → cleanup 时 `start "" 路径` 重启
- **重启 daemon**：代理设好后杀掉 DingTalkReal → 重新启动（让它读到新代理值）→ 轮询 `service status` 等就绪
- **Named pipe 检测**：`\\.\pipe\real-daemon` 存在 → daemon 实际就绪（CLI 可能因版本不匹配报错）
- **wukong-cli 查找**：动态搜索 `C:\Program Files\Wukong\<version>\bin\wukong-cli.exe`（按版本号降序取最新）

### cap_deap.py（mitmproxy 脚本）

- 过滤条件：`"api-deap" in host` 或 `("dingtalk" in host and "chat" in path)`
- 记录：URL、Authorization 头、所有请求头、body 前 2000 字符
- 响应也记录（status、响应头、body）
- 日志路径：macOS `/tmp/deap_capture.log`，Windows `%TEMP%/deap_capture.log`

## 验收标准

- [ ] macOS：运行脚本 → .env WUKONG_KEYS 含有效 sk- key
- [ ] Windows：运行脚本（管理员） → .env WUKONG_KEYS 含有效 sk- key
- [ ] 成功完成后，系统代理还原为原始值
- [ ] 成功完成后，`/tmp/deap_capture.log` 等临时日志已删除
- [ ] 失败时，临时日志保留 + 路径打印
- [ ] 失败时，系统代理仍还原（finally 保证）
- [ ] .env 未被 git 忽略 → 中止并报错
- [ ] key 校验遇 402 → 明确提示「配额超限，重抓无解」
- [ ] 竞争代理检测 → 提示关闭 System Proxy 开关

## 已知边界

- **Key 格式**：`sk-` + 32 字符 `[0-9a-z]`（不是 hex 字符集，含 g-z），有效期约 29 天
- **#1 失败原因**：daemon 未就绪（未登录、未启动、`--app-relaunched` 后台实例不含完整 daemon）
- **sudo 密码**：`security add-trusted-cert` 需 sudo，但脚本不存储密码（依赖系统 sudo 缓存）
- **Clash Verge 抢占**：开着 System Proxy 开关时会持续改写系统代理，必须先在其界面关闭
- **Windows 需管理员权限**：`netsh`、`certutil -addstore`、注册表写入都需要
- **mitmdump 端口冲突**：8888 被占用 → `killPortProcess` 先清理
- **daemon keep-alive**：可能复用旧连接不走代理 → 重试触发 + 诊断日志
