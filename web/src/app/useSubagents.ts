// 子代理全局状态管理：读取、乐观更新、竞态保护、异常结构防御与失败回滚。
import { useCallback, useEffect, useRef, useState } from 'react';
import { SUBAGENT_MODES, type SubagentConfig, type SubagentMode, type SubagentRoute, type SubagentState } from '@cosyee/shared';
import { api } from '../core/api';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object';
const isMode = (x: unknown): x is SubagentMode => typeof x === 'string' && (SUBAGENT_MODES as readonly string[]).includes(x);
const isRoute = (x: unknown): x is SubagentRoute =>
  isObj(x)
  && typeof x.backend === 'string'
  && typeof x.accountId === 'string'
  && (x.model === null || typeof x.model === 'string')
  && (x.effort === null || typeof x.effort === 'string');

/** 校验服务端返回的 SubagentState 结构，防止非预期响应导致渲染崩溃 */
export function isSubagentState(x: unknown): x is SubagentState {
  if (!isObj(x)) return false;
  if (!isMode(x.effective)) return false;
  if (!isObj(x.config) || !Array.isArray(x.accounts) || !isObj(x.routeFallbacks)) return false;
  const c = x.config;
  if (!isMode(c.mode)) return false;
  if (!isObj(c.native) || !isObj(c.delegate)) return false;
  if (typeof c.native.model !== 'string' || typeof c.native.effort !== 'string') return false;
  if (c.delegate.default !== null && !isRoute(c.delegate.default)) return false;
  return true;
}

const hasAccount = (state: SubagentState, route: SubagentRoute | null | undefined): boolean =>
  !!route && state.accounts.some((a) => a.backend === route.backend && a.id === route.accountId);

export function useSubagents(flash: (msg: string) => void, cwd?: string | null) {
  const [subagents, setSubagents] = useState<SubagentState | null>(null);
  const seqRef = useRef(0);
  /** 本窗口正在进行的保存 / 开关请求数：进行中时忽略外部广播触发的刷新，避免旧值盖掉乐观更新或废掉在途保存 */
  const pendingSavesRef = useRef(0);
  const confirmedRef = useRef<SubagentState | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const fetchSubagents = useCallback(() => {
    const seq = ++seqRef.current;
    api.subagents(cwd)
      .then((s) => {
        if (!aliveRef.current || seq !== seqRef.current) return;
        if (isSubagentState(s)) {
          confirmedRef.current = s;
          setSubagents(s);
        }
      })
      .catch(() => {});
  }, [cwd]);

  const refreshSubagents = useCallback(() => {
    if (pendingSavesRef.current > 0) return;
    fetchSubagents();
  }, [fetchSubagents]);

  useEffect(() => {
    fetchSubagents();
  }, [fetchSubagents]);

  const rollback = useCallback((seq: number) => {
    api.subagents(cwd)
      .then((s) => {
        if (!aliveRef.current || seq !== seqRef.current) return;
        if (isSubagentState(s)) {
          confirmedRef.current = s;
          setSubagents(s);
        } else if (confirmedRef.current) {
          setSubagents(confirmedRef.current);
        }
      })
      .catch(() => {
        if (!aliveRef.current || seq !== seqRef.current) return;
        if (confirmedRef.current) setSubagents(confirmedRef.current);
      });
  }, [cwd]);

  const changeSubagents = useCallback((c: SubagentConfig) => {
    const seq = ++seqRef.current;
    pendingSavesRef.current += 1;
    setSubagents((prev) => {
      if (!prev) return prev;
      // 若之前默认路线本身可用但仍退回原生（例如委派工具被停用），保持退回态等待服务端确认
      const toolDisabled =
        prev.config.mode === 'delegate'
        && prev.effective === 'native'
        && hasAccount(prev, prev.config.delegate.default);
      const defaultOk = hasAccount(prev, c.delegate.default);
      const effective: SubagentMode = c.mode === 'native' || toolDisabled || !defaultOk ? 'native' : 'delegate';
      const nextFallbacks: Record<string, string> = {};
      for (const [name, reason] of Object.entries(prev.routeFallbacks)) {
        const nextRoute = c.delegate.agents?.[name];
        if (nextRoute && !hasAccount(prev, nextRoute)) nextFallbacks[name] = reason;
      }
      return {
        ...prev,
        config: c,
        effective,
        routeFallbacks: nextFallbacks,
        fallbackReason: effective === c.mode ? undefined : prev.fallbackReason,
      };
    });
    api.saveSubagents(c, cwd)
      .then((r) => {
        pendingSavesRef.current = Math.max(0, pendingSavesRef.current - 1);
        if (!aliveRef.current || seq !== seqRef.current) return;
        if (isSubagentState(r?.state)) {
          confirmedRef.current = r.state;
          setSubagents(r.state);
        } else {
          fetchSubagents();
        }
      })
      .catch((e) => {
        pendingSavesRef.current = Math.max(0, pendingSavesRef.current - 1);
        if (!aliveRef.current || seq !== seqRef.current) return;
        flash(`保存子代理设置失败：${errText(e)}`);
        rollback(seq);
      });
  }, [cwd, flash, fetchSubagents, rollback]);

  const toggleAgent = useCallback((name: string, enabled: boolean): Promise<boolean> => {
    const seq = ++seqRef.current;
    pendingSavesRef.current += 1;
    setSubagents((prev) => {
      if (!prev || !prev.disabledAgents) return prev;
      const rest = prev.disabledAgents.filter((n) => n !== name);
      return { ...prev, disabledAgents: enabled ? rest : [...rest, name] };
    });
    return api.setAgent(name, enabled)
      .then((r) => {
        pendingSavesRef.current = Math.max(0, pendingSavesRef.current - 1);
        if (!aliveRef.current || seq !== seqRef.current) return true;
        if (Array.isArray(r?.disabledAgents)) {
          setSubagents((prev) => {
            if (!prev) return prev;
            const next = { ...prev, disabledAgents: r.disabledAgents };
            if (confirmedRef.current) confirmedRef.current = { ...confirmedRef.current, disabledAgents: r.disabledAgents };
            return next;
          });
        }
        fetchSubagents();
        return true;
      })
      .catch((e) => {
        pendingSavesRef.current = Math.max(0, pendingSavesRef.current - 1);
        if (!aliveRef.current || seq !== seqRef.current) return false;
        flash(`${enabled ? '开启' : '关闭'}智能体失败：${errText(e)}`);
        rollback(seq);
        return false;
      });
  }, [flash, fetchSubagents, rollback]);

  return { subagents, changeSubagents, refreshSubagents, toggleAgent };
}
