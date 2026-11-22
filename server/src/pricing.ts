// 官方价格表：定期抓取 https://platform.claude.com/docs/en/about-claude/pricing.md 并解析，
// 与内置表（shared/src/pricing.ts）合并；抓取失败一律退回已有的表，不影响使用。
import fs from 'node:fs';
import path from 'node:path';
import { BUILTIN_PRICES, type ModelPrice, type PriceTable, type TokenPrices } from '@cosyee/shared';
import { cosyeeHome } from './paths.js';

export const PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing.md';
const DAY_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

/** 单元格里的价格：「$5 / MTok」「$0.20 / MTok<sup>1</sup>」「$16 USD / MTok」 */
function parsePrice(cell: string): number | null {
  const m = /\$\s*([\d,]*\.?\d+)\s*(?:USD\s*)?\/\s*MTok/i.exec(cell);
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

const cells = (line: string): string[] => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

/** 取某个标题下面的表格行（到下一个同级或更高级标题为止） */
function sectionRows(md: string, heading: RegExp): string[][] {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return [];
  const level = /^#+/.exec(lines[start]!)![0].length;
  const rows: string[][] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!;
    const h = /^(#+)\s/.exec(l);
    if (h && h[1]!.length <= level) break;
    if (l.trim().startsWith('|')) rows.push(cells(l));
  }
  return rows;
}

/** 「Claude Opus 5.5」→ { id: claude-opus-5-5, label: Claude Opus 5.5 }；认不出返回 null */
function nameOf(text: string, requirePrefix: boolean): { id: string; label: string } | null {
  const m = (requirePrefix ? /Claude\s+([A-Za-z]+)(?:\s+(\d+(?:\.\d+)?))?/ : /^(?:Claude\s+)?([A-Za-z]+)(?:\s+(\d+(?:\.\d+)?))?\s*$/i).exec(text.trim());
  if (!m) return null;
  const fam = m[1]!;
  const label = ['Claude', fam[0]!.toUpperCase() + fam.slice(1).toLowerCase(), m[2]].filter(Boolean).join(' ');
  return { id: label.toLowerCase().replace(/[\s.]+/g, '-'), label };
}

/** 模型单元格 → 名称（去掉 <sup>、括号备注、链接） */
function modelCellName(cell: string): { id: string; label: string } | null {
  const clean = cell.replace(/<sup>.*?<\/sup>/gi, '').split(/[(\[]/)[0]!;
  return nameOf(clean, true);
}

/**
 * 解析官方价格页 markdown：「Model pricing」表（含长上下文行）+「Fast mode pricing」表。
 * 解析不了的行直接忽略，绝不抛异常。
 */
export function parsePricingMarkdown(md: string): ModelPrice[] {
  try {
    const base = new Map<string, ModelPrice>();
    const long = new Map<string, TokenPrices & { threshold: number }>();
    for (const row of sectionRows(md, /^##\s+Model pricing\s*$/i)) {
      if (row.length < 6) continue;
      const name = modelCellName(row[0]!);
      const prices = row.slice(1, 6).map(parsePrice);
      if (!name || prices.some((x) => x === null)) continue;
      const [input, write5m, write1h, read, output] = prices as number[];
      const tp = { input: input!, write5m: write5m!, write1h: write1h!, read: read!, output: output! };
      // 「(for prompts over 100,000 tokens)」是长上下文价；「up to」那行才是基础价
      const over = /over\s+([\d,]+)\s+tokens/i.exec(row[0]!);
      if (over) {
        const threshold = Number(over[1]!.replace(/,/g, ''));
        if (Number.isFinite(threshold) && threshold > 0) long.set(name.id, { threshold, ...tp });
      } else if (!base.has(name.id)) {
        base.set(name.id, { id: name.id, label: name.label, ...tp });
      }
    }
    for (const [id, l] of long) {
      const b = base.get(id);
      if (b) b.long = l;
    }
    for (const row of sectionRows(md, /^###\s+Fast mode pricing\s*$/i)) {
      if (row.length < 3) continue;
      const input = parsePrice(row[1]!);
      const output = parsePrice(row[2]!);
      if (input === null || output === null) continue;
      for (const piece of row[0]!.replace(/<sup>.*?<\/sup>/gi, '').split(/\s*(?:\/|,|\band\b)\s*/i)) {
        const n = nameOf(piece, false);
        const b = n && base.get(n.id);
        if (b) b.fast = { input, output };
      }
    }
    return [...base.values()];
  } catch {
    return [];
  }
}

const finitePrice = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n) && n > 0 && n < 1000;

function modelPricesOk(m: ModelPrice): boolean {
  const tp = (t: TokenPrices) => [t.input, t.write5m, t.write1h, t.read, t.output].every(finitePrice);
  if (!m || typeof m.id !== 'string' || !tp(m)) return false;
  if (m.long && !(tp(m.long) && Number.isFinite(m.long.threshold) && m.long.threshold > 0)) return false;
  if (m.fast && !(finitePrice(m.fast.input) && finitePrice(m.fast.output))) return false;
  return true;
}

/** 解析结果是否可信：至少 5 个模型、opus / sonnet / haiku 各至少一个、所有价格有限且在 (0, 1000) 内 */
export function validateParsed(models: ModelPrice[]): boolean {
  if (!Array.isArray(models) || models.length < 5) return false;
  if (!models.every(modelPricesOk)) return false;
  return ['opus', 'sonnet', 'haiku'].every((f) => models.some((m) => m.id.startsWith(`claude-${f}`)));
}

/** 以内置表为底，官方解析结果按 id 覆盖（官方没列 long / fast 时沿用内置的），新 id 追加 */
export function mergeWithBuiltin(parsed: ModelPrice[]): ModelPrice[] {
  const out = BUILTIN_PRICES.models.map((b) => {
    const p = parsed.find((x) => x.id === b.id);
    if (!p) return b;
    const m: ModelPrice = { ...p };
    if (!m.long && b.long) m.long = b.long;
    if (!m.fast && b.fast) m.fast = b.fast;
    return m;
  });
  const known = new Set(out.map((m) => m.id));
  for (const p of parsed) if (!known.has(p.id)) out.push(p);
  return out;
}

export interface PricingOptions {
  /** 磁盘缓存文件（JSON { fetchedAt, models }） */
  file: string;
  url?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  intervalMs?: number;
}

export class PricingService {
  private readonly file: string;
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private current: PriceTable = BUILTIN_PRICES;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: PricingOptions) {
    this.file = opts.file;
    this.url = opts.url ?? PRICING_URL;
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
    this.now = opts.now ?? Date.now;
    this.intervalMs = opts.intervalMs ?? DAY_MS;
    this.loadCache();
  }

  /** 当前价格表（官方缓存 / 抓取结果与内置表合并，否则就是内置表） */
  table(): PriceTable {
    return this.current;
  }

  private loadCache(): void {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { fetchedAt?: unknown; models?: unknown };
      if (typeof j.fetchedAt !== 'number' || !Array.isArray(j.models)) return;
      const models = j.models as ModelPrice[];
      if (!validateParsed(models)) return;
      this.current = { source: 'official', fetchedAt: j.fetchedAt, models: mergeWithBuiltin(models) };
    } catch { /* 没有缓存或缓存损坏：用内置表 */ }
  }

  private saveCache(fetchedAt: number, models: ModelPrice[]): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ fetchedAt, models }));
    fs.renameSync(tmp, this.file);
  }

  /** 抓取并更新；任何失败都保留现有表，只打一行警告，从不抛异常 */
  async refresh(): Promise<void> {
    try {
      const res = await this.fetchImpl(this.url, {
        headers: { 'user-agent': 'cosyee', accept: 'text/markdown,text/plain,*/*' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = parsePricingMarkdown(await res.text());
      if (!validateParsed(parsed)) throw new Error('解析结果不可信');
      const fetchedAt = this.now();
      this.current = { source: 'official', fetchedAt, models: mergeWithBuiltin(parsed) };
      try {
        this.saveCache(fetchedAt, parsed);
      } catch (e) {
        console.warn(`[pricing] 写入缓存失败：${(e as Error).message}`);
      }
    } catch (e) {
      console.warn(`[pricing] 更新官方价格失败，沿用现有价格表：${(e as Error).message}`);
    }
  }

  /** 启动定时更新：缓存还新鲜就先不抓；COSYEE_NO_PRICING_FETCH=1 时什么也不做 */
  start(): void {
    if (process.env.COSYEE_NO_PRICING_FETCH === '1' || this.timer) return;
    const age = this.current.fetchedAt === null ? Infinity : this.now() - this.current.fetchedAt;
    if (age >= this.intervalMs) void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** 正式环境的服务：缓存放在 ~/.cosyee/pricing.json */
export const defaultPricingFile = (): string => path.join(cosyeeHome(), 'pricing.json');
