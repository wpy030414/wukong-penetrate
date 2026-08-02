/**
 * PluginClient — 连接 xrl-router 的 WebSocket 客户端。
 *
 * 功能：
 * - 启动时连接 xrl-router 并注册为插件
 * - 每 30s 发送心跳保持连接
 * - 每 5s 轮询 .env 文件，检测密钥变化并推送给 xrl-router
 * - 断线自动重连（指数退避，最大间隔 60s）
 */

import { WebSocket } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { settings } from './config';
import { isQwenwork, PLUGIN_ID } from './channel';
import { displayName as qwenDisplayName } from './qwenwork/client';
import { displayName as wukongDisplayName } from './wukong/client';

const ENV_POLL_INTERVAL_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 30000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60000;

/** 密钥池环境变量键（qwenwork 用 QWEN_KEYS，wukong 用 WUKONG_KEYS） */
const KEYS_ENV_KEY = isQwenwork() ? 'QWEN_KEYS' : 'WUKONG_KEYS';

export class PluginClient {
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private envPollTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastKeys: string[] = [];
  private connected = false;

  constructor() {
    this.loadCurrentKeys();
    this.connect();
    this.startEnvPolling();
  }

  /**
   * 加载当前 .env 中的密钥列表
   */
  private loadCurrentKeys(): void {
    try {
      const envPath = path.resolve(process.cwd(), '.env');
      if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf-8');
        const parsed = dotenv.parse(envContent);
        const keysStr = parsed[KEYS_ENV_KEY] || '';
        this.lastKeys = keysStr
          .split(',')
          .map(s => s.trim())
          .filter(Boolean);
      }
    } catch {
      // .env 加载失败时保持 lastKeys 为空
    }
  }

  /**
   * 连接 xrl-router
   */
  private connect(): void {
    const wsUrl = settings.xrlRouterUrl.replace(/^http/, 'ws') + '/ws/plugin';
    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      console.log('[PluginClient] Connected to xrl-router');
      this.connected = true;
      this.reconnectAttempts = 0;
      this.sendRegister();
      this.startHeartbeat();
    });

    this.ws.on('message', (data) => {
      this.handleMessage(data.toString());
    });

    this.ws.on('close', () => {
      console.log('[PluginClient] Disconnected from xrl-router');
      this.connected = false;
      this.stopHeartbeat();
      this.scheduleReconnect();
    });

    this.ws.on('error', (error) => {
      console.error('[PluginClient] WebSocket error:', error.message);
    });
  }

  /**
   * 发送注册消息
   */
  private sendRegister(): void {
    const models = settings.availableModels.map(id => ({
      model_id: id,
      display_name: isQwenwork() ? qwenDisplayName(id) : wukongDisplayName(id),
      tier: id.includes('opus') ? 'opus' : 'custom',
    }));

    const message = {
      type: 'register',
      plugin_id: PLUGIN_ID,
      provider: {
        kind: 'openai',
        base_url: `http://localhost:${settings.port}`,
        api_path: '/v1/chat/completions',
      },
      models,
      keys: this.lastKeys,
    };

    this.send(message);
  }

  /**
   * 处理 xrl-router 返回的消息
   */
  private handleMessage(_data: string): void {
    // xrl-router 消息静默处理（registered/reconnected/keys_ack/activated 均无需动作）
  }

  /**
   * 发送消息
   */
  private send(message: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  /**
   * 启动心跳
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'heartbeat', timestamp: Date.now() });
    }, HEARTBEAT_INTERVAL_MS);
  }

  /**
   * 停止心跳
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * 计划重连
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts),
      RECONNECT_MAX_MS
    );
    console.log(`[PluginClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempts++;
      this.connect();
    }, delay);
  }

  /**
   * 启动 .env 轮询
   */
  private startEnvPolling(): void {
    this.envPollTimer = setInterval(() => {
      this.checkEnvChanges();
    }, ENV_POLL_INTERVAL_MS);
  }

  /**
   * 检查 .env 变化
   */
  private checkEnvChanges(): void {
    try {
      const envPath = path.resolve(process.cwd(), '.env');
      if (!fs.existsSync(envPath)) return;

      const envContent = fs.readFileSync(envPath, 'utf-8');
      const parsed = dotenv.parse(envContent);
      const keysStr = parsed[KEYS_ENV_KEY] || '';
      const currentKeys = keysStr
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

      // 比较密钥列表是否变化
      const changed =
        currentKeys.length !== this.lastKeys.length ||
        currentKeys.some((k, i) => k !== this.lastKeys[i]);

      if (changed) {
        this.lastKeys = currentKeys;

        if (this.connected) {
          this.send({
            type: 'keys_update',
            keys: currentKeys,
          });
        }
      }
    } catch {
      // .env 检查失败时静默忽略
    }
  }

  /**
   * 关闭客户端
   */
  public close(): void {
    this.stopHeartbeat();
    if (this.envPollTimer) {
      clearInterval(this.envPollTimer);
      this.envPollTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
