// 委派后端逐次请求用量适配器统一接口。
// 每个委派后端在 usage/ 下实现一个 UsageAdapter，将各自的原始事件转换成统一的 CachePoint（turn 一律为 0）与上下文窗口。
// point.tools 放的是 ACP toolCallId；jobs.ts 封装 cosyee_usage 事件时按 AcpProgress 规则统一换算成前端 ToolStep.id。
import type { CachePoint } from '@cosyee/shared';

export interface UsageAdapter {
  /** 喂入一条后端原始事件，返回本次新产生或更新的 CachePoint（可能为空或多个） */
  push(raw: unknown): CachePoint[];
  /** 当前已知的模型上下文窗口（token）；未知返回 null */
  window(): number | null;
}

export { ClaudeUsageAdapter } from './claudeUsage.js';
export { CodexUsageAdapter, type CodexUsageAdapterOptions, type CodexUsageInput } from './codexUsage.js';
export { AgyUsageAdapter, type AgyUsageAdapterOptions, type AgyUsageInput } from './agyUsage.js';

/** 用量解析只为展示 / 记账：适配器出错一律吞掉，返回空，不影响委派执行 */
export function safePush(a: { push(raw: unknown): CachePoint[] }, raw: unknown): CachePoint[] {
  try {
    return a.push(raw);
  } catch {
    return [];
  }
}
