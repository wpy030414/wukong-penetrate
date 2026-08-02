/**
 * 双通道插件入口（共享骨架）：
 *   无后缀（pnpm serve）        = qwenwork 通道（src/qwenwork/：千问办公 → gateway.qwenwork.cn → 智谱 GLM）
 *   --wukong（pnpm serve:wukong）= wukong 通道（src/wukong/：钉钉悟空 → api-deap.dingtalk.com）
 *
 * 共享：Express 骨架 / 健康检查 / 端口释放 / WS 插件注册 / 密钥池推送。
 * 通道差异封装在 src/<channel>/ 两个目录，各自含 client（转发）与专用逻辑。
 */

import express, { Request, Response, Express } from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import { settings } from './config';
import { PluginClient } from './pluginClient';
import { CHANNEL, isQwenwork, PLUGIN_ID } from './channel';
import { forwardChatCompletions as forwardQwenChat } from './qwenwork/client';
import { forwardChatCompletions as forwardWukongChat } from './wukong/client';

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
// 路由
// ============================================================================

// 根路径（健康探针）
app.get('/', (_req: Request, res: Response) => {
  res.json({
    version: '0.1.0',
    service: PLUGIN_ID,
    status: 'running',
    mode: 'plugin',
    channel: CHANNEL,
    backend: CHANNEL === 'wukong' ? 'deap' : 'qwenwork',
    endpoints: { chat: '/v1/chat/completions', health: '/health' },
  });
});

// 健康检查
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    channel: CHANNEL,
    backend: CHANNEL === 'wukong' ? 'deap' : 'qwenwork',
    plugin_mode: true,
    base_url: CHANNEL === 'wukong' ? settings.deapBaseUrl : settings.qwenBaseUrl,
  });
});

// OpenAI Chat Completions（按通道分发到各自 client）
app.post('/v1/chat/completions', async (req: Request, res: Response) => {
  if (isQwenwork()) {
    // qwenwork：Authorization 透传密钥池的 refresh token（QWEN_KEYS），网关正确使用
    await forwardQwenChat(req.body, res, req.headers.authorization);
  } else {
    await forwardWukongChat(req, res);
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
