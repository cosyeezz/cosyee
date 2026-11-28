// 订阅用量统计调试页：http://127.0.0.1:5173/?dev=ledger
// 支持参数：
//   scene=claude|agy|codex|kiro|empty|disabled|error|manager
//   theme=dark|light
//   expand=1（自动展开首个窗口）
import { useEffect, useState } from 'react';
import type {
  AccountList,
  AgyAccountList,
  CodexAccountList,
  LedgerBackend,
  LedgerWindowDetail,
  LedgerWindowList,
} from '@cosyee/shared';
import '../styles/tokens.css';
import '../styles/motion.css';
import '../ui/sidebar/Sidebar.css';
import { api } from '../core/api';
import { TOKEN_UNIT_ORDER, TOKEN_UNIT_STORAGE_KEY } from '../ui/ledger/format';
import { LedgerPanel, type LedgerTarget } from '../ui/ledger/LedgerPanel';
import { AccountManager } from '../ui/sidebar/AccountManager';

const H = 3_600_000;
const D = 24 * H;
// 固定基准时间，保证截图与交互稳定可复现
const NOW = new Date(2026, 10, 27, 15, 20, 0).getTime();

type SceneId = 'claude' | 'agy' | 'codex' | 'kiro' | 'empty' | 'disabled' | 'error' | 'manager';

const SCENES: { id: SceneId; label: string }[] = [
  { id: 'claude', label: 'Claude 订阅' },
  { id: 'agy', label: 'Antigravity' },
  { id: 'codex', label: 'Codex' },
  { id: 'kiro', label: 'Kiro 月度' },
  { id: 'empty', label: '空状态' },
  { id: 'disabled', label: '账本停用' },
  { id: 'error', label: '加载失败' },
  { id: 'manager', label: '账号管理入口' },
];

const DETAILS: Record<string, LedgerWindowDetail> = {
  // Claude 5h 当前窗口（进行中，完整四层级 + 推理 + 无价格示例）
  'claude|default|session||cur': {
    id: 'claude|default|session||cur',
    backend: 'claude',
    account: 'default',
    accountName: 'cosyeey',
    accountKind: 'subscription',
    kind: 'session',
    group: null,
    start: NOW - 3.2 * H,
    end: NOW + 1.8 * H,
    current: true,
    startPercent: 14,
    endPercent: 68,
    firstSnapshotAt: NOW - 3.0 * H,
    lastSnapshotAt: NOW - 8 * 60_000,
    requests: 47,
    tokens: { input: 68_400, create5m: 312_000, create1h: 48_000, read: 2_840_000, output: 94_200, reasoning: 0 },
    costUsd: 7.98,
    unpricedRequests: 1,
    estimate: { usdPer100: 14.78, basisPercent: 54, basisCost: 7.98, reliable: true },
    external: false,
    snapshots: [
      { at: NOW - 3.0 * H, percent: 14, source: 'probe' },
      { at: NOW - 2.4 * H, percent: 22, source: 'event' },
      { at: NOW - 1.9 * H, percent: 35, source: 'event' },
      { at: NOW - 1.3 * H, percent: 44, source: 'probe' },
      { at: NOW - 0.7 * H, percent: 59, source: 'event' },
      { at: NOW - 8 * 60_000, percent: 68, source: 'event' },
    ],
    rows: [
      {
        model: 'claude-opus-4-6',
        layer: 'main',
        agent: null,
        requests: 24,
        tokens: { input: 36_200, create5m: 190_000, create1h: 48_000, read: 1_920_000, output: 54_800, reasoning: 0 },
        costUsd: 5.42,
        unpricedRequests: 0,
        estimated: false,
      },
      {
        model: 'claude-sonnet-4-6',
        layer: 'native',
        agent: 'Explore',
        requests: 12,
        tokens: { input: 18_400, create5m: 82_000, create1h: 0, read: 620_000, output: 24_100, reasoning: 0 },
        costUsd: 1.64,
        unpricedRequests: 0,
        estimated: false,
      },
      {
        model: 'claude-sonnet-4-6',
        layer: 'delegate',
        agent: 'code-reviewer',
        requests: 6,
        tokens: { input: 9_800, create5m: 34_000, create1h: 0, read: 260_000, output: 11_900, reasoning: 0 },
        costUsd: 0.76,
        unpricedRequests: 0,
        estimated: false,
      },
      {
        model: 'claude-haiku-4-5-20251001',
        layer: 'internal',
        agent: null,
        requests: 4,
        tokens: { input: 3_200, create5m: 6_000, create1h: 0, read: 40_000, output: 2_600, reasoning: 0 },
        costUsd: 0.16,
        unpricedRequests: 0,
        estimated: false,
      },
      {
        model: 'claude-experimental-preview',
        layer: 'delegate',
        agent: 'sandbox',
        requests: 1,
        tokens: { input: 800, create5m: 0, create1h: 0, read: 0, output: 800, reasoning: 0 },
        costUsd: 0,
        unpricedRequests: 1,
        estimated: false,
      },
    ],
  },

  // Claude 5h 历史窗口：外部用量 + reliable=false
  'claude|default|session||ext': {
    id: 'claude|default|session||ext',
    backend: 'claude',
    account: 'default',
    accountName: 'cosyeey',
    accountKind: 'subscription',
    kind: 'session',
    group: null,
    start: NOW - 11 * H,
    end: NOW - 6 * H,
    current: false,
    startPercent: 5,
    endPercent: 86,
    firstSnapshotAt: NOW - 10.6 * H,
    lastSnapshotAt: NOW - 6.2 * H,
    requests: 29,
    tokens: { input: 41_000, create5m: 150_000, create1h: 0, read: 1_210_000, output: 48_500, reasoning: 0 },
    costUsd: 4.35,
    unpricedRequests: 0,
    estimate: { usdPer100: 5.37, basisPercent: 81, basisCost: 4.35, reliable: false },
    external: true,
    snapshots: [
      { at: NOW - 10.6 * H, percent: 5, source: 'probe' },
      { at: NOW - 9.4 * H, percent: 18, source: 'event' },
      { at: NOW - 8.1 * H, percent: 62, source: 'probe' },
      { at: NOW - 6.2 * H, percent: 86, source: 'event' },
    ],
    rows: [
      {
        model: 'claude-sonnet-4-6',
        layer: 'main',
        agent: null,
        requests: 25,
        tokens: { input: 36_000, create5m: 138_000, create1h: 0, read: 1_120_000, output: 43_000, reasoning: 0 },
        costUsd: 3.92,
        unpricedRequests: 0,
        estimated: false,
      },
      {
        model: 'claude-haiku-4-5-20251001',
        layer: 'internal',
        agent: null,
        requests: 4,
        tokens: { input: 5_000, create5m: 12_000, create1h: 0, read: 90_000, output: 5_500, reasoning: 0 },
        costUsd: 0.43,
        unpricedRequests: 0,
        estimated: false,
      },
    ],
  },

  // Claude 5h 历史窗口：增量不足 5%，usdPer100 = null
  'claude|default|session||small': {
    id: 'claude|default|session||small',
    backend: 'claude',
    account: 'default',
    accountName: 'cosyeey',
    accountKind: 'subscription',
    kind: 'session',
    group: null,
    start: NOW - 24 * H,
    end: NOW - 19 * H,
    current: false,
    startPercent: 2,
    endPercent: 5,
    firstSnapshotAt: NOW - 23.2 * H,
    lastSnapshotAt: NOW - 20.1 * H,
    requests: 6,
    tokens: { input: 8_200, create5m: 22_000, create1h: 0, read: 110_000, output: 7_400, reasoning: 0 },
    costUsd: 0.48,
    unpricedRequests: 0,
    estimate: { usdPer100: null, basisPercent: 3, basisCost: 0.48, reliable: true },
    external: false,
    snapshots: [
      { at: NOW - 23.2 * H, percent: 2, source: 'probe' },
      { at: NOW - 20.1 * H, percent: 5, source: 'event' },
    ],
    rows: [
      {
        model: 'claude-sonnet-4-6',
        layer: 'main',
        agent: null,
        requests: 6,
        tokens: { input: 8_200, create5m: 22_000, create1h: 0, read: 110_000, output: 7_400, reasoning: 0 },
        costUsd: 0.48,
        unpricedRequests: 0,
        estimated: false,
      },
    ],
  },

  // Claude 每周当前窗口
  'claude|default|weekly||cur': {
    id: 'claude|default|weekly||cur',
    backend: 'claude',
    account: 'default',
    accountName: 'cosyeey',
    accountKind: 'subscription',
    kind: 'weekly',
    group: null,
    start: NOW - 4 * D,
    end: NOW + 3 * D,
    current: true,
    startPercent: 0,
    endPercent: 41,
    firstSnapshotAt: NOW - 3.9 * D,
    lastSnapshotAt: NOW - 8 * 60_000,
    requests: 214,
    tokens: { input: 320_000, create5m: 1_240_000, create1h: 180_000, read: 14_600_000, output: 410_000, reasoning: 0 },
    costUsd: 38.6,
    unpricedRequests: 0,
    estimate: { usdPer100: 94.15, basisPercent: 41, basisCost: 38.6, reliable: true },
    external: false,
    snapshots: [
      { at: NOW - 3.9 * D, percent: 0, source: 'probe' },
      { at: NOW - 3.0 * D, percent: 11, source: 'event' },
      { at: NOW - 2.0 * D, percent: 23, source: 'event' },
      { at: NOW - 1.0 * D, percent: 32, source: 'probe' },
      { at: NOW - 8 * 60_000, percent: 41, source: 'event' },
    ],
    rows: [
      {
        model: 'claude-opus-4-6',
        layer: 'main',
        agent: null,
        requests: 120,
        tokens: { input: 190_000, create5m: 780_000, create1h: 180_000, read: 10_200_000, output: 245_000, reasoning: 0 },
        costUsd: 27.4,
        unpricedRequests: 0,
        estimated: false,
      },
      {
        model: 'claude-sonnet-4-6',
        layer: 'native',
        agent: 'general-purpose',
        requests: 94,
        tokens: { input: 130_000, create5m: 460_000, create1h: 0, read: 4_400_000, output: 165_000, reasoning: 0 },
        costUsd: 11.2,
        unpricedRequests: 0,
        estimated: false,
      },
    ],
  },

  // Claude 按模型周额度（Opus）
  'claude|default|scoped|Opus|cur': {
    id: 'claude|default|scoped|Opus|cur',
    backend: 'claude',
    account: 'default',
    accountName: 'cosyeey',
    accountKind: 'subscription',
    kind: 'scoped',
    group: 'Opus',
    start: NOW - 4 * D,
    end: NOW + 3 * D,
    current: true,
    startPercent: 0,
    endPercent: 28,
    firstSnapshotAt: NOW - 3.8 * D,
    lastSnapshotAt: NOW - 12 * 60_000,
    requests: 120,
    tokens: { input: 190_000, create5m: 780_000, create1h: 180_000, read: 10_200_000, output: 245_000, reasoning: 0 },
    costUsd: 27.4,
    unpricedRequests: 0,
    estimate: { usdPer100: 97.86, basisPercent: 28, basisCost: 27.4, reliable: true },
    external: false,
    snapshots: [
      { at: NOW - 3.8 * D, percent: 0, source: 'probe' },
      { at: NOW - 2.1 * D, percent: 15, source: 'event' },
      { at: NOW - 12 * 60_000, percent: 28, source: 'event' },
    ],
    rows: [
      {
        model: 'claude-opus-4-6',
        layer: 'main',
        agent: null,
        requests: 120,
        tokens: { input: 190_000, create5m: 780_000, create1h: 180_000, read: 10_200_000, output: 245_000, reasoning: 0 },
        costUsd: 27.4,
        unpricedRequests: 0,
        estimated: false,
      },
    ],
  },

  // Antigravity：按模型组 + estimated 行 + reasoning
  'agy|agy-main|session|Gemini|cur': {
    id: 'agy|agy-main|session|Gemini|cur',
    backend: 'agy',
    account: 'agy-main',
    accountName: 'alex.chen@example.com',
    accountKind: 'subscription',
    kind: 'session',
    group: 'Gemini',
    start: NOW - 2.5 * H,
    end: NOW + 2.5 * H,
    current: true,
    startPercent: 10,
    endPercent: 52,
    firstSnapshotAt: NOW - 2.2 * H,
    lastSnapshotAt: NOW - 10 * 60_000,
    requests: 18,
    tokens: { input: 145_000, create5m: 0, create1h: 0, read: 980_000, output: 64_200, reasoning: 28_400 },
    costUsd: 2.34,
    unpricedRequests: 0,
    estimate: { usdPer100: 5.57, basisPercent: 42, basisCost: 2.34, reliable: true },
    external: false,
    snapshots: [
      { at: NOW - 2.2 * H, percent: 10, source: 'probe' },
      { at: NOW - 1.4 * H, percent: 31, source: 'event' },
      { at: NOW - 10 * 60_000, percent: 52, source: 'event' },
    ],
    rows: [
      {
        model: 'gemini-3-pro',
        layer: 'delegate',
        agent: 'research',
        requests: 14,
        tokens: { input: 112_000, create5m: 0, create1h: 0, read: 820_000, output: 51_000, reasoning: 24_200 },
        costUsd: 1.92,
        unpricedRequests: 0,
        estimated: true,
      },
      {
        model: 'gemini-3-flash',
        layer: 'delegate',
        agent: 'Explore',
        requests: 4,
        tokens: { input: 33_000, create5m: 0, create1h: 0, read: 160_000, output: 13_200, reasoning: 4_200 },
        costUsd: 0.42,
        unpricedRequests: 0,
        estimated: false,
      },
    ],
  },
  'agy|agy-main|session|Claude · GPT|cur': {
    id: 'agy|agy-main|session|Claude · GPT|cur',
    backend: 'agy',
    account: 'agy-main',
    accountName: 'alex.chen@example.com',
    accountKind: 'subscription',
    kind: 'session',
    group: 'Claude · GPT',
    start: NOW - 2.5 * H,
    end: NOW + 2.5 * H,
    current: true,
    startPercent: 20,
    endPercent: 92,
    firstSnapshotAt: NOW - 2.1 * H,
    lastSnapshotAt: NOW - 6 * 60_000,
    requests: 22,
    tokens: { input: 98_000, create5m: 0, create1h: 0, read: 1_420_000, output: 72_000, reasoning: 18_000 },
    costUsd: 6.18,
    unpricedRequests: 0,
    estimate: { usdPer100: 8.58, basisPercent: 72, basisCost: 6.18, reliable: true },
    external: false,
    snapshots: [
      { at: NOW - 2.1 * H, percent: 20, source: 'probe' },
      { at: NOW - 1.1 * H, percent: 64, source: 'event' },
      { at: NOW - 6 * 60_000, percent: 92, source: 'event' },
    ],
    rows: [
      {
        model: 'claude-sonnet-4-6',
        layer: 'delegate',
        agent: 'coder',
        requests: 22,
        tokens: { input: 98_000, create5m: 0, create1h: 0, read: 1_420_000, output: 72_000, reasoning: 18_000 },
        costUsd: 6.18,
        unpricedRequests: 0,
        estimated: true,
      },
    ],
  },

  // Codex：group + reasoning
  'codex|codex-pro|session|Codex|cur': {
    id: 'codex|codex-pro|session|Codex|cur',
    backend: 'codex',
    account: 'codex-pro',
    accountName: '主力 Pro',
    accountKind: 'subscription',
    kind: 'session',
    group: 'Codex',
    start: NOW - 3.6 * H,
    end: NOW + 1.4 * H,
    current: true,
    startPercent: 12,
    endPercent: 78,
    firstSnapshotAt: NOW - 3.4 * H,
    lastSnapshotAt: NOW - 4 * 60_000,
    requests: 31,
    tokens: { input: 210_000, create5m: 0, create1h: 0, read: 3_120_000, output: 88_400, reasoning: 42_100 },
    costUsd: 5.92,
    unpricedRequests: 0,
    estimate: { usdPer100: 8.97, basisPercent: 66, basisCost: 5.92, reliable: true },
    external: false,
    snapshots: [
      { at: NOW - 3.4 * H, percent: 12, source: 'probe' },
      { at: NOW - 2.0 * H, percent: 45, source: 'event' },
      { at: NOW - 0.8 * H, percent: 67, source: 'event' },
      { at: NOW - 4 * 60_000, percent: 78, source: 'event' },
    ],
    rows: [
      {
        model: 'gpt-5.3-codex',
        layer: 'delegate',
        agent: 'implementer',
        requests: 31,
        tokens: { input: 210_000, create5m: 0, create1h: 0, read: 3_120_000, output: 88_400, reasoning: 42_100 },
        costUsd: 5.92,
        unpricedRequests: 0,
        estimated: false,
      },
    ],
  },

  // Kiro：仅 monthly + used/limit credits
  'claude|k1|monthly||cur': {
    id: 'claude|k1|monthly||cur',
    backend: 'claude',
    account: 'k1',
    accountName: 'Kiro 个人',
    accountKind: 'kiro',
    kind: 'monthly',
    group: null,
    start: new Date(2026, 10, 1, 0, 0, 0).getTime(),
    end: new Date(2026, 11, 1, 0, 0, 0).getTime(),
    current: true,
    startPercent: 6,
    endPercent: 37,
    firstSnapshotAt: new Date(2026, 10, 3, 10, 0, 0).getTime(),
    lastSnapshotAt: NOW - 20 * 60_000,
    used: 184.5,
    limit: 500,
    requests: 138,
    tokens: { input: 240_000, create5m: 640_000, create1h: 0, read: 6_800_000, output: 290_000, reasoning: 0 },
    costUsd: 16.4,
    unpricedRequests: 0,
    estimate: { usdPer100: 52.9, basisPercent: 31, basisCost: 16.4, reliable: true },
    external: false,
    snapshots: [
      { at: new Date(2026, 10, 3, 10, 0, 0).getTime(), percent: 6, source: 'probe' },
      { at: new Date(2026, 10, 10, 14, 0, 0).getTime(), percent: 17, source: 'event' },
      { at: new Date(2026, 10, 18, 19, 0, 0).getTime(), percent: 26, source: 'event' },
      { at: NOW - 20 * 60_000, percent: 37, source: 'event' },
    ],
    rows: [
      {
        model: 'claude-sonnet-4-6',
        layer: 'main',
        agent: null,
        requests: 112,
        tokens: { input: 205_000, create5m: 560_000, create1h: 0, read: 5_900_000, output: 248_000, reasoning: 0 },
        costUsd: 14.1,
        unpricedRequests: 0,
        estimated: false,
      },
      {
        model: 'claude-haiku-4-5-20251001',
        layer: 'native',
        agent: 'Explore',
        requests: 26,
        tokens: { input: 35_000, create5m: 80_000, create1h: 0, read: 900_000, output: 42_000, reasoning: 0 },
        costUsd: 2.3,
        unpricedRequests: 0,
        estimated: false,
      },
    ],
  },
  'claude|k1|monthly||prev': {
    id: 'claude|k1|monthly||prev',
    backend: 'claude',
    account: 'k1',
    accountName: 'Kiro 个人',
    accountKind: 'kiro',
    kind: 'monthly',
    group: null,
    start: new Date(2026, 9, 1, 0, 0, 0).getTime(),
    end: new Date(2026, 10, 1, 0, 0, 0).getTime(),
    current: false,
    startPercent: 0,
    endPercent: 94,
    firstSnapshotAt: new Date(2026, 9, 2, 9, 0, 0).getTime(),
    lastSnapshotAt: new Date(2026, 9, 30, 22, 0, 0).getTime(),
    used: 470,
    limit: 500,
    requests: 412,
    tokens: { input: 720_000, create5m: 1_900_000, create1h: 0, read: 21_400_000, output: 860_000, reasoning: 0 },
    costUsd: 49.8,
    unpricedRequests: 0,
    estimate: { usdPer100: 52.98, basisPercent: 94, basisCost: 49.8, reliable: true },
    external: false,
    snapshots: [
      { at: new Date(2026, 9, 2, 9, 0, 0).getTime(), percent: 0, source: 'probe' },
      { at: new Date(2026, 9, 15, 18, 0, 0).getTime(), percent: 48, source: 'event' },
      { at: new Date(2026, 9, 30, 22, 0, 0).getTime(), percent: 94, source: 'event' },
    ],
    rows: [
      {
        model: 'claude-sonnet-4-6',
        layer: 'main',
        agent: null,
        requests: 412,
        tokens: { input: 720_000, create5m: 1_900_000, create1h: 0, read: 21_400_000, output: 860_000, reasoning: 0 },
        costUsd: 49.8,
        unpricedRequests: 0,
        estimated: false,
      },
    ],
  },
};

const stripDetail = ({ rows: _r, snapshots: _s, ...sum }: LedgerWindowDetail) => sum;

const SCENE_LISTS: Record<Exclude<SceneId, 'error' | 'manager'>, LedgerWindowList> = {
  claude: {
    enabled: true,
    windows: [
      stripDetail(DETAILS['claude|default|session||cur']!),
      stripDetail(DETAILS['claude|default|session||ext']!),
      stripDetail(DETAILS['claude|default|session||small']!),
      stripDetail(DETAILS['claude|default|weekly||cur']!),
      stripDetail(DETAILS['claude|default|scoped|Opus|cur']!),
    ],
  },
  agy: {
    enabled: true,
    windows: [
      stripDetail(DETAILS['agy|agy-main|session|Gemini|cur']!),
      stripDetail(DETAILS['agy|agy-main|session|Claude · GPT|cur']!),
    ],
  },
  codex: {
    enabled: true,
    windows: [stripDetail(DETAILS['codex|codex-pro|session|Codex|cur']!)],
  },
  kiro: {
    enabled: true,
    windows: [
      stripDetail(DETAILS['claude|k1|monthly||cur']!),
      stripDetail(DETAILS['claude|k1|monthly||prev']!),
    ],
  },
  empty: { enabled: true, windows: [] },
  disabled: { enabled: false, windows: [] },
};

const SCENE_TARGETS: Record<Exclude<SceneId, 'manager'>, LedgerTarget> = {
  claude: { backend: 'claude', account: 'default', accountName: 'cosyeey', brand: 'claude', plan: 'Max' },
  agy: { backend: 'agy', account: 'agy-main', accountName: 'alex.chen@example.com', brand: 'agy', plan: 'Pro' },
  codex: { backend: 'codex', account: 'codex-pro', accountName: '主力 Pro', brand: 'codex', plan: 'Pro' },
  kiro: { backend: 'claude', account: 'k1', accountName: 'Kiro 个人', brand: 'kiro', plan: null },
  empty: { backend: 'claude', account: 'empty-acct', accountName: '新账号', brand: 'claude', plan: 'Pro' },
  disabled: { backend: 'claude', account: 'disabled-acct', accountName: 'cosyeey', brand: 'claude', plan: 'Max' },
  error: { backend: 'claude', account: 'err-acct', accountName: 'cosyeey', brand: 'claude', plan: 'Max' },
};

const MOCK_ACCOUNTS: AccountList = {
  mode: 'parallel',
  login: null,
  list: [
    { id: 'default', label: '', name: 'cosyeey', plan: 'Max', loggedIn: true, active: true, isDefault: true, subscribedAt: NOW - 18 * D, loginExpiresAt: NOW + 22 * D },
    { id: 'k1', label: 'Kiro 个人', name: 'Kiro 个人', plan: null, loggedIn: true, active: false, isDefault: false, kiro: { method: 'builderId', proxy: 'ready', error: null, credential: 'ok' } },
  ],
};
const MOCK_AGY: AgyAccountList = {
  installed: true,
  login: null,
  list: [{ id: 'agy-main', label: '', email: 'alex.chen@example.com', quota: null, plan: 'Pro', loggedIn: true, active: true, isDefault: false, running: 0 }],
};
const MOCK_CODEX: CodexAccountList = {
  installed: true,
  login: null,
  list: [{ id: 'codex-pro', label: '主力 Pro', email: 'pro@studio.dev', plan: 'pro', planType: 'pro', authMode: 'chatgpt', loggedIn: true, active: true, isDefault: false, running: 0, quota: null }],
};

// 替换 api 方法（不连后端）
let currentScene: SceneId = 'claude';
const apiRec = api as unknown as Record<string, unknown>;
apiRec.ledgerWindows = (o: { backend?: LedgerBackend; account?: string } = {}) => {
  if (currentScene === 'error') return Promise.reject(new Error('HTTP 503: 账本服务暂不可用'));
  if (currentScene === 'manager') {
    if (o.backend === 'agy') return Promise.resolve(SCENE_LISTS.agy);
    if (o.backend === 'codex') return Promise.resolve(SCENE_LISTS.codex);
    if (o.account === 'k1') return Promise.resolve(SCENE_LISTS.kiro);
    return Promise.resolve(SCENE_LISTS.claude);
  }
  return Promise.resolve(SCENE_LISTS[currentScene]);
};
apiRec.ledgerWindowDetail = (id: string) => {
  const hit = DETAILS[id];
  if (!hit) return Promise.reject(new Error('HTTP 404: 窗口不存在'));
  return Promise.resolve(hit);
};
apiRec.components = () => Promise.resolve({ list: [] });

export default function LedgerDev() {
  const params = new URLSearchParams(location.search);
  const unitParam = params.get('unit');
  if (unitParam && (TOKEN_UNIT_ORDER as readonly string[]).includes(unitParam)) {
    try { localStorage.setItem(TOKEN_UNIT_STORAGE_KEY, unitParam); } catch {}
  }
  const initialScene = (params.get('scene') as SceneId) || 'claude';
  const expandFirst = params.get('expand') === '1';
  const [scene, setScene] = useState<SceneId>(SCENES.some((s) => s.id === initialScene) ? initialScene : 'claude');
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    params.get('theme') === 'light' || document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
  );
  const [mgrOpen, setMgrOpen] = useState(true);

  currentScene = scene;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const target = scene !== 'manager' ? SCENE_TARGETS[scene] : null;
  const firstId =
    expandFirst && scene !== 'error' && scene !== 'manager'
      ? SCENE_LISTS[scene].windows[0]?.id ?? null
      : null;

  return (
    <div
      style={{
        minHeight: '100dvh',
        background: 'var(--bg)',
        backgroundImage: 'var(--ambient)',
        color: 'var(--text)',
        padding: '14px 12px 32px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <div
        style={{
          width: 'min(820px, 100%)',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 6,
          padding: '8px 10px',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-md)',
          background: 'var(--mat-card)',
        }}
      >
        {SCENES.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`cz-ledger-btn${scene === s.id ? ' is-primary' : ''}`}
            onClick={() => {
              currentScene = s.id;
              setScene(s.id);
              if (s.id === 'manager') setMgrOpen(true);
            }}
          >
            {s.label}
          </button>
        ))}
        <button
          type="button"
          className="cz-ledger-btn"
          style={{ marginLeft: 'auto' }}
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        >
          {theme === 'dark' ? '切换浅色' : '切换深色'}
        </button>
      </div>

      {scene !== 'manager' && target && (
        <div style={{ width: 'min(820px, 100%)' }}>
          <LedgerPanel
            key={`${scene}:${firstId ?? ''}`}
            target={target}
            onClose={() => {}}
            defaultExpandedId={firstId}
            now={NOW}
            inline
          />
        </div>
      )}

      {scene === 'manager' && mgrOpen && (
        <AccountManager
          data={MOCK_ACCOUNTS}
          agyData={MOCK_AGY}
          codexData={MOCK_CODEX}
          error={null}
          quotas={{ default: { status: 'none' } }}
          kiroBalances={{ k1: { status: 'ok', info: { subscription: 'Kiro Pro', used: 184.5, limit: 500, resetsAt: NOW + 4 * D } } }}
          now={NOW}
          version={1}
          switching={null}
          agySwitching={null}
          codexSwitching={null}
          covered={false}
          onClose={() => setMgrOpen(false)}
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
        />
      )}
    </div>
  );
}
