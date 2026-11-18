import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { toContextUsage } from './context.js';

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../shared/fixtures');

function realResponse(): Record<string, any> {
  const lines = fs.readFileSync(path.join(FIX, 'control-probe.jsonl'), 'utf8').split('\n').filter(Boolean);
  for (const l of lines) {
    const j = JSON.parse(l);
    if (j.type === 'control_response' && j.response?.request_id === 'c0') return j.response.response;
  }
  throw new Error('fixture 里没有 c0 响应');
}

describe('toContextUsage', () => {
  const raw = realResponse();
  const u = toContextUsage(raw, 123);

  it('总量与百分比', () => {
    expect(u.usedTokens).toBe(22746);
    expect(u.totalTokens).toBe(150000);
    expect(u.percent).toBe(15);
    expect(u.untilAutocompact).toBe(117000 - 22746);
    expect(u.at).toBe(123);
  });

  it('categories：used / buffer / free 共 7 项，deferred 单列', () => {
    expect(u.categories.map((c) => [c.name, c.tokens])).toEqual([
      ['System prompt', 3361],
      ['System tools', 9849],
      ['Custom agents', 239],
      ['Skills', 3608],
      ['Messages', 5689],
      ['Autocompact buffer', 33000],
      ['Free space', 94254],
    ]);
    expect(u.categories[0]!.percent).toBeCloseTo((3361 / 150000) * 100, 5);
    expect(u.deferred).toEqual([{ name: 'System tools (deferred)', tokens: 14052 }]);
  });

  it('agents 不带 path 字段；mcpTools 为空', () => {
    expect(u.agents.length).toBeGreaterThan(0);
    for (const a of u.agents) expect(Object.keys(a).sort()).toEqual(['name', 'tokens']);
    expect(u.mcpTools).toEqual([]);
    expect(JSON.stringify(u)).not.toContain('path');
    expect(JSON.stringify(u)).not.toMatch(/[A-Za-z]:\\\\/);
  });

  it('自动压缩关闭时 untilAutocompact 为 null；缺字段不抛错', () => {
    expect(toContextUsage({ ...raw, isAutoCompactEnabled: false }).untilAutocompact).toBeNull();
    const empty = toContextUsage({});
    expect(empty.totalTokens).toBe(0);
    expect(empty.percent).toBe(0);
    expect(empty.categories).toEqual([]);
  });

  it('skills：只有 get_context_usage 时取 skillFrontmatter，全部为 on，不带 path', () => {
    expect(u.skills.length).toBe(17);
    expect(u.skills.find((s) => s.name === 'ax-supervise')).toEqual({ name: 'ax-supervise', mode: 'on', tokens: 86, source: 'userSettings' });
    expect(u.skills.map((s) => s.name)).toEqual([...u.skills.map((s) => s.name)].sort((a, b) => a.localeCompare(b)));
    for (const s of u.skills) expect(Object.keys(s).sort()).toEqual(['mode', 'name', 'source', 'tokens']);
  });

  it('skills：按 init 顺序合并前缀名，叠加状态，补上已关闭的', () => {
    const r = toContextUsage(
      {
        skills: {
          skillFrontmatter: [
            { name: 'pdf', source: 'syncedSkills', tokens: 50, path: 'x' },
            { name: 'impeccable', source: 'userSettings', tokens: 60 },
          ],
        },
      },
      1,
      {
        initSkills: ['impeccable', 'schedule', 'anthropic-skills:pdf'],
        overrides: { schedule: 'user-invocable-only', init: 'off', impeccable: 'name-only' },
        cosyeeOverrides: { 'anthropic-skills:xlsx': 'off', schedule: 'user-invocable-only', gone: 'on' },
      },
    );
    expect(r.skills).toEqual([
      { name: 'impeccable', mode: 'on', tokens: 60, source: 'userSettings' },
      { name: 'init', mode: 'off', tokens: null, source: null },
      { name: 'anthropic-skills:pdf', mode: 'on', tokens: 50, source: 'syncedSkills' },
      { name: 'schedule', mode: 'user-invocable-only', tokens: null, source: null },
      { name: 'anthropic-skills:xlsx', mode: 'off', tokens: null, source: 'plugin' },
    ]);
    // 刚从「关」切回「开」：init 里还没有，但 frontmatter 已有（不带前缀），合并成一条
    const back = toContextUsage({ skills: { skillFrontmatter: [{ name: 'xlsx', source: 'syncedSkills', tokens: 9 }] } }, 1, {
      initSkills: [],
      cosyeeOverrides: { 'anthropic-skills:xlsx': 'on' },
    });
    expect(back.skills).toEqual([{ name: 'anthropic-skills:xlsx', mode: 'on', tokens: 9, source: 'syncedSkills' }]);
  });

  it('skills：磁盘上的 skill 一并列出（含已关闭 / 还没加载的），标出能否移除；刚移除的藏起来', () => {
    const disk = [
      { name: 'mine', source: 'userSettings' as const, dir: '/u/mine', removable: true },
      { name: 'proj', source: 'projectSettings' as const, dir: '/p/proj', removable: true },
      { name: 'anthropic-skills:pdf', source: 'plugin' as const, dir: '/pl/pdf', removable: false },
      { name: 'gone', source: 'userSettings' as const, dir: '/u/gone', removable: true },
    ];
    const r = toContextUsage({ skills: { skillFrontmatter: [{ name: 'mine', source: 'userSettings', tokens: 7 }] } }, 1, {
      initSkills: ['mine'],
      diskSkills: disk,
      hidden: ['gone'],
      // settings.json 里关掉的、磁盘上没有的内置 skill 也要列出来
      overrides: { 'skill-creator': 'off', verify: 'on' },
    });
    expect(r.skills.map((x) => x.name).sort()).toEqual(['anthropic-skills:pdf', 'mine', 'proj', 'skill-creator']);
    const by = (n: string) => r.skills.find((x) => x.name === n)!;
    expect(by('mine')).toMatchObject({ mode: 'on', tokens: 7, removable: true });
    // 磁盘上有、进程里没加载：用磁盘来源，状态按 on 处理但没有 token
    expect(by('proj')).toMatchObject({ mode: 'on', tokens: null, source: 'projectSettings', removable: true });
    expect(by('anthropic-skills:pdf')).toMatchObject({ source: 'plugin', removable: false });
    expect(by('skill-creator')).toMatchObject({ mode: 'off', tokens: null });
  });

  it('mcpServers：以 mcp_status 为准，工具 token 按规范化名匹配', () => {
    const r = toContextUsage(
      {
        mcpTools: [
          { name: 'mcp__claude_ai_Docs__read', serverName: 'claude_ai_Docs', tokens: 30 },
          { name: 'mcp__claude_ai_Docs__extra', serverName: 'claude_ai_Docs', tokens: 5 },
        ],
      },
      1,
      {
        mcpStatus: {
          mcpServers: [
            { name: 'claude.ai Docs', status: 'connected', tools: [{ name: 'read' }, { name: 'query' }], scope: 'claudeai' },
            { name: 'local', status: 'disabled', tools: [] },
          ],
        },
      },
    );
    expect(r.mcpServers).toEqual([
      {
        name: 'claude.ai Docs',
        status: 'connected',
        tokens: 35,
        tools: [
          { name: 'read', tokens: 30 },
          { name: 'query', tokens: null },
          { name: 'extra', tokens: 5 },
        ],
      },
      { name: 'local', status: 'disabled', tokens: 0, tools: [] },
    ]);
  });

  it('mcpServers：没有 mcp_status 时按 serverName 分组，状态 unknown', () => {
    const r = toContextUsage({ mcpTools: [{ name: 'mcp__s__a', serverName: 's', tokens: 2 }, { name: 'mcp__s__b', serverName: 's', tokens: 3 }] });
    expect(r.mcpServers).toEqual([{ name: 's', status: 'unknown', tokens: 5, tools: [{ name: 'a', tokens: 2 }, { name: 'b', tokens: 3 }] }]);
  });

  it('mcpTools 取 serverName', () => {
    const r = toContextUsage({ totalTokens: 10, maxTokens: 100, mcpTools: [{ name: 't', serverName: 's', tokens: 5, isLoaded: true }] });
    expect(r.mcpTools).toEqual([{ name: 't', server: 's', tokens: 5 }]);
  });

  it('tools：有就带上，没有就不出现', () => {
    expect(toContextUsage({}, 0, { tools: ['Bash', 'Read'] }).tools).toEqual(['Bash', 'Read']);
    expect('tools' in toContextUsage({}, 0, {})).toBe(false);
  });
});
