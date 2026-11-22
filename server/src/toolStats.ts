// 跨会话的工具累计调用次数：扫描 projects 下所有会话记录（含子智能体的 agent-*.jsonl），按工具名计数。
// 会话记录只追加不改写，所以每个文件记下已读到的字节位置，之后只读新增部分；结果落盘到 ~/.cosyee/tool-stats.json，
// 重启后也是增量扫描。文件变短（被改写）就从头重扫；文件不在了（会话被删除）它的计数一并去掉。
// 只数 type:"assistant" 行里的 tool_use：同一文件里的 api-request-blob 行是请求体副本，会重复出现同一批 tool_use。
// 同时按 skill 名计数：模型调用 Skill 工具（input.skill）与用户输入 /名字（user 行的 <command-name>）。
// 斜杠命令里也有 /clear 之类的内置命令，这里不区分，前端只取 skill 列表里有的名字。
import fs from 'node:fs';
import path from 'node:path';
import type { ToolStats } from '@cosyee/shared';
import { cosyeeHome, projectsDir } from './paths.js';
import { parseLine } from './transcript.js';

interface FileEntry {
  /** 已统计到的字节位置（总在某个换行之后） */
  offset: number;
  counts: Record<string, number>;
  /** skill 名 -> 调用次数（模型调用 + 用户 /名字） */
  skills: Record<string, number>;
}

interface CacheFile {
  /** v2 起带 skills；v1 缓存直接丢弃重扫 */
  v: 2;
  files: Record<string, FileEntry>;
}

const CHUNK = 4 * 1024 * 1024;
const NL = 0x0a;

const CMD_NAME_RE = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/;

/** user 行的文字（字符串或 text 块拼接） */
function userText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('\n');
}

/**
 * 统计一段完整行里的工具调用，累加到 counts；seen 用来去掉同一文件里重复的 tool_use id。
 * 传了 skills 时顺带按 skill 名计数（Skill 工具的 input.skill；用户输入的 /名字）。
 */
export function countToolUses(
  lines: Iterable<string>,
  counts: Record<string, number>,
  seen?: Set<string>,
  skills?: Record<string, number>,
): void {
  const addSkill = (name: unknown): void => {
    if (!skills || typeof name !== 'string') return;
    const n = name.trim().replace(/^\//, '');
    if (n) skills[n] = (skills[n] ?? 0) + 1;
  };
  for (const line of lines) {
    // 用户输入 /名字：只看真实的 user 行（isMeta 是注入的正文，不算）
    if (skills && line.includes('<command-name>') && line.includes('"user"')) {
      const e = parseLine(line);
      if (e?.type === 'user' && !e.isMeta) {
        const m = CMD_NAME_RE.exec(userText(e.message?.content));
        if (m) addSkill(m[1]);
      }
      continue;
    }
    // 绝大多数行没有工具调用，先用字符串判断，省掉 JSON 解析
    if (!line.includes('"tool_use"') || !line.includes('"assistant"')) continue;
    const e = parseLine(line);
    if (e?.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
    for (const b of e.message.content) {
      if (b?.type !== 'tool_use' || typeof b.name !== 'string' || !b.name) continue;
      if (seen && typeof b.id === 'string') {
        if (seen.has(b.id)) continue;
        seen.add(b.id);
      }
      counts[b.name] = (counts[b.name] ?? 0) + 1;
      if (b.name === 'Skill') addSkill(b.input?.skill);
    }
  }
}

/** 从 offset 读到文件末尾最后一个换行，返回新的 offset（没有完整新行时不变） */
async function scanFrom(
  file: string,
  offset: number,
  size: number,
  counts: Record<string, number>,
  skills: Record<string, number>,
): Promise<number> {
  const fh = await fs.promises.open(file, 'r');
  const seen = new Set<string>();
  try {
    let pos = offset;
    let carry = Buffer.alloc(0);
    while (pos < size) {
      const buf = Buffer.alloc(Math.min(CHUNK, size - pos));
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (bytesRead <= 0) break;
      pos += bytesRead;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      const end = data.lastIndexOf(NL);
      if (end < 0) {
        carry = Buffer.from(data);
        continue;
      }
      countToolUses(data.subarray(0, end).toString('utf8').split('\n'), counts, seen, skills);
      carry = Buffer.from(data.subarray(end + 1));
      offset = pos - carry.length;
    }
    return offset;
  } finally {
    await fh.close();
  }
}

/** projects 下所有会话记录：<项目>/<会话>.jsonl 与 <项目>/<会话>/subagents/agent-*.jsonl */
async function listTranscripts(root: string): Promise<{ files: string[]; sessions: number }> {
  const files: string[] = [];
  let sessions = 0;
  const dirs = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const proj = path.join(root, d.name);
    const items = await fs.promises.readdir(proj, { withFileTypes: true }).catch(() => []);
    for (const it of items) {
      if (it.isFile() && it.name.endsWith('.jsonl')) {
        files.push(path.join(proj, it.name));
        sessions++;
      } else if (it.isDirectory()) {
        const sub = path.join(proj, it.name, 'subagents');
        const agents = await fs.promises.readdir(sub).catch(() => [] as string[]);
        for (const a of agents) if (a.startsWith('agent-') && a.endsWith('.jsonl')) files.push(path.join(sub, a));
      }
    }
  }
  return { files, sessions };
}

export class ToolStatsStore {
  private cache: CacheFile | null = null;
  private running: Promise<ToolStats> | null = null;

  constructor(
    private readonly root: () => string = projectsDir,
    private readonly cacheFile: string = path.join(cosyeeHome(), 'tool-stats.json'),
  ) {}

  /** 增量扫描并返回合计；同时只跑一次，并发请求共用结果 */
  get(): Promise<ToolStats> {
    this.running ??= this.scan().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async load(): Promise<CacheFile> {
    if (this.cache) return this.cache;
    try {
      const j = JSON.parse(await fs.promises.readFile(this.cacheFile, 'utf8'));
      if (j?.v === 2 && j.files && typeof j.files === 'object') return (this.cache = j as CacheFile);
    } catch {
      // 没有缓存或已损坏：从头扫
    }
    return (this.cache = { v: 2, files: {} });
  }

  private async scan(): Promise<ToolStats> {
    const cache = await this.load();
    const { files, sessions } = await listTranscripts(this.root());
    const next: Record<string, FileEntry> = {};
    let changed = files.length !== Object.keys(cache.files).length;
    for (const f of files) {
      const st = await fs.promises.stat(f).catch(() => null);
      if (!st) continue;
      let ent = cache.files[f];
      if (!ent || st.size < ent.offset) ent = { offset: 0, counts: {}, skills: {} };
      if (st.size > ent.offset) {
        const counts = { ...ent.counts };
        const skills = { ...ent.skills };
        try {
          const offset = await scanFrom(f, ent.offset, st.size, counts, skills);
          if (offset !== ent.offset) {
            ent = { offset, counts, skills };
            changed = true;
          }
        } catch {
          // 读失败（被占用 / 刚被删）：沿用上次的结果
        }
      }
      next[f] = ent;
    }
    cache.files = next;
    if (changed) await this.save(cache);

    const counts: Record<string, number> = {};
    const skills: Record<string, number> = {};
    for (const e of Object.values(next)) {
      for (const [k, n] of Object.entries(e.counts)) counts[k] = (counts[k] ?? 0) + n;
      for (const [k, n] of Object.entries(e.skills ?? {})) skills[k] = (skills[k] ?? 0) + n;
    }
    return { counts, skills, sessions, at: Date.now() };
  }

  private async save(cache: CacheFile): Promise<void> {
    try {
      await fs.promises.mkdir(path.dirname(this.cacheFile), { recursive: true });
      const tmp = `${this.cacheFile}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(cache));
      await fs.promises.rename(tmp, this.cacheFile);
    } catch {
      // 写缓存失败不影响结果，下次重扫
    }
  }
}
