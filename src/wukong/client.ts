/**
 * wukong/client.ts — wukong 通道：OpenAI Chat Completions → 钉钉 DEAP 网关。
 *
 * 注入 DEAP 业务头（x-dingtalk-* / x-wukong-*，缺一 400）+ 请求体清洗
 * （extra_body / enable_thinking / enable_search；流式不能带 Accept: text/event-stream）。
 */

import { randomUUID } from 'node:crypto';
import { settings } from '../config';

/** DEAP 要求的一整套业务头（缺任何一个 x-dingtalk-* 都会被拒 400） */
function buildDeapHeaders(deapKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${deapKey}`,
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

/** 清洗请求体：注入 DEAP 特有字段（extra_body, enable_thinking, enable_search） */
function buildDeapBody(body: any): any {
  const userQuery = (body.messages || [])
    .filter((m: any) => m.role === 'user')
    .map((m: any) => typeof m.content === 'string' ? m.content : '')
    .filter(Boolean)
    .pop() || '';

  const isStream = body.stream === true;

  return {
    ...body,
    max_tokens: body.max_tokens ?? 4096,
    temperature: body.temperature ?? 0.6,
    enable_thinking: body.enable_thinking ?? true,
    enable_search: true,
    ...(isStream ? { stream_options: { include_usage: true } } : {}),
    extra_body: {
      enable_thinking: body.enable_thinking ?? true,
      user_query: userQuery,
      enable_search: true,
      ...(body.extra_body || {}),
    },
  };
}

/**
 * 转发 OpenAI Chat Completions 请求到 DEAP 网关。
 * 密钥来自 xrl-router 透传的 Authorization 头。
 */
export async function forwardChatCompletions(req: any, res: any): Promise<void> {
  const authHeader = req.headers.authorization || '';
  const deapKey = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : authHeader;

  if (!deapKey) {
    res.status(401).json({ error: { message: 'No API key provided (expected Authorization: Bearer <key> from xrl-router)' } });
    return;
  }

  const body = buildDeapBody(req.body);
  const isStream = req.body.stream === true;
  const upstreamUrl = `${settings.deapBaseUrl}/chat/completions`;
  const headers = buildDeapHeaders(deapKey);

  // 客户端断开时取消上游请求，避免无谓消耗 + 写已关闭的 res 导致崩溃
  // 注意：Node.js 24 下 req.on('close') 在请求体消费完就触发（不等连接关闭）
  // 所以必须监听 res.on('close')（连接真正关闭时才触发）
  const abortController = new AbortController();
  const onClientClose = () => {
    if (!res.writableEnded) abortController.abort();
  };
  res.on('close', onClientClose);

  // 连接超时：60s 内上游必须响应（fetch 本身无默认超时，DEAP 挂起会导致 CC 先超时断开）
  const connectTimeout = setTimeout(() => abortController.abort(), 60_000);

  try {
    const resp = await fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: abortController.signal,
    });
    clearTimeout(connectTimeout);

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      if (!res.headersSent) {
        res.status(resp.status).type('application/json').send(text || JSON.stringify({ error: { message: `DEAP returned ${resp.status}` } }));
      }
      return;
    }

    if (isStream) {
      // SSE 流式：按行拆分后逐条写入，避免上游 TCP 批量合包导致客户端「一块一块出」
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (res.socket) res.socket.setNoDelay(true);

      if (resp.body) {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop()!; // 末尾可能是不完整行，留给下次拼接
            for (const line of lines) {
              res.write(line + '\n');
              if (typeof (res as any).flush === 'function') (res as any).flush();
            }
          }
          // 流结束后刷出剩余内容
          if (buffer) {
            res.write(buffer);
            if (typeof (res as any).flush === 'function') (res as any).flush();
          }
        } finally {
          res.end();
        }
      } else {
        res.end();
      }
    } else {
      // 非流式：直接透传 JSON
      const data = await resp.json();
      if (!res.headersSent) res.json(data);
    }
  } catch (error: any) {
    // 客户端主动断开 → 正常终止，无需报错
    if (error.name === 'AbortError') {
      if (!res.writableEnded) res.end();
      return;
    }
    // 流式模式已发过头 → 只能静默结束，不能再 set header / status
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    res.status(502).json({ error: { message: `Upstream error: ${error.message}` } });
  } finally {
    res.removeListener('close', onClientClose);
  }
}
