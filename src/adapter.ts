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
  ServerToolUseBlock,
  WebSearchToolResultBlock,
  WebSearchResultItem,
  Usage,
} from './types';
import { settings } from './config';
import { DeapClient, DeapChatMessage, DeapTool, DeapToolCall } from './deapClient';
import { getSearchProvider, SearchHit } from './search';

export class AnthropicAdapter {
  /**
   * 把 Anthropic tools 定义翻译成 OpenAI function 定义。
   * 注意：Anthropic 的 server tool（type 以 web_search 开头）会被剥离——
   * chat/completions 不通过 tools 启用联网搜索，留着会被转成名为 web_search 的假 function 误导模型。
   * 联网改由 extra_body.enable_search 注入（见 deapClient.buildBody，受 settings.enableSearch 控制）。
   */
  static buildDeapTools(request: AnthropicRequest): DeapTool[] | undefined {
    if (!request.tools || request.tools.length === 0) return undefined;
    const customTools = request.tools.filter((t) => !t.type || !/^web_search/i.test(t.type));
    if (customTools.length === 0) return undefined;
    return customTools.map((t) => ({
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

  // ===== 乙路：网关自封 WebSearch（拦截 web_search → 自行搜索 → 伪造 server tool 块）=====

  /** 请求是否带 Anthropic web_search server tool（客户端期望联网）。 */
  private static requestWantsWebSearch(request: AnthropicRequest): boolean {
    return !!request.tools?.some(
      (t) => typeof t.type === 'string' && /^web_search/i.test(t.type)
    );
  }

  /** 暴露给 deap 模型的内部 web_search function（让模型用 tool_call 表达搜索意图）。 */
  private static makeSearchToolDef(): DeapTool {
    return {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the web for real-time / fresh information. Returns ranked web pages with titles, urls and snippets.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: 'The search query' } },
          required: ['query'],
        },
      },
    };
  }

  /** 把搜索结果格式化成喂回 deap 的 role:tool 文本（Qwen 可读）。 */
  private static hitsToToolResultText(hits: SearchHit[]): string {
    if (hits.length === 0) return '(搜索无结果或搜索失败，请基于已有知识回答，或换个关键词重试)';
    return hits
      .map((h, i) => `[${i + 1}] ${h.title}\n    ${h.url}\n    ${h.snippet}`)
      .join('\n');
  }

  /** 构造 Anthropic 的 server_tool_use + web_search_tool_result 两块（非流式）。 */
  private static buildSearchBlocks(
    query: string,
    hits: SearchHit[]
  ): [ServerToolUseBlock, WebSearchToolResultBlock] {
    const id = AnthropicAdapter.shortId('srvtoolu_');
    return [
      { type: 'server_tool_use', id, name: 'web_search', input: { query } },
      {
        type: 'web_search_tool_result',
        tool_use_id: id,
        content: hits.map<WebSearchResultItem>((h) => ({
          type: 'web_search_result',
          url: h.url,
          title: h.title,
          encrypted_content: h.snippet,
        })),
      },
    ];
  }

  /** 解析 web_search tool_call 的 arguments，提取 query 字符串。 */
  private static parseWebSearchQuery(args: string): string {
    try {
      const q = JSON.parse(args || '{}')?.query;
      if (typeof q === 'string' && q.trim()) return q.trim();
    } catch { /* fallthrough */ }
    return (args || '').trim();
  }

  /**
   * 非流式：把 deap 结果翻译成标准 Anthropic 响应 JSON。
   * 乙路：若请求带 web_search 且 searchEngine 开启，进入多轮搜索循环——拦截模型的
   * web_search tool_call → 调 SearchProvider → 伪造 server_tool_use + web_search_tool_result
   * 块累积进 content，并把结果喂回 deap 续写，直到模型不再搜索或达到轮数上限。
   */
  static async chat(request: AnthropicRequest, deapClient: DeapClient): Promise<AnthropicResponse> {
    const { messages, cache } = AnthropicAdapter.buildDeapMessages(request);
    const provider = getSearchProvider();
    const wantSearch = !!provider && AnthropicAdapter.requestWantsWebSearch(request);
    let tools = AnthropicAdapter.buildDeapTools(request);
    if (wantSearch) tools = [...(tools ?? []), AnthropicAdapter.makeSearchToolDef()];
    const toolChoice = AnthropicAdapter.buildToolChoice(request);
    const model = AnthropicAdapter.resolveModel(request);
    const enableThinking = AnthropicAdapter.resolveThinking(request);

    // 构建 extra_body 传递缓存元数据
    const extraBody = AnthropicAdapter.buildExtraBody(cache, request.tools);

    const content: (ThinkingBlock | TextBlock | ToolUseBlock | ServerToolUseBlock | WebSearchToolResultBlock)[] = [];
    const usage: Usage = { input_tokens: 0, output_tokens: 0 };
    let stopReason = 'end_turn';

    for (let round = 0; round <= settings.searchMaxRounds; round++) {
      const result = await deapClient.chat(
        messages,
        model,
        request.max_tokens,
        tools,
        toolChoice,
        extraBody,
        enableThinking
      );

      // thinking → text → 客户端 tool_use（累积，跨轮）
      if (result.reasoning) {
        content.push({
          type: 'thinking',
          thinking: result.reasoning,
          signature: AnthropicAdapter.shortId('sig_'),
        });
      }
      if (result.text) content.push({ type: 'text', text: result.text });

      const wsCall = result.toolCalls.find((tc) => tc.function.name === 'web_search');
      const clientCalls = result.toolCalls.filter((tc) => tc.function.name !== 'web_search');
      for (const tc of clientCalls) {
        let input: Record<string, any> = {};
        try {
          input = JSON.parse(tc.function.arguments || '{}');
        } catch { /* 保留空对象 */ }
        content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }

      // usage（input 取末轮；output 跨轮累加）
      const inT = result.usage?.prompt_tokens ?? request.messages.length * 100;
      const outT = result.usage?.completion_tokens ?? Math.floor((result.text?.length ?? 0) / 4);
      usage.input_tokens = inT;
      usage.output_tokens += outT;
      usage.total_tokens = inT + usage.output_tokens;
      const cachedTokens = result.usage?.prompt_tokens_details?.cached_tokens;
      if (cachedTokens !== undefined && cachedTokens > 0) {
        usage.cache_read_input_tokens = cachedTokens;
      }

      // 客户端工具调用优先：立即交还控制权
      if (clientCalls.length > 0) {
        stopReason = 'tool_use';
        break;
      }
      // 模型想搜索且未达上限：执行搜索续轮
      if (wantSearch && wsCall && round < settings.searchMaxRounds) {
        const query = AnthropicAdapter.parseWebSearchQuery(wsCall.function.arguments);
        let hits: SearchHit[] = [];
        try {
          hits = await provider!.search(query);
        } catch {
          hits = [];
        }
        content.push(...AnthropicAdapter.buildSearchBlocks(query, hits));
        // 喂回 deap：assistant 的 web_search tool_call + role:tool 结果（仅 wsCall，保持 OpenAI 消息链一致）
        messages.push({ role: 'assistant', content: null, tool_calls: [wsCall] });
        messages.push({
          role: 'tool',
          tool_call_id: wsCall.id,
          content: AnthropicAdapter.hitsToToolResultText(hits),
        });
        continue;
      }
      // 无搜索意图，或搜索达上限（wsCall 为内部代办，不计客户端 tool_use）→ end_turn
      stopReason = 'end_turn';
      break;
    }

    return {
      id: AnthropicAdapter.shortId('msg_'),
      type: 'message',
      role: 'assistant',
      content,
      model: request.model,
      stop_reason: stopReason,
      usage,
    };
  }

  /**
   * 流式：把 deap 的 SSE 增量翻译成 Anthropic 标准事件序列。
   *
   * 乙路真流式（跨轮）：message_start 整个响应只发一次；blockIndex/openBlock 跨搜索轮续自增。
   * 每轮 chatStream 透传 thinking/text/客户端 tool_use；模型的 web_search tool_call「攒而不发」，
   * 本轮结束后执行搜索，注入 server_tool_use + web_search_tool_result 两对 content_block_start/stop，
   * 再把结果喂回 deap 发起下一轮续写，直到模型不再搜索或达到轮数上限。
   *
   *   message_start
   *   → [每轮] content_block_start(text/thinking/tool_use) → delta×N → stop
   *   → [搜索轮] content_block_start(server_tool_use)→stop + content_block_start(web_search_tool_result)→stop
   *   → message_delta(stop_reason, usage) → message_stop
   */
  static async *streamResponse(request: AnthropicRequest, deapClient: DeapClient): AsyncGenerator<string> {
    const messageId = AnthropicAdapter.shortId('msg_');
    const { messages, cache } = AnthropicAdapter.buildDeapMessages(request);
    const provider = getSearchProvider();
    const wantSearch = !!provider && AnthropicAdapter.requestWantsWebSearch(request);
    let tools = AnthropicAdapter.buildDeapTools(request);
    if (wantSearch) tools = [...(tools ?? []), AnthropicAdapter.makeSearchToolDef()];
    const toolChoice = AnthropicAdapter.buildToolChoice(request);
    const model = AnthropicAdapter.resolveModel(request);
    const enableThinking = AnthropicAdapter.resolveThinking(request);
    const inputTokens = request.messages.length * 100;

    // 构建 extra_body 传递缓存元数据
    const extraBody = AnthropicAdapter.buildExtraBody(cache, request.tools);

    let eventId = 0;
    const ev = (type: string, data: any) =>
      `id: ${messageId}-${eventId++}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

    // message_start：整个响应只发一次（跨多轮搜索仍是同一个 message）
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

    // 跨轮状态：blockIndex 在多轮间连续递增，openBlock/closeBlock 复用
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

    for (let round = 0; round <= settings.searchMaxRounds; round++) {
      let wsId: string | null = null;
      let wsArgs = '';
      let hadClientToolCall = false;

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
          if (e.name === 'web_search') {
            // 内部代办：关掉前面的块，攒 id（绝不透传成客户端的 tool_use）
            yield* closeBlock();
            wsId = e.id;
            wsArgs = '';
          } else {
            // 客户端工具：透传 tool_use 块
            yield* closeBlock();
            blockIndex++;
            yield ev('content_block_start', {
              type: 'content_block_start',
              index: blockIndex,
              content_block: { type: 'tool_use', id: e.id, name: e.name, input: {} },
            });
            openBlock = 'tool_use';
            hadClientToolCall = true;
          }
        } else if (e.kind === 'tool_call_args') {
          if (openBlock === 'tool_use') {
            yield ev('content_block_delta', {
              type: 'content_block_delta',
              index: blockIndex,
              delta: { type: 'input_json_delta', partial_json: e.args },
            });
          } else if (wsId !== null) {
            wsArgs += e.args; // 累积 web_search 的 query 参数（攒而不发）
          }
        } else if (e.kind === 'done') {
          finalStop = e.finishReason === 'tool_calls' ? 'tool_use' : 'end_turn';
          outputTokens += e.usage?.completion_tokens ?? 0;
          if (e.usage?.prompt_tokens_details?.cached_tokens) {
            cachedTokens = e.usage.prompt_tokens_details.cached_tokens;
          }
        }
      }

      yield* closeBlock(); // 关掉本轮最后一个块

      // 客户端工具调用优先：立即交还控制权
      if (hadClientToolCall) {
        finalStop = 'tool_use';
        break;
      }
      // 模型想搜索且未达上限：执行搜索 + 注入搜索块 + 喂回 deap 续轮
      if (wantSearch && wsId && round < settings.searchMaxRounds) {
        const query = AnthropicAdapter.parseWebSearchQuery(wsArgs);
        let hits: SearchHit[] = [];
        try {
          hits = await provider!.search(query);
        } catch {
          hits = [];
        }
        const suId = AnthropicAdapter.shortId('srvtoolu_');

        // 注入 server_tool_use 块（跨轮 blockIndex 续）
        blockIndex++;
        yield ev('content_block_start', {
          type: 'content_block_start',
          index: blockIndex,
          content_block: { type: 'server_tool_use', id: suId, name: 'web_search', input: { query } },
        });
        yield ev('content_block_stop', { type: 'content_block_stop', index: blockIndex });

        // 注入 web_search_tool_result 块
        blockIndex++;
        yield ev('content_block_start', {
          type: 'content_block_start',
          index: blockIndex,
          content_block: {
            type: 'web_search_tool_result',
            tool_use_id: suId,
            content: hits.map((h) => ({
              type: 'web_search_result',
              url: h.url,
              title: h.title,
              encrypted_content: h.snippet,
            })),
          },
        });
        yield ev('content_block_stop', { type: 'content_block_stop', index: blockIndex });

        // 喂回 deap：assistant web_search tool_call + role:tool 结果
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [{ id: wsId, type: 'function' as const, function: { name: 'web_search', arguments: wsArgs || '{}' } }],
        });
        messages.push({
          role: 'tool',
          tool_call_id: wsId,
          content: AnthropicAdapter.hitsToToolResultText(hits),
        });
        continue; // 发起下一轮 chatStream 续写
      }

      // 无搜索意图：正常结束
      finalStop = 'end_turn';
      break;
    }

    const finalOutput = outputTokens > 0 ? outputTokens : Math.floor(accumulatedText.length / 4);
    const deltaUsage: any = { output_tokens: finalOutput };
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
