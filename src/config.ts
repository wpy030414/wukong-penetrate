import dotenv from 'dotenv';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CHANNEL, type Channel } from './channel';

dotenv.config();

/** qwenwork 通道默认 auth-v2.dat 路径（按平台：Windows %APPDATA% / macOS ~/Library/Application Support） */
function detectQwenOauthTokenPath(): string {
  const envVal = process.env.QWEN_OAUTH_TOKEN_PATH;
  if (envVal) return envVal;
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'QwenWorkCN', 'auth-v2.dat');
  }
  return path.join(os.homedir(), 'Library', 'Application Support', 'QwenWorkCN', 'auth-v2.dat');
}

/** qwenwork 通道默认 Electron userData 目录（Windows 取 Local State 的 os_crypt 密钥） */
function detectQwenUserDataDir(): string {
  const envVal = process.env.QWEN_USER_DATA_DIR;
  if (envVal) return envVal;
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'QwenWorkCN');
  }
  return path.join(os.homedir(), 'Library', 'Application Support', 'QwenWorkCN');
}

/** 动态获取 Wukong 客户端版本号（从安装目录名推断，不再硬编码） */
function detectWukongClientVersion(): string {
  const envVal = process.env.DEAP_WUKONG_CLIENT_VERSION;
  if (envVal) return envVal;

  // Windows: 从 C:\Program Files\Wukong\<version>\ 目录名推断
  if (process.platform === 'win32') {
    const wukongDir = 'C:\\Program Files\\Wukong';
    try {
      const versions = fs.readdirSync(wukongDir).filter(d => /^\d+\.\d+\.\d+-.+$/.test(d));
      versions.sort((a, b) => b.localeCompare(a));
      if (versions.length > 0) return versions[0];
    } catch { /* 目录不存在 */ }
  }

  // 兜底：已知可用版本
  return '0.9.65-26061702';
}

export interface Settings {
  port: number;
  availableModels: string[];
  channel: Channel;

  // —— wukong 通道（DEAP）——
  deapBaseUrl: string;
  deapUserType: string;
  deapScenarioCode: string;
  deapProductCode: string;
  deapAbilityCode: string;
  deapWukongClientVersion: string;
  deapWukongDeviceType: string;
  deapAgentLoopVersion: string;
  deapBizParam: string;

  // —— qwenwork 通道（gateway.qwenwork.cn / 智谱 GLM）——
  qwenBaseUrl: string;              // 推理网关 base
  qwenOauthTokenPath: string;       // auth-v2.dat 路径（safeStorage 加密的 OAuth token）
  qwenUserDataDir: string;          // Electron userData 目录（Windows 取 Local State 的 os_crypt 密钥）
  qwenKeychainService: string;      // Keychain 中 Electron SafeStorage service 名（仅 macOS）
  qwenKeychainAccount: string;      // Keychain account 名（仅 macOS）
  qwenDeviceRefreshPath: string;    // deviceToken/refresh 相对路径
  qwenRsaPublicKeyPath: string;     // asar 硬编码 RSA 公钥 PEM（未提供则用内嵌）
  qwenRefreshIntervalMs: number;    // token 自动刷新检查间隔
  qwenTarget: string;               // deviceToken/refresh 的 target 参数（"c" = 个人）

  // —— xrl-router 集成配置 ——
  xrlRouterUrl: string;
}

/** 按通道读 env 键（qwenwork 读 QWEN_*，wukong 读 DEAP_*，跨通道通用读 * 无前缀） */
function env(key: string, fallback: string): string {
  const v = process.env[key];
  return v !== undefined && v !== '' ? v : fallback;
}

export const settings: Settings = {
  port: parseInt(env('PORT', '19067'), 10),
  availableModels: (process.env.AVAILABLE_MODELS || (CHANNEL === 'qwenwork'
    ? 'qwork-advanced'
    : 'dingtalk-auto'))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  channel: CHANNEL,

  // —— wukong 通道（原默认值）——
  deapBaseUrl: env('DEAP_BASE_URL', 'https://api-deap.dingtalk.com/dingtalk/v1'),
  deapUserType: env('DEAP_USER_TYPE', 'vip'),
  deapScenarioCode: env('DEAP_SCENARIO_CODE', 'com.dingtalk.scenario.wukong'),
  deapProductCode: env('DEAP_PRODUCT_CODE', 'AI_WUKONG'),
  deapAbilityCode: env('DEAP_ABILITY_CODE', 'M_AI_WUKONG'),
  deapWukongClientVersion: detectWukongClientVersion(),
  deapWukongDeviceType: env('DEAP_WUKONG_DEVICE_TYPE', '2'),
  deapAgentLoopVersion: env('DEAP_AGENT_LOOP_VERSION', 'V2'),
  deapBizParam: env('DEAP_BIZ_PARAM', '{"taskDes":"5L2g5aW9"}'),

  // —— qwenwork 通道 ——
  qwenBaseUrl: env('QWEN_BASE_URL', 'https://gateway.qwenwork.cn'),
  qwenOauthTokenPath: detectQwenOauthTokenPath(),
  qwenUserDataDir: detectQwenUserDataDir(),
  qwenKeychainService: env('QWEN_KEYCHAIN_SERVICE', 'QwenWorkCN Safe Storage'), // 仅 macOS 使用
  qwenKeychainAccount: env('QWEN_KEYCHAIN_ACCOUNT', 'QwenWorkCN Key'),         // 仅 macOS 使用
  qwenDeviceRefreshPath: env('QWEN_DEVICE_REFRESH_PATH', '/api/v1/deviceToken/refresh'),
  qwenRsaPublicKeyPath: env('QWEN_RSA_PUBLIC_KEY_PATH', ''),
  qwenRefreshIntervalMs: parseInt(env('QWEN_REFRESH_INTERVAL_MS', '600000'), 10), // 10min
  qwenTarget: env('QWEN_TARGET', 'c'),

  // xrl-router 集成
  xrlRouterUrl: env('XRL_ROUTER_URL', 'http://localhost:19068'),
};
