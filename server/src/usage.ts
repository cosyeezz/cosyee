// 订阅额度：起一个不发消息的 claude 进程，发 control_request get_usage 取额度（不调用模型、不写会话记录）。
// 只下发 limits 里的百分比 / 重置时间 / 模型名，不含账号、花费、使用习惯等其它字段。
import { spawn } from 'node:child_process';
import os from 'node:os';
import type { UsageInfo, UsageLimit, UsageSeverity } from '@cosyee/shared';
import { LineSplitter } from './transcript.js';
import { claudeEnv, resolveClaude, spawnSpec } from './claude/bin.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const TTL_OK = 60_000;
const TTL_FAIL = 30_000;
/** refresh=1 也至少间隔这么久，避免频繁起进程 */
const MIN_REFRESH = 10_000;
const TIMEOUT = 25_000;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pct = (v: unknown): number => Math.max(0, Math.min(100, Math.round(num(v) ?? 0)));
const time = (v: unknown): number | null => {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
};
const severity = (v: unknown, p: number): UsageSeverity =>
  v === 'critical' || v === 'warning' || v === 'normal' ? v : p >= 100 ? 'critical' : p >= 80 ? 'warning' : 'normal';

/** get_usage 的 response → UsageInfo；没有额度信息返回 null。 */
export function parseUsage(r: Json | null | undefined, at = Date.now()): UsageInfo | null {
  const rl = r?.rate_limits;
  if (!rl || typeof rl !== 'object' || r?.rate_limits_available === false) return null;
  const limits: UsageLimit[] = [];
  const raw: Json[] = Array.isArray(rl.limits) ? rl.limits : [];
  if (raw.length) {
    const shares: Json[] = Array.isArray(rl.weekly_scoped_shares) ? rl.weekly_scoped_shares : [];
    const scopedName = (l: Json) => {
      const m = l?.scope?.model;
      return typeof m?.display_name === 'string' ? m.display_name : typeof m?.id === 'string' ? m.id : null;
    };
    raw.forEach((l, i) => {
      const p = pct(l?.percent);
      const base = { percent: p, severity: severity(l?.severity, p), resetsAt: time(l?.resets_at) };
      if (l?.kind === 'session') limits.push({ kind: 'session', ...base });
      else if (l?.kind === 'weekly_all') {
        const segs = shares
          .map((s) => ({ model: scopedName(raw[s?.limit_index]), percent: pct(s?.used_percent_of_weekly) }))
          .filter((s): s is { model: string; percent: number } => !!s.model && s.percent > 0);
        limits.push({ kind: 'weekly', ...base, shares: segs });
      } else if (l?.kind === 'weekly_scoped') {
        const model = scopedName(l);
        if (!model) return;
        const share = shares.find((s) => s?.limit_index === i);
        limits.push({ kind: 'scoped', ...base, model, allowance: num(share?.allowance_percent_of_weekly) });
      }
    });
  } else {
    // 旧版 CLI 没有 limits，退回 five_hour / seven_day
    const w = (k: string, kind: 'session' | 'weekly') => {
      const o = rl[k];
      if (!o || typeof o !== 'object') return;
      const p = pct(o.utilization);
      limits.push({ kind, percent: p, severity: severity(null, p), resetsAt: time(o.resets_at) });
    };
    w('five_hour', 'session');
    w('seven_day', 'weekly');
  }
  return limits.length ? { limits, at } : null;
}

/** dir：账号的配置目录（null = 默认账号，不传 = 当前账号） */
export function fetchUsage(dir?: string | null): Promise<UsageInfo | null> {
  return new Promise((resolve) => {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'];
    const spec = spawnSpec(resolveClaude(), args);
    let done = false;
    const finish = (v: UsageInfo | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { proc.stdin?.end(); } catch { /* ignore */ }
      setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, 2000).unref();
      resolve(v);
    };
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(spec.command, spec.args, {
        cwd: os.homedir(),
        env: claudeEnv(dir),
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
        windowsVerbatimArguments: spec.verbatim,
      });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => finish(null), TIMEOUT);
    const splitter = new LineSplitter();
    proc.stdout!.on('data', (d: Buffer) => {
      for (const line of splitter.push(d)) {
        let m: Json;
        try { m = JSON.parse(line); } catch { continue; }
        if (m?.type !== 'control_response' || m.response?.request_id !== 'usage') continue;
        finish(m.response.subtype === 'success' ? parseUsage(m.response.response) : null);
      }
    });
    proc.stdin!.on('error', () => { /* 进程已退出 */ });
    proc.on('error', () => finish(null));
    proc.on('close', () => finish(null));
    proc.stdin!.write(JSON.stringify({ type: 'control_request', request_id: 'usage', request: { subtype: 'get_usage' } }) + '\n');
  });
}

export class UsageProvider {
  private cached: { at: number; ttl: number; value: UsageInfo | null } | null = null;
  private pending: Promise<UsageInfo | null> | null = null;
  /** 切换账号时递增：旧账号还在路上的结果直接丢弃，不进缓存 */
  private gen = 0;

  constructor(private readonly fetcher: () => Promise<UsageInfo | null> = fetchUsage) {}

  /** 切换账号后调用：清掉缓存与在途请求 */
  reset(): void {
    this.gen++;
    this.cached = null;
    this.pending = null;
  }

  async get(refresh = false): Promise<UsageInfo | null> {
    const c = this.cached;
    if (c) {
      const age = Date.now() - c.at;
      if (age < (refresh ? MIN_REFRESH : c.ttl)) return c.value;
    }
    if (this.pending) return this.pending;
    const gen = this.gen;
    const p: Promise<UsageInfo | null> = this.fetcher()
      .catch(() => null)
      .then((value) => {
        if (gen !== this.gen) return null;
        // 失败时保留上一次的成功结果
        const keep = value ?? this.cached?.value ?? null;
        this.cached = { at: Date.now(), ttl: value ? TTL_OK : TTL_FAIL, value: keep };
        return keep;
      })
      .finally(() => {
        if (this.pending === p) this.pending = null;
      });
    this.pending = p;
    return p;
  }
}
