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
  ThinkingBlock,
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
  /** 从数组尾部查找最后一个带 cache_control 的元素索引（message content / tools 共用）。 */
  private static findCacheControlIndex<T>(items: T[] | undefined | null): number | undefined {
    if (!items || !Array.isArray(items)) return undefined;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i] as any;
      if (item && typeof item === 'object' && item.cache_control) return i;
    }
    return undefined;
  }

  /** message content 数组的 cache_control 索引。 */
  private static detectMessageCacheControl(content: any): number | undefined {
    return AnthropicAdapter.findCacheControlIndex(content);
  }

  /** tools 数组的 cache_control 索引。 */
  private static detectToolsCacheControl(tools: AnthropicRequest['tools']): number | undefined {
    return AnthropicAdapter.findCacheControlIndex(tools);
  }

  /**
   * 构建 extra_body 用于传递给 deap 的缓存控制参数
   */
  private static buildExtraBody(
    cache: { message_indices: number[] },
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

    // 从侧表读消息级缓存断点（消息对象本身已无 _cache_control）
    if (cache.message_indices.length > 0) {
      extraBody.cache_control = {
        ...(extraBody.cache_control || {}),
        message_indices: cache.message_indices
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

  /**
   * 把一条 assistant 消息的 content blocks 翻译成 OpenAI 形态：
   * 文本拼成 content，tool_use 块翻成 tool_calls[]。
   *
   * 注意：
   *   - thinking 块会被静默丢弃（deap 用 OpenAI 协议，历史 reasoning 不回传，请求时现场生成）。
   *   - 若该 assistant 消息是请求的最后一条（Pre-filling），其 text 会原样进入 content，
   *     由 deap 续写（已实测：末尾 assistant 消息 deap 支持续写）。
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
   * 把 Anthropic 请求翻译成 OpenAI messages 数组 + 缓存断点侧表。
   * system 提升为第一条 system 消息；逐条翻译 user/assistant。
   * cache_control 不再污染消息对象，而是记入侧表 cache.message_indices（纯净 messages 直发 deap）。
   */
  static buildDeapMessages(request: AnthropicRequest): {
    messages: DeapChatMessage[];
    cache: { message_indices: number[] };
  } {
    const out: DeapChatMessage[] = [];
    const message_indices: number[] = [];

    // system 提升为第一条消息；若带 cache_control 则记入侧表
    const sysResult = AnthropicAdapter.extractSystemCacheControl(request.system);
    if (sysResult.systemText) {
      out.push({ role: 'system', content: sysResult.systemText });
      if (sysResult.hasCacheControl) message_indices.push(out.length - 1);
    }

    for (const msg of request.messages) {
      if (msg.role === 'assistant') {
        // Pre-filling：末尾 assistant 消息原样透传给 deap 续写。
        if (typeof msg.content === 'string') {
          out.push({ role: 'assistant', content: msg.content });
        } else {
          const t = AnthropicAdapter.translateAssistantBlocks(msg.content as any[]);
          const m: DeapChatMessage = { role: 'assistant', content: t.content || null };
          if (t.tool_calls) m.tool_calls = t.tool_calls;
          out.push(m);
          if (AnthropicAdapter.detectMessageCacheControl(msg.content) !== undefined) {
            message_indices.push(out.length - 1);
          }
        }
      } else {
        const userMsgs = AnthropicAdapter.translateUserMessage(msg.content);
        out.push(...userMsgs);
        if (userMsgs.length > 0 && AnthropicAdapter.detectMessageCacheControl(msg.content) !== undefined) {
          message_indices.push(out.length - 1);
        }
      }
    }
    return { messages: out, cache: { message_indices } };
  }

  /**
   * 模型路由：信任客户端指定的 model（动态验证交给 deapClient）。
   * deapClient 收到 403 "requested model is not available" 会自动兜底到 wukongModel
   * 并缓存（TTL 内不再试该失效名）。兜底模型 wukongModel（dingtalk-auto→qwen3.7-plus，稳定）。
   * 因此无需维护写死的白名单——deap 新增/下线模型可自动适应。
   */
  private static resolveModel(request: AnthropicRequest): string {
    return request.model || settings.wukongModel;
  }

  /**
   * 决定是否开启 Extended Thinking。
   * 请求显式声明优先（thinking.type='enabled'）；否则用服务端默认开关。
   * deap 底层对应 enable_thinking=true，会返回 reasoning_content（已实测可用）。
   */
  private static resolveThinking(request: AnthropicRequest): boolean {
    if (request.thinking) {
      return request.thinking.type === 'enabled';
    }
    return settings.enableExtendedThinking;
  }

  /** 生成短 id（24 位无连字符 uuid），用于 message id / thinking signature。 */
  private static shortId(prefix: string): string {
    return `${prefix}${uuidv4().replace(/-/g, '').slice(0, 24)}`;
  }

  /** 非流式：把 deap 结果翻译成标准 Anthropic 响应 JSON。 */
  static async chat(request: AnthropicRequest, deapClient: DeapClient): Promise<AnthropicResponse> {
    const { messages, cache } = AnthropicAdapter.buildDeapMessages(request);
    const tools = AnthropicAdapter.buildDeapTools(request);
    const toolChoice = AnthropicAdapter.buildToolChoice(request);
    const model = AnthropicAdapter.resolveModel(request);

    const enableThinking = AnthropicAdapter.resolveThinking(request);

    // 构建 extra_body 传递缓存元数据
    const extraBody = AnthropicAdapter.buildExtraBody(cache, request.tools);

    const result = await deapClient.chat(
      messages,
      model,
      request.max_tokens,
      tools,
      toolChoice,
      extraBody,
      enableThinking
    );

    // content 块顺序：thinking（若有）→ text → tool_use
    const content: (ThinkingBlock | TextBlock | ToolUseBlock)[] = [];
    if (result.reasoning) {
      content.push({
        type: 'thinking',
        thinking: result.reasoning,
        signature: AnthropicAdapter.shortId('sig_'),
      });
    }
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
    const cachedTokens = result.usage?.prompt_tokens_details?.cached_tokens;
    if (cachedTokens !== undefined && cachedTokens > 0) {
      usage.cache_read_input_tokens = cachedTokens;
    }

    return {
      id: AnthropicAdapter.shortId('msg_'),
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
    const messageId = AnthropicAdapter.shortId('msg_');
    const { messages, cache } = AnthropicAdapter.buildDeapMessages(request);
    const tools = AnthropicAdapter.buildDeapTools(request);
    const toolChoice = AnthropicAdapter.buildToolChoice(request);
    const model = AnthropicAdapter.resolveModel(request);
    const enableThinking = AnthropicAdapter.resolveThinking(request);
    const inputTokens = request.messages.length * 100;

    // 构建 extra_body 传递缓存元数据
    const extraBody = AnthropicAdapter.buildExtraBody(cache, request.tools);

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
    let openBlock: 'text' | 'tool_use' | 'thinking' | null = null;
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

    for await (const e of deapClient.chatStream(messages, model, request.max_tokens, tools, toolChoice, extraBody, enableThinking)) {
      if (e.kind === 'thinking') {
        // 思考块：开启 thinking content block，下发 thinking_delta
        if (openBlock !== 'thinking') {
          yield* closeBlock();
          blockIndex++;
          yield ev('content_block_start', {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'thinking', thinking: '' },
          });
          openBlock = 'thinking';
        }
        yield ev('content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'thinking_delta', thinking: e.thinking },
        });
      } else if (e.kind === 'text') {
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
        cachedTokens = e.usage?.prompt_tokens_details?.cached_tokens ?? 0;
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
