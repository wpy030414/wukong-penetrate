// —— Anthropic 请求/响应的类型定义（支持 tools）——

/** Cache control 标记，用于指示哪些内容应该被缓存 */
export interface CacheControl {
  type: 'ephemeral';  // 目前只支持 ephemeral（临时缓存）
}

/** Anthropic 消息内容块（结构透传，由 deap 运行时验证） */
export type ContentBlock = Record<string, any>;

export interface Message {
  role: string;
  content: string | ContentBlock[];
}

/** Anthropic 工具定义 */
export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, any>;
  cache_control?: CacheControl;  // 新增：支持工具定义的缓存控制
}

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: Message[];
  system?: string | { type: string; text?: string; cache_control?: CacheControl }[];  // 扩展：支持 cache_control
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  tools?: AnthropicTool[];
  tool_choice?: { type: 'auto' | 'any' | 'tool' | 'none'; name?: string };
  /** Extended Thinking：type='enabled' 时透传给 deap 的 enable_thinking=true */
  thinking?: { type: 'enabled' | 'disabled'; budget_tokens?: number };
  metadata?: {
    user_id?: string;
    [key: string]: any;
  };
}

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, any>;
}

/**
 * 扩展思考块（透传 deap 的 reasoning_content）。
 * signature 为透传占位值（deap 不提供签名），回传历史消息时会被 adapter 丢弃。
 */
export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  total_tokens?: number;
  // Anthropic Prompt Caching 相关字段
  cache_creation_input_tokens?: number;  // 创建缓存消耗的 token
  cache_read_input_tokens?: number;      // 读取缓存的 token（命中时）
}

export interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: (ThinkingBlock | TextBlock | ToolUseBlock)[];
  model: string;
  stop_reason?: string;
  usage: Usage;
}
