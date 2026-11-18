// 会话配置的解析：服务端记下的配置 > 会话记录里最后一条 assistant 消息的模型 + 全局默认的其余字段 > 全局默认。
import { canonicalModel, type SessionConfig, type SessionSummary } from '@cosyee/shared';

/**
 * 打开一个会话时输入框应该显示的配置。
 * - 有服务端记录（上次发送 / 切换时记下的）：原样使用；
 * - 没有（旧会话）：模型取会话记录里最后一条 assistant 消息的模型（归一成菜单 id），思考强度等沿用全局默认；
 * - 都没有：全局默认。
 */
export function resolveSessionConfig(s: Pick<SessionSummary, 'config' | 'lastModel'> | null | undefined, defaults: SessionConfig): SessionConfig {
  if (s?.config) return { ...s.config };
  const model = canonicalModel(s?.lastModel);
  return model ? { ...defaults, model } : { ...defaults };
}
