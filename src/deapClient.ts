/**
 * DeapClient — 直接调用钉钉 deap 网关的客户端（本代理唯一后端）。
 *
 * 拿「deap API Key」直连
 *   POST https://api-deap.dingtalk.com/dingtalk/v1/chat/completions
 * deap 说 OpenAI 兼容协议（chat/completions，支持 SSE 流式 + function calling）。
 *
 * 本客户端负责：
 *   - 透传结构化的 OpenAI messages（含 tool_calls / role:tool）与 tools 定义
 *   - 注入完整的一组 x-dingtalk-* / x-wukong-* 头（缺一个都会 400）
 *   - 解析非流式 JSON / 流式 SSE，产出文本增量、思考增量(thinking) 与 工具调用增量
 *   - 模型 403 不可用时自动兜底到 wukongModel 并缓存；550 无渠道时带退避重试
 *
 * Key 的来源：本机已登录的悟空 daemon 调 deap 时挂在 Authorization 头上的临时密钥
 * （约 29 天有效）。本代理通过 MITM 代理截获该 Bearer token，抓取流程见 docs/CAPTURE_DEAP_KEY.md。
 */

import { randomUUID } from 'crypto';
import Table from 'cli-table3';
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

/** deap 返回的 usage（含可选的缓存命中 token 数）。 */
export type DeapUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
};

/** 非流式的完整结果：正文 + 可选的思考链 + 可选的工具调用 + 真实 usage */
export interface DeapChatResult {
  text: string;
  /** deap 返回的 reasoning_content（仅 enable_thinking=true 时有值） */
  reasoning?: string;
  toolCalls: DeapToolCall[];
  finishReason: string;
  usage?: DeapUsage;
}

/** 流式产出的事件：文本增量、思考增量、工具调用增量，或最终的 finish/usage */
export type DeapStreamEvent =
  | { kind: 'thinking'; thinking: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool_call_start'; index: number; id: string; name: string }
  | { kind: 'tool_call_args'; index: number; args: string }
  | { kind: 'done'; finishReason: string; usage?: DeapUsage };

export class DeapClient {
  private apiKeys: string[];
  private currentKeyIndex: number = 0;
  private baseUrl: string;
  /** 已被 deap 判定不可用的模型缓存（model → 过期时间戳），避免重复撞 403 */
  private unavailableCache = new Map<string, number>();
  /** 已被判定无效的密钥索引集合（401鉴权失败，永久失效） */
  private invalidKeyIndices = new Set<number>();
  /** 密钥的配额状态：'low' 表示402配额不足（黄灯，暂时不可用） */
  private keyQuotaStatus = new Map<number, 'low'>();
  /** 日志队列：存储需要显示的日志行（刷新时还原），最多100条 */
  private logQueue: string[] = [];

  constructor(apiKey?: string, baseUrl?: string) {
    this.apiKeys = apiKey ? [apiKey] : settings.deapApiKeys;
    this.baseUrl = (baseUrl || settings.deapBaseUrl).replace(/\/$/, '');

    if (this.apiKeys.length === 0) {
      throw new Error('DEAP_API_KEYS is not configured. Set it in .env or env.');
    }
  }

  /** 获取当前可用的密钥（跳过已标记为无效的密钥） */
  private getCurrentKey(): string | null {
    // 如果所有密钥都被标记为无效，返回 null（调用者应返回402）
    if (this.invalidKeyIndices.size >= this.apiKeys.length) {
      console.error('[deap] 所有密钥均已被标记为无效，无法继续请求');
      return null;
    }

    // 寻找下一个有效密钥（跳过401红灯和402黄灯的密钥）
    for (let i = 0; i < this.apiKeys.length; i++) {
      const idx = (this.currentKeyIndex + i) % this.apiKeys.length;
      // 跳过401鉴权失败的密钥（红灯）
      if (this.invalidKeyIndices.has(idx)) continue;
      // 跳过402配额不足的密钥（黄灯）
      if (this.keyQuotaStatus.get(idx) === 'low') continue;

      this.currentKeyIndex = idx;
      return this.apiKeys[idx];
    }

    // 理论上不会到这里（前面已检查过全部无效的情况）
    return null;
  }

  /** 标记当前密钥为无效（401鉴权失败） */
  private markCurrentKeyInvalid() {
    this.invalidKeyIndices.add(this.currentKeyIndex);
    // 添加到日志队列（带时间戳）
    const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    this.logQueue.push(`[${timestamp}] [deap] 🔴 密钥 #${this.currentKeyIndex + 1} 鉴权失败`);
    // 限制日志队列长度，删除最老的日志
    if (this.logQueue.length > 100) {
      this.logQueue.shift();
    }
    // 原地刷新密钥池表格（包含历史日志）
    this.printKeyTable(true);
  }

  /** 标记当前密钥配额不足（402但还能用） */
  private markCurrentKeyLowQuota() {
    this.keyQuotaStatus.set(this.currentKeyIndex, 'low');
    // 添加到日志队列（带时间戳）
    const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    this.logQueue.push(`[${timestamp}] [deap] 🟡 密钥 #${this.currentKeyIndex + 1} 配额不足`);
    // 限制日志队列长度，删除最老的日志
    if (this.logQueue.length > 100) {
      this.logQueue.shift();
    }
    // 原地刷新密钥池表格（包含历史日志）
    this.printKeyTable(true);
  }

  /** 获取当前有效的密钥数量（仅计算绿灯密钥） */
  getValidKeyCount(): number {
    let count = 0;
    for (let i = 0; i < this.apiKeys.length; i++) {
      // 跳过401鉴权失败的密钥（红灯）
      if (this.invalidKeyIndices.has(i)) continue;
      // 跳过402配额不足的密钥（黄灯）
      if (this.keyQuotaStatus.get(i) === 'low') continue;
      count++;
    }
    return count;
  }

  /** 生成密钥脱敏字符串（sk-xxxxxxxx…xxxx，保留前10后4位） */
  private maskKey(key: string): string {
    if (key.length <= 14) return key.slice(0, 7) + '…';
    return `${key.slice(0, 10)}…${key.slice(-4)}`;
  }

  /**
   * 打印密钥池可用性表格（cli-table3）。
   * @param refresh 是否原地刷新（清除之前的所有内容后重新打印）
   */
  printKeyTable(refresh = false): void {
    const now = new Date().toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).replace(/\//g, '-');
    const rows: string[][] = [];

    for (let i = 0; i < this.apiKeys.length; i++) {
      // 优先级：401鉴权失败（红灯） > 402配额不足（黄灯） > 正常（绿灯）
      let light: string;
      if (this.invalidKeyIndices.has(i)) {
        light = '🔴'; // 401鉴权失败，永久失效
      } else if (this.keyQuotaStatus.get(i) === 'low') {
        light = '🟡'; // 402配额不足，但还能用
      } else {
        light = '🟢'; // 正常
      }
      const masked = this.maskKey(this.apiKeys[i]);
      const keyStr = i === this.currentKeyIndex ? '\x1b[4m' + masked + '\x1b[24m' : masked;
      const note = settings.keysName[i] || '';
      rows.push([light, String(i + 1), keyStr, note]);
    }

    const titleCell = '密钥池 @ ' + now;
    const head = ['', '序号', '密钥', '备注'];

    const table = new Table({
      style: { head: ['cyan'] },
      colWidths: [4, 6, 22, 16],
    });

    // 标题行独占一行（跨列）
    table.push([{ colSpan: 4, content: titleCell, hAlign: 'center' }]);
    // 列头
    table.push(head);
    // 数据行
    table.push(...rows);

    const tableStr = table.toString();

    if (refresh) {
      // 从头输出：清除整个屏幕并回到顶部
      process.stdout.write('\x1B[H\x1B[2J');
    }

    // 输出启动信息
    console.log(`🚀 wukong-penetrate running at http://0.0.0.0:${settings.port}`);

    // 输出表格
    console.log(tableStr);

    // 输出历史日志队列（刷新时还原）
    if (this.logQueue.length > 0) {
      for (const log of this.logQueue) {
        console.log(log);
      }
    }
  }

  /**
   * 判断一个错误是否「可重试」：deap 对第三方模型（claude/gpt）的动态渠道池
   * 间歇性返回 550 "No available channel"（及其它 5xx），重试同一模型通常能命中空闲渠道。
   * 4xx（鉴权 / 参数类错误）不重试。
   */
  private isRetriableError(status: number, body: string): boolean {
    if (status >= 500) return true;
    // 少数情况下 4xx body 里带 channel 字样也视作可重试
    if (status >= 400 && /no available channel|channel/i.test(body)) return true;
    return false;
  }

  /** 指数退避：第 attempt 次重试等待 base * 2^(attempt) 毫秒。 */
  private backoff(attempt: number): Promise<void> {
    const ms = settings.channelRetryBaseMs * Math.pow(2, attempt);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** deap 是否明确表示「该模型不可用」（403 + requested model is not available）。 */
  private isModelUnavailable(status: number, body: string): boolean {
    return status === 403 && /requested model is not available/i.test(body);
  }

  /** 该模型是否在「已知不可用」缓存中（且未过期）。 */
  private isKnownUnavailable(model: string): boolean {
    const exp = this.unavailableCache.get(model);
    return !!exp && exp > Date.now();
  }

  /** 标记某模型不可用，缓存一个 TTL（到期后允许重新验证，模型可能恢复可用）。 */
  private markUnavailable(model: string): void {
    if (!model) return;
    this.unavailableCache.set(model, Date.now() + settings.modelAvailabilityTtlMs);
  }

  /**
   * 带模型兜底（403）+ 渠道重试（550）的统一 fetch。chat/chatStream 共用，消除重复循环。
   * @param label 日志/错误信息前缀（'chat' / 'stream'）。成功返回 Response（已 res.ok）。
   */
  private async fetchWithRetry(
    messages: DeapChatMessage[],
    stream: boolean,
    maxTokens: number | undefined,
    tools: DeapTool[] | undefined,
    toolChoice: any,
    extraBody: Record<string, any> | undefined,
    enableThinking: boolean | undefined,
    initialModel: string | undefined,
    label: string,
  ): Promise<Response> {
    let useModel = initialModel && !this.isKnownUnavailable(initialModel) ? initialModel : settings.wukongModel;
    let fallbackTried = useModel === settings.wukongModel;
    for (let attempt = 0; ; attempt++) {
      const body = this.buildBody(messages, useModel, stream, maxTokens, tools, toolChoice, extraBody, enableThinking);
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
      });
      if (res.ok) return res;
      const text = await res.text().catch(() => '');
      // 鉴权失败（401）→ 标记当前密钥无效，切换密钥并重试
      if (res.status === 401) {
        this.markCurrentKeyInvalid();
        const nextKey = this.getCurrentKey();
        if (nextKey) {
          const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
          const logMsg = `[${timestamp}] [deap ${label}] 密钥 #${this.currentKeyIndex + 1} 鉴权失败（401），切换到密钥 #${this.currentKeyIndex + 1} 重试`;
          this.logQueue.push(logMsg);
          // 限制日志队列长度，删除最老的日志
          if (this.logQueue.length > 100) {
            this.logQueue.shift();
          }
          attempt = -1; // 重新计数重试
          continue;
        } else {
          // 所有密钥都失效，返回402错误
          throw new Error('deap ' + label + ' failed: 所有密钥均已失效（鉴权失败），无法继续请求');
        }
      }
      // 配额超限（402）→ 标记为配额不足（黄灯），切换密钥并重试
      if (res.status === 402) {
        this.markCurrentKeyLowQuota();
        const nextKey = this.getCurrentKey();
        if (nextKey) {
          const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
          const logMsg = `[${timestamp}] [deap ${label}] 密钥 #${this.currentKeyIndex + 1} 配额不足（402），切换到密钥 #${this.currentKeyIndex + 1} 重试`;
          this.logQueue.push(logMsg);
          // 限制日志队列长度，删除最老的日志
          if (this.logQueue.length > 100) {
            this.logQueue.shift();
          }
          attempt = -1; // 重新计数重试
          continue;
        } else {
          // 所有密钥都失效，返回402错误
          throw new Error('deap ' + label + ' failed: 所有密钥均已失效（配额不足），无法继续请求');
        }
      }
      // 模型不可用（403）→ 动态兜底到 wukongModel（仅一次）
      if (this.isModelUnavailable(res.status, text) && !fallbackTried) {
        this.markUnavailable(useModel);
        const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        const logMsg = `[${timestamp}] [deap ${label}] 模型 "${useModel}" 不可用（403），动态兜底到 "${settings.wukongModel}"`;
        this.logQueue.push(logMsg);
        if (this.logQueue.length > 100) {
          this.logQueue.shift();
        }
        useModel = settings.wukongModel;
        fallbackTried = true;
        attempt = -1; // 兜底模型重新计重试
        continue;
      }
      // 渠道错误（550 等）→ 重试同一模型
      if (this.isRetriableError(res.status, text) && attempt < settings.channelRetryMax) {
        const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        const logMsg = `[${timestamp}] [deap ${label}] 可重试错误，第 ${attempt + 1}/${settings.channelRetryMax} 次重试：HTTP ${res.status} ${text.slice(0, 200)}`;
        this.logQueue.push(logMsg);
        if (this.logQueue.length > 100) {
          this.logQueue.shift();
        }
        await this.backoff(attempt);
        continue;
      }
      throw new Error('deap ' + label + ' failed: HTTP ' + res.status + ' ' + text.slice(0, 300));
    }
  }

  /** 组装 deap 要求的一整套请求头。缺任何一个 x-dingtalk-* 都会被拒（400）。 */
  private buildHeaders(): Record<string, string> {
    const key = this.getCurrentKey();
    if (!key) throw new Error('所有密钥均已失效，无法发起请求');
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
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
   *
   * @param extraBody 额外的参数对象，用于传递缓存控制等高级功能
   */
  private buildBody(
    messages: DeapChatMessage[],
    model: string | undefined,
    stream: boolean,
    maxTokens?: number,
    tools?: DeapTool[],
    toolChoice?: any,
    extraBody?: Record<string, any>,
    enableThinking?: boolean,
  ) {
    const userQuery =
      messages.filter((m) => m.role === 'user').map((m) => m.content).filter(Boolean).pop() || '';

    return {
      model: model || settings.wukongModel,
      stream,
      max_tokens: maxTokens ?? 4096,
      temperature: 0.6,
      enable_thinking: enableThinking ?? false,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      extra_body: {
        enable_thinking: enableThinking ?? false,
        user_query: typeof userQuery === 'string' ? userQuery : '',
        // 合并传入的 extra_body（包含 cache_control）
        ...extraBody,
      },
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
    extraBody?: Record<string, any>,
    enableThinking?: boolean,
  ): Promise<DeapChatResult> {
    const res = await this.fetchWithRetry(messages, false, maxTokens, tools, toolChoice, extraBody, enableThinking, model, 'chat');
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

    const reasoning =
      typeof msg.reasoning_content === 'string' && msg.reasoning_content.length > 0
        ? msg.reasoning_content
        : undefined;

    return {
      text,
      reasoning,
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
    extraBody?: Record<string, any>,
    enableThinking?: boolean,
  ): AsyncGenerator<DeapStreamEvent> {
    // 403 模型兜底 + 550 渠道重试统一在 fetchWithRetry（首字节前可安全切换模型）
    const res = await this.fetchWithRetry(messages, true, maxTokens, tools, toolChoice, extraBody, enableThinking, model, 'stream');
    if (!res.body) throw new Error('deap stream failed: empty body');

    const decoder = new TextDecoder();
    let buffer = '';
    const reader = (res.body as any).getReader();

    let finishReason = 'stop';
    let usage: DeapUsage | undefined;

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
              prompt_tokens_details: json.usage.prompt_tokens_details,
            };
          }

          const choice = json?.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason) finishReason = choice.finish_reason;

          const delta = choice.delta ?? {};

          // 思考增量（reasoning_content，仅 enable_thinking=true 时有）
          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
            yield { kind: 'thinking', thinking: delta.reasoning_content };
          }

          // 正文增量
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
