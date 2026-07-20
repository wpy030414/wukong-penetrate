#!/usr/bin/env tsx
/**
 * capture-key.ts — 一键抓取 deap API Key 并写入 .env（对应 pnpm capture-key）。
 *
 * 已验证的可行链路（详见 docs/CAPTURE_DEAP_KEY.md）：
 *   daemon（DingTalkReal）的 chat 客户端【无视 HTTPS_PROXY 环境变量】，但【认系统级 HTTP 代理】。
 *   所以：开系统代理(networksetup)→8888 → 用 wukong-cli -p 触发 daemon 发 chat → mitmdump 抓到
 *   带完整 `Authorization: Bearer sk-...` 的 /chat/completions → 校验 → 写 .env → 关系统代理。
 *
 * 流程：自检 → 起 mitmdump →【sudo 开系统代理】→ 触发抓 key →【sudo 关系统代理】→ 校验写 env → 清理。
 *
 * 需要主人介入：
 *   1. 运行时在终端手动输入一次 sudo 密码（用于开/关系统代理，TTY 下不回显、不落盘）。
 *   2. daemon 须已登录运行（脚本检测，不擅自重启悟空）。
 * 安全红线：系统代理在 finally 里务必还原；.env 永不进 git；含明文 key 的日志用完即焚。
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { settings } from '../src/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CAP_SCRIPT = path.join(__dirname, 'cap_deap.py');
const LOG = '/tmp/deap_capture.log';
const PROXY_PORT = 8888;
const ENV_PATH = path.join(REPO_ROOT, '.env');
const WAIT_MS = 45000;
const NET_SERVICE = process.env.CAPTURE_NET_SERVICE || 'Wi-Fi'; // 主用网络接口名

const DEAP_BASE_URL = settings.deapBaseUrl;

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

interface ShResult {
  code: number;
  out: string;
}

// —— 输出 / 工具 ——
const ok = (s: string): void => console.log(`✅ ${s}`);
const fail = (s: string): void => console.error(`\n❌ ${s}`);
const step = (s: string): void => console.log(`\n▶ ${s}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const mask = (k: string): string => (k && k.length > 10 ? `${k.slice(0, 10)}…${k.slice(-4)}` : '(无效)');

function sh(cmd: string): ShResult {
  try {
    return { code: 0, out: execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString() };
  } catch (e: any) {
    return { code: e.status ?? 1, out: (e.stdout?.toString() || '') + (e.stderr?.toString() || '') };
  }
}

function findWukongCli(): string | null {
  const candidates = [
    process.env.WUKONG_CLI_PATH,
    '/Applications/Wukong.app/Contents/MacOS/wukong-cli',
    path.join(os.homedir(), '.real', 'bin', 'wukong-cli'),
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    const expanded = c.replace(/^~/, os.homedir());
    if (fs.existsSync(expanded)) return expanded;
  }
  const w = sh('command -v wukong-cli');
  if (w.code === 0 && w.out.trim()) return w.out.trim();
  return null;
}

// —— 交互式读 sudo 密码（TTY 下不回显；非 TTY 按行读，便于测试）——
function askSudoPassword(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
      const rl = readline.createInterface({ input: stdin, output: stdout, terminal: false });
      rl.question('🔐 请输入 sudo 密码（用于开/关系统代理）: ', (ans) => { rl.close(); resolve(ans.trim()); });
      return;
    }

    stdout.write('🔐 请输入 sudo 密码（用于开/关系统代理，不回显、不落盘）: ');
    let pwd = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (ch: string): void => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          stdout.write('\n');
          resolve(pwd);
          return;
        } else if (c === '' || c === '\b') {
          pwd = pwd.slice(0, -1);
        } else if (c === '') {
          stdout.write('\n');
          process.exit(130);
        } else {
          pwd += c;
        }
      }
    };
    stdin.on('data', onData);
  });
}

// 用密码执行一条 sudo 命令（剔除 Password 提示行）
function sudo(cmd: string, pwd: string): ShResult {
  const r = sh(`printf '%s\n' '${pwd.replace(/'/g, `'\\''`)}' | sudo -S ${cmd} 2>&1`);
  const out = r.out.split('\n').filter((l) => !/password/i.test(l)).join('\n');
  return { code: r.code, out };
}

// —— 前置自检 ——
let CLI: string | null = null;
function preflight(): boolean {
  step('前置自检');
  if (sh('mitmdump --version').code !== 0) { fail('未找到 mitmdump。请 brew install mitmproxy'); return false; }
  ok('mitmdump 可用');

  const ca = path.join(os.homedir(), '.mitmproxy', 'mitmproxy-ca-cert.pem');
  if (!fs.existsSync(ca)) { fail(`未找到 CA 证书（${ca}）。先裸跑一次 mitmdump 生成`); return false; }
  const v = sh(`security verify-cert -c "${ca}"`);
  if (v.code !== 0 || !/successful/i.test(v.out)) {
    fail('mitmproxy CA 未被系统信任（一次性人工步骤）。请执行：');
    console.error(`\n  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${ca}"\n`);
    return false;
  }
  ok('mitmproxy CA 已被系统信任');

  if (!fs.existsSync(CAP_SCRIPT)) { fail(`缺少抓包脚本 ${CAP_SCRIPT}`); return false; }

  if (sh('pgrep -f "MacOS/DingTalkReal"').code !== 0) {
    fail('未检测到运行中的悟空 daemon。请先打开悟空并登录（脚本不擅自重启，以免打断你）。');
    return false;
  }
  ok('悟空 daemon 运行中');

  CLI = findWukongCli();
  if (!CLI) { fail('未找到 wukong-cli'); return false; }
  ok(`wukong-cli: ${CLI}`);
  return true;
}

// —— mitmdump ——
let mitm: ChildProcess | null = null;
async function startMitm(): Promise<boolean> {
  step(`启动 mitmdump（:${PROXY_PORT}）`);
  fs.rmSync(LOG, { force: true });
  mitm = spawn('mitmdump', ['-p', String(PROXY_PORT), '-s', CAP_SCRIPT], { stdio: 'ignore' });
  mitm.on('error', () => {});
  for (let i = 0; i < 15; i++) {
    if (sh(`lsof -ti :${PROXY_PORT}`).out.trim()) { ok('mitmdump 已监听'); return true; }
    await sleep(500);
  }
  fail(`mitmdump 未能监听 ${PROXY_PORT}`);
  return false;
}

// —— 系统代理 开/关 ——
function setSystemProxy(on: boolean, pwd: string): boolean {
  if (on) {
    sudo(`networksetup -setwebproxy "${NET_SERVICE}" 127.0.0.1 ${PROXY_PORT}`, pwd);
    sudo(`networksetup -setsecurewebproxy "${NET_SERVICE}" 127.0.0.1 ${PROXY_PORT}`, pwd);
    sudo(`networksetup -setwebproxystate "${NET_SERVICE}" on`, pwd);
    sudo(`networksetup -setsecurewebproxystate "${NET_SERVICE}" on`, pwd);
  } else {
    sudo(`networksetup -setwebproxystate "${NET_SERVICE}" off`, pwd);
    sudo(`networksetup -setsecurewebproxystate "${NET_SERVICE}" off`, pwd);
  }
  const check = sh(`networksetup -getwebproxy "${NET_SERVICE}"`);
  return new RegExp(`Enabled: ${on ? 'Yes' : 'No'}`).test(check.out);
}

// —— 触发 + 等待提取 ——
function trigger(): void {
  step('用 wukong-cli -p 触发 daemon 发 chat');
  const p = spawn(CLI as string, ['-p', '在', '--output-format', 'json', '--quiet'], { stdio: 'ignore' });
  p.on('error', () => {});
  setTimeout(() => { try { p.kill(); } catch {} }, 30000);
}

async function extractKey(): Promise<string | null> {
  step('等待并提取 Bearer key');
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(LOG)) {
      const content = fs.readFileSync(LOG, 'utf8');
      const matches = [...content.matchAll(/Bearer (sk-[0-9a-z]{32})/g)].map((m) => m[1]);
      if (matches.length > 0) {
        const key = matches[matches.length - 1];
        ok(`提取到 key: ${mask(key)}`);
        return key;
      }
    }
    await sleep(1500);
  }
  fail(`等待 ${WAIT_MS / 1000}s 未抓到 key（系统代理是否已开启？daemon 是否真的发了 chat？）`);
  return null;
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
    return false;
  } catch (e: any) {
    fail(`校验异常: ${e.message}`);
    return false;
  }
}

// —— 写 .env ——
function writeEnv(key: string): boolean {
  step('写入 .env');
  if (sh(`cd "${REPO_ROOT}" && git check-ignore .env`).code !== 0) {
    fail('.env 未被 git 忽略！为防止泄露已中止。请先把 .env 加入 .gitignore');
    return false;
  }
  const lines = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8').split('\n') : [];
  const set = (k: string, v: string): void => {
    const i = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (i >= 0) lines[i] = `${k}=${v}`; else lines.push(`${k}=${v}`);
  };
  set('BACKEND', 'deap');
  set('DEAP_API_KEY', key);
  set('DEAP_BASE_URL', DEAP_BASE_URL);
  set('WUKONG_MODEL', 'dingtalk-auto');
  const content = lines.filter((l, i) => !(l === '' && i === lines.length - 1)).join('\n').replace(/\n{3,}/g, '\n\n');
  fs.writeFileSync(ENV_PATH, content + '\n', { mode: 0o600 });
  fs.chmodSync(ENV_PATH, 0o600);
  ok(`已写入 ${ENV_PATH}（mode 600，git-ignored）`);
  return true;
}

// —— 清理（finally 必做）：停 mitm、关系统代理、焚日志 ——
let proxyOn = false;
let sudoPwd: string | null = null;
function cleanup(): void {
  if (proxyOn && sudoPwd) {
    setSystemProxy(false, sudoPwd);
    console.log('🧹 系统代理已还原（关闭）');
  }
  if (mitm) { try { mitm.kill('SIGKILL'); } catch {} mitm = null; }
  sh(`lsof -ti :${PROXY_PORT} | xargs kill -9 2>/dev/null`);
  fs.rmSync(LOG, { force: true });
  sudoPwd = null; // 密码不留内存
}

// —— 主流程 ——
(async () => {
  console.log('🔑 wukong-penetrate · deap 密钥一键抓取（系统代理方案）\n');
  try {
    if (!preflight()) { process.exitCode = 1; return; }
    if (!(await startMitm())) { process.exitCode = 1; return; }

    sudoPwd = await askSudoPassword();
    if (!sudoPwd) { fail('未输入 sudo 密码'); process.exitCode = 1; return; }

    step(`开系统级 HTTP/HTTPS 代理（${NET_SERVICE} → 127.0.0.1:${PROXY_PORT}）`);
    if (!setSystemProxy(true, sudoPwd)) {
      fail('系统代理开启失败（密码错误？接口名不对？可用 CAPTURE_NET_SERVICE 指定）');
      process.exitCode = 1; return;
    }
    proxyOn = true;
    ok('系统代理已开启');

    trigger();
    const key = await extractKey();
    if (!key) { process.exitCode = 1; return; }

    if (!(await validateKey(key))) { process.exitCode = 1; return; }
    if (!writeEnv(key)) { process.exitCode = 1; return; }

    console.log(`\n🎉 完成！抓到 key ${mask(key)} 并已写入 .env。`);
    console.log('   重启代理后生效：lsof -ti :8000 | xargs kill -9; pnpm serve\n');
  } finally {
    cleanup();
  }
})();
