import dotenv from 'dotenv';

dotenv.config();

export interface Settings {
  host: string;
  port: number;
  defaultModel: string;
  wukongModel: string;
  logLevel: string;
  apiKey?: string;

  // —— 直连 deap 的配置（核心，唯一后端）——
  /** 登录态换来的 deap API Key（sk-...），必填 */
  deapApiKey?: string;
  /** deap 网关 base url */
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
}

export const settings: Settings = {
  host: process.env.HOST || '0.0.0.0',
  port: parseInt(process.env.PORT || '8000', 10),
  defaultModel: process.env.DEFAULT_MODEL || 'claude-3-5-sonnet-20241022',
  wukongModel: process.env.WUKONG_MODEL || 'dingtalk-auto',
  logLevel: process.env.LOG_LEVEL || 'info',
  apiKey: process.env.API_KEY,

  // 直连 deap
  deapApiKey: process.env.DEAP_API_KEY,
  deapBaseUrl: process.env.DEAP_BASE_URL || 'https://api-deap.dingtalk.com/dingtalk/v1',

  // deap 头（默认值来自对真实 App 请求的反汇编抓取）
  deapUserType: process.env.DEAP_USER_TYPE || 'vip',
  deapScenarioCode: process.env.DEAP_SCENARIO_CODE || 'com.dingtalk.scenario.wukong',
  deapProductCode: process.env.DEAP_PRODUCT_CODE || 'AI_WUKONG',
  deapAbilityCode: process.env.DEAP_ABILITY_CODE || 'M_AI_WUKONG',
  deapWukongClientVersion: process.env.DEAP_WUKONG_CLIENT_VERSION || '0.9.65-26061702',
  deapWukongDeviceType: process.env.DEAP_WUKONG_DEVICE_TYPE || '2',
  deapAgentLoopVersion: process.env.DEAP_AGENT_LOOP_VERSION || 'V2',
  deapBizParam: process.env.DEAP_BIZ_PARAM || '{"taskDes":"5L2g5aW9"}',
};
