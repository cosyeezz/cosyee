// 当前打开的会话：订阅 WS、加载历史、把实时事件交给 reducer。
// 时序：先挂监听再 subscribe（后端先发 status，若本轮未结束再发 replay），同时拉历史；
// 历史回来之前收到的 event / replay / status 先排队，历史载入后按顺序应用，避免与历史重复或丢失。
import { startTransition, useCallback, useEffect, useRef, useState } from 'react';
import type { AppliedSettings, ContextUsage, QueueItem, RunStatus, ServerMsg } from '@cosyee/shared';
import { api, socket } from '../core/api';
import { dropHistory, getHistory, putHistory } from '../core/historyCache';
import { applyEvent, applyReplay, applyStatus, batch, fromHistory, initState, type ConvState } from '../core/reducer';

export interface SessionView {
  id: string;
  conv: ConvState;
  status: RunStatus | null;
  error?: string;
  applied: AppliedSettings | null;
  context: ContextUsage | null;
  /** 已向后端查过上下文缓存（无论有无）；之后仍为空才需要主动采集 */
  contextChecked: boolean;
  /** 已发给 CLI、还没开始执行的消息（后端推送的全量快照，按发送顺序） */
  queue: QueueItem[];
  /** 历史加载中 */
  loading: boolean;
  loadError?: string;
}

type SessionMsg = Extract<ServerMsg, { sessionId: string }>;

/**
 * @param fresh 本页新建、还没有磁盘记录的会话：不拉历史，直接从空状态开始
 */
export function useSessionStream(sessionId: string | null, cwd: string | null, fresh: boolean) {
  const [view, setView] = useState<SessionView | null>(null);
  const curRef = useRef<SessionView | null>(null);

  useEffect(() => {
    if (!sessionId || !cwd) {
      curRef.current = null;
      setView(null);
      return;
    }
    let alive = true;
    let loaded = fresh;
    let pending: SessionMsg[] = [];
    const cur: SessionView = {
      id: sessionId, conv: initState(), status: null, applied: null, context: null, contextChecked: fresh, queue: [], loading: !fresh,
    };
    curRef.current = cur;
    const commit = () => { if (alive) setView({ ...cur }); };

    const apply = (m: SessionMsg) => {
      const now = Date.now();
      switch (m.t) {
        case 'event': cur.conv = applyEvent(cur.conv, m.e, now); break;
        case 'replay': cur.conv = applyReplay(cur.conv, m.events); cur.status = m.status; break;
        case 'status':
          cur.status = m.status;
          cur.error = m.error;
          cur.conv = applyStatus(cur.conv, m.status, m.error, now);
          break;
        case 'settings': cur.applied = m.applied; break;
        case 'context': cur.context = m.usage; break;
        case 'queue': cur.queue = m.items; break;
      }
    };

    const off = socket.on((m) => {
      if (!('sessionId' in m) || m.sessionId !== sessionId) return;
      if (!loaded && (m.t === 'event' || m.t === 'replay' || m.t === 'status')) {
        pending.push(m);
        // 历史需要知道会话是否仍在跑
        if (m.t === 'status') cur.status = m.status;
        if (m.t === 'replay') cur.status = m.status;
        return;
      }
      apply(m);
      commit();
    });
    socket.send({ t: 'subscribe', sessionId });
    commit();

    if (!fresh) {
      const isRunning = () => cur.status === 'running' || cur.status === 'starting';
      const hit = getHistory(cwd, sessionId);
      api.history(sessionId, cwd, hit?.version)
        .then(async (r) => {
          if (!alive) return;
          // 没变且进程不在跑：直接复用上次构建好的状态
          if (r.unchanged && hit && !isRunning()) {
            cur.conv = hit.conv;
            return;
          }
          // 没变但进程在跑（缓存是按「已结束」构建的，最后一轮要保持未结束）：重新拉完整历史
          if (!r.entries) r = await api.history(sessionId, cwd);
          if (!alive) return;
          const running = isRunning();
          cur.conv = fromHistory(r.entries ?? [], { running });
          if (r.version && !running) putHistory(cwd, sessionId, r.version, cur.conv);
          else dropHistory(cwd, sessionId);
        })
        .catch((err: unknown) => { cur.loadError = err instanceof Error ? err.message : String(err); })
        .finally(() => {
          if (!alive) return;
          loaded = true;
          cur.loading = false;
          // 加载期间排队的事件一次性应用（共享草稿，避免逐个克隆）
          const queued = pending;
          pending = [];
          batch(() => { for (const m of queued) apply(m); });
          // 整段历史挂载很重（Markdown 解析）：用 transition 分片渲染，期间旧对话的淡出、胶囊流动不掉帧。
          // 每次 commit 都是完整快照，之后到达的实时事件即使抢先提交也不会丢数据
          startTransition(commit);
        });
      api.context(sessionId)
        .then((u) => { if (alive && u && !cur.context) cur.context = u; })
        .catch(() => { /* 没有缓存就算了 */ })
        .finally(() => { if (alive) { cur.contextChecked = true; commit(); } });
    }

    return () => {
      alive = false;
      off();
      socket.send({ t: 'unsubscribe', sessionId });
    };
  }, [sessionId, cwd, fresh]);

  /** 外部补丁（例如手动刷新上下文后写回） */
  const patch = useCallback((fn: (v: SessionView) => void) => {
    const cur = curRef.current;
    if (!cur) return;
    fn(cur);
    setView({ ...cur });
  }, []);

  return { view, patch };
}
