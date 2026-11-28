// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  AccountList,
  AgyAccountList,
  CodexAccountList,
  LedgerWindowDetail,
  LedgerWindowList,
  LedgerWindowSummary,
} from '@cosyee/shared';
import { api } from '../../core/api';
import { AccountManager } from '../sidebar/AccountManager';
import {
  availableKinds,
  estimateHint,
  formatLedgerTokens,
  formatPercentRange,
  formatWindowRange,
  LAYER_LABEL,
  nextTokenUnit,
  TOKEN_UNIT_STORAGE_KEY,
} from './format';
import { LedgerPanel } from './LedgerPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
function mount(el: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(el));
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  localStorage.removeItem(TOKEN_UNIT_STORAGE_KEY);
  vi.restoreAllMocks();
});

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

const NOW = new Date(2026, 10, 27, 15, 0, 0).getTime();
const H = 3_600_000;

function makeWindow(over: Partial<LedgerWindowSummary> = {}): LedgerWindowSummary {
  return {
    id: 'claude|default|session||1',
    backend: 'claude',
    account: 'default',
    accountName: 'cosyeey',
    accountKind: 'subscription',
    kind: 'session',
    group: null,
    start: NOW - 3 * H,
    end: NOW + 2 * H,
    current: true,
    startPercent: 10,
    endPercent: 60,
    firstSnapshotAt: NOW - 2.5 * H,
    lastSnapshotAt: NOW - 0.5 * H,
    requests: 20,
    tokens: { input: 12_000, create5m: 40_000, create1h: 0, read: 500_000, output: 18_000, reasoning: 0 },
    costUsd: 4.5,
    unpricedRequests: 0,
    estimate: { usdPer100: 9.0, basisPercent: 50, basisCost: 4.5, reliable: true },
    external: false,
    ...over,
  };
}

describe('ledger/format', () => {
  it('按标准顺序返回实际存在的窗口种类', () => {
    expect(availableKinds([makeWindow({ kind: 'monthly' })])).toEqual(['monthly']);
    expect(
      availableKinds([
        makeWindow({ kind: 'scoped' }),
        makeWindow({ kind: 'session' }),
        makeWindow({ kind: 'weekly' }),
      ]),
    ).toEqual(['session', 'weekly', 'scoped']);
  });

  it('格式化时间范围与百分比区间', () => {
    expect(formatWindowRange(NOW - 3 * H, NOW + 2 * H, 'session', NOW)).toContain('今天');
    expect(formatPercentRange(12.2, 68.7)).toBe('12% → 69%');
    expect(formatPercentRange(null, null)).toBe('—');
  });

  it('推算提示覆盖 null 与不可靠场景', () => {
    expect(estimateHint(makeWindow({ estimate: { usdPer100: null, basisPercent: 2, basisCost: 0.2, reliable: true } }))).toContain('不足 5%');
    expect(estimateHint(makeWindow({ estimate: { usdPer100: 8, basisPercent: 40, basisCost: 3.2, reliable: false } }))).toContain('外部用量');
  });

  it('层级标签为中文', () => {
    expect(LAYER_LABEL).toEqual({
      main: '主代理',
      native: '原生子代理',
      delegate: '委派',
      internal: '内部调用',
    });
  });

  it('token 单位四种模式格式化与循环顺序正确', () => {
    expect(nextTokenUnit('auto')).toBe('M');
    expect(nextTokenUnit('M')).toBe('B');
    expect(nextTokenUnit('B')).toBe('full');
    expect(nextTokenUnit('full')).toBe('auto');

    // auto：小于 1K 原样，其余 K / M / B 大写
    expect(formatLedgerTokens(820, 'auto')).toBe('820');
    expect(formatLedgerTokens(36_200, 'auto')).toBe('36.2K');
    expect(formatLedgerTokens(1_900_000, 'auto')).toBe('1.9M');
    expect(formatLedgerTokens(1_240_000_000, 'auto')).toBe('1.24B');

    // M：统一以兆为单位
    expect(formatLedgerTokens(36_200, 'M')).toBe('0.04M');
    expect(formatLedgerTokens(1_900_000, 'M')).toBe('1.90M');
    expect(formatLedgerTokens(800, 'M')).toBe('0.0008M');

    // B：统一以十亿为单位
    expect(formatLedgerTokens(1_900_000, 'B')).toBe('0.0019B');
    expect(formatLedgerTokens(1_240_000_000, 'B')).toBe('1.24B');

    // full：完整千分位整数
    expect(formatLedgerTokens(1_903_442, 'full')).toBe('1,903,442');
  });
});

describe('LedgerPanel', () => {
  it('展示空状态说明与停用状态提示', async () => {
    vi.spyOn(api, 'ledgerWindows').mockResolvedValue({ enabled: true, windows: [] });
    mount(<LedgerPanel target={{ backend: 'claude', account: 'default', accountName: 'cosyeey' }} onClose={() => {}} now={NOW} />);
    await flush();
    expect(document.body.textContent).toContain('从现在开始记录 Cosyee 发出的请求，不含历史');

    act(() => root?.unmount());
    vi.spyOn(api, 'ledgerWindows').mockResolvedValue({ enabled: false, windows: [] });
    mount(<LedgerPanel target={{ backend: 'claude', account: 'default', accountName: 'cosyeey' }} onClose={() => {}} now={NOW} />);
    await flush();
    expect(document.body.textContent).toContain('账本统计已停用');
  });

  it('只显示有数据的分段（Kiro 仅每月），展开行加载曲线与明细表', async () => {
    const win = makeWindow({
      id: 'claude|k1|monthly||1',
      account: 'k1',
      accountName: 'Kiro 个人',
      accountKind: 'kiro',
      kind: 'monthly',
      used: 180,
      limit: 500,
      external: true,
      estimate: { usdPer100: 42, basisPercent: 30, basisCost: 12.6, reliable: false },
    });
    const detail: LedgerWindowDetail = {
      ...win,
      snapshots: [
        { at: win.start + H, percent: 10, source: 'probe' },
        { at: NOW - 10 * 60_000, percent: 40, source: 'event' },
      ],
      rows: [
        {
          model: 'claude-sonnet-4-6',
          layer: 'delegate',
          agent: 'coder',
          requests: 10,
          tokens: { input: 20_000, create5m: 50_000, create1h: 0, read: 400_000, output: 15_000, reasoning: 5_000 },
          costUsd: 3.2,
          unpricedRequests: 1,
          estimated: true,
        },
      ],
    };
    const listSpy = vi.spyOn(api, 'ledgerWindows').mockResolvedValue({ enabled: true, windows: [win] } satisfies LedgerWindowList);
    const detailSpy = vi.spyOn(api, 'ledgerWindowDetail').mockResolvedValue(detail);

    mount(<LedgerPanel target={{ backend: 'claude', account: 'k1', accountName: 'Kiro 个人', brand: 'kiro' }} onClose={() => {}} now={NOW} />);
    await flush();

    expect(listSpy).toHaveBeenCalledWith({ backend: 'claude', account: 'k1' });
    const tabs = [...document.querySelectorAll('[role="tab"]')].map((el) => el.textContent);
    expect(tabs).toEqual(['每月']);
    expect(document.body.textContent).toContain('外部用量');
    expect(document.body.textContent).toContain('180 / 500 credits');

    const rowBtn = document.querySelector('.cz-ledger-row__head')!;
    click(rowBtn);
    await flush();

    expect(detailSpy).toHaveBeenCalledWith('claude|k1|monthly||1');
    expect(document.querySelector('.cz-ledger-chart__svg')).not.toBeNull();
    expect(document.body.textContent).toContain('Sonnet 4.6');
    expect(document.body.textContent).toContain('委派');
    expect(document.body.textContent).toContain('估算');
    expect(document.body.textContent).toContain('无价格');
    expect(document.body.textContent).toContain('含推理 5K');

    // 悬停 tooltip 始终展示完整千分位 token 数；点击任意 token 单元格与单位按钮可在 4 种模式间循环并写入 localStorage
    const tokBtn = document.querySelector('.cz-ledger-tok-btn') as HTMLButtonElement;
    expect(tokBtn.title).toContain('20,000');
    click(tokBtn);
    expect(localStorage.getItem(TOKEN_UNIT_STORAGE_KEY)).toBe('M');
    expect(document.body.textContent).toContain('0.40M');

    const unitBtn = document.querySelector('.cz-ledger-unit-btn') as HTMLButtonElement;
    click(unitBtn);
    expect(localStorage.getItem(TOKEN_UNIT_STORAGE_KEY)).toBe('B');
    expect(document.body.textContent).toContain('0.0004B');

    click(unitBtn);
    expect(localStorage.getItem(TOKEN_UNIT_STORAGE_KEY)).toBe('full');
    expect(document.body.textContent).toContain('400,000');

    // 点击表头也能循环回到 auto
    const tokTh = document.querySelector('.cz-ledger-tok-th') as HTMLButtonElement;
    click(tokTh);
    expect(localStorage.getItem(TOKEN_UNIT_STORAGE_KEY)).toBe('auto');
    expect(document.body.textContent).toContain('400K');
  });

  it('AccountManager 的各类账号卡片均提供用量统计入口并按账号过滤', async () => {
    const listSpy = vi.spyOn(api, 'ledgerWindows').mockResolvedValue({ enabled: true, windows: [] });
    vi.spyOn(api, 'components').mockResolvedValue({ list: [] });

    const data: AccountList = {
      mode: 'parallel',
      login: null,
      list: [
        { id: 'c1', label: '', name: 'ClaudeUser', plan: 'Pro', loggedIn: true, active: true, isDefault: true },
        { id: 'k1', label: 'KiroUser', name: 'KiroUser', plan: null, loggedIn: true, active: false, isDefault: false, kiro: { method: 'builderId', proxy: 'ready', error: null, credential: 'ok' } },
      ],
    };
    const agyData: AgyAccountList = {
      installed: true,
      login: null,
      list: [{ id: 'g1', label: 'AgyUser', email: 'a@b.com', quota: null, plan: 'Pro', loggedIn: true, active: true, isDefault: false, running: 0 }],
    };
    const codexData: CodexAccountList = {
      installed: true,
      login: null,
      list: [{ id: 'x1', label: 'CodexUser', email: 'c@d.com', plan: 'plus', planType: 'plus', authMode: 'chatgpt', loggedIn: true, active: true, isDefault: false, running: 0, quota: null }],
    };

    mount(
      <AccountManager
        data={data}
        agyData={agyData}
        codexData={codexData}
        error={null}
        quotas={{ c1: { status: 'none' } }}
        kiroBalances={{ k1: { status: 'fail' } }}
        now={NOW}
        version={1}
        switching={null}
        agySwitching={null}
        codexSwitching={null}
        covered={false}
        onClose={() => {}}
        onAdd={() => {}}
        onSwitch={() => {}}
        onRelogin={() => {}}
        onEditApi={() => {}}
        onRename={async () => true}
        onRemove={() => {}}
        onDedupe={async () => ({ removed: 0, skipped: 0 })}
        onSwitchAgy={() => {}}
        onReloginAgy={() => {}}
        onRenameAgy={async () => true}
        onRemoveAgy={() => {}}
        onDedupeAgy={async () => ({ removed: 0, skipped: 0 })}
        onSwitchCodex={() => {}}
        onReloginCodex={() => {}}
        onRenameCodex={async () => true}
        onRemoveCodex={() => {}}
        onDedupeCodex={async () => ({ removed: 0, skipped: 0 })}
      />,
    );
    await flush();

    expect(document.querySelector('[aria-label="查看「ClaudeUser」用量统计"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="查看「KiroUser」用量统计"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="查看「AgyUser」用量统计"]')).not.toBeNull();
    const codexBtn = document.querySelector('[aria-label="查看「CodexUser」用量统计"]')!;
    expect(codexBtn).not.toBeNull();

    click(codexBtn);
    await flush();

    expect(listSpy).toHaveBeenCalledWith({ backend: 'codex', account: 'x1' });
    expect(document.querySelector('.cz-ledger')).not.toBeNull();
  });
});
