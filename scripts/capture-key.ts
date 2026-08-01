#!/usr/bin/env tsx
/**
 * capture-key.ts — 一键抓取 deap API Key 并写入 .env（对应 pnpm capture-key）。
 *
 * 跨平台支持：macOS + Windows
 *
 * 已验证的可行链路（详见 docs/README.md）：
 *   daemon（DingTalkReal）的 chat 客户端【无视 HTTPS_PROXY 环境变量】，但【认系统级 HTTP 代理】。
 *   所以：开系统代理→8888 → 用 wukong-cli -p 触发 daemon 发 chat → mitmdump 抓到
 *   带完整 `Authorization: Bearer sk-...` 的 /chat/completions → 校验 → 写 .env → 还原系统代理。
 *
 * 平台差异：
 *   macOS: networksetup / lsof / kill / security
 *   Windows: netsh / netstat / taskkill / certutil
 *
 * 本机常见坑（已加固，见 git log / docs 排错表）：
 *   - Clash Verge / Mihomo / Surge / Stash 等「System Proxy」开关会持续把系统代理改写成它们自己的端口。
 *       加固①：preflight 检测并提示先关闭其系统代理开关；
 *       加固②：开代理后【校验 server=127.0.0.1 & port=8888，而非只看 Enabled】，被抢占立即中止；
 *       加固③：cleanup【记录并还原原始 server:port】，不再留下脏值。
 *   - 旧版失败即焚所有日志 → 纯黑盒无从排错。
 *       加固④：mitmdump / wukong-cli 输出落日志；失败时【保留】并打印三段定位。
 *       加固⑤：validateKey 遇 402 quotaExceeded 明确提示「配额超限、重抓无解」。
 *
 * 流程：自检 → 起 mitmdump → 开系统代理（校验 server:port）→ 触发抓 key → 还原原系统代理 → 校验写 env → 清理。
 *
 * 需要主人介入：
 *   1. daemon 须已登录运行（脚本检测 `.real` daemon 就绪，未就绪会先尝试 service start）。
 *   2. 若装了 Clash Verge 等，请先在其界面关闭「System Proxy / 系统代理」开关。
 *   3. Windows 需以管理员权限运行（netsh/certutil 需要）。
 * 安全红线：系统代理在 finally 里务必还原；.env 永不进 git；含明文 key 的日志【成功才焚、失败保留供排查】。
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { settings } from '../src/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CAP_SCRIPT = path.join(__dirname, 'cap_deap.py');

/** 平台检测 */
const IS_WINDOWS = process.platform === 'win32';
const IS_MACOS = process.platform === 'darwin';

// 日志路径：macOS 用 /tmp/，Windows 用 %TEMP%（cap_deap.py 也需要同步改写 LOG）
const TMP_DIR = IS_WINDOWS ? (process.env.TEMP || process.env.TMP || path.join(os.homedir(), 'AppData', 'Local', 'Temp')) : '/tmp';
const LOG = path.join(TMP_DIR, 'deap_capture.log');   // cap_deap.py 写的抓包日志（含明文 Authorization）
const MITM_LOG = path.join(TMP_DIR, 'deap_mitm.log'); // mitmdump 自身输出
const CLI_LOG = path.join(TMP_DIR, 'deap_cli.log');   // wukong-cli 输出
const PROXY_PORT = 8888;
const ENV_PATH = path.join(REPO_ROOT, '.env');
const WAIT_MS = 45000;
const NET_SERVICE = process.env.CAPTURE_NET_SERVICE || 'Wi-Fi'; // 主用网络接口名（macOS 用）

const DEAP_BASE_URL = settings.baseUrl;

/** deap 业务头：直接复用 src/config.ts 的 settings，消除重复定义 */
const DEAP_HEADERS: Record<string, string> = {
  'x-dingtalk-user-type': settings.deapUserType,
  'x-dingtalk-scenario-code': settings.deapScenarioCode,
  'x-dingtalk-product-code': settings.deapProductCode,
  'x-dingtalk-ability-code': settings.deapAbilityCode,
  'x-wukong-client-version': settings.deapWukongClientVersion,
  'x-wukong-device-type': settings.deapWukongDeviceType,
  'x-wukong-agent-loop-version': settings.deapAgentLoopVersion,
  'x-dingtalk-biz-param': settings.deapBizParam,
};

interface ShResult { code: number; out: string; }
interface ProxyCfg { server: string; port: string; enabled: boolean; }

// —— 输出 / 工具 ——
const ok = (s: string): void => console.log(`✅ ${s}`);
const fail = (s: string): void => console.error(`\n❌ ${s}`);
const step = (s: string): void => console.log(`\n▶ ${s}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const mask = (k: string): string => (k && k.length > 10 ? `${k.slice(0, 10)}…${k.slice(-4)}` : '(无效)');
const readFileSafe = (p: string): string => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

function sh(cmd: string): ShResult {
  try {
    return { code: 0, out: execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString() };
  } catch (e: any) {
    return { code: e.status ?? 1, out: (e.stdout?.toString() || '') + (e.stderr?.toString() || '') };
  }
}

// ==================== 平台抽象层 ====================


/** 平台抽象接口 */
interface Platform {
  /** 系统代理：读取当前配置 */
  getProxy(which: 'web' | 'secure'): ProxyCfg;
  /** 系统代理：设置（server/port/enabled） */
  setProxy(which: 'web' | 'secure', server: string, port: string, enabled: boolean): boolean;
  /** 端口检测：是否被监听 */
  isPortListening(port: number): boolean;
  /** 进程管理：按 PID 杀进程 */
  killProcess(pid: string): void;
  /** 进程管理：杀掉占用某端口的进程 */
  killPortProcess(port: number): void;
  /** CA 证书：是否被系统信任 */
  isCaTrusted(caPath: string): boolean;
  /** CA 证书：信任（需管理员/root 权限） */
  trustCa(caPath: string): boolean;
  /** 查找可执行文件 */
  findExecutable(name: string): string | null;
}

/** macOS 实现 */
class MacOSPlatform implements Platform {
  private readonly CMD: Record<'web' | 'secure', string> = { web: 'web', secure: 'secureweb' };

  getProxy(which: 'web' | 'secure'): ProxyCfg {
    const out = sh(`networksetup -get${this.CMD[which]}proxy "${NET_SERVICE}"`).out;
    const server = (out.match(/Server:\s*(\S+)/) || [, ''])[1] ?? '';
    const port = (out.match(/Port:\s*(\d+)/) || [, ''])[1] ?? '';
    const enabled = /Enabled:\s*Yes/i.test(out);
    return { server, port, enabled };
  }

  setProxy(which: 'web' | 'secure', server: string, port: string, enabled: boolean): boolean {
    sh(`networksetup -set${this.CMD[which]}proxy "${NET_SERVICE}" ${server} ${port}`);
    sh(`networksetup -set${this.CMD[which]}proxystate "${NET_SERVICE}" ${enabled ? 'on' : 'off'}`);
    // 校验
    const got = this.getProxy(which);
    return got.server === server && got.port === port && got.enabled === enabled;
  }

  isPortListening(port: number): boolean {
    return sh(`lsof -ti :${port}`).out.trim().length > 0;
  }

  killProcess(pid: string): void {
    sh(`kill -9 ${pid} 2>/dev/null`);
  }

  killPortProcess(port: number): void {
    sh(`lsof -ti :${port} | xargs kill -9 2>/dev/null`);
  }

  isCaTrusted(caPath: string): boolean {
    const r = sh(`security verify-cert -c "${caPath}"`);
    return r.code === 0 && /successful/i.test(r.out);
  }

  trustCa(caPath: string): boolean {
    const r = sh(`sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${caPath}"`);
    return r.code === 0;
  }

  findExecutable(name: string): string | null {
    const w = sh(`command -v ${name}`);
    return w.code === 0 && w.out.trim() ? w.out.trim() : null;
  }
}

/** Windows 实现 */
class WindowsPlatform implements Platform {
  /** Internet Options 注册表路径（WinINet 系统代理） */
  private readonly IE_OPTIONS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

  getProxy(which: 'web' | 'secure'): ProxyCfg {
    // 优先 WinHTTP（由 netsh 设置，Rust reqwest 等使用）
    const out = sh('netsh winhttp show proxy').out;
    const proxyMatch = out.match(/代理服务器:\s*(\S+):(\d+)/i) || out.match(/Proxy Server\(s\):\s*(\S+):(\d+)/i);
    if (proxyMatch) {
      return { server: proxyMatch[1], port: proxyMatch[2], enabled: true };
    }
    // 兜底 Internet Options 注册表（WinINet，传统桌面应用）
    const enR = sh(`reg query "${this.IE_OPTIONS}" /v ProxyEnable 2>nul`);
    if (enR.code === 0 && /0x1/i.test(enR.out)) {
      const svR = sh(`reg query "${this.IE_OPTIONS}" /v ProxyServer 2>nul`).out;
      const svM = svR.match(/(\S+):(\d+)/);
      if (svM) return { server: svM[1], port: svM[2], enabled: true };
    }
    return { server: '', port: '', enabled: false };
  }

  setProxy(which: 'web' | 'secure', server: string, port: string, enabled: boolean): boolean {
    if (enabled) {
      // WinINet 系统代理（Internet Options 注册表）
      sh(`reg add "${this.IE_OPTIONS}" /v ProxyEnable /t REG_DWORD /d 1 /f 2>nul`);
      sh(`reg add "${this.IE_OPTIONS}" /v ProxyServer /t REG_SZ /d "${server}:${port}" /f 2>nul`);
      sh(`reg add "${this.IE_OPTIONS}" /v ProxyOverride /t REG_SZ /d "<local>" /f 2>nul`);
      // WinHTTP（Rust reqwest 等使用）
      sh(`netsh winhttp set proxy proxy-server="${server}:${port}"`);
    } else {
      // 关闭 WinINet 代理
      sh(`reg add "${this.IE_OPTIONS}" /v ProxyEnable /t REG_DWORD /d 0 /f 2>nul`);
      // 关闭 WinHTTP 代理
      sh('netsh winhttp reset proxy');
    }
    // 校验
    const got = this.getProxy(which);
    return enabled ? (got.server === server && got.port === port && got.enabled) : !got.enabled;
  }

  isPortListening(port: number): boolean {
    // PowerShell Get-NetTCPConnection（跨 locale，不受 LISTENING/监听 影响）
    const r = sh(`powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"`);
    return r.code === 0;
  }

  killProcess(pid: string): void {
    sh(`taskkill /F /PID ${pid} 2>nul`);
  }

  killPortProcess(port: number): void {
    sh(`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force }" 2>nul`);
  }

  isCaTrusted(caPath: string): boolean {
    // Windows: 确认 cert 在受信任根存储区（而非 AIA 在线验证，certutil -verify 瞎说可信）
    const r = sh(`certutil -verifystore "Root" mitmproxy 2>nul`);
    return r.code === 0 && /mitmproxy/i.test(r.out);
  }

  trustCa(caPath: string): boolean {
    const r = sh(`certutil -addstore -f "Root" "${caPath}"`);
    return r.code === 0;
  }

  findExecutable(name: string): string | null {
    const w = sh(`where ${name} 2>nul`);
    return w.code === 0 && w.out.trim() ? w.out.trim().split('\n')[0] : null;
  }
}

/** 平台实例 */
const platform: Platform = IS_WINDOWS ? new WindowsPlatform() : new MacOSPlatform();

// ==================== 平台无关逻辑 ====================

/** 系统代理是否真的指向 mitmdump（server+port+enabled 三者都对）*/
function proxyPointsToMitm(which: 'web' | 'secure'): boolean {
  if (IS_WINDOWS) {
    // Windows: 没有系统代理概念，改检查 mitmdump 是否仍在监听
    return platform.isPortListening(PROXY_PORT);
  }
  const c = platform.getProxy(which);
  return c.enabled && c.server === '127.0.0.1' && c.port === String(PROXY_PORT);
}

/** 检测会持续抢占系统代理的客户端（Clash Verge / Mihomo / Surge / Stash 等）*/
function detectCompetingProxy(): string | null {
  const ps = IS_WINDOWS
    ? sh('powershell -NoProfile -Command "(Get-Process).Name" 2>nul').out
    : sh('ps -Axo comm= 2>/dev/null').out;
  const rules: Array<[RegExp, string]> = [
    [/clash-verge|verge-mihomo|mihomo/i, 'Clash Verge / Mihomo'],
    [/\bSurge\b/i, 'Surge'],
    [/\bStash\b/i, 'Stash'],
    [/sing-box|v2ray|xray|trojan-go/i, 'sing-box / v2ray 等'],
    [/quantumult/i, 'Quantumult'],
  ];
  for (const [re, label] of rules) if (re.test(ps)) return label;
  return null;
}

/** 查找 wukong-cli */
function findWukongCli(): string | null {
  // —— Windows：动态搜索 C:\Program Files\Wukong\<版本>\bin\wukong-cli.exe ——
  if (IS_WINDOWS) {
    const wukongDir = 'C:\\Program Files\\Wukong';
    try {
      const versions = fs.readdirSync(wukongDir).filter(d => {
        // 版本目录形如 "0.9.65-26061702"
        return /^\d+\.\d+\.\d+-.+$/.test(d) && fs.existsSync(path.join(wukongDir, d, 'bin', 'wukong-cli.exe'));
      });
      // 按版本号降序排列（取最新版本）
      versions.sort((a, b) => b.localeCompare(a));
      if (versions.length > 0) {
        return path.join(wukongDir, versions[0], 'bin', 'wukong-cli.exe');
      }
    } catch { /* 目录不存在或无权限 */ }
  }

  const candidates = [
    process.env.WUKONG_CLI_PATH,
    // Windows 固定安装路径
    IS_WINDOWS ? 'C:\\Program Files\\Wukong\\wukong-cli.exe' : null,
    // macOS 固定路径
    IS_MACOS ? '/Applications/Wukong.app/Contents/MacOS/wukong-cli' : null,
    // ~/.real/bin 下的 CLI（两平台通用兜底）
    path.join(os.homedir(), '.real', 'bin', IS_WINDOWS ? 'wukong-cli.exe' : 'wukong-cli'),
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    const expanded = c.replace(/^~/, os.homedir());
    if (fs.existsSync(expanded)) return expanded;
  }
  return platform.findExecutable(IS_WINDOWS ? 'wukong-cli.exe' : 'wukong-cli');
}

// —— Windows 系统代理管理 + daemon 重启 ——
const IE_OPTIONS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
let CLASH_PATH: string | null = null;
let CLASH_WAS_RUNNING = false;
let ORIG_PROXY: { enabled: boolean; server: string } = { enabled: false, server: '' };

/** Windows：准备代理环境（停 Clash → 设 8888 → 重启 daemon 读新代理） */
async function windowsPrepareProxy(): Promise<boolean> {
  if (!IS_WINDOWS) return true;

  // 1. 快照原始代理
  const eR = sh(`powershell -NoProfile -Command "(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings').ProxyEnable"`);
  const sR = sh(`powershell -NoProfile -Command "(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings').ProxyServer"`);
  ORIG_PROXY = { enabled: eR.out.trim() === '1', server: sR.out.trim() };

  // 2. 停 Clash Verge（以免它抢回代理设置）
  const clashPs = sh(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name like 'clash-verge%' or name like 'verge-mihomo%' or name like 'mihomo%'\\" | Select-Object ExecutablePath"`);
  const pathMatch = clashPs.out.match(/ExecutablePath\s+:\s+(.+)/i);
  if (pathMatch) CLASH_PATH = pathMatch[1].trim();
  CLASH_WAS_RUNNING = clashPs.code === 0 && clashPs.out.trim().length > 0;
  if (CLASH_WAS_RUNNING) {
    sh(`powershell -NoProfile -Command "Get-Process clash-verge,verge-mihomo,mihomo -ErrorAction SilentlyContinue | Stop-Process -Force"`);
    console.log('   ⏸ Clash Verge 已暂停');
  } else {
    console.log('   Clash Verge 未运行');
  }

  // 3. 设系统代理为 127.0.0.1:8888
  sh(`powershell -NoProfile -Command "Set-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' ProxyEnable 1; Set-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' ProxyServer '127.0.0.1:8888'"`);
  console.log('   📡 系统代理已设为 127.0.0.1:8888（注册表 WinINet）');

  // 4. 重启 daemon（让它读到新代理值）
  const daemonExe = sh(`powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"name='DingTalkReal.exe'\\" | Select-Object -ExpandProperty ExecutablePath)"`).out.trim();
  if (daemonExe) {
    sh(`powershell -NoProfile -Command "Get-Process DingTalkReal -ErrorAction SilentlyContinue | Stop-Process -Force"`);
    await sleep(2000); // 等进程退出
    sh(`start "" "${daemonExe}"`);
    console.log('   🔄 Daemon 已重启（读取新代理 127.0.0.1:8888）');
    // 等 daemon 就绪
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      const r = sh(`"${CLI}" service status 2>nul`);
      if (r.code === 0 && !/not running|未运行|未启动/i.test(r.out)) {
        console.log(`   ✅ Daemon 就绪（约 ${i + 1}s）`);
        return true;
      }
    }
    fail('daemon 重启后未就绪');
    return false;
  } else {
    // daemon 原来没跑 — 正常启动它
    const cliDir = path.dirname(CLI || '');
    const daemonPath = path.resolve(cliDir, '..', 'DingTalkReal.exe');
    if (fs.existsSync(daemonPath)) {
      sh(`start "" "${daemonPath}"`);
      console.log('   🔄 Daemon 已启动');
      for (let i = 0; i < 15; i++) {
        await sleep(1000);
        const r = sh(`"${CLI}" service status 2>nul`);
        if (r.code === 0 && !/not running|未运行|未启动/i.test(r.out)) {
          console.log(`   ✅ Daemon 就绪（约 ${i + 1}s）`);
          return true;
        }
      }
    }
    fail('无法启动 daemon');
    return false;
  }
}

/** Windows：还原代理环境（恢复注册表 + 重启 Clash） */
function windowsRestoreProxy(): void {
  if (!IS_WINDOWS) return;
  // 还原注册表代理
  if (ORIG_PROXY.enabled && ORIG_PROXY.server) {
    sh(`powershell -NoProfile -Command "Set-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' ProxyEnable 1; Set-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' ProxyServer '${ORIG_PROXY.server}'"`);
  } else {
    sh(`powershell -NoProfile -Command "Set-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' ProxyEnable 0"`);
  }
  console.log('   🧹 系统代理已还原');
  // 重启 Clash
  if (CLASH_WAS_RUNNING && CLASH_PATH) {
    sh(`start "" "${CLASH_PATH}"`);
    console.log('   ▶ Clash Verge 已重启');
  }
}

// —— daemon 就绪检测 / 拉起（真正的闸门：~/.real/daemon.sock）——
let CLI: string | null = null;

function daemonReady(): boolean {
  if (!CLI) return false;
  const r = sh(`"${CLI}" service status`);
  // 兼容多 locale：中 / 英均识别
  return r.code === 0 && !/not running|未运行|未启动/i.test(r.out);
}

/** Windows：检测 named pipe \\.\pipe\real-daemon 是否存在（取代已弃用的 wmic） */
function windowsDaemonPipeExists(): boolean {
  if (!IS_WINDOWS) return false;
  // Test-Path 在 PowerShell 中可直接检测 named pipe 是否存在（\\.\pipe\ 是 NT 设备命名空间）
  const r = sh(`powershell -NoProfile -Command "Test-Path '\\\\.\\pipe\\real-daemon'"`);
  if (r.code === 0 && /true/i.test(r.out)) return true;
  // 兜底：尝试连接 pipe（超时 0）
  const r2 = sh(`powershell -NoProfile -Command "try { \$p = New-Object System.IO.Pipes.NamedPipeClientStream('.', 'real-daemon', [System.IO.Pipes.PipeDirection]::In); \$p.Connect(0); Write-Host 'pipe_ok'; \$p.Close() } catch {}"`);
  return /pipe_ok/i.test(r2.out);
}

/** 检测是否在跑 DingTalkReal --app-relaunched 后台实例（不含完整 daemon） */
function isAppRelaunchedInstance(): boolean {
  const ps = IS_WINDOWS
    ? sh(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name='DingTalkReal.exe'\\" | Select-Object -ExpandProperty CommandLine" 2>nul`).out
    : sh('ps -Axo command= 2>/dev/null').out;
  return /--app-relaunched/i.test(ps);
}

async function ensureDaemonReady(): Promise<boolean> {
  if (daemonReady()) return true;

  // Windows：额外检查 named pipe（CLI 可能因为路径问题查不到，但 pipe 实际存在）
  if (IS_WINDOWS && windowsDaemonPipeExists()) {
    ok('Windows named pipe \\.\pipe\\real-daemon 存在，daemon 实际就绪');
    // 再验证一次 CLI 能连上
    const r = sh(`"${CLI}" service status`);
    if (r.code === 0 && !/not running|未运行|未启动/i.test(r.out)) return true;
    // pipe 存在但 CLI 报 not running → 可能是 CLI 版本与 daemon 版本不匹配
    console.log('   ⚠️ named pipe 存在但 CLI 报 not running，可能是版本不匹配。尝试 service start…');
  }

  // 检测后台实例
  if (isAppRelaunchedInstance()) {
    fail('.real daemon 未就绪，且检测到 `DingTalkReal --app-relaunched` 后台实例（不含完整 daemon）。');
    console.error('   后台实例无法启动完整 daemon，请任选其一让其就绪：');
    console.error('     1) 退出该后台实例，正常打开 Wukong App（完整界面并登录），等 daemon 赟来；');
    console.error('     2) 或安装含完整 daemon 的悟空版本；');
    console.error(`     3) 就绪验证：运行 "${CLI}" service status 应显示 running（退出码 0）。`);
    return false;
  }

  console.log('   .real daemon 未就绪，尝试拉起…');
  if (IS_WINDOWS) {
    // Windows: 直接运行 DingTalkReal.exe（service start 不支持）
    const daemonPath = path.resolve(path.dirname(CLI || ''), '..', 'DingTalkReal.exe');
    if (fs.existsSync(daemonPath)) {
      sh(`start "" "${daemonPath}"`);
    } else {
      fail('找不到 DingTalkReal.exe');
      return false;
    }
  } else {
    sh(`"${CLI}" service start`);
  }
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    if (daemonReady()) { console.log(`   .real daemon 已拉起（约 ${i + 1}）`); return true; }
    // Windows：也检查 pipe
    if (IS_WINDOWS && windowsDaemonPipeExists()) {
      ok(`   .real daemon 已拉起（named pipe 就绪，约 ${i + 1}）`);
      return true;
    }
  }
  fail('.real daemon 未就绪，无法拉起 —— wukong-cli 连不上 daemon，触发不了 chat。');
  console.error('   请任选其一让其就绪：');
  console.error('     1) 正常打开 Wukong App（完整界面并登录），等 daemon 赟来；');
  console.error('     2) 或安装含完整 daemon 的悟空版本；');
  console.error(`     3) 就绪验证：运行 "${CLI}" service status 应显示 running（退出码 0）。`);
  if (IS_WINDOWS) {
    console.error(`     4) Windows 也可检查 named pipe：PowerShell 查看 [System.IO.Directory]::GetFiles('\\\\.\\\\pipe\\\\') 是否含 real-daemon`);
  }
  return false;
}

// —— 前置自检 ——
async function preflight(): Promise<boolean> {
  step('前置自检');
  if (sh('mitmdump --version').code !== 0) { fail('未找到 mitmdump。请安装 mitmproxy'); return false; }
  ok('mitmdump 可用');

  const ca = path.join(os.homedir(), '.mitmproxy', 'mitmproxy-ca-cert.pem');
  if (!fs.existsSync(ca)) { fail(`未找到 CA 证书（${ca}）。先裸跑一次 mitmdump 生成`); return false; }
  if (!platform.isCaTrusted(ca)) {
    fail('mitmproxy CA 未被系统信任（一次性人工步骤）。请执行：');
    if (IS_WINDOWS) {
      console.error(`\n  certutil -addstore -f "Root" "${ca}"\n  （需以管理员权限运行）\n`);
    } else {
      console.error(`\n  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${ca}"\n`);
    }
    return false;
  }
  ok('mitmproxy CA 已被系统信任');

  if (!fs.existsSync(CAP_SCRIPT)) { fail(`缺少抓包脚本 ${CAP_SCRIPT}`); return false; }

  CLI = findWukongCli();
  if (!CLI) { fail('未找到 wukong-cli'); return false; }
  ok(`wukong-cli: ${CLI}`);

  // 检「.real daemon 就绪」而非「App 进程在跑」
  if (!(await ensureDaemonReady())) return false;
  ok('.real daemon 就绪');

  // 检测会抢系统代理的客户端
  const clash = detectCompetingProxy();
  const webNow = platform.getProxy('web');
  const secureNow = platform.getProxy('secure');
  const occupied = (webNow.enabled && webNow.server !== '127.0.0.1') || (secureNow.enabled && secureNow.server !== '127.0.0.1');
  if (clash && occupied) {
    console.log(`\n⚠️  检测到系统代理当前被占用（web=${webNow.server}:${webNow.port} secure=${secureNow.server}:${secureNow.port}，疑似 ${clash}）。`);
    console.log(`    ${clash} 的「System Proxy」开着时，会和本脚本抢同一个系统代理设置。`);
    console.log(`    请先在 ${clash} 里关闭「System Proxy / 系统代理」开关（VPN 本体可继续跑），再重跑。\n`);
  } else if (clash) {
    ok(`${clash} 在运行，但系统代理未被占用（已临时关闭其系统代理）——可以继续`);
  } else {
    ok('未检测到会抢系统代理的客户端（Clash/Surge/Stash 等）');
  }
  return true;
}

// —— mitmdump（输出落 MITM_LOG，供失败排错）——
let mitm: ChildProcess | null = null;
let mitmFd: number | null = null;
async function startMitm(): Promise<boolean> {
  step(`启动 mitmdump（:${PROXY_PORT}）`);
  fs.rmSync(LOG, { force: true });
  fs.rmSync(MITM_LOG, { force: true });
  mitmFd = fs.openSync(MITM_LOG, 'w');
  mitm = spawn('mitmdump', ['-p', String(PROXY_PORT), '-s', CAP_SCRIPT], { stdio: ['ignore', mitmFd, mitmFd] });
  mitm.on('error', () => {});
  for (let i = 0; i < 15; i++) {
    if (platform.isPortListening(PROXY_PORT)) { ok('mitmdump 已监听'); return true; }
    await sleep(500);
  }
  fail(`mitmdump 未能监听 ${PROXY_PORT}`);
  return false;
}

// —— 系统代理：开（逐项设置+校验+重试）/ 还原原始值 ——
function trySet(which: 'web' | 'secure'): boolean {
  return platform.setProxy(which, '127.0.0.1', String(PROXY_PORT), true);
}

function enableSystemProxy(): boolean {
  // 每项最多重试 3 次
  for (let attempt = 1; attempt <= 3; attempt++) {
    const webOk = proxyPointsToMitm('web') || trySet('web');
    const secureOk = proxyPointsToMitm('secure') || trySet('secure');
    if (webOk && secureOk) return true;
    if (attempt < 3) {
      const w = platform.getProxy('web');
      const s = platform.getProxy('secure');
      console.log(`   …第 ${attempt} 次未完全生效（web=${w.enabled ? w.server + ':' + w.port : 'off'} secure=${s.enabled ? s.server + ':' + s.port : 'off'}），重试`);
    }
  }
  const web = platform.getProxy('web');
  const secure = platform.getProxy('secure');
  fail(`系统代理设不上 127.0.0.1:${PROXY_PORT}（重试 3 次仍失败）：`);
  console.error(`   web   → ${web.enabled ? 'Enabled' : 'Disabled'} server=${web.server}:${web.port}`);
  console.error(`   secure→ ${secure.enabled ? 'Enabled' : 'Disabled'} server=${secure.server}:${secure.port}`);
  console.error(`   多半是 ${detectCompetingProxy() || '某个代理客户端'} 在持续改写系统代理，把 8888 抢了回去。`);
  console.error(`   处置：在其界面关闭「System Proxy / 系统代理」开关（VPN 本体可继续跑），再重跑 pnpm capture-key。`);
  return false;
}

function restoreProxy(snap: { web: ProxyCfg; secure: ProxyCfg }): void {
  // 还原每项并【校验】，最多重试 3 次
  for (const which of ['web', 'secure'] as const) {
    const want = snap[which];
    for (let attempt = 1; attempt <= 3; attempt++) {
      platform.setProxy(which, want.server, want.port, want.enabled);
      const got = platform.getProxy(which);
      if (got.server === want.server && got.port === want.port && got.enabled === want.enabled) break;
      if (attempt === 3) {
        console.error(`   ⚠️  ${which} 代理还原未到位（现为 ${got.enabled ? got.server + ':' + got.port : 'off'}，期望 ${want.enabled ? want.server + ':' + want.port : 'off'}）。请手动核对网络设置。`);
      }
    }
  }
}

// —— 触发 daemon 发 chat（输出落 CLI_LOG，供失败排错）——
function trigger(): void {
  step('用 wukong-cli -p 触发 daemon 发 chat');
  fs.rmSync(CLI_LOG, { force: true });
  const fd = fs.openSync(CLI_LOG, 'w');
  const p = spawn(CLI as string, ['-p', '在', '--output-format', 'json', '--quiet'], { stdio: ['ignore', fd, fd] });
  p.on('error', () => {});
  setTimeout(() => { try { p.kill(); } catch {} }, 30000);
}

/** 从抓包日志提取 Bearer key */
async function extractKey(): Promise<string | null> {
  step('等待并提取 Bearer key');
  const deadline = Date.now() + WAIT_MS;
  let lastProxyCheck = 0;
  let lastMitmCheck = 0;
  while (Date.now() < deadline) {
    const content = readFileSafe(LOG);
    const matches = [...content.matchAll(/Bearer (sk-[0-9a-z]{32})/g)].map((m) => m[1]);
    if (matches.length > 0) {
      const key = matches[matches.length - 1];
      ok(`提取到 key: ${mask(key)}`);
      return key;
    }

    // 早停（~5s 节流）：代理真脱离 8888 就别干等
    if (Date.now() - lastProxyCheck >= 5000) {
      lastProxyCheck = Date.now();
      if (!proxyPointsToMitm('web') || !proxyPointsToMitm('secure')) {
        fail('抓包期间系统代理已脱离 127.0.0.1:8888（被代理客户端抢走），停止等待。');
        return null;
      }
    }

    // 诊断（~10s）：检查 mitmdump 是否收到任何流量
    if (Date.now() - lastMitmCheck >= 10000) {
      lastMitmCheck = Date.now();
      const mitmOut = readFileSafe(MITM_LOG);
      if (!/CONNECT|GET |POST /i.test(mitmOut)) {
        console.log('   ⚠️ mitmdump 仍未收到流量 — daemon 可能没走代理。再触发一次…');
        const retryFd = fs.openSync(CLI_LOG + '.retry', 'w');
        spawn(CLI as string, ['-p', '在', '--output-format', 'json', '--quiet'], { stdio: ['ignore', retryFd, retryFd] });
        setTimeout(() => { try { fs.closeSync(retryFd); } catch {} }, 5000);
      } else {
        console.log('   ✓ mitmdump 已收到流量，继续等待 Bearer key 出现…');
      }
    }

    await sleep(1500);
  }
  fail(`等待 ${WAIT_MS / 1000}s 未抓到 key`);
  return null;
}

// —— 写 .env（操作 CAPTURED_KEYS 行，追加 / 新增，不碰其他变量）——
function writeEnv(key: string): boolean {
  step('写入 CAPTURED_KEYS 到 .env');
  if (sh(`cd "${REPO_ROOT}" && git check-ignore .env`).code !== 0) {
    fail('.env 未被 git 忽略！为防止泄露已中止。请先把 .env 加入 .gitignore');
    return false;
  }
  const lines = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8').split('\n') : [];

  const keysIdx = lines.findIndex((l) => l.startsWith('CAPTURED_KEYS='));

  if (keysIdx >= 0) {
    const raw = lines[keysIdx].slice('CAPTURED_KEYS='.length).trim();
    const existing = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
    if (existing.includes(key)) {
      ok(`密钥已存在于 CAPTURED_KEYS 池中（${mask(key)}），无需重复添加`);
      return true;
    }
    existing.push(key);
    lines[keysIdx] = `CAPTURED_KEYS=${existing.join(',')}`;
    console.log(`   已追加密钥 ${mask(key)}，池中共 ${existing.length} 个密钥`);
  } else {
    lines.push(`CAPTURED_KEYS=${key}`);
    console.log(`   已新增 CAPTURED_KEYS=${mask(key)}`);
  }

  const content = lines.filter((l, i) => !(l === '' && i === lines.length - 1)).join('\n').replace(/\n{3,}/g, '\n\n');
  fs.writeFileSync(ENV_PATH, content + '\n', { mode: 0o600 });
  fs.chmodSync(ENV_PATH, 0o600);
  ok(`已写入 ${ENV_PATH}（mode 600，git-ignored）`);
  return true;
}
// —— 失败诊断 ——
function diagnoseFailure(): void {
  console.log('\n🔎 失败诊断（对照 docs/README.md 排错表）：');
  if (IS_WINDOWS) {
    const alive = platform.isPortListening(PROXY_PORT);
    console.log(`   ① mitmdump 是否还在 127.0.0.1:${PROXY_PORT}: ${alive ? '是' : '否'}`);
    if (!alive) console.log(`      → mitmdump 已退出。可能是端口冲突或 Clash 重启后占回。`);
  } else {
    const web = proxyPointsToMitm('web');
    const secure = proxyPointsToMitm('secure');
    console.log(`   ① 系统代理此刻是否指向 mitm: web=${web} secure=${secure}`);
    if (!web || !secure) {
      console.log(`      → 代理已不在 8888：daemon 流量没进 mitmdump，必然抓不到。`);
      console.log(`         关掉 Clash Verge / Surge 等的「System Proxy」开关，或临时退出它们，再重跑。`);
    }
  }
  const mitmLog = readFileSafe(MITM_LOG);
  const sawAny = /CONNECT|GET |POST |PUT /i.test(mitmLog);
  const sawDeap = /api-deap|deap|dingtalk/i.test(mitmLog);
  console.log(`   ② mitmdump 是否收到流量: ${sawAny ? '是' : '否'}${sawDeap ? '，且含 deap 相关' : '，未见 deap'}`);
  if (sawAny && !sawDeap) console.log(`      → 有流量但无 deap：daemon 可能复用了 keep-alive 旧连接，或触发的 prompt 没走 deap 网关。`);
  if (!sawAny) {
    console.log(`      → 完全无流量：daemon 根本没经过 mitmdump（Clash 未被停掉 / daemon 没发 chat）。`);
    if (IS_WINDOWS) {
      console.log(`      → Windows 排查：`);
      console.log(`         1) netstat -ano | findstr :7897 确认 mitmdump 在监听`);
      console.log(`         2) 若有其他 CLOSE_WAIT 残留连接，等 30s 后重试`);
      console.log(`         3) 确认 Clash Verge 已被停掉（ps 无 clash-verge/mihomo 进程）`);
      console.log(`         4) 重启 daemon：wukong-cli service stop && wukong-cli service start`);
    }
  }
  if (/error|tls|certificate|alert/i.test(mitmLog)) console.log(`      → mitm 日志含 TLS/cert 关键词：daemon 可能改了证书校验（pinning），见 ${MITM_LOG}。`);
  const cliLog = readFileSafe(CLI_LOG);
  const cliErr = /error|fail|refused|not found|no such|denied|timeout/i.test(cliLog);
  console.log(`   ③ wukong-cli 触发是否正常: ${cliErr ? '疑似报错（见 CLI_LOG）' : '未见明显报错'}`);
}

// —— 校验 ——
async function validateKey(key: string): Promise<boolean> {
  step('直连 deap 校验 key');
  try {
    const res = await fetch(`${DEAP_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'x-litellm-session-id': randomUUID(),
        'x-dingtalk-ability-call-session-id': randomUUID(),
        'x-dingtalk-biz-id': randomUUID(),
        ...DEAP_HEADERS,
      },
      body: JSON.stringify({
        model: 'dingtalk-auto', stream: false, max_tokens: 10, temperature: 0.6,
        enable_thinking: false, extra_body: { enable_thinking: false, user_query: 'hi' },
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    const data: any = await res.json().catch(() => null);
    if (res.ok && data && !data.error && Array.isArray(data.choices)) {
      ok(`key 有效（路由模型: ${data.model || '?'}）`);
      return true;
    }
    fail(`key 校验失败: HTTP ${res.status} ${data?.error?.message || ''}`);
    const blob = JSON.stringify(data);
    if (res.status === 401 || /unauthor|invalid.*key|expired/i.test(blob)) {
      console.error('   → 这是 key 失效/过期（401），重抓一把新 key 通常即可解决。');
    } else if (res.status === 402 || /quota/i.test(blob)) {
      console.error('   → 这是【账号配额超限】（402 quotaExceeded），不是 key 失效：重抓新 key 大概率还是 402。');
      console.error('     需等账号配额重置，或换一个登录账号；抓 key 治标不治本。');
    }
    return false;
  } catch (e: any) {
    fail(`校验异常: ${e.message}`);
    return false;
  }
}

// —— 清理（finally 必做）：还原原始系统代理、停 mitm；成功焚日志；真正抓包过才保留诊断日志 ——
let proxySnap: { web: ProxyCfg; secure: ProxyCfg } | null = null;
let attempted = false;

function cleanup(success: boolean): void {
  if (IS_WINDOWS) {
    windowsRestoreProxy();
  } else if (proxySnap) {
    restoreProxy(proxySnap);
    console.log(success ? '🧹 系统代理已还原（原始 server:port + state）' : '🧹 系统代理已还原为抓包前的原始值');
  }
  if (mitm) { try { mitm.kill('SIGKILL'); } catch {} mitm = null; }
  if (mitmFd !== null) { try { fs.closeSync(mitmFd); } catch {} mitmFd = null; }
  if (!IS_WINDOWS) platform.killPortProcess(PROXY_PORT);
  // 成功 → 焚；真正抓包过但失败 → 保留供排查；压根没到触发 → 静默焚空日志
  if (success || !attempted) {
    for (const f of [LOG, MITM_LOG, CLI_LOG]) fs.rmSync(f, { force: true });
  } else {
    console.log(`\n🔍 诊断日志已保留（含明文，排查后请手动删除）：`);
    console.log(`   ${LOG}（抓包）   ${MITM_LOG}（mitmdump）   ${CLI_LOG}（wukong-cli）`);
  }
}

// —— 主流程 ——
(async () => {
  console.log(`🔑 wukong-penetrate · deap 密钥一键抓取（${IS_WINDOWS ? 'Windows' : 'macOS'} 系统代理方案）\n`);
  let success = false;
  try {
    if (!(await preflight())) { process.exitCode = 1; return; }

    // Windows: 设系统代理 8888 + 停 Clash + 重启 daemon
    if (IS_WINDOWS) {
      if (!(await windowsPrepareProxy())) { process.exitCode = 1; return; }
    }

    if (!(await startMitm())) { process.exitCode = 1; return; }

    if (IS_WINDOWS) {
      console.log(`   Daemon 已重启并读取新代理 127.0.0.1:${PROXY_PORT}，流量走 mitmdump`);
    } else {
      // macOS: 快照当前系统代理，设置系统代理
      proxySnap = { web: platform.getProxy('web'), secure: platform.getProxy('secure') };
      step(`开系统级 HTTP/HTTPS 代理（${NET_SERVICE} → 127.0.0.1:${PROXY_PORT}，校验 server:port）`);
      if (!enableSystemProxy()) { process.exitCode = 1; return; }
      ok('系统代理已开启且确实指向 mitmdump');
    }

    attempted = true;
    trigger();
    const key = await extractKey();
    if (!key) { diagnoseFailure(); process.exitCode = 1; return; }

    if (!(await validateKey(key))) { process.exitCode = 1; return; }
    if (!writeEnv(key)) { process.exitCode = 1; return; }

    console.log(`\n🎉 完成！抓到 key ${mask(key)} 并已写入 CAPTURED_KEYS。`);
    console.log('   重启代理后生效：lsof -ti :19067 | xargs kill -9; pnpm serve\n');
    success = true;
  } finally {
    cleanup(success);
  }
})();
