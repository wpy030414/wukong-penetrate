// —— Anthropic 请求/响应的类型定义（支持 tools）——

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

export type ContentBlock = TextContent | ToolUseContent | ToolResultContent | Record<string, any>;

export interface Message {
  role: string;
  content: string | ContentBlock[];
}

/** Anthropic 工具定义 */
export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, any>;
}

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: Message[];
  system?: string | { type: string; text?: string }[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  tools?: AnthropicTool[];
  tool_choice?: { type: 'auto' | 'any' | 'tool' | 'none'; name?: string };
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
