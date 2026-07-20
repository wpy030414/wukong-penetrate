/**
 * DeapClient — 直接调用钉钉 deap 网关的客户端（本代理唯一后端）。
 *
 * 拿「登录态换来的 deap API Key」直连
 *   POST https://api-deap.dingtalk.com/dingtalk/v1/chat/completions
 * deap 说 OpenAI 兼容协议（chat/completions，支持 SSE 流式 + function calling）。
 *
 * 本客户端负责：
 *   - 透传结构化的 OpenAI messages（含 tool_calls / role:tool）与 tools 定义
 *   - 注入完整的一组 x-dingtalk-* / x-wukong-* 头（缺一个都会 400）
 *   - 解析非流式 JSON / 流式 SSE，产出文本增量 与 工具调用增量（跳过 reasoning_content）
 *
 * Key 的来源：登录成功后 DingTalkReal 经
 *   getCliAuthCode → claimGlobalTaskToken → createTempApiKey
 * 铸出的临时密钥（约 29 天有效）。抓取流程见 docs/CAPTURE_DEAP_KEY.md。
 */

import { randomUUID } from 'crypto';
import { settings } from './config';

/** OpenAI 风格的消息（content 可为字符串或结构化数组，支持工具调用） */
export interface DeapChatMessage {
  role: string;
  content?: string | null;
  tool_calls?: DeapToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface DeapToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface DeapTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, any>;
  };
}

/** 非流式的完整结果：正文 + 可选的工具调用 + 真实 usage */
export interface DeapChatResult {
  text: string;
  toolCalls: DeapToolCall[];
  finishReason: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

/** 流式产出的事件：文本增量、工具调用增量，或最终的 finish/usage */
export type DeapStreamEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool_call_start'; index: number; id: string; name: string }
  | { kind: 'tool_call_args'; index: number; args: string }
  | { kind: 'done'; finishReason: string; usage?: { prompt_tokens: number; completion_tokens: number } };

export class DeapClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey?: string, baseUrl?: string) {
    this.apiKey = apiKey || settings.deapApiKey || '';
    this.baseUrl = (baseUrl || settings.deapBaseUrl).replace(/\/$/, '');
    if (!this.apiKey) {
      throw new Error('DEAP_API_KEY is not configured. Set it in .env or env.');
    }
  }

  /** 组装 deap 要求的一整套请求头。缺任何一个 x-dingtalk-* 都会被拒（400）。 */
  private buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      // 注意：流式也【不要】设 Accept: text/event-stream —— deap 会因该头返回 406。
      'x-litellm-session-id': randomUUID(),
      'x-dingtalk-ability-call-session-id': randomUUID(),
      'x-dingtalk-biz-id': randomUUID(),
      'x-dingtalk-user-type': settings.deapUserType,
      'x-dingtalk-scenario-code': settings.deapScenarioCode,
      'x-dingtalk-product-code': settings.deapProductCode,
      'x-dingtalk-ability-code': settings.deapAbilityCode,
      'x-wukong-client-version': settings.deapWukongClientVersion,
      'x-wukong-device-type': settings.deapWukongDeviceType,
      'x-wukong-agent-loop-version': settings.deapAgentLoopVersion,
      'x-dingtalk-biz-param': settings.deapBizParam,
    };
  }

  /**
   * 组请求体。流式必须带 stream_options / temperature / enable_thinking / extra_body，
   * 否则返回 406。tools / tool_choice 直接透传（deap 走标准 function calling）。
   */
  private buildBody(
    messages: DeapChatMessage[],
    model: string | undefined,
    stream: boolean,
    maxTokens?: number,
    tools?: DeapTool[],
    toolChoice?: any,
  ) {
    const userQuery =
      messages.filter((m) => m.role === 'user').map((m) => m.content).filter(Boolean).pop() || '';
    return {
      model: model || settings.wukongModel,
      stream,
      max_tokens: maxTokens ?? 4096,
      temperature: 0.6,
      enable_thinking: false,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      extra_body: { enable_thinking: false, user_query: typeof userQuery === 'string' ? userQuery : '' },
      messages,
      ...(tools && tools.length > 0 ? { tools, tool_choice: toolChoice ?? 'auto' } : {}),
    };
  }

  /** 非流式调用：返回正文 + 工具调用 + 真实 usage。 */
  async chat(
    messages: DeapChatMessage[],
    model?: string,
    maxTokens?: number,
    tools?: DeapTool[],
    toolChoice?: any,
  ): Promise<DeapChatResult> {
    const body = this.buildBody(messages, model, false, maxTokens, tools, toolChoice);

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`deap chat failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    }

    const data: any = await res.json();
    const choice = data?.choices?.[0];
    const msg = choice?.message ?? {};

    let text = '';
    if (typeof msg.content === 'string') {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content.map((c: any) => (typeof c === 'string' ? c : c?.text || '')).join('');
    }

    const toolCalls: DeapToolCall[] = Array.isArray(msg.tool_calls)
      ? msg.tool_calls.map((tc: any) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '' },
        }))
      : [];

    return {
      text,
      toolCalls,
      finishReason: choice?.finish_reason ?? 'stop',
      usage: data?.usage
        ? { prompt_tokens: data.usage.prompt_tokens, completion_tokens: data.usage.completion_tokens }
        : undefined,
    };
  }

  /**
   * 流式调用：产出文本增量与工具调用增量（跳过 reasoning_content 思维链）。
   * 工具调用首块带 id+name（tool_call_start），后续仅 arguments 增量（tool_call_args）。
   */
  async *chatStream(
    messages: DeapChatMessage[],
    model?: string,
    maxTokens?: number,
    tools?: DeapTool[],
    toolChoice?: any,
  ): AsyncGenerator<DeapStreamEvent> {
    const body = this.buildBody(messages, model, true, maxTokens, tools, toolChoice);

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`deap stream failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    }

    const decoder = new TextDecoder();
    let buffer = '';
    const reader = (res.body as any).getReader();

    let finishReason = 'stop';
    let usage: { prompt_tokens: number; completion_tokens: number } | undefined;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        for (const line of rawEvent.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') {
            yield { kind: 'done', finishReason, usage };
            return;
          }

          let json: any;
          try {
            json = JSON.parse(payload);
          } catch {
            continue; // 忽略非 JSON 行
          }

          // 末块可能只带 usage
          if (json?.usage) {
            usage = {
              prompt_tokens: json.usage.prompt_tokens,
              completion_tokens: json.usage.completion_tokens,
            };
          }

          const choice = json?.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason) finishReason = choice.finish_reason;

          const delta = choice.delta ?? {};

          // 正文增量（跳过 reasoning_content 思维链）
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            yield { kind: 'text', text: delta.content };
          }

          // 工具调用增量
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const index = tc.index ?? 0;
              if (tc.id && tc.function?.name) {
                yield { kind: 'tool_call_start', index, id: tc.id, name: tc.function.name };
              }
              const args = tc.function?.arguments;
              if (typeof args === 'string' && args.length > 0) {
                yield { kind: 'tool_call_args', index, args };
              }
            }
          }
        }
      }
    }

    yield { kind: 'done', finishReason, usage };
  }

  /** 健康检查：发一句最便宜的请求。 */
  async healthCheck(): Promise<boolean> {
    try {
      const out = await this.chat([{ role: 'user', content: '你好' }]);
      return out.text.length > 0;
    } catch {
      return false;
    }
  }
}
