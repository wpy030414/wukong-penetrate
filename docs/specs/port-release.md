# port-release: 跨平台端口释放

## 目标

在 Express 服务器启动前，检测并杀死占用目标端口的进程，确保 `app.listen()` 不因 `EADDRINUSE` 失败喵～

## 输入输出

**输入：**
- `port`：目标端口号（默认 19067，来自 `settings.port`）

**输出：**
- Promise<void>：端口已释放（或本就空闲）时 resolve

## 关键约束

### 调用时机

`startServer()` 中，`app.listen()` 之前调用 `await killPortProcess(port)` 喵。

```typescript
async function startServer() {
  const port = settings.port;
  await killPortProcess(port);
  app.listen(port, host, () => { ... });
}
```

### macOS 实现

```typescript
const lsof = spawn('lsof', ['-ti', `:${port}`]);
// 收集 stdout → PID 列表
// code === 0 && pids 非空 → spawn('kill', ['-9', ...pidList])
// code !== 0（端口空闲）→ 直接 resolve
```

- `lsof -ti` 只输出 PID（`-t`）+ 抑制头信息（`-i`）
- 退出码 0 = 找到进程，非 0 = 无进程
- `kill -9` 强制杀死

### Windows 实现

```typescript
const netstat = spawn('netstat', ['-ano']);
// 收集全部 stdout
// 逐行匹配：包含 `:${port}` 且包含 `LISTENING`
// 提取最后一列（PID），去重
// PID 非空 → spawn('taskkill', ['/F', '/PID', ...pids])
```

- `netstat -ano` 输出所有连接（含 PID）
- 匹配条件：`line.includes(`:${port}`) && line.includes('LISTENING')`
- PID 提取：`parts[parts.length - 1]`（最后一列）
- `taskkill /F /PID` 强制杀死

### Graceful 语义

- 端口空闲 → resolve（不 reject）
- kill 失败 → resolve（不 reject）
- `lsof` / `netstat` 异常 → resolve（不 reject）
- **Promise 永不 reject** — 端口释放是 best-effort，不应阻塞启动

## 验收标准

- [ ] 端口被占用 → 杀死进程 → `app.listen()` 成功
- [ ] 端口空闲 → 无操作 → `app.listen()` 成功
- [ ] macOS：`lsof` 找到多个 PID → 全部 kill -9
- [ ] Windows：`netstat` 找到多个 LISTENING 行 → 去重 PID → 全部 taskkill
- [ ] `killPortProcess` 不会 throw / reject

## 已知边界

- macOS 上 `lsof` 可能需要几秒（端口多时），但通常 < 100ms
- Windows `netstat -ano` 输出量大，全量收集到 `output` 字符串后逐行解析
- `kill -9` / `taskkill /F` 是强制杀死，不给进程 graceful shutdown 机会
- 如果端口被系统进程占用（PID 0 / System），kill 可能失败 → 静默 resolve → `app.listen()` 随后报 EADDRINUSE
- 只在 `startServer()` 启动时调用一次，不做运行时端口监控
