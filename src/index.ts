import express, { Request, Response, NextFunction, Express } from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import { settings } from './config';
import { AnthropicRequest } from './types';
import { AnthropicAdapter } from './adapter';
import { DeapClient } from './deapClient';

const app: Express = express();
// 唯一推理后端：直连 deap 网关
const deapClient = new DeapClient();

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
        console.log(`⚠️  检测到端口 ${port} 被进程占用，PID: ${pids.join(', ')}`);
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
          console.log(`⚠️  检测到端口 ${port} 被进程占用，PID: ${pidList.join(', ')}`);
          const kill = spawn('kill', ['-9', ...pidList]);
          kill.on('close', () => resolve());
        } else {
          resolve();
        }
      });
    }
  });
}

// API密钥验证（仅当服务端设了 API_KEY 才校验）
function verifyApiKey(req: Request, res: Response, next: NextFunction) {
  if (settings.apiKey) {
    const apiKey = req.headers['x-api-key'] as string;
    if (apiKey !== settings.apiKey) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
  }
  next();
}

// 根路径
app.get('/', (_req: Request, res: Response) => {
  res.json({
    service: 'wukong-penetrate',
    version: '0.1.0',
    status: 'running',
    backend: 'deap',
    deap_configured: Boolean(settings.deapApiKey),
    tools_supported: true,
    default_model: settings.wukongModel,
    available_models: settings.availableModels,
    endpoints: { messages: '/v1/messages', health: '/health', models: '/v1/models' },
  });
});

// 健康检查
app.get('/health', async (_req: Request, res: Response) => {
  const isHealthy = await deapClient.healthCheck();
  res.json({ status: isHealthy ? 'healthy' : 'unhealthy', backend: 'deap', deap_available: isHealthy });
});

// Anthropic Messages API（支持 tools / 流式）
app.post('/v1/messages', verifyApiKey, async (req: Request, res: Response) => {
  const request: AnthropicRequest = req.body;

  try {
    if (request.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (res.socket) res.socket.setNoDelay(true);

      for await (const event of AnthropicAdapter.streamResponse(request, deapClient)) {
        res.write(event);
        if (typeof (res as any).flush === 'function') (res as any).flush();
      }
      res.end();
    } else {
      const response = await AnthropicAdapter.chat(request, deapClient);
      res.json(response);
    }
  } catch (error: any) {
    if (request.stream && res.headersSent) {
      console.error('[Error] Stream error:', error.message);
      res.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
      if (typeof (res as any).flush === 'function') (res as any).flush();
      res.end();
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// 模型元数据：display_name / owned_by / capabilities（仅用于 /v1/models 展示，不参与路由）
const MODEL_META: Record<string, { display_name: string; owned_by: string; capabilities: string[] }> = {
  'dingtalk-auto': { display_name: 'DingTalk Auto · Qwen3.7-Plus', owned_by: 'dingtalk', capabilities: ['text', 'tools'] },
  'claude-opus-4-8': { display_name: 'Claude Opus 4.8', owned_by: 'anthropic', capabilities: ['text', 'tools', 'thinking'] },
  'gpt-4o': { display_name: 'GPT-4o', owned_by: 'openai', capabilities: ['text', 'tools'] },
};

// 模型列表：展示候选模型（供客户端发现/选择）。实际可用性由 deap 运行时动态验证——
// deapClient 收到 403 "model not available" 会自动兜底到 wukongModel，无需此处保证准确。
app.get('/v1/models', verifyApiKey, async (_req: Request, res: Response) => {
  const data = settings.availableModels.map((id) => {
    const meta = MODEL_META[id] ?? { display_name: id, owned_by: 'dingtalk', capabilities: ['text', 'tools'] };
    return {
      id,
      object: 'model',
      created: 1699000000,
      owned_by: meta.owned_by,
      display_name: meta.display_name,
      capabilities: meta.capabilities,
    };
  });
  res.json({ object: 'list', data });
});

// 余额查询（mock 彩蛋，供某些客户端探活）
app.get('/user/balance', (_req: Request, res: Response) => {
  res.json({ isValid: true, remaining: 114514.1919, unit: '算粒' });
});

// 启动服务器
async function startServer() {
  const port = settings.port;
  const host = settings.host;
  await killPortProcess(port);
  app.listen(port, host, () => {
    console.log(`🚀 wukong-penetrate running at http://${host}:${port}`);
  });
}

startServer();

export default app;
