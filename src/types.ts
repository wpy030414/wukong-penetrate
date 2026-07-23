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
  /**
   * server tool 类型标识（如 'web_search_20250305'）。普通自定义 tool 无此字段；
   * 带此标识的不会被转成 function 透传——chat/completions 不靠 tools 启用搜索，
   * 联网改由 extra_body.enable_search 注入（见 deapClient.buildBody）。
   */
  type?: string;
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

/** Anthropic server-side tool 调用块（乙路网关伪造，对应客户端发起的 web_search） */
export interface ServerToolUseBlock {
  type: 'server_tool_use';
  id: string;
  name: string;
  input: Record<string, any>;
}

/** 单条网页搜索结果（encrypted_content 用搜索引擎 snippet 填充） */
export interface WebSearchResultItem {
  type: 'web_search_result';
  url: string;
  title: string;
  encrypted_content?: string;
}

/** server tool 搜索结果块，tool_use_id 关联对应的 ServerToolUseBlock */
export interface WebSearchToolResultBlock {
  type: 'web_search_tool_result';
  tool_use_id: string;
  content: WebSearchResultItem[];
}

export interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: (ThinkingBlock | TextBlock | ToolUseBlock | ServerToolUseBlock | WebSearchToolResultBlock)[];
  model: string;
  stop_reason?: string;
  usage: Usage;
}
