/**
 * AnthropicAdapter — Anthropic Messages API ⇄ deap(OpenAI) 的双向协议翻译。
 *
 * 只服务 deap 后端。核心职责：
 *   - 把 Anthropic 请求（含 system / 结构化 content blocks / tools）翻译成 OpenAI messages
 *   - 把 deap 返回（文本 / tool_calls）翻译回 Anthropic 的响应 JSON 或 SSE 事件流
 *
 * 关键映射：
 *   Anthropic tool_use   (assistant block)  →  OpenAI message.tool_calls[]
 *   Anthropic tool_result(user block)      →  OpenAI role:tool 消息
 *   OpenAI tool_calls[].function.arguments →  Anthropic tool_use.input（流式用 input_json_delta 增量）
 */

import { v4 as uuidv4 } from 'uuid';
import {
  AnthropicRequest,
  AnthropicResponse,
  TextBlock,
  ToolUseBlock,
  CacheControl,
  Usage,
} from './types';
import { settings } from './config';
import { DeapClient, DeapChatMessage, DeapTool, DeapToolCall } from './deapClient';

export class AnthropicAdapter {
  /** 把 Anthropic tools 定义翻译成 OpenAI function 定义。 */
  static buildDeapTools(request: AnthropicRequest): DeapTool[] | undefined {
    if (!request.tools || request.tools.length === 0) return undefined;
    return request.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema ?? { type: 'object', properties: {} },
      },
    }));
  }

  /**
   * 从 Anthropic system 数组中提取 cache_control 标记
   * 返回: { systemText: string, hasCacheControl: boolean, cacheControlIndex: number | undefined }
   */
  private static extractSystemCacheControl(
    system: AnthropicRequest['system']
  ): { systemText: string; hasCacheControl: boolean; cacheControlIndex?: number } {
    if (!system) return { systemText: '', hasCacheControl: false };
    if (typeof system === 'string') return { systemText: system, hasCacheControl: false };

    let combinedText = '';
    let cacheControlIndex: number | undefined;

    for (let i = 0; i < system.length; i++) {
      const item = system[i];
      const text = typeof item === 'object' && item.text ? item.text :
                   typeof item === 'string' ? item : '';
      combinedText += text || '';

      // 检查是否有 cache_control 标记
      if (typeof item === 'object' && item.cache_control) {
        cacheControlIndex = i;
      }
    }

    return { systemText: combinedText, hasCacheControl: cacheControlIndex !== undefined, cacheControlIndex };
  }

  /**
   * 从 message content 数组中检测 cache_control 标记
   * 返回最后一个带 cache_control 的元素的索引
   */
  private static detectMessageCacheControl(content: any): number | undefined {
    if (!Array.isArray(content)) return undefined;

    for (let i = content.length - 1; i >= 0; i--) {
      const block = content[i];
      if (block && typeof block === 'object' && block.cache_control) {
        return i;
      }
    }
    return undefined;
  }

  /**
   * 从 tools 数组中检测 cache_control 标记
   */
  private static detectToolsCacheControl(tools: AnthropicRequest['tools']): number | undefined {
    if (!tools) return undefined;

    for (let i = tools.length - 1; i >= 0; i--) {
      const tool = tools[i];
      if (tool && typeof tool === 'object' && (tool as any).cache_control) {
        return i;
      }
    }
    return undefined;
  }

  /**
   * 构建 extra_body 用于传递给 deap 的缓存控制参数
   */
  private static buildExtraBody(
    messages: DeapChatMessage[],
    tools: AnthropicRequest['tools']
  ): Record<string, any> | undefined {
    const extraBody: any = {};

    // 检测 tools 的 cache_control
    const toolsCacheIdx = AnthropicAdapter.detectToolsCacheControl(tools);
    if (toolsCacheIdx !== undefined) {
      extraBody.cache_control = {
        type: 'ephemeral',
        tools_index: toolsCacheIdx
      };
    }

    // 检查 messages 中是否有 _cache_control 标记（由 buildDeapMessages 注入）
    const cachedMsgIndices = messages
      .map((m, i) => (m as any)._cache_control ? i : -1)
      .filter(i => i !== -1);
    if (cachedMsgIndices.length > 0) {
      extraBody.cache_control = {
        ...(extraBody.cache_control || {}),
        message_indices: cachedMsgIndices
      };
    }

    return Object.keys(extraBody).length > 0 ? extraBody : undefined;
  }

  /** 翻译 Anthropic tool_choice → OpenAI tool_choice。 */
  private static buildToolChoice(request: AnthropicRequest): any {
    const tc = request.tool_choice;
    if (!tc) return undefined;
    switch (tc.type) {
      case 'auto':
        return 'auto';
      case 'any':
        return 'required';
      case 'none':
        return 'none';
      case 'tool':
        return tc.name ? { type: 'function', function: { name: tc.name } } : 'auto';
      default:
        return 'auto';
    }
  }

  /** 提取 system 文本（兼容字符串 / 数组形态）。 */
  private static systemText(system: AnthropicRequest['system']): string {
    if (!system) return '';
    if (typeof system === 'string') return system;
    if (Array.isArray(system)) {
      return system
        .map((item: any) => (typeof item === 'object' && item.text ? item.text : typeof item === 'string' ? item : ''))
        .filter(Boolean)
        .join(' ');
    }
    return '';
  }

  /**
   * 把一条 assistant 消息的 content blocks 翻译成 OpenAI 形态：
   * 文本拼成 content，tool_use 块翻成 tool_calls[]。
   */
  private static translateAssistantBlocks(blocks: any[]): { content: string; tool_calls?: DeapToolCall[] } {
    let content = '';
    const toolCalls: DeapToolCall[] = [];
    for (const b of blocks) {
      if (b && typeof b === 'object') {
        if (b.type === 'text' && typeof b.text === 'string') {
          content += b.text;
        } else if (b.type === 'tool_use') {
          toolCalls.push({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          });
        }
      } else if (typeof b === 'string') {
        content += b;
      }
    }
    return { content, tool_calls: toolCalls.length > 0 ? toolCalls : undefined };
  }

  /**
   * 把一条 user 消息展开为一条或多条 OpenAI 消息。
   * 纯文本 → 单条 user；含 tool_result 块 → 每个 tool_result 生成一条 role:tool，
   * 其余文本（若有）合并为一条 user 消息。
   */
  private static translateUserMessage(content: any): DeapChatMessage[] {
    if (typeof content === 'string') {
      return [{ role: 'user', content }];
    }
    if (!Array.isArray(content)) {
      return [{ role: 'user', content: String(content ?? '') }];
    }

    const out: DeapChatMessage[] = [];
    let textParts = '';
    for (const b of content) {
      if (b && typeof b === 'object' && b.type === 'tool_result') {
        const body = typeof b.content === 'string'
          ? b.content
          : Array.isArray(b.content)
            ? b.content.map((c: any) => (c?.text ?? '')).join('')
            : '';
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: body });
      } else if (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') {
        textParts += b.text;
      } else if (typeof b === 'string') {
        textParts += b;
      }
    }
    if (textParts) out.push({ role: 'user', content: textParts });
    return out;
  }

  /**
   * 把 Anthropic 请求翻译成 OpenAI messages 数组。
   * system 提升为第一条 system 消息；逐条翻译 user/assistant。
   * 同时检测并注入 cache_control 元数据。
   */
  static buildDeapMessages(request: AnthropicRequest): DeapChatMessage[] {
    const out: DeapChatMessage[] = [];

    // 处理 system 并提取 cache_control 信息
    const sysResult = AnthropicAdapter.extractSystemCacheControl(request.system);
    if (sysResult.systemText) {
      const sysMsg: DeapChatMessage = { role: 'system', content: sysResult.systemText };
      // 通过 _cache_control 传递缓存信息（内部使用，不会发送给 deap）
      if (sysResult.hasCacheControl && sysResult.cacheControlIndex !== undefined) {
        (sysMsg as any)._cache_control = {
          enabled: true,
          index: sysResult.cacheControlIndex
        };
      }
      out.push(sysMsg);
    }

    for (const msg of request.messages) {
      if (msg.role === 'assistant') {
        if (typeof msg.content === 'string') {
          out.push({ role: 'assistant', content: msg.content });
        } else {
          const t = AnthropicAdapter.translateAssistantBlocks(msg.content as any[]);
          const m: DeapChatMessage = { role: 'assistant', content: t.content || null };
          if (t.tool_calls) m.tool_calls = t.tool_calls;

          // 检测 message content 的 cache_control
          const cacheIdx = AnthropicAdapter.detectMessageCacheControl(msg.content);
          if (cacheIdx !== undefined) {
            (m as any)._cache_control = {
              enabled: true,
              content_index: cacheIdx
            };
          }

          out.push(m);
        }
      } else {
        // user 消息
        const userMsgs = AnthropicAdapter.translateUserMessage(msg.content);

        // 检测 cache_control 并附加到对应的 message
        const cacheIdx = AnthropicAdapter.detectMessageCacheControl(msg.content);
        if (cacheIdx !== undefined && userMsgs.length > 0) {
          const lastUserMsg = userMsgs[userMsgs.length - 1];
          (lastUserMsg as any)._cache_control = {
            enabled: true,
            content_index: cacheIdx
          };
        }

        out.push(...userMsgs);
      }
    }
    return out;
  }

  /**
   * 模型透传：deap 只路由到一个底层模型，请求的 model 名基本不影响结果。
   * 传了非默认模型名就透传给 deap（它要么接受要么改名路由），否则用服务端 WUKONG_MODEL。
   */
  private static resolveModel(request: AnthropicRequest): string | undefined {
    return request.model !== settings.defaultModel ? request.model : undefined;
  }

  /** 非流式：把 deap 结果翻译成标准 Anthropic 响应 JSON。 */
  static async chat(request: AnthropicRequest, deapClient: DeapClient): Promise<AnthropicResponse> {
    const messages = AnthropicAdapter.buildDeapMessages(request);
    const tools = AnthropicAdapter.buildDeapTools(request);
    const toolChoice = AnthropicAdapter.buildToolChoice(request);
    const model = AnthropicAdapter.resolveModel(request);

    // 构建 extra_body 传递缓存元数据
    const extraBody = AnthropicAdapter.buildExtraBody(messages, request.tools);

    const result = await deapClient.chat(
      messages,
      model,
      request.max_tokens,
      tools,
      toolChoice,
      extraBody
    );

    const content: (TextBlock | ToolUseBlock)[] = [];
    if (result.text) content.push({ type: 'text', text: result.text });
    for (const tc of result.toolCalls) {
      let input: Record<string, any> = {};
      try {
        input = JSON.parse(tc.function.arguments || '{}');
      } catch { /* 保留空对象 */ }
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
    }

    const inputTokens = result.usage?.prompt_tokens ?? request.messages.length * 100;
    const outputTokens = result.usage?.completion_tokens ?? Math.floor(result.text.length / 4);

    // 构建 usage，包含缓存相关字段
    const usage: Usage = {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    };

    // 如果 deap 返回了 prompt_tokens_details.cached_tokens，转换为 Anthropic 格式
    const cachedTokens = (result.usage as any)?.prompt_tokens_details?.cached_tokens;
    if (cachedTokens !== undefined && cachedTokens > 0) {
      usage.cache_read_input_tokens = cachedTokens;
    }

    return {
      id: `msg_${uuidv4().replace(/-/g, '').slice(0, 24)}`,
      type: 'message',
      role: 'assistant',
      content,
      model: request.model,
      stop_reason: result.finishReason === 'tool_calls' ? 'tool_use' : 'end_turn',
      usage,
    };
  }

  /**
   * 流式：把 deap 的 SSE 增量翻译成 Anthropic 标准事件序列。
   *
   *   message_start
   *   → content_block_start(text) → content_block_delta(text_delta)×N → content_block_stop
   *   → content_block_start(tool_use) → content_block_delta(input_json_delta)×N → content_block_stop
   *   → message_delta(stop_reason, usage) → message_stop
   *
   * 文本块与工具块按出现顺序各占一个 index；工具的 arguments 增量以 input_json_delta 流式下发。
   */
  static async *streamResponse(request: AnthropicRequest, deapClient: DeapClient): AsyncGenerator<string> {
    const messageId = `msg_${uuidv4().replace(/-/g, '').slice(0, 24)}`;
    const messages = AnthropicAdapter.buildDeapMessages(request);
    const tools = AnthropicAdapter.buildDeapTools(request);
    const toolChoice = AnthropicAdapter.buildToolChoice(request);
    const model = AnthropicAdapter.resolveModel(request);
    const inputTokens = request.messages.length * 100;

    // 构建 extra_body 传递缓存元数据
    const extraBody = AnthropicAdapter.buildExtraBody(messages, request.tools);

    let eventId = 0;
    const ev = (type: string, data: any) =>
      `id: ${messageId}-${eventId++}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

    yield `id: ${messageId}\nevent: message_start\ndata: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: request.model,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    })}\n\n`;

    // 块状态机：当前打开的 content block 的 index 与类型
    let blockIndex = -1;
    let openBlock: 'text' | 'tool_use' | null = null;
    let accumulatedText = '';
    let finalStop = 'end_turn';
    let outputTokens = 0;
    let cachedTokens = 0;

    const closeBlock = function* (): Generator<string> {
      if (openBlock !== null) {
        yield ev('content_block_stop', { type: 'content_block_stop', index: blockIndex });
        openBlock = null;
      }
    };

    for await (const e of deapClient.chatStream(messages, model, request.max_tokens, tools, toolChoice, extraBody)) {
      if (e.kind === 'text') {
        if (openBlock !== 'text') {
          yield* closeBlock();
          blockIndex++;
          yield ev('content_block_start', {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'text', text: '' },
          });
          openBlock = 'text';
        }
        accumulatedText += e.text;
        yield ev('content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'text_delta', text: e.text },
        });
      } else if (e.kind === 'tool_call_start') {
        // 新工具块：关掉上一个，开启 tool_use 块
        yield* closeBlock();
        blockIndex++;
        yield ev('content_block_start', {
          type: 'content_block_start',
          index: blockIndex,
          content_block: { type: 'tool_use', id: e.id, name: e.name, input: {} },
        });
        openBlock = 'tool_use';
      } else if (e.kind === 'tool_call_args') {
        if (openBlock === 'tool_use') {
          yield ev('content_block_delta', {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'input_json_delta', partial_json: e.args },
          });
        }
      } else if (e.kind === 'done') {
        finalStop = e.finishReason === 'tool_calls' ? 'tool_use' : 'end_turn';
        outputTokens = e.usage?.completion_tokens ?? Math.floor(accumulatedText.length / 4);
        // 提取缓存信息
        cachedTokens = (e.usage as any)?.prompt_tokens_details?.cached_tokens ?? 0;
      }
    }

    yield* closeBlock();

    // 构建 message_delta 的 usage
    const deltaUsage: any = { output_tokens: outputTokens };
    if (cachedTokens > 0) {
      deltaUsage.cache_read_input_tokens = cachedTokens;
    }

    yield ev('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: finalStop },
      usage: deltaUsage,
    });
    yield ev('message_stop', { type: 'message_stop' });
  }
}
