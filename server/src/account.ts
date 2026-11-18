// 账号信息：套餐来自 `claude auth status`，名字来自该账号的 .claude.json（只读）。
// 返回值只含 { name, plan }，绝不包含邮箱、uuid、组织名。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import type { Account } from '@cosyee/shared';
import { claudeEnv, resolveClaude, spawnSpec } from './claude/bin.js';
import { activeConfigDir, claudeJsonPath } from './paths.js';

const TTL_OK = 10 * 60_000;
const TTL_FAIL = 60_000;

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** 'pro' / 'max' / 'claude_max_5x' 等 -> 'Pro' / 'Max'；未知返回 null。 */
export function planLabel(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const s = raw.trim().toLowerCase().replace(/^claude[_-]/, '');
  const word = s.split(/[_\-\s]/)[0] ?? '';
  return word ? capitalize(word) : null;
}

/** 从 ~/.claude.json 的 oauthAccount 取显示名；含 '@' 的（像邮箱）不用。 */
export function nameFromOauth(oauth: unknown): string | null {
  if (!oauth || typeof oauth !== 'object') return null;
  const o = oauth as Record<string, unknown>;
  for (const k of ['displayName', 'fullName']) {
    const v = o[k];
    if (typeof v === 'string' && v.trim() && !v.includes('@')) return v.trim();
  }
  return null;
}

/** 读某个配置目录的 .claude.json（dir 为 null = 默认账号），读不到返回 null */
export function readClaudeJson(dir: string | null = activeConfigDir()): Record<string, unknown> | null {
  try {
    const j = JSON.parse(fs.readFileSync(claudeJsonPath(dir), 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function runAuthStatus(dir: string | null | undefined): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const spec = spawnSpec(resolveClaude(), ['auth', 'status']);
    try {
      execFile(
        spec.command,
        spec.args,
        { env: claudeEnv(dir), timeout: 20_000, windowsHide: true, windowsVerbatimArguments: spec.verbatim, encoding: 'utf8' },
        (err, stdout) => {
          // 未登录时 CLI 可能以非 0 退出但仍输出 JSON，所以不看 err，直接解析
          try {
            const j = JSON.parse(String(stdout));
            resolve(j && typeof j === 'object' ? (j as Record<string, unknown>) : null);
          } catch {
            void err;
            resolve(null);
          }
        },
      );
    } catch {
      resolve(null);
    }
  });
}

export class AccountProvider {
  private cached: { at: number; ttl: number; value: Account | null } | null = null;
  private pending: Promise<Account | null> | null = null;
  /** 切换账号时递增：旧账号还在路上的结果直接丢弃 */
  private gen = 0;

  /** dir：账号的配置目录（null = 默认账号，不传 = 当前账号） */
  constructor(private readonly dir?: string | null) {}

  /** 切换账号后调用：清掉缓存与在途请求 */
  reset(): void {
    this.gen++;
    this.cached = null;
    this.pending = null;
  }

  async get(): Promise<Account | null> {
    const c = this.cached;
    if (c && Date.now() - c.at < c.ttl) return c.value;
    if (this.pending) return this.pending;
    const gen = this.gen;
    const p: Promise<Account | null> = this.load(gen).finally(() => {
      if (this.pending === p) this.pending = null;
    });
    this.pending = p;
    return p;
  }

  private async load(gen: number): Promise<Account | null> {
    const status = await runAuthStatus(this.dir);
    const json = readClaudeJson(this.dir);
    const oauth = json?.oauthAccount;
    let value: Account | null = null;
    if (status) {
      if (status.loggedIn === false) value = null;
      else {
        value = {
          name: nameFromOauth(oauth) ?? 'Claude',
          plan: planLabel(status.subscriptionType) ?? planLabel(status.planTier),
        };
      }
    } else if (oauth && typeof oauth === 'object') {
      // claude 命令不可用时，退回 ~/.claude.json
      const o = oauth as Record<string, unknown>;
      value = { name: nameFromOauth(oauth) ?? 'Claude', plan: planLabel(o.subscriptionType ?? o.organizationType) };
    }
    if (gen !== this.gen) return null;
    this.cached = { at: Date.now(), ttl: value ? TTL_OK : TTL_FAIL, value };
    return value;
  }
}
