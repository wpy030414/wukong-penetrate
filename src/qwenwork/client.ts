/**
 * qwenwork/client.ts — qwenwork 通道转发：OpenAI Chat Completions → gateway.qwenwork.cn。
 *
 * 对每个请求：
 *  1. 取 OAuth token（自动刷新）
 *  2. encryptUserInfo → cosy-key / info（每请求新 16B AES key）
 *  3. generateAuthToken → authorization（md5 绑定 body/path/时间戳，天然防重放）
 *  4. body 明文透传（去 Encode=1；必需 request_id/session_id 自动补）
 *  5. 流式/非流式透传
 */

import { randomUUID } from 'node:crypto';
import { settings } from '../config';
import { refreshDeviceToken } from './auth';
import { buildSignMaterial, buildAuthHeaders } from './signer';

/** qwenwork 应用层模型 → 展示名 */
const DISPLAY_NAMES: Record<string, string> = {
  'qwork-advanced': 'glm-5.2',
};

/** 模型 id 映射（OpenAI 客户端常见名 → qwenwork 应用层档位） */
const MODEL_ALIASES: Record<string, string> = {
  'glm-5.2': 'qwork-advanced',
};

export function resolveModel(model: string): string {
  return MODEL_ALIASES[model] || model;
}

export function displayName(modelId: string): string {
  return DISPLAY_NAMES[modelId] || modelId;
}

/** 从 Authorization 头取出 refresh token（xrl-router 密钥池 QWEN_KEYS 的透传） */
function extractRefreshToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const t = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();
  return t.startsWith('ory_rt_') ? t : null;
}

/** 从 OAuth access token（JWT）payload 解出 uid（deviceToken/refresh 响应无 user 字段） */
function extractUidFromToken(token: string): string {
  try {
    const part = token.split('.')[1] || '';
    const json = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return json.sub || json.uid || json.user_id || '';
  } catch { return ''; }
}

const COSY_STATIC_HEADERS: Record<string, string> = {
  'Cosy-Business-Product': 'qoder_work',
  'Cosy-Business-Type': 'agent',
  'Cosy-ClientType': '6',
  'Cosy-Data-Policy': 'disagree',
  'Cosy-MachineId': 'unknown',
  'Cosy-MachineToken': 'unknown',
  'Cosy-MachineType': '5',
  'Cosy-Scene': 'qwork',
  'Cosy-MachineOs': 'aarch64_darwin',
  'Cosy-Version': '1.0.47',
  'Login-Version': 'v2',
  'x-model-source': 'system',
};

const INFER_PATH = '/algo/api/v2/service/pro/sse/agent_chat_generation';
const INFER_QUERY = '?FetchKeys=llm_model_result&AgentId=agent_common';

/**
 * 转发 OpenAI Chat Completions 请求到 qwenwork 推理网关。
 *
 * token 权威来源：请求 Authorization 透传的 refresh token（xrl-router 密钥池 QWEN_KEYS）。
 * 无 Authorization / 非 ory_rt_ 前缀 → 401（serve 不自行取 token，见 docs/README）。
 */
export async function forwardChatCompletions(
  body: any,
  res: any,
  authHeader?: string,
): Promise<void> {
  const model = resolveModel(body.model || 'qwork-advanced');
  const isStream = body.stream === true;

  // token 来源：只认 xrl-router 透传的 refresh token（密钥池）
  const rt = extractRefreshToken(authHeader);
  if (!rt) {
    res.status(401).json({ error: { message: 'No refresh token provided (expected Authorization: Bearer <ory_rt_...> from xrl-router)' } });
    return;
  }
  let token;
  try {
    token = await refreshDeviceToken(rt); // 密钥池 refresh token → 刷新为 access token
  } catch (e: any) {
    res.status(401).json({ error: { message: `refresh token 无效: ${e.message}` } });
    return;
  }
  token.user = { uid: extractUidFromToken(token.token) }; // 从 JWT 解 uid

  // body：明文透传 + 补 request_id/session_id
  const forwardBody: any = {
    ...body,
    model,
    request_id: body.request_id || randomUUID(),
    session_id: body.session_id || randomUUID(),
  };

  // 去掉可能带入的 Encode=1 相关字段（qwenwork 网关明文即可）
  delete forwardBody.encode;
  delete forwardBody.extra_body;

  const bodyStr = JSON.stringify(forwardBody);
  const material = buildSignMaterial(token);
  const url = `${settings.qwenBaseUrl}${INFER_PATH}${INFER_QUERY}`;
  const auth = buildAuthHeaders(material, { url, body: bodyStr });

  const headers: Record<string, string> = {
    ...COSY_STATIC_HEADERS,
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'Authorization': auth.authorization,
    'Cosy-Key': auth.cosyKey,
    'Cosy-Date': auth.cosyDate,
    'Cosy-User': auth.cosyUser,
    'x-model-key': model,
  };

  const upstream = await fetch(url, { method: 'POST', headers, body: bodyStr });

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    res.status(upstream.status).type('application/json')
      .send(text || JSON.stringify({ error: { message: `qwenwork upstream ${upstream.status}` } }));
    return;
  }

  // qwenwork 响应是外层 SSE：data:{"headers":{...},"body":"<内层OpenAI chunk JSON>","statusCodeValue":200}
  // 解包成标准 OpenAI SSE 透传
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.socket) res.socket.setNoDelay(true);

  const reader = upstream.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let sentDone = false;

  const emitChunk = (inner: string): void => {
    // 去重：上游本身会发 [DONE]（chunk 数最后一行 data:{}），我们自己只发一次
    if (inner === '{}' || /\[DONE\]/.test(inner)) return;
    res.write(`data: ${inner}\n\n`);
    if (typeof (res as any).flush === 'function') (res as any).flush();
  };

  const flushLine = (line: string): void => {
    const t = line.trim();
    if (!t.startsWith('data:')) return;
    try {
      const outer = JSON.parse(t.slice(5));
      const inner = typeof outer.body === 'string' ? outer.body : JSON.stringify(outer.body ?? {});
      emitChunk(inner);
    } catch { /* 忽略无法解析的行 */ }
  };

  // —— 非流式：聚合所有 chunk 为完整 OpenAI JSON ——
  if (!isStream) {
    const parts: any[] = [];
    const usage: any = {};
    let innerId = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const t = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (t.startsWith('data:')) {
            try {
              const outer = JSON.parse(t.slice(5));
              const inner = JSON.parse(outer.body);
              if (inner.id) innerId = inner.id;
              if (inner.choices?.[0]?.delta) parts.push(inner.choices[0].delta);
              if (inner.usage) Object.assign(usage, inner.usage);
            } catch { /* 跳过 */ }
          }
        }
      }
      // 合并 delta：content/reasoning_content/tool_calls 拼接
      const msg: any = { role: 'assistant', content: '', reasoning_content: '' };
      for (const d of parts) {
        if (typeof d.content === 'string') msg.content += d.content;
        if (typeof d.reasoning_content === 'string') msg.reasoning_content += d.reasoning_content;
        if (d.tool_calls) msg.tool_calls = d.tool_calls;
      }
      res.json({
        id: innerId || `chatcmpl-${randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{ index: 0, message: msg, finish_reason: 'stop' }],
        usage: Object.keys(usage).length ? usage : undefined,
      });
    } catch (e: any) {
      console.error('[qwenwork] 非流式聚合失败:', e.message);
      if (!res.headersSent) res.status(502).json({ error: { message: `Upstream error: ${e.message}` } });
    } finally {
      res.end();
    }
    return;
  }

  // —— 流式：解包透传 ——
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        flushLine(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    }
    if (buf.trim()) flushLine(buf);
    if (!sentDone) { res.write('data: [DONE]\n\n'); sentDone = true; }
  } catch (e: any) {
    console.error('[qwenwork] 流读取失败:', e.message);
  } finally {
    res.end();
  }
}
