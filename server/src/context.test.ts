import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { toContextUsage } from './context.js';
import type { SkillMode } from '@cosyee/shared';

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

  it('skills：init 还没到时（null）不推定已删除，保留 cosyeeOverrides 里的 on 状态 skill', () => {
    const r = toContextUsage({ skills: { skillFrontmatter: [] } }, 1, {
      initSkills: null,
      cosyeeOverrides: { ghost: 'on' as SkillMode },
    });
    expect(r.skills.map((s) => s.name)).toContain('ghost');
    expect(r.skills.find((s) => s.name === 'ghost')).toMatchObject({ mode: 'on', tokens: null });
  });

  it('skills：cosyeeOverrides 里的裸键若已有同名带前缀 skill 则不重复列出，无对应带前缀条目时仍列出', () => {
    // 1. init 里已有带前缀名：裸键只作设置回退，不作为独立条目列出
    const r1 = toContextUsage({ skills: { skillFrontmatter: [] } }, 1, {
      initSkills: ['anthropic-skills:xlsx'],
      cosyeeOverrides: { xlsx: 'user-invocable-only' },
    });
    expect(r1.skills).toEqual([{ name: 'anthropic-skills:xlsx', mode: 'user-invocable-only', tokens: null, source: 'plugin' }]);

    // 2. cosyeeOverrides 里裸键排在带前缀键之前：仍只列出带前缀条目
    const r2 = toContextUsage({ skills: { skillFrontmatter: [] } }, 1, {
      initSkills: [],
      cosyeeOverrides: { docs: 'off', 'anthropic-skills:docs': 'off' },
    });
    expect(r2.skills).toEqual([{ name: 'anthropic-skills:docs', mode: 'off', tokens: null, source: 'plugin' }]);

    // 3. 没有对应带前缀条目的裸键：仍然列出
    const r3 = toContextUsage({ skills: { skillFrontmatter: [] } }, 1, {
      initSkills: [],
      cosyeeOverrides: { schedule: 'user-invocable-only' },
    });
    expect(r3.skills).toEqual([{ name: 'schedule', mode: 'user-invocable-only', tokens: null, source: null }]);
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

  it('toolTokens：当前 CLI 不给单个工具占用时不出现；给了就合并常驻与延迟加载', () => {
    expect('toolTokens' in u).toBe(false);
    const t = toContextUsage(
      {
        systemTools: [{ name: 'Bash', tokens: 900 }, { name: 'Read', tokens: 400 }],
        deferredBuiltinTools: [
          { name: 'WebFetch', tokens: 300, isLoaded: false },
          { name: 'Monitor', tokens: 200, isLoaded: true },
          { name: 'Bash', tokens: 1, isLoaded: false },
        ],
      },
      0,
    );
    expect(t.toolTokens).toEqual([
      { name: 'Bash', tokens: 900 },
      { name: 'Read', tokens: 400 },
      { name: 'WebFetch', tokens: 300, deferred: true },
      { name: 'Monitor', tokens: 200 },
    ]);
  });
  it('描述原文：skill 按完整名或去前缀名取，智能体整表下发，过长截断；没有就不带', () => {
    const raw = { skills: { skillFrontmatter: [{ name: 'pdf', tokens: 10 }, { name: 'impeccable', tokens: 5 }, { name: 'none', tokens: 1 }] } };
    const u = toContextUsage(raw, 1, {
      initSkills: ['anthropic-skills:pdf', 'impeccable', 'none'],
      skillDescriptions: new Map([['pdf', 'PDF 工具'], ['impeccable', 'x'.repeat(5000)]]),
      agentDescriptions: new Map([['Explore', '只读搜索']]),
    });
    const by = Object.fromEntries(u.skills.map((s) => [s.name, s]));
    expect(by['anthropic-skills:pdf']!.description).toBe('PDF 工具');
    expect(by.impeccable!.description!.length).toBe(4001);
    expect('description' in by.none!).toBe(false);
    expect(u.agentDescriptions).toEqual({ Explore: '只读搜索' });
    expect('agentDescriptions' in toContextUsage(raw, 1, {})).toBe(false);
  });

  it('mcpServers：带上 mcp_status 的工具描述；cosyee 自带工具缺描述时补上注册的定义', () => {
    const u = toContextUsage({ mcpTools: [{ name: 'mcp__cosyee__delegate', serverName: 'cosyee', tokens: 900 }] }, 1, {
      mcpStatus: {
        mcpServers: [
          { name: 'gh', status: 'connected', tools: [{ name: 'search', description: '  搜索仓库 ' }, { name: 'plain' }] },
          { name: 'cosyee', status: 'connected', tools: [{ name: 'delegate' }] },
        ],
      },
    });
    const gh = u.mcpServers.find((s) => s.name === 'gh')!;
    expect(gh.tools).toEqual([{ name: 'search', tokens: null, description: '搜索仓库' }, { name: 'plain', tokens: null }]);
    const co = u.mcpServers.find((s) => s.name === 'cosyee')!;
    expect(co.tools[0]!.tokens).toBe(900);
    expect(co.tools[0]!.description).toMatch(/^Launch a delegate agent[\s\S]*input_schema: \{/);
  });

  it('分类明细：把 cosyee 工具的常驻与延迟 token 从 MCP tools 挪到 System tools，总和不变', () => {
    const u = toContextUsage({
      maxTokens: 10000,
      totalTokens: 3000,
      categories: [
        { name: 'System tools', tokens: 1000, kind: 'used', color: 'c-sys' },
        { name: 'MCP tools', tokens: 1500, kind: 'used', color: 'c-mcp' },
        { name: 'Messages', tokens: 500, kind: 'used' },
        { name: 'MCP tools (deferred)', tokens: 400, kind: 'deferred' },
        { name: 'System tools (deferred)', tokens: 600, kind: 'deferred' },
      ],
      mcpTools: [
        { name: 'mcp__cosyee__delegate', serverName: 'cosyee', tokens: 900 },
        { name: 'mcp__cosyee__delegate_agents', server: 'cosyee', tokens: 250, isLoaded: false },
        { name: 'mcp__github__search', serverName: 'github', tokens: 600 },
        { name: 'mcp__github__list', serverName: 'github', tokens: 150, isLoaded: false },
      ],
    }, 1);
    expect(u.categories).toEqual([
      { name: 'System tools', tokens: 1900, percent: 19, color: 'c-sys' },
      { name: 'MCP tools', tokens: 600, percent: 6, color: 'c-mcp' },
      { name: 'Messages', tokens: 500, percent: 5 },
    ]);
    expect(u.categories.reduce((s, c) => s + c.tokens, 0)).toBe(3000);
    expect(u.deferred).toEqual([
      { name: 'MCP tools (deferred)', tokens: 150 },
      { name: 'System tools (deferred)', tokens: 850 },
    ]);
    expect(u.deferred.reduce((s, d) => s + d.tokens, 0)).toBe(1000);
  });

  it('分类明细：源项归零则去掉；目标项不存在则在源项原位置新建并沿用 color', () => {
    const u = toContextUsage({
      maxTokens: 10000,
      totalTokens: 2000,
      categories: [
        { name: 'System prompt', tokens: 500, kind: 'used' },
        { name: 'MCP tools', tokens: 900, kind: 'used', color: 'c-mcp' },
        { name: 'Messages', tokens: 600, kind: 'used' },
        { name: 'MCP tools (deferred)', tokens: 300, kind: 'deferred' },
      ],
      mcpTools: [
        { name: 'mcp__cosyee__delegate', serverName: 'cosyee', tokens: 900 },
        { name: 'mcp__cosyee__delegate_agents', serverName: 'cosyee', tokens: 300, isLoaded: false },
      ],
    }, 1);
    expect(u.categories).toEqual([
      { name: 'System prompt', tokens: 500, percent: 5 },
      { name: 'System tools', tokens: 900, percent: 9, color: 'c-mcp' },
      { name: 'Messages', tokens: 600, percent: 6 },
    ]);
    expect(u.deferred).toEqual([{ name: 'System tools (deferred)', tokens: 300 }]);
  });

  it('分类明细：超量截断、无源项、无 cosyee 工具时的边界行为', () => {
    // 超量截断：cosyee 声称 2000，但 MCP tools 只有 500 -> 最多挪 500，总和不变
    const capped = toContextUsage({
      maxTokens: 10000,
      totalTokens: 1500,
      categories: [
        { name: 'System tools', tokens: 1000, kind: 'used' },
        { name: 'MCP tools', tokens: 500, kind: 'used' },
        { name: 'MCP tools (deferred)', tokens: 100, kind: 'deferred' },
      ],
      mcpTools: [
        { name: 'mcp__cosyee__delegate', serverName: 'cosyee', tokens: 2000 },
        { name: 'mcp__cosyee__delegate_agents', serverName: 'cosyee', tokens: 500, isLoaded: false },
      ],
    }, 1);
    expect(capped.categories).toEqual([{ name: 'System tools', tokens: 1500, percent: 15 }]);
    expect(capped.deferred).toEqual([{ name: 'System tools (deferred)', tokens: 100 }]);

    // 无源项：不新建 System tools，结果不变
    const noSrc = toContextUsage({
      maxTokens: 10000,
      totalTokens: 500,
      categories: [{ name: 'Messages', tokens: 500, kind: 'used' }],
      mcpTools: [{ name: 'mcp__cosyee__delegate', serverName: 'cosyee', tokens: 900 }],
    }, 1);
    expect(noSrc.categories).toEqual([{ name: 'Messages', tokens: 500, percent: 5 }]);
    expect(noSrc.deferred).toEqual([]);

    // 目标项不存在但源项未归零：在源项原位置新建目标项，源项保留在后
    const partial = toContextUsage({
      maxTokens: 10000,
      totalTokens: 1000,
      categories: [{ name: 'MCP tools', tokens: 1000, kind: 'used' }],
      mcpTools: [{ name: 'mcp__cosyee__delegate', serverName: 'cosyee', tokens: 400 }],
    }, 1);
    expect(partial.categories).toEqual([
      { name: 'System tools', tokens: 400, percent: 4 },
      { name: 'MCP tools', tokens: 600, percent: 6 },
    ]);
  });

  it('slashCommands：有值时透传副本，空或未给时不带字段', () => {
    const withCmds = toContextUsage({}, 1, { slashCommands: ['compact', 'clear'] });
    expect(withCmds.slashCommands).toEqual(['compact', 'clear']);
    expect(toContextUsage({}, 1, { slashCommands: [] }).slashCommands).toBeUndefined();
    expect(toContextUsage({}, 1, { slashCommands: null }).slashCommands).toBeUndefined();
  });
});
