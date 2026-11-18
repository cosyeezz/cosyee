// 多账号的 MCP 共享：MCP 配置（用户级 mcpServers、各项目的 MCP 服务器与启用 / 禁用、信任与已允许的工具）
// 存在各账号自己的 .claude.json 里，没法用链接共享（.claude.json 里还有登录信息）。
// 这里做三方同步：基础账号的 .claude.json 为「主」，每个账号目录里存一份上次同步后的快照（.cosyee-mcp-sync.json）。
//   推：账号里与快照不同的项 = 该账号期间改过的，写回主文件；
//   拉：主文件的值写进账号文件，快照更新为主文件的值。
// 只在账号没有 claude 进程时调用（激活时、服务启动时、启动第一个会话进程前），避免与 CLI 自己的写入冲突。
import fs from 'node:fs';
import path from 'node:path';

type Json = Record<string, unknown>;

const TOP_KEYS = ['mcpServers'] as const;
const PROJECT_KEYS = [
  'mcpServers',
  'enabledMcpjsonServers',
  'disabledMcpjsonServers',
  'disabledMcpServers',
  'mcpContextUris',
  'hasTrustDialogAccepted',
  'allowedTools',
] as const;

export const SNAPSHOT_FILE = '.cosyee-mcp-sync.json';

/** 空值（{} / [] / false / null）视为「没设置」：CLI 新建项目条目时会写入这些默认值，不应当作改动 */
function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null || v === false) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v as object).length === 0;
  return false;
}

function obj(v: unknown): Json | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
}

/** 键 = JSON 数组 [范围, 项目路径, 字段]，值 = 字段值的 JSON 字符串 */
function flatten(j: Json): Map<string, string> {
  const out = new Map<string, string>();
  for (const k of TOP_KEYS) if (!isEmpty(j[k])) out.set(JSON.stringify(['top', '', k]), JSON.stringify(j[k]));
  const projects = obj(j.projects);
  if (projects) {
    for (const [p, raw] of Object.entries(projects)) {
      const o = obj(raw);
      if (!o) continue;
      for (const k of PROJECT_KEYS) if (!isEmpty(o[k])) out.set(JSON.stringify(['project', p, k]), JSON.stringify(o[k]));
    }
  }
  return out;
}

/** 把一个键的值写进 j（value 为 undefined 表示删除）；返回是否有变化 */
function apply(j: Json, key: string, value: string | undefined): boolean {
  const [scope, project, field] = JSON.parse(key) as [string, string, string];
  let target: Json;
  if (scope === 'top') target = j;
  else {
    let projects = obj(j.projects);
    if (!projects) {
      if (value === undefined) return false;
      projects = j.projects = {};
    }
    let p = obj(projects[project]);
    if (!p) {
      if (value === undefined) return false;
      p = projects[project] = {};
    }
    target = p;
  }
  if (value === undefined) {
    if (!(field in target)) return false;
    delete target[field];
    return true;
  }
  if (JSON.stringify(target[field]) === value) return false;
  target[field] = JSON.parse(value);
  return true;
}

type ReadResult = { ok: true; json: Json; exists: boolean } | { ok: false };

function readJsonFile(file: string): ReadResult {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, json: {}, exists: false };
    return { ok: false };
  }
  try {
    const j = obj(JSON.parse(text));
    return j ? { ok: true, json: j, exists: true } : { ok: false };
  } catch {
    // 解析失败（可能正被别的进程写到一半）：这次不同步，绝不覆盖
    return { ok: false };
  }
}

/** 原子写：临时文件再改名；目标是符号链接时写到它指向的文件 */
export function writeJsonAtomic(file: string, j: unknown): void {
  let real = file;
  try {
    real = fs.realpathSync(file);
  } catch { /* 不存在 */ }
  const tmp = `${real}.cosyee-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2), 'utf8');
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, real);
      return;
    } catch (e) {
      if (i >= 5) {
        fs.rmSync(tmp, { force: true });
        throw e;
      }
      const until = Date.now() + 30 * (i + 1);
      while (Date.now() < until) { /* Windows 上目标被占用时短暂重试 */ }
    }
  }
}

export interface SyncResult {
  pushed: number;
  pulled: number;
}

/**
 * 同步一个账号的 .claude.json（accountFile）与主文件（masterFile）里的 MCP 相关配置。
 * snapshotFile 不存在（第一次同步）时只拉不推：主文件为准。任一文件读不了就什么都不做。
 */
export function syncMcp(masterFile: string, accountFile: string, snapshotFile: string): SyncResult | null {
  const m = readJsonFile(masterFile);
  const a = readJsonFile(accountFile);
  if (!m.ok || !a.ok) return null;
  const snapRead = readJsonFile(snapshotFile);
  const snap = new Map<string, string>();
  const first = !snapRead.ok || !snapRead.exists;
  if (snapRead.ok) {
    const s = obj(snapRead.json.values);
    if (s) for (const [k, v] of Object.entries(s)) if (typeof v === 'string') snap.set(k, v);
  }

  const master = m.json;
  const account = a.json;
  const accFlat = flatten(account);
  let pushed = 0;
  if (!first) {
    for (const k of new Set([...accFlat.keys(), ...snap.keys()])) {
      const v = accFlat.get(k);
      if (v === snap.get(k)) continue;
      if (apply(master, k, v)) pushed++;
    }
  }
  const masterFlat = flatten(master);
  let pulled = 0;
  for (const k of new Set([...masterFlat.keys(), ...accFlat.keys()])) {
    const v = masterFlat.get(k);
    if (v === accFlat.get(k)) continue;
    if (apply(account, k, v)) pulled++;
  }

  if (pushed > 0) writeJsonAtomic(masterFile, master);
  if (pulled > 0) writeJsonAtomic(accountFile, account);
  const values = Object.fromEntries(masterFlat);
  const prev = snapRead.ok ? JSON.stringify(obj(snapRead.json.values) ?? {}) : '';
  if (first || prev !== JSON.stringify(values)) {
    fs.mkdirSync(path.dirname(snapshotFile), { recursive: true });
    writeJsonAtomic(snapshotFile, { version: 1, values });
  }
  return { pushed, pulled };
}
