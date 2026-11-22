import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolStatsStore, countToolUses } from './toolStats.js';

let tmp: string;
let root: string;
let cacheFile: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cz-toolstats-'));
  root = path.join(tmp, 'projects');
  cacheFile = path.join(tmp, 'home', 'tool-stats.json');
  fs.mkdirSync(path.join(root, 'proj'), { recursive: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const use = (id: string, name: string) => ({ type: 'tool_use', id, name, input: {} });
const assistant = (...blocks: object[]) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: blocks } });
/** 请求体副本：里面也有 assistant 消息与 tool_use，不能重复计数 */
const blob = (...blocks: object[]) =>
  JSON.stringify({ type: 'api-request-blob', body: { messages: [{ role: 'assistant', content: blocks }] } });
const user = () => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } });

const write = (rel: string, lines: string[]) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, lines.map((l) => `${l}\n`).join(''));
  return f;
};

describe('countToolUses', () => {
  it('只数 assistant 行里的 tool_use，同一 id 只算一次，忽略请求体副本', () => {
    const counts: Record<string, number> = {};
    const seen = new Set<string>();
    countToolUses(
      [
        assistant(use('a', 'Bash'), { type: 'text', text: 'hi' }, use('b', 'Read')),
        blob(use('a', 'Bash'), use('b', 'Read')),
        assistant(use('a', 'Bash')),
        user(),
        'not json "tool_use" "assistant"',
        '',
      ],
      counts,
      seen,
    );
    expect(counts).toEqual({ Bash: 1, Read: 1 });
  });


  it('传了 skills 时按 skill 名计数：Skill 工具的 input.skill 与用户的 /名字（isMeta 注入正文不算）', () => {
    const counts: Record<string, number> = {};
    const skills: Record<string, number> = {};
    const cmd = (name: string, meta = false) =>
      JSON.stringify({ type: 'user', ...(meta ? { isMeta: true } : {}), message: { role: 'user', content: `<command-message>${name}</command-message>
<command-name>/${name}</command-name>` } });
    countToolUses(
      [
        assistant({ type: 'tool_use', id: 's1', name: 'Skill', input: { skill: 'anthropic-skills:pdf' } }),
        assistant({ type: 'tool_use', id: 's2', name: 'Skill', input: { skill: 'pdf', args: 'x' } }),
        assistant({ type: 'tool_use', id: 's1', name: 'Skill', input: { skill: 'anthropic-skills:pdf' } }),
        cmd('frontend-design'),
        cmd('frontend-design', true),
        JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '<command-name>/clear</command-name>' }] } }),
      ],
      counts,
      new Set(),
      skills,
    );
    expect(counts).toEqual({ Skill: 2 });
    expect(skills).toEqual({ 'anthropic-skills:pdf': 1, pdf: 1, 'frontend-design': 1, clear: 1 });
  });
});

describe('ToolStatsStore', () => {
  it('合计所有会话与子智能体记录；增量读新增行，结果落盘后新实例接着用', async () => {
    const main = write('proj/s1.jsonl', [assistant(use('a', 'Bash')), user()]);
    write('proj/s1/subagents/agent-1.jsonl', [assistant(use('c', 'Read'), use('d', 'Read'))]);
    write('proj/s2.jsonl', [assistant(use('e', 'Agent'))]);
    // 子目录里不是 subagents 的东西不算
    write('proj/s2/other/x.jsonl', [assistant(use('f', 'Glob'))]);

    const store = new ToolStatsStore(() => root, cacheFile);
    const first = await store.get();
    expect(first.counts).toEqual({ Bash: 1, Read: 2, Agent: 1 });
    expect(first.sessions).toBe(2);
    expect(fs.existsSync(cacheFile)).toBe(true);

    // 追加一行完整的 + 半行（还没写完的行不计，下次补齐后再计）
    const half = assistant(use('g', 'Grep'));
    fs.appendFileSync(main, `${assistant(use('h', 'Bash'))}\n${half.slice(0, 20)}`);
    expect((await store.get()).counts).toEqual({ Bash: 2, Read: 2, Agent: 1 });
    fs.appendFileSync(main, `${half.slice(20)}\n`);
    expect((await store.get()).counts).toEqual({ Bash: 2, Read: 2, Agent: 1, Grep: 1 });

    // 新实例从缓存继续：缓存里的偏移有效时不会重新计数
    const again = new ToolStatsStore(() => root, cacheFile);
    expect((await again.get()).counts).toEqual({ Bash: 2, Read: 2, Agent: 1, Grep: 1 });
  });

  it('文件变短就从头重扫；文件删除后它的计数去掉', async () => {
    const f = write('proj/s1.jsonl', [assistant(use('a', 'Bash')), assistant(use('b', 'Bash'))]);
    const g = write('proj/s2.jsonl', [assistant(use('c', 'Read'))]);
    const store = new ToolStatsStore(() => root, cacheFile);
    expect((await store.get()).counts).toEqual({ Bash: 2, Read: 1 });

    fs.writeFileSync(f, `${assistant(use('z', 'Glob'))}\n`);
    fs.rmSync(g);
    const s = await store.get();
    expect(s.counts).toEqual({ Glob: 1 });
    expect(s.sessions).toBe(1);
  });

  it('并发请求共用同一次扫描；目录不存在时返回空', async () => {
    const store = new ToolStatsStore(() => path.join(tmp, 'missing'), cacheFile);
    const [a, b] = [store.get(), store.get()];
    expect(a).toBe(b);
    expect(await a).toMatchObject({ counts: {}, sessions: 0 });
  });
});
