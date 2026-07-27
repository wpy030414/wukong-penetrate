import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config();

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

  // macOS: 从 /Applications/Wukong.app/Contents/Info.plist 推断（暂不实现，保留硬编码兜底）

  // 兜底：已知可用版本
  return '0.9.65-26061702';
}

export interface Settings {
  port: number;
  /** 兜底模型名（硬编码），被 deap 判定不可用时的 fallback */
  wukongModel: string;
  /** deap 已实测可用的模型白名单（在此列表内才透传给 deap，否则兜底到 wukongModel） */
  availableModels: string[];
  logLevel: string;
  apiKey?: string;

  // —— 直连 deap 的配置（核心，唯一后端）——
  /** deap API Key 池（逗号分隔的多个密钥），必填，用于高可用服务 */
  deapApiKeys: string[];
  /** 密钥对应的备注名（逗号分隔，与 DEAP_API_KEYS 按顺序一一对应），可选 */
  keysName: string[];
  /** deap 网关 base url（硬编码） */
  deapBaseUrl: string;

  // —— deap 要求的一整套业务头（缺一个会 400）——
  deapUserType: string;
  deapScenarioCode: string;
  deapProductCode: string;
  deapAbilityCode: string;
  deapWukongClientVersion: string;
  deapWukongDeviceType: string;
  deapAgentLoopVersion: string;
  deapBizParam: string;

  // —— Extended Thinking 配置 ——
  /**
   * 是否默认开启 Extended Thinking（硬编码为 true）。
   * 仅当请求未显式声明 thinking 字段时生效；请求带了 thinking.type='enabled' 一定开启。
   * deap 底层对应 enable_thinking=true，会返回 reasoning_content（已实测）。
   */
  enableExtendedThinking: boolean;

  // —— 联网搜索（甲路实测）——
  /**
   * 是否在 deap 请求里注入 enable_search（DashScope/Qwen 联网搜索）。
   * 设环境变量 ENABLE_SEARCH=true 开启；开启后所有请求都会带 enable_search，
   * 用于验证 deap 是否透传给底层 Qwen。
   * 注意：OpenAI 兼容协议不返回搜索来源 URL，仅让模型回答体现实时信息。
   */
  enableSearch: boolean;

  // —— 联网搜索（乙路：网关自封搜索）——
  /** 搜索引擎：'off' 关闭；'bing-web' 走 cn.bing.com 网页版（无 key 免费） */
  searchEngine: 'off' | 'bing-web';
  /** 每次搜索返回的结果条数 */
  searchMaxResults: number;
  /** 单次请求最大搜索轮数（防死循环） */
  searchMaxRounds: number;
  /** 单次搜索超时（毫秒） */
  searchTimeoutMs: number;
  /** Bing 网页版主机（默认 cn.bing.com；国际版 www.bing.com 易触发验证码） */
  bingWebHost: string;
  /** Bing 搜索语言区域 */
  bingWebLocale: string;

  // —— 渠道错误重试配置 ——
  /**
   * deap 对第三方模型（claude/gpt）用动态渠道池，间歇性返回 550 "No available channel"。
   * 命中这类可重试错误时，带指数退避重试同一模型（不改模型名）。
   */
  channelRetryMax: number;
  /** 首次重试的退避基数（毫秒），之后指数增长 */
  channelRetryBaseMs: number;
  /** 模型可用性缓存 TTL（毫秒）：被 deap 判定不可用的模型名缓存多久，过期后重新验证 */
  modelAvailabilityTtlMs: number;
}

export const settings: Settings = {
  port: parseInt(process.env.PORT || '19067', 10),
  wukongModel: 'dingtalk-auto',
  // deap 已实测可用：dingtalk-auto→qwen3.7-plus, claude-opus-4-8→真 Claude, gpt-4o→真 GPT
  // 兜底模型为 wukongModel(dingtalk-auto)；可用 AVAILABLE_MODELS 环境变量覆盖
  availableModels: (process.env.AVAILABLE_MODELS || 'dingtalk-auto,claude-opus-4-8,gpt-4o')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  logLevel: 'info',
  apiKey: process.env.API_KEY,

  // 直连 deap
  // 密钥池：从 DEAP_API_KEYS 环境变量读取（逗号分隔），必填
  deapApiKeys: (process.env.DEAP_API_KEYS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  keysName: (process.env.KEYS_NAME || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  deapBaseUrl: 'https://api-deap.dingtalk.com/dingtalk/v1',

  // deap 头（默认值来自对真实 App 请求的反汇编抓取）
  deapUserType: process.env.DEAP_USER_TYPE || 'vip',
  deapScenarioCode: process.env.DEAP_SCENARIO_CODE || 'com.dingtalk.scenario.wukong',
  deapProductCode: process.env.DEAP_PRODUCT_CODE || 'AI_WUKONG',
  deapAbilityCode: process.env.DEAP_ABILITY_CODE || 'M_AI_WUKONG',
  deapWukongClientVersion: detectWukongClientVersion(),
  deapWukongDeviceType: process.env.DEAP_WUKONG_DEVICE_TYPE || '2',
  deapAgentLoopVersion: process.env.DEAP_AGENT_LOOP_VERSION || 'V2',
  deapBizParam: process.env.DEAP_BIZ_PARAM || '{"taskDes":"5L2g5aW9"}',

  // Extended Thinking 默认开启（deap 已实测支持 reasoning_content）
  enableExtendedThinking: true,

  // 联网搜索实测开关（甲路）：设 ENABLE_SEARCH=true 后请求注入 DashScope enable_search
  enableSearch: true,

  // 联网搜索（乙路）：默认 cn.bing.com 网页版（无 key 免费）
  searchEngine: (process.env.SEARCH_ENGINE as 'off' | 'bing-web') || 'bing-web',
  searchMaxResults: 5,
  searchMaxRounds: 3,
  searchTimeoutMs: 8000,
  bingWebHost: process.env.BING_WEB_HOST || 'cn.bing.com',
  bingWebLocale: 'zh-CN',

  // 渠道错误重试配置（应对第三方模型 550 No available channel）
  channelRetryMax: 3,
  channelRetryBaseMs: 400,
  // 模型可用性缓存 TTL（10 分钟）：失效模型名缓存后短期内直接兜底，过期重新验证
  modelAvailabilityTtlMs: 600000,
};
