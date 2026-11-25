// 从 agy acp 进程内置的 language server 读登录邮箱与额度。
// agy acp 启动后会在 localhost 上开一个随机端口的 HTTP 服务（Connect 协议，JSON），端口写在它自己的日志
// <数据目录>/log/acp-server-<时间>-<pid>.log 里：「Language server listening on random port at 53868 for HTTP」。
// - GetUserStatus → userStatus.email
// - RetrieveUserQuotaSummary → response.groups[].buckets[]（remainingFraction + resetTime）
// 只连 127.0.0.1、只读这两个接口；令牌由 agy 自己持有，这里拿不到也不碰。
// 读不到（日志还没写、端口不通、接口变了）一律返回 null，不影响登录状态的判断。
import fs from 'node:fs';
import path from 'node:path';
import type { AgyQuota, AgyQuotaBucket, AgyQuotaGroup, UsageSeverity } from '@cosyee/shared';
import type { Json } from '../transcript.js';

const SERVICE = 'exa.language_server_pb.LanguageServerService';
const METADATA = { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' };

export interface AgyStatus {
  email: string | null;
  quota: AgyQuota | null;
}

/** 在 logDir 里找 pid 对应的 acp-server 日志，读出 language server 的 HTTP 端口 */
export function findLsPort(logDir: string, pid: number | undefined): number | null {
  if (!pid) return null;
  let names: string[];
  try {
    names = fs.readdirSync(logDir);
  } catch {
    return null;
  }
  const suffix = `-${pid}.log`;
  const hit = names.filter((n) => n.startsWith('acp-server-') && n.endsWith(suffix)).sort().pop();
  if (!hit) return null;
  let txt: string;
  try {
    txt = fs.readFileSync(path.join(logDir, hit), 'utf8');
  } catch {
    return null;
  }
  const m = /listening on random port at (\d{2,5}) for HTTP\s*$/m.exec(txt);
  const port = m ? Number(m[1]) : NaN;
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

const severity = (p: number): UsageSeverity => (p >= 100 ? 'critical' : p >= 80 ? 'warning' : 'normal');

const time = (v: unknown): number | null => {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/** 组名：「Gemini Models」→「Gemini」，「Claude and GPT models」→「Claude · GPT」 */
export function quotaGroupName(raw: string): string {
  const s = raw.replace(/\s+models?$/i, '').trim();
  return s.replace(/\s+and\s+/gi, ' · ') || raw;
}

/** 解析 RetrieveUserQuotaSummary 的返回；结构不对返回 null */
export function parseQuota(j: Json, at: number): AgyQuota | null {
  const groups = j?.response?.groups;
  if (!Array.isArray(groups)) return null;
  const out: AgyQuotaGroup[] = [];
  for (const g of groups) {
    if (!g || !Array.isArray(g.buckets)) continue;
    const buckets: AgyQuotaBucket[] = [];
    for (const b of g.buckets) {
      const f = typeof b?.remainingFraction === 'number' ? b.remainingFraction : b?.remainingFraction === undefined ? 0 : NaN;
      if (!Number.isFinite(f)) continue;
      const percent = Math.max(0, Math.min(100, Math.round((1 - f) * 100)));
      buckets.push({
        window: typeof b.window === 'string' && b.window ? b.window : String(b.bucketId ?? ''),
        percent,
        severity: severity(percent),
        resetsAt: time(b.resetTime),
      });
    }
    // 5 小时窗口在前，每周在后
    buckets.sort((a, b) => rank(a.window) - rank(b.window));
    if (buckets.length) out.push({ name: quotaGroupName(String(g.displayName ?? '模型')), buckets });
  }
  return out.length ? { groups: out, at } : null;
}

const rank = (w: string) => (w === '5h' ? 0 : w === 'weekly' ? 1 : 2);

async function call(port: number, method: string, signal: AbortSignal): Promise<Json | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/${SERVICE}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
      body: JSON.stringify({ metadata: METADATA }),
      signal,
    });
    if (!r.ok) return null;
    return (await r.json()) as Json;
  } catch {
    return null;
  }
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

/** 并行读邮箱和额度；总时长不超过 timeoutMs */
export async function fetchAgyStatus(port: number, timeoutMs: number, now: number): Promise<AgyStatus> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  timer.unref?.();
  try {
    const [user, quota] = await Promise.all([
      call(port, 'GetUserStatus', ctl.signal),
      call(port, 'RetrieveUserQuotaSummary', ctl.signal),
    ]);
    const email = user?.userStatus?.email;
    return {
      email: typeof email === 'string' && EMAIL_RE.test(email.trim()) ? email.trim() : null,
      quota: quota ? parseQuota(quota, now) : null,
    };
  } finally {
    clearTimeout(timer);
  }
}
