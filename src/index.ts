/**
 * xrl-router-plugin-wukong — 纯 DEAP 协议桥接插件。
 *
 * 作为 xrl-router 的插件运行，职责：
 *   1. 接收 xrl-router 转发的 OpenAI Chat Completions 请求（密钥在 Authorization 头）
 *   2. 注入 DEAP 业务头（x-dingtalk-* 与 x-wukong-* 等十几个头）
 *   3. 注入 DEAP 特有请求体字段（extra_body, enable_thinking, enable_search）
 *   4. 转发到 DEAP 网关并返回结果
 *
 * 不管密钥、不管轮换、不管 Anthropic 翻译——这些全部由 xrl-router 负责。
 */

import express, { Request, Response, Express } from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { settings } from './config';
import { PluginClient } from './pluginClient';

const app: Express = express();

// 中间件
app.use(cors());
app.use(express.json({ limit: '50mb' }));

/**
 * 检测并释放指定端口（跨平台支持）
 */
async function killPortProcess(port: number): Promise<void> {
  const isWindows = process.platform === 'win32';
  return new Promise((resolve) => {
    if (isWindows) {
      const netstat = spawn('netstat', ['-ano']);
      let output = '';
      netstat.stdout.on('data', (data) => { output += data.toString(); });
      netstat.on('close', () => {
        const pids: string[] = [];
        for (const line of output.split('\n')) {
          if (line.includes(`:${port}`) && line.includes('LISTENING')) {
            const parts = line.trim().split(/\s+/);
            const pid = parts[parts.length - 1];
            if (pid && !pids.includes(pid)) pids.push(pid);
          }
        }
        if (pids.length === 0) return resolve();
        const taskkill = spawn('taskkill', ['/F', '/PID', ...pids]);
        taskkill.on('close', () => resolve());
      });
    } else {
      const lsof = spawn('lsof', ['-ti', `:${port}`]);
      let pids = '';
      lsof.stdout.on('data', (data) => { pids += data.toString(); });
      lsof.stderr.on('data', () => {});
      lsof.on('close', (code) => {
        if (code === 0 && pids.trim()) {
          const pidList = pids.trim().split('\n').filter(Boolean);
          const kill = spawn('kill', ['-9', ...pidList]);
          kill.on('close', () => resolve());
        } else {
          resolve();
        }
      });
    }
  });
}

// ============================================================================
// DEAP 头注入 + 请求体清洗
// ============================================================================

/**
 * 组装 DEAP 要求的一整套请求头。缺任何一个 x-dingtalk-* 都会被拒（400）。
 * Authorization 使用 Router 透传过来的密钥。
 */
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

/**
 * 清洗请求体：注入 DEAP 特有字段（extra_body, enable_thinking, enable_search）。
 * DEAP 要求流式请求必须带 stream_options / temperature / enable_thinking / extra_body，否则返回 406。
 */
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

// ============================================================================
// 路由
// ============================================================================

// 根路径（健康探针）
app.get('/', (_req: Request, res: Response) => {
  res.json({
    version: '0.1.0',
    service: 'xrl-router-plugin-wukong',
    status: 'running',
    mode: 'plugin',
    backend: 'deap',
    endpoints: { chat: '/v1/chat/completions', health: '/health' },
  });
});

// 健康检查（轻量级，不发请求到 DEAP）
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    backend: 'deap',
    plugin_mode: true,
    base_url: settings.baseUrl,
  });
});

// OpenAI Chat Completions（插件唯一对外接口）
app.post('/v1/chat/completions', async (req: Request, res: Response) => {
  // 从 Authorization 头取出 Router 透传的 DEAP 密钥
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
  const upstreamUrl = `${settings.baseUrl}/chat/completions`;
  const headers = buildDeapHeaders(deapKey);

  try {
    const resp = await fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      // DEAP 错误直接返回给 Router（Router 的 retry loop 会换 key 重试）
      const text = await resp.text().catch(() => '');
      res.status(resp.status).type('application/json').send(text || JSON.stringify({ error: { message: `DEAP returned ${resp.status}` } }));
      return;
    }

    if (isStream) {
      // SSE 流式：直接透传字节流
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (res.socket) res.socket.setNoDelay(true);

      if (resp.body) {
        const reader = resp.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
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
      res.json(data);
    }
  } catch (error: any) {
    res.status(502).json({ error: { message: `Upstream error: ${error.message}` } });
  }
});

// ============================================================================
// 启动
// ============================================================================

async function startServer() {
  const port = settings.port;
  const host = '0.0.0.0';
  await killPortProcess(port);
  app.listen(port, host, () => {
    // 启动 PluginClient（自动连接 xrl-router 并注册）
    const pluginClient = new PluginClient();

    // 优雅退出
    process.on('SIGTERM', () => {
      pluginClient.close();
      process.exit(0);
    });
    process.on('SIGINT', () => {
      pluginClient.close();
      process.exit(0);
    });
  });
}

startServer();

export default app;
