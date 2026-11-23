// 账号实际可用的模型：起一个不发消息的 claude 进程，发 control_request initialize，取 response.models
// （不调用模型、不耗额度、约 1 秒）。initialize 的响应里还有 account（含邮箱）等个人信息，这里只留模型字段。
// 按账号缓存并落盘（cli-models.json）；CLI 版本变了、账号重新登录 / 改 API 配置时作废。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EFFORTS, type CliModel, type CliModelList, type Effort } from '@cosyee/shared';
import { LineSplitter } from './transcript.js';
import { claudeEnv, resolveClaude, spawnSpec } from './claude/bin.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const TTL_OK = 24 * 60 * 60_000;
const TTL_FAIL = 60_000;
/** refresh 也至少间隔这么久，避免连点起一堆进程 */
const MIN_REFRESH = 10_000;
const TIMEOUT = 25_000;
const MAX_MODELS = 60;
/** 与 runner 的 --model 校验一致 */
const MODEL_RE = /^[A-Za-z0-9._:/@+[\]-]{1,120}$/;
const EFFORT_IDS = new Set<string>(EFFORTS.map((e) => e.id));

const str = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim() ? v.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max) : undefined;

/**
 * initialize 的 response → 模型列表。去掉 default（Cosyee 有自己的默认模型）、去重、只留认识的强度档位。
 * 没有可用条目返回 null（当作拉取失败，前端退回内置表）。
 */
export function parseCliModels(r: Json | null | undefined): CliModel[] | null {
  const raw: unknown[] = Array.isArray(r?.models) ? r!.models : [];
  const out: CliModel[] = [];
  const seen = new Set<string>();
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    const o = m as Json;
    const value = typeof o.value === 'string' ? o.value.trim() : '';
    if (!value || value === 'default' || !MODEL_RE.test(value) || seen.has(value)) continue;
    seen.add(value);
    const efforts: Effort[] | undefined = Array.isArray(o.supportedEffortLevels)
      ? (o.supportedEffortLevels as unknown[]).filter((e): e is Effort => typeof e === 'string' && EFFORT_IDS.has(e))
      : o.supportsEffort === true
        ? EFFORTS.map((e) => e.id)
        : undefined;
    const resolvedModel = str(o.resolvedModel, 140);
    const description = str(o.description, 200);
    out.push({
      value,
      displayName: str(o.displayName, 60) ?? value,
      ...(resolvedModel ? { resolvedModel } : {}),
      ...(description ? { description } : {}),
      ...(efforts?.length ? { efforts } : {}),
    });
    if (out.length >= MAX_MODELS) break;
  }
  return out.length ? out : null;
}

export interface FetchedModels {
  models: CliModel[];
  /** claude_code_version；用来判断落盘的缓存是否过期 */
  cli: string | null;
}

/** dir：账号的配置目录（null = 默认账号） */
export function fetchCliModels(dir?: string | null): Promise<FetchedModels | null> {
  return new Promise((resolve) => {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'];
    const spec = spawnSpec(resolveClaude(), args);
    let done = false;
    const finish = (v: FetchedModels | null) => {
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
        if (m?.type !== 'control_response' || m.response?.request_id !== 'models') continue;
        if (m.response.subtype !== 'success') return finish(null);
        const r = m.response.response;
        const models = parseCliModels(r);
        finish(models ? { models, cli: typeof r?.claude_code_version === 'string' ? r.claude_code_version : null } : null);
      }
    });
    proc.stdin!.on('error', () => { /* 进程已退出 */ });
    proc.on('error', () => finish(null));
    proc.on('close', () => finish(null));
    proc.stdin!.write(JSON.stringify({ type: 'control_request', request_id: 'models', request: { subtype: 'initialize' } }) + '\n');
  });
}

interface DiskEntry {
  at: number;
  /** 拉取时的 claude_code_version（只做记录，排查用） */
  cli: string | null;
  models: CliModel[];
}

/** 落盘的 CliModel 还原成 initialize 的字段形状，复用 parseCliModels 做校验 */
function toRaw(m: unknown): Json {
  const o = (m ?? {}) as Json;
  return { value: o.value, resolvedModel: o.resolvedModel, displayName: o.displayName, description: o.description, supportedEffortLevels: o.efforts };
}

/** cli-models.json：{ [accountId]: { at, cli, models } }。读写失败都静默（只是缓存）。 */
export class CliModelsDisk {
  private data: Record<string, DiskEntry> | null = null;
  constructor(private readonly file: string | null) {}

  private load(): Record<string, DiskEntry> {
    if (this.data) return this.data;
    this.data = {};
    if (!this.file) return this.data;
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      for (const [id, v] of Object.entries(j ?? {})) {
        const e = (v ?? {}) as Json;
        const models = Array.isArray(e.models) ? parseCliModels({ models: e.models.map(toRaw) }) : null;
        if (models && typeof e.at === 'number') this.data[id] = { at: e.at, cli: typeof e.cli === 'string' ? e.cli : null, models };
      }
    } catch { /* 没有或坏了：当空 */ }
    return this.data;
  }

  get(id: string): DiskEntry | undefined {
    return this.load()[id];
  }

  set(id: string, e: DiskEntry | null): void {
    const d = this.load();
    if (e) d[id] = e;
    else if (d[id]) delete d[id];
    else return;
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(d) + '\n', 'utf8');
      fs.renameSync(tmp, this.file);
    } catch { /* ignore */ }
  }
}

export interface CliModelsProviderOpts {
  id: string;
  fetcher: () => Promise<FetchedModels | null>;
  disk?: CliModelsDisk;
  now?: () => number;
}

export class CliModelsProvider {
  private cached: { at: number; ttl: number; value: CliModelList | null } | null = null;
  private pending: Promise<CliModelList | null> | null = null;
  /** reset 时递增：旧账号还在路上的结果直接丢弃 */
  private gen = 0;
  /** 从落盘恢复的：第一次 get 先返回它，同时后台重拉 */
  private revalidate = false;
  private readonly now: () => number;

  constructor(private readonly o: CliModelsProviderOpts) {
    this.now = o.now ?? Date.now;
    // 落盘的先直接用（菜单秒开），本进程第一次 get 时再在后台重拉一次——CLI 升级后模型表可能变了
    const e = o.disk?.get(o.id);
    if (e) {
      this.cached = { at: e.at, ttl: TTL_OK, value: { models: e.models, at: e.at } };
      this.revalidate = true;
    }
  }

  /** 账号重新登录 / 改了 API 配置：清掉缓存、在途请求与落盘条目 */
  reset(): void {
    this.gen++;
    this.cached = null;
    this.pending = null;
    this.o.disk?.set(this.o.id, null);
  }

  async get(refresh = false): Promise<CliModelList | null> {
    const c = this.cached;
    if (this.revalidate && c) {
      this.revalidate = false;
      if (!refresh) {
        void this.load();
        return c.value;
      }
    }
    if (c && this.now() - c.at < (refresh ? MIN_REFRESH : c.ttl)) return c.value;
    return this.load();
  }

  private load(): Promise<CliModelList | null> {
    if (this.pending) return this.pending;
    const gen = this.gen;
    const p: Promise<CliModelList | null> = this.o.fetcher()
      .catch(() => null)
      .then((r) => {
        if (gen !== this.gen) return null;
        const at = this.now();
        if (r) {
          const value = { models: r.models, at };
          this.cached = { at, ttl: TTL_OK, value };
          this.o.disk?.set(this.o.id, { at, cli: r.cli, models: r.models });
          return value;
        }
        // 失败时保留上一次的成功结果，过一会再试
        const keep = this.cached?.value ?? null;
        this.cached = { at, ttl: TTL_FAIL, value: keep };
        return keep;
      })
      .finally(() => {
        if (this.pending === p) this.pending = null;
      });
    this.pending = p;
    return p;
  }
}
