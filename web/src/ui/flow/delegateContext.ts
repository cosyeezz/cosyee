// 委派任务的操作，经 context 传给会话流里的子代理面板，避免给 ConversationView / TurnView 加 props、破坏 memo。
// 没有 Provider 时（预览页、历史浏览）不提供操作：子代理行不显示停止按钮。
import { createContext, useContext } from 'react';

export interface DelegateActions {
  /** 停止委派任务（toolUseId = 那次 delegate 调用） */
  stop: (toolUseId: string) => void;
}

export const DelegateContext = createContext<DelegateActions | null>(null);
export const useDelegateActions = (): DelegateActions | null => useContext(DelegateContext);
