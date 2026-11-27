// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DEFAULT_SUBAGENTS, type SubagentConfig, type SubagentState } from '@cosyee/shared';
import { api } from '../core/api';
import { isSubagentState, useSubagents } from './useSubagents';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement;

const allOk: SubagentState['available'] = {
  native: { ok: true },
  claude: { ok: true },
  agy: { ok: true },
};

const mkState = (kind: SubagentConfig['kind'] = 'native', over: Partial<SubagentState> = {}): SubagentState => ({
  config: { ...DEFAULT_SUBAGENTS, kind },
  available: allOk,
  effective: kind,
  ...over,
});

const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  host.remove();
  vi.restoreAllMocks();
});

function mountHook(flash = vi.fn(), initialCwd?: string | null) {
  let current!: ReturnType<typeof useSubagents>;
  function Harness({ cwd }: { cwd?: string | null }) {
    current = useSubagents(flash, cwd);
    return null;
  }
  act(() => root!.render(<Harness cwd={initialCwd} />));
  return {
    get: () => current,
    flash,
    setCwd: (nextCwd?: string | null) => act(() => root!.render(<Harness cwd={nextCwd} />)),
  };
}

describe('isSubagentState', () => {
  it('校验合法与非预期结构', () => {
    expect(isSubagentState(mkState('claude'))).toBe(true);
    expect(isSubagentState(null)).toBe(false);
    expect(isSubagentState({})).toBe(false);
    expect(isSubagentState({ config: DEFAULT_SUBAGENTS, available: allOk, effective: 'bad' })).toBe(false);
    expect(isSubagentState({ config: { kind: 'native' }, available: allOk, effective: 'native' })).toBe(false);
  });
});

describe('useSubagents', () => {
  it('初始加载中为 null；加载失败或返回非预期结构保持 null 不崩溃', async () => {
    vi.spyOn(api, 'subagents').mockResolvedValueOnce({ unexpected: true } as unknown as SubagentState);
    const h = mountHook();
    expect(h.get().subagents).toBeNull();
    await flush();
    expect(h.get().subagents).toBeNull();

    vi.spyOn(api, 'subagents').mockRejectedValueOnce(new Error('offline'));
    act(() => h.get().refreshSubagents());
    await flush();
    expect(h.get().subagents).toBeNull();
  });

  it('快速连续点击切换（竞态）：先发请求慢、后发请求快，旧响应不覆盖新状态', async () => {
    vi.spyOn(api, 'subagents').mockResolvedValueOnce(mkState('native'));
    const slowClaude = deferred<{ ok: true; state: SubagentState }>();
    const fastAgy = deferred<{ ok: true; state: SubagentState }>();
    vi.spyOn(api, 'saveSubagents')
      .mockReturnValueOnce(slowClaude.promise)
      .mockReturnValueOnce(fastAgy.promise);

    const h = mountHook();
    await flush();
    expect(h.get().subagents?.config.kind).toBe('native');

    // 先切 claude（慢），立刻再切 agy（快）
    act(() => h.get().changeSubagents({ ...DEFAULT_SUBAGENTS, kind: 'claude' }));
    expect(h.get().subagents?.config.kind).toBe('claude');
    act(() => h.get().changeSubagents({ ...DEFAULT_SUBAGENTS, kind: 'agy' }));
    expect(h.get().subagents?.config.kind).toBe('agy');

    // 后发的 agy 先返回
    fastAgy.resolve({ ok: true, state: mkState('agy') });
    await flush();
    expect(h.get().subagents?.config.kind).toBe('agy');

    // 先发的 claude 后返回，必须被忽略
    slowClaude.resolve({ ok: true, state: mkState('claude') });
    await flush();
    expect(h.get().subagents?.config.kind).toBe('agy');
  });

  it('保存失败时提示并回滚；若回滚请求也失败（断网），退回上一次服务端确认状态', async () => {
    vi.spyOn(api, 'subagents')
      .mockResolvedValueOnce(mkState('native'))
      .mockRejectedValueOnce(new Error('network down'));
    vi.spyOn(api, 'saveSubagents').mockRejectedValueOnce(new Error('save failed'));

    const h = mountHook();
    await flush();
    act(() => h.get().changeSubagents({ ...DEFAULT_SUBAGENTS, kind: 'claude' }));
    // 乐观更新生效
    expect(h.get().subagents?.config.kind).toBe('claude');
    await flush();

    expect(h.flash).toHaveBeenCalledWith('保存子代理设置失败：save failed');
    // 虽然回滚 GET 也失败，仍应恢复到上次确认的 native
    expect(h.get().subagents?.config.kind).toBe('native');
  });

  it('先发请求失败不打扰也不回滚后续已发出的新切换请求', async () => {
    vi.spyOn(api, 'subagents').mockResolvedValueOnce(mkState('native'));
    const failFirst = deferred<{ ok: true; state: SubagentState }>();
    const okSecond = deferred<{ ok: true; state: SubagentState }>();
    vi.spyOn(api, 'saveSubagents')
      .mockReturnValueOnce(failFirst.promise)
      .mockReturnValueOnce(okSecond.promise);

    const h = mountHook();
    await flush();

    act(() => h.get().changeSubagents({ ...DEFAULT_SUBAGENTS, kind: 'claude' }));
    act(() => h.get().changeSubagents({ ...DEFAULT_SUBAGENTS, kind: 'agy' }));

    failFirst.reject(new Error('old error'));
    await flush();
    expect(h.flash).not.toHaveBeenCalled();
    expect(h.get().subagents?.config.kind).toBe('agy');

    okSecond.resolve({ ok: true, state: mkState('agy') });
    await flush();
    expect(h.get().subagents?.config.kind).toBe('agy');
  });

  it('重连刷新可从退回原生恢复到可用状态；组件卸载后异步响应不触发报错', async () => {
    const initial = mkState('agy', {
      available: { native: { ok: true }, claude: { ok: true }, agy: { ok: false, reason: '未登录' } },
      effective: 'native',
    });
    const pending = deferred<SubagentState>();
    vi.spyOn(api, 'subagents')
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(mkState('agy'))
      .mockReturnValueOnce(pending.promise);

    const h = mountHook();
    await flush();
    expect(h.get().subagents?.effective).toBe('native');

    act(() => h.get().refreshSubagents());
    await flush();
    expect(h.get().subagents?.effective).toBe('agy');

    // 触发请求后立即卸载，再 resolve 不应抛出异常
    act(() => h.get().refreshSubagents());
    act(() => root!.unmount());
    pending.resolve(mkState('claude'));
    await flush();
  });

  it('带 cwd 请求并在切换工作区时重新拉取；保存设置也带 cwd', async () => {
    const getSpy = vi.spyOn(api, 'subagents').mockResolvedValue(mkState('native'));
    const saveSpy = vi.spyOn(api, 'saveSubagents').mockResolvedValue({ ok: true, state: mkState('claude') });

    const h = mountHook(vi.fn(), 'F:\\proj-a');
    await flush();
    expect(getSpy).toHaveBeenLastCalledWith('F:\\proj-a');

    act(() => h.get().changeSubagents({ ...DEFAULT_SUBAGENTS, kind: 'claude' }));
    await flush();
    expect(saveSpy).toHaveBeenLastCalledWith({ ...DEFAULT_SUBAGENTS, kind: 'claude' }, 'F:\\proj-a');

    // 切换工作区：自动用新 cwd 重新拉取
    h.setCwd('F:\\proj-b');
    await flush();
    expect(getSpy).toHaveBeenLastCalledWith('F:\\proj-b');
  });

  it('开关代理类型：乐观更新 disabledAgents，成功后刷新；失败时提示并回滚', async () => {
    const initial = mkState('native', { disabledAgents: ['Plan'] });
    const afterOff = mkState('native', { disabledAgents: ['Plan', 'Explore'] });
    const getSpy = vi.spyOn(api, 'subagents')
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(afterOff)
      .mockRejectedValueOnce(new Error('offline'));
    const setSpy = vi.spyOn(api, 'setAgent')
      .mockResolvedValueOnce({ ok: true, disabledAgents: ['Plan', 'Explore'] })
      .mockRejectedValueOnce(new Error('denied'));

    const h = mountHook(vi.fn(), 'F:\\proj-a');
    await flush();
    expect(h.get().subagents?.disabledAgents).toEqual(['Plan']);

    // 关闭 Explore：立即乐观更新
    let p1!: Promise<boolean>;
    act(() => { p1 = h.get().toggleAgent('Explore', false); });
    expect(h.get().subagents?.disabledAgents).toEqual(['Plan', 'Explore']);
    await flush();
    expect(await p1).toBe(true);
    expect(setSpy).toHaveBeenCalledWith('Explore', false);
    expect(getSpy).toHaveBeenCalledTimes(2);
    expect(h.get().subagents?.disabledAgents).toEqual(['Plan', 'Explore']);

    // 再尝试开启 Plan 但请求失败（且回滚 GET 也失败）：应提示并回滚到上次确认态
    let p2!: Promise<boolean>;
    act(() => { p2 = h.get().toggleAgent('Plan', true); });
    expect(h.get().subagents?.disabledAgents).toEqual(['Explore']);
    await flush();
    expect(await p2).toBe(false);
    expect(h.flash).toHaveBeenCalledWith('开启智能体失败：denied');
    expect(h.get().subagents?.disabledAgents).toEqual(['Plan', 'Explore']);
  });

  it('有未完成的保存请求时，外部广播触发的 refreshSubagents 不发请求、不覆盖乐观更新、不废掉在途保存', async () => {
    const getSpy = vi.spyOn(api, 'subagents')
      .mockResolvedValueOnce(mkState('native'))
      .mockResolvedValueOnce(mkState('agy'));
    const pendingSave = deferred<{ ok: true; state: SubagentState }>();
    vi.spyOn(api, 'saveSubagents').mockReturnValueOnce(pendingSave.promise);

    const h = mountHook(vi.fn(), 'F:\\proj-a');
    await flush();
    expect(getSpy).toHaveBeenCalledTimes(1);

    // 发起保存请求（尚未返回）
    act(() => h.get().changeSubagents({ ...DEFAULT_SUBAGENTS, kind: 'claude' }));
    expect(h.get().subagents?.config.kind).toBe('claude');

    // 保存途中收到 subagents.changed 触发 refreshSubagents：应跳过
    act(() => h.get().refreshSubagents());
    await flush();
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(h.get().subagents?.config.kind).toBe('claude');

    // 在途保存返回：状态正常应用
    pendingSave.resolve({ ok: true, state: mkState('claude') });
    await flush();
    expect(h.get().subagents?.config.kind).toBe('claude');

    // 保存完成后，再次收到 subagents.changed 触发 refreshSubagents：正常拉取新状态
    act(() => h.get().refreshSubagents());
    await flush();
    expect(getSpy).toHaveBeenCalledTimes(2);
    expect(h.get().subagents?.config.kind).toBe('agy');
  });
});
