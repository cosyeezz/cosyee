// 点击会话时先把高亮挪过去（只重渲染这一列，胶囊立刻开始流动），
// 再用 transition 让主区去换对话：重的那次提交不会挡住点击反馈。
// 主区真的换过去（currentId 变了）或 1.5 秒后，回到以 currentId 为准。
import { startTransition, useEffect, useState } from 'react';

export function usePendingSelect(currentId: string | null, onSelect: (id: string) => void) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [seenId, setSeenId] = useState(currentId);
  if (seenId !== currentId) {
    setSeenId(currentId);
    setPendingId(null);
  }
  useEffect(() => {
    if (pendingId === null) return;
    const t = setTimeout(() => setPendingId(null), 1500);
    return () => clearTimeout(t);
  }, [pendingId]);
  const select = (id: string) => {
    if (id === currentId) {
      onSelect(id);
      return;
    }
    setPendingId(id);
    startTransition(() => onSelect(id));
  };
  return { activeId: pendingId ?? currentId, select };
}
