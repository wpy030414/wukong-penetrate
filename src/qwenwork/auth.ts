/**
 * qwenwork/auth.ts — 千问办公 OAuth token 管理。
 *
 * 来源：对 QwenWorkCN 的逆向（docs/QWENWORKCN_REVERSE.md §6.8/§6.9）
 * - auth-v2.dat 是 Electron safeStorage 加密（v10 头）：Keychain 取密码 → PBKDF2(1003, saltysalt) → AES-128-CBC(IV=0x20)
 * - 刷新：POST {base}/api/v1/deviceToken/refresh，body {refresh_token, target}
 *
 * 仅 macOS（Keychain）；Windows 的 safeStorage 走 DPAPI，暂不支持（报错提示）。
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { settings } from '../config';

export interface QwenUserInfo {
  uid: string;
  name?: string;
  email?: string;
}

export interface QwenTokenState {
  /** OAuth access token（JWT，~1h 有效，作为 encryptUserInfo 的 security_oauth_token） */
  token: string;
  /** ory_rt_ 刷新令牌（deviceToken/refresh 轮换） */
  refreshToken: string;
  user: QwenUserInfo;
  /** access token 过期时间（ms epoch） */
  expiresAt: number;
  /** 原始解密 JSON（写回时保留千问办公字段：loginDeviceId 等） */
  raw?: any;
}

/** safeStorage 解密 key（Keychain password，含尾换行要去掉） */
function getKeychainPassword(): string {
  const raw = execFileSync('security', [
    'find-generic-password', '-s', settings.qwenKeychainService,
    '-a', settings.qwenKeychainAccount, '-w',
  ], { encoding: 'utf8' });
  // security -w 输出末尾带换行；password 本身可能是 base64 字符串（原样使用，不做二次解码）
  return raw.replace(/\n$/, '');
}

/** 解密 auth-v2.dat（Electron safeStorage，macOS） */
function decryptAuthFile(filePath: string): QwenTokenState {
  const pw = getKeychainPassword();
  const aesKey = crypto.pbkdf2Sync(Buffer.from(pw, 'utf8'), 'saltysalt', 1003, 16, 'sha1');
  const iv = Buffer.alloc(16, 0x20); // 16 个空格
  const enc = fs.readFileSync(filePath);
  if (enc.slice(0, 3).toString() !== 'v10') {
    throw new Error(`auth 文件头不是 v10（${filePath}），可能不是 safeStorage 格式`);
  }
  const dec = crypto.createDecipheriv('aes-128-cbc', aesKey, iv);
  const out = Buffer.concat([dec.update(enc.slice(3)), dec.final()]);
  const json = JSON.parse(out.toString('utf8'));
  if (typeof json.token !== 'string' || typeof json.refreshToken !== 'string') {
    throw new Error('auth.dat 缺少 token/refreshToken（未登录千问办公？）');
  }
  return {
    token: json.token,
    refreshToken: json.refreshToken,
    user: {
      uid: json.user?.id ?? '',
      name: json.user?.name,
      email: json.user?.email,
    },
    expiresAt: json.expiresAt ? Date.parse(json.expiresAt) : 0,
    raw: json,
  };
}

/** deviceToken/refresh：换取新 token + 轮换 refresh token */
export async function refreshDeviceToken(refreshToken: string): Promise<QwenTokenState> {
  const url = `${settings.qwenBaseUrl}${settings.qwenDeviceRefreshPath}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken, target: settings.qwenTarget }),
  });
  if (!res.ok) {
    throw new Error(`deviceToken/refresh 失败: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const j = await res.json() as any;
  const token = j.device_token ?? j.token;
  const rt = j.refresh_token;
  if (typeof token !== 'string' || typeof rt !== 'string') {
    throw new Error('deviceToken/refresh 响应缺 device_token/refresh_token');
  }
  const expiresAt = typeof j.expires_at === 'string' ? Date.parse(j.expires_at) : Date.now() + 3600_000;
  const user = cached?.user ?? { uid: '' };
  // 只同步 .env QWEN_KEYS（密钥池闭环）。绝不写回 auth-v2.dat——那是千问办公 App 的登录态，轮换会污染它。
  syncEnvRefreshToken(rt);
  return { token, refreshToken: rt, user, expiresAt, raw: cached?.raw };
}

/** 从 .env 读 QWEN_KEYS（capture-key 备份的 refresh token，可作自举源） */
function loadRefreshTokenFromEnv(): string | null {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    const parsed = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
    const v = parsed.QWEN_KEYS?.trim();
    return v || null;
  } catch { return null; }
}

/** 同步 .env 的 QWEN_KEYS（单元素密钥池自愈：pluginClient 轮询到新值会推送 xrl-router） */
function syncEnvRefreshToken(refreshToken: string): void {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    const lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8').split('\n') : [];
    const idx = lines.findIndex((l) => l.startsWith('QWEN_KEYS='));
    if (idx >= 0) lines[idx] = `QWEN_KEYS=${refreshToken}`;
    else lines.push(`QWEN_KEYS=${refreshToken}`);
    fs.writeFileSync(envPath, lines.filter((l, i) => !(l === '' && i === lines.length - 1)).join('\n') + '\n', { mode: 0o600 });
  } catch (e: any) {
    console.warn(`[qwenwork] QWEN_KEYS 同步失败（不影响运行）: ${e.message}`);
  }
}

// —— token 缓存与自动刷新 ——
let cached: QwenTokenState | null = null;
let refreshing: Promise<QwenTokenState> | null = null;

/** 获取当前有效 token（缓存 + 临近过期自动刷新，单飞防并发） */
export async function getToken(): Promise<QwenTokenState> {
  if (cached && Date.now() < cached.expiresAt - 5 * 60_000) {
    return cached;
  }
  if (refreshing) return refreshing;

  refreshing = (async () => {
    // 源①：内存缓存里的 refresh token（有就刷新）
    if (cached?.refreshToken) {
      try {
        const next = await refreshDeviceToken(cached.refreshToken);
        next.user = cached.user;
        cached = next;
        console.log(`[qwenwork] token 已刷新（有效期至 ${new Date(next.expiresAt).toISOString()}）`);
        return next;
      } catch (e: any) {
        console.warn(`[qwenwork] token 刷新失败，尝试其他源: ${e.message}`);
      }
    }
    // 源②：auth-v2.dat（App 登录态，优先持久源）
    if (fs.existsSync(settings.qwenOauthTokenPath)) {
      try {
        cached = decryptAuthFile(settings.qwenOauthTokenPath);
        return cached;
      } catch (e: any) {
        console.warn(`[qwenwork] auth-v2.dat 解密失败: ${e.message}`);
      }
    }
    // 源③：.env QWEN_KEYS（capture-key 备份的 refresh token，自举：拷项目即可用）
    const rt = loadRefreshTokenFromEnv();
    if (rt) {
      const next = await refreshDeviceToken(rt);
      next.user = { uid: '' };
      cached = next;
      console.log(`[qwenwork] 已用 QWEN_KEYS 自举刷新（有效期至 ${new Date(next.expiresAt).toISOString()}）`);
      return next;
    }
    throw new Error('无可用 token 源（auth-v2.dat 缺失/失效且 QWEN_KEYS 为空）');
  })().finally(() => { refreshing = null; });

  return refreshing;
}

/** 强制刷新一次（capture-key 用：验证刷新链 + 拿到新 token） */
export async function forceRefresh(): Promise<QwenTokenState> {
  const cur = await getToken();
  const next = await refreshDeviceToken(cur.refreshToken);
  next.user = cur.user;
  cached = next;
  return next;
}
