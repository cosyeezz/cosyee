// 子代理全局状态管理：读取、乐观更新、竞态保护、异常结构防御与失败回滚。
import { useCallback, useEffect, useRef, useState } from 'react';
import { SUBAGENT_KINDS, type SubagentConfig, type SubagentKind, type SubagentState } from '@cosyee/shared';
import { api } from '../core/api';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object';
const isKind = (x: unknown): x is SubagentKind => typeof x === 'string' && (SUBAGENT_KINDS as readonly string[]).includes(x);

/** 校验服务端返回的 SubagentState 结构，防止非预期响应导致渲染崩溃 */
export function isSubagentState(x: unknown): x is SubagentState {
  if (!isObj(x)) return false;
  if (!isKind(x.effective)) return false;
  if (!isObj(x.config) || !isObj(x.available)) return false;
  const c = x.config;
  if (!isKind(c.kind)) return false;
  if (!isObj(c.native) || !isObj(c.claude) || !isObj(c.agy)) return false;
  if (typeof c.native.model !== 'string' || typeof c.native.effort !== 'string') return false;
  return true;
}

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
      // 若之前因委派工具被手动停用而退回原生（后端本身可用），切换委派后端时继续保持退回态等待服务端确认
      const delegateDisabled = prev.config.kind !== 'native' && prev.effective === 'native' && !!prev.available[prev.config.kind]?.ok;
      const effective: SubagentKind =
        c.kind === 'native' || delegateDisabled || !prev.available[c.kind]?.ok ? 'native' : c.kind;
      return { ...prev, config: c, effective };
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
