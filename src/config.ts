import dotenv from 'dotenv';
import fs from 'node:fs';

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

  // 兜底：已知可用版本
  return '0.9.65-26061702';
}

export interface Settings {
  port: number;
  availableModels: string[];

  // —— 直连 deap 的配置（核心，唯一后端）——
  /** deap 网关 base url */
  baseUrl: string;

  // —— deap 要求的一整套业务头（缺一个会 400）——
  deapUserType: string;
  deapScenarioCode: string;
  deapProductCode: string;
  deapAbilityCode: string;
  deapWukongClientVersion: string;
  deapWukongDeviceType: string;
  deapAgentLoopVersion: string;
  deapBizParam: string;

  // —— xrl-router 集成配置 ——
  /** xrl-router 的地址，用于 WS 连接注册为插件 */
  xrlRouterUrl: string;
}

export const settings: Settings = {
  port: parseInt(process.env.PORT || '19067', 10),
  availableModels: (process.env.AVAILABLE_MODELS || 'dingtalk-auto,claude-opus-4-8,gpt-4o')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // 直连 deap
  baseUrl: 'https://api-deap.dingtalk.com/dingtalk/v1',

  // deap 头（默认值来自对真实 App 请求的反汇编抓取）
  deapUserType: process.env.DEAP_USER_TYPE || 'vip',
  deapScenarioCode: process.env.DEAP_SCENARIO_CODE || 'com.dingtalk.scenario.wukong',
  deapProductCode: process.env.DEAP_PRODUCT_CODE || 'AI_WUKONG',
  deapAbilityCode: process.env.DEAP_ABILITY_CODE || 'M_AI_WUKONG',
  deapWukongClientVersion: detectWukongClientVersion(),
  deapWukongDeviceType: process.env.DEAP_WUKONG_DEVICE_TYPE || '2',
  deapAgentLoopVersion: process.env.DEAP_AGENT_LOOP_VERSION || 'V2',
  deapBizParam: process.env.DEAP_BIZ_PARAM || '{"taskDes":"5L2g5aW9"}',

  // xrl-router 集成
  xrlRouterUrl: process.env.XRL_ROUTER_URL || 'http://localhost:19068',
};
