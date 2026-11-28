// 订阅用量统计的纯格式化与聚合工具（面板与单测共用）。
import type {
  LedgerLayer,
  LedgerTokens,
  LedgerWindowKind,
  LedgerWindowSummary,
} from '@cosyee/shared';
import { formatUsd } from '../context/cost';
import { formatTokens } from '../context/formatTokens';
import { prettyModel } from '../flow/format';

export const KIND_ORDER: readonly LedgerWindowKind[] = ['session', 'weekly', 'scoped', 'monthly'];

export const KIND_LABEL: Record<LedgerWindowKind, string> = {
  session: '5 小时',
  weekly: '每周',
  scoped: '按模型',
  monthly: '每月',
};

export const LAYER_LABEL: Record<LedgerLayer, string> = {
  main: '主代理',
  native: '原生子代理',
  delegate: '委派',
  internal: '内部调用',
};

export type TokenUnitMode = 'auto' | 'M' | 'B' | 'full';

export const TOKEN_UNIT_ORDER: readonly TokenUnitMode[] = ['auto', 'M', 'B', 'full'];

export const TOKEN_UNIT_LABEL: Record<TokenUnitMode, string> = {
  auto: '自动',
  M: 'M',
  B: 'B',
  full: '完整',
};

export const TOKEN_UNIT_STORAGE_KEY = 'cz-ledger-token-unit';

export function nextTokenUnit(cur: TokenUnitMode): TokenUnitMode {
  const idx = TOKEN_UNIT_ORDER.indexOf(cur);
  return TOKEN_UNIT_ORDER[(idx + 1) % TOKEN_UNIT_ORDER.length]!;
}

export function loadTokenUnit(): TokenUnitMode {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(TOKEN_UNIT_STORAGE_KEY) : null;
    if (raw && (TOKEN_UNIT_ORDER as readonly string[]).includes(raw)) return raw as TokenUnitMode;
  } catch {
    // 忽略隐私模式或受限环境下的存储错误
  }
  return 'auto';
}

export function saveTokenUnit(mode: TokenUnitMode): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(TOKEN_UNIT_STORAGE_KEY, mode);
  } catch {
    // 忽略存储错误
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

function trimNum(n: number, digits = 1): string {
  return n.toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

/** 从窗口列表里提取实际存在的种类，按标准顺序排列 */
export function availableKinds(windows: readonly LedgerWindowSummary[]): LedgerWindowKind[] {
  const present = new Set<LedgerWindowKind>();
  for (const w of windows) present.add(w.kind);
  return KIND_ORDER.filter((k) => present.has(k));
}

/** 窗口本地时间范围：同日「MM/DD HH:mm – HH:mm」，跨日「MM/DD HH:mm – MM/DD HH:mm」，跨年补年份；月度窗口省去时分 */
export function formatWindowRange(start: number, end: number, kind?: LedgerWindowKind, now = Date.now()): string {
  const s = new Date(start);
  const e = new Date(end);
  const curYear = new Date(now).getFullYear();
  const showYear = s.getFullYear() !== curYear || e.getFullYear() !== curYear;
  const dateOf = (d: Date) =>
    `${showYear ? `${d.getFullYear()}/` : ''}${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  const timeOf = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

  if (kind === 'monthly') {
    return `${dateOf(s)} – ${dateOf(e)}`;
  }
  const sameDay =
    s.getFullYear() === e.getFullYear() &&
    s.getMonth() === e.getMonth() &&
    s.getDate() === e.getDate();
  if (sameDay) {
    const today = new Date(now);
    const isToday =
      s.getFullYear() === today.getFullYear() &&
      s.getMonth() === today.getMonth() &&
      s.getDate() === today.getDate();
    return `${isToday ? '今天' : dateOf(s)} ${timeOf(s)} – ${timeOf(e)}`;
  }
  return `${dateOf(s)} ${timeOf(s)} – ${dateOf(e)} ${timeOf(e)}`;
}

/** 图表刻度 / 悬停提示的本地时间 */
export function formatClockTime(ms: number, spanMs: number): string {
  const d = new Date(ms);
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (spanMs <= 24 * 3_600_000) return t;
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${t}`;
}

/** 起→止百分比文字 */
export function formatPercentRange(startPct: number | null, endPct: number | null): string {
  if (startPct == null && endPct == null) return '—';
  const fmt = (v: number) => `${Math.round(v)}%`;
  if (startPct == null) return `→ ${fmt(endPct!)}`;
  if (endPct == null) return `${fmt(startPct)} →`;
  return `${fmt(startPct)} → ${fmt(endPct)}`;
}

/** Kiro credits 摘要：「184.5 / 500 credits」 */
export function formatKiroCredits(used?: number | null, limit?: number | null): string | null {
  if (used == null || limit == null || limit <= 0) return null;
  return `${trimNum(used, 1)} / ${trimNum(limit, 1)} credits`;
}

/** 模型显示名：复用 prettyModel，未知时显示「未知模型」 */
export function formatModelName(model: string | null): string {
  if (!model) return '未知模型';
  return prettyModel(model) || model;
}

/** 推算「100% ≈ $xx」的说明文字（tooltip） */
export function estimateHint(win: LedgerWindowSummary): string {
  const { usdPer100, basisPercent, basisCost, reliable } = win.estimate;
  if (usdPer100 == null) {
    return '窗口内百分比增量不足 5% 或缺少有效额度快照，暂无法推算 100% 额度等效花费';
  }
  if (!reliable) {
    return `检测到 Cosyee 外部用量，仅供参考（按增量 ${trimNum(basisPercent, 1)}% · ${formatUsd(basisCost)} 推算）`;
  }
  return `按窗口内 ${trimNum(basisPercent, 1)}% 增量（等效花费 ${formatUsd(basisCost)}）推算 100% 额度`;
}

/** 完整千分位 token 整数（用于「完整」模式与悬停 tooltip） */
export function formatFullTokens(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** 按指定单位模式格式化 token 数：
 *  - auto：自动选 K / M / B（K/M 复用项目既有 formatTokens 并转为大写）
 *  - M：统一以兆为单位（如 0.04M、1.90M）
 *  - B：统一以十亿为单位（如 0.0019B）
 *  - full：完整千分位整数（如 1,920,000） */
export function formatLedgerTokens(n: number, mode: TokenUnitMode = 'auto'): string {
  if (!Number.isFinite(n)) return '0';
  if (mode === 'full') return formatFullTokens(n);
  const abs = Math.abs(n);
  if (mode === 'auto') {
    if (abs >= 1_000_000_000) return `${trimNum(n / 1_000_000_000, 2)}B`;
    return formatTokens(n).replace(/([km])$/, (u) => u.toUpperCase());
  }
  if (mode === 'M') {
    if (n === 0) return '0M';
    const v = n / 1_000_000;
    const av = Math.abs(v);
    const digits = av >= 0.01 ? 2 : av >= 0.001 ? 3 : 4;
    return `${v.toFixed(digits)}M`;
  }
  // mode === 'B'
  if (n === 0) return '0B';
  const v = n / 1_000_000_000;
  const av = Math.abs(v);
  const digits = av >= 0.01 ? 2 : av >= 0.0001 ? 4 : 6;
  return `${v.toFixed(digits)}B`;
}

/** 总 token（reasoning 已包含在 output 内，不重复相加） */
export function totalTokens(t: LedgerTokens): number {
  return t.input + t.create5m + t.create1h + t.read + t.output;
}

/** 窗口进度条的起止比例（0~1） */
export function barRatios(win: LedgerWindowSummary): { start: number; end: number } {
  const clamp = (v: number | null) => (v == null ? 0 : Math.max(0, Math.min(1, v / 100)));
  const end = clamp(win.endPercent ?? win.startPercent);
  const start = Math.min(end, clamp(win.startPercent));
  return { start, end };
}

/** 百分比严重度（沿用 AccountQuota 阈值） */
export function percentTone(pct: number | null): 'normal' | 'warning' | 'critical' {
  if (pct == null) return 'normal';
  if (pct >= 90) return 'critical';
  if (pct >= 75) return 'warning';
  return 'normal';
}
