/**
 * channel.ts — 双通道判定。
 *
 * 无后缀入口（pnpm serve / pnpm capture-key）= qwenwork 通道（默认）
 * `--use wukong` 参数（pnpm serve:wukong）= wukong 通道
 */

export type Channel = 'qwenwork' | 'wukong';

/** 解析 --use <channel> 参数（argv 形如 ["--use", "wukong"]） */
function parseChannel(): Channel {
  const i = process.argv.indexOf('--use');
  if (i >= 0 && process.argv[i + 1] === 'wukong') return 'wukong';
  return 'qwenwork';
}

export const CHANNEL: Channel = parseChannel();

export const isWukong = (): boolean => CHANNEL === 'wukong';
export const isQwenwork = (): boolean => CHANNEL === 'qwenwork';

export const PLUGIN_ID: string = CHANNEL === 'wukong'
  ? 'xrl-router-plugin-wukong'
  : 'xrl-router-plugin-qwenwork';
