// 会话流里技能 / MCP 面板用到的会话级信息，经 context 传入，避免给 TurnView 加一堆 props、破坏 memo。
// 工作目录取自 FilesContext.cwd；这里只放 MCP 服务器名与技能正文加载函数。没有 Provider 时用默认值。
import { createContext, useContext } from 'react';
import type { SkillContent } from '@cosyee/shared';
import { api } from '../../core/api';

export type SkillLoader = (name: string, cwd?: string) => Promise<SkillContent>;

/** 默认：core/api 的 getSkillContent（读磁盘 SKILL.md） */
export const defaultSkillLoader: SkillLoader = (name, cwd) => api.getSkillContent(name, cwd);

export interface FlowMeta {
  /** SessionMeta.mcpServers 的服务器名，用来解析 mcp__ 工具名 */
  mcpServers: readonly string[];
  loadSkill: SkillLoader;
}

const EMPTY: readonly string[] = [];
export const FlowMetaContext = createContext<FlowMeta>({ mcpServers: EMPTY, loadSkill: defaultSkillLoader });
export const useFlowMeta = (): FlowMeta => useContext(FlowMetaContext);
