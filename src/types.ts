// —— Anthropic 请求/响应的类型定义（支持 tools）——

/** Cache control 标记，用于指示哪些内容应该被缓存 */
export interface CacheControl {
  type: 'ephemeral';  // 目前只支持 ephemeral（临时缓存）
}

/** 带缓存控制的文本块 */
export interface CachedTextContent {
  type: 'text';
  text: string;
  cache_control?: CacheControl;
}

/** 带缓存控制的 Image 块（预留） */
export interface CachedImageContent {
  type: 'image';
  source: {
    type: 'base64' | 'url';
    media_type: string;
    data: string;
  };
  cache_control?: CacheControl;
}

export interface TextContent {
  type: 'text';
  text: string;
}

/** 工具调用（assistant 产出） */
export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, any>;
}

/** 工具结果（user 回传） */
export interface ToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | { type: string; text?: string }[];
  is_error?: boolean;
}

export type ContentBlock =
  | TextContent
  | ToolUseContent
  | ToolResultContent
  | CachedTextContent
  | CachedImageContent
  | Record<string, any>;

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
  content: (TextBlock | ToolUseBlock)[];
  model: string;
  stop_reason?: string;
  usage: Usage;
}

export interface StreamEvent {
  type: string;
  index?: number;
  delta?: Record<string, any>;
}
