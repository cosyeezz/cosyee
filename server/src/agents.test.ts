import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agentNamesLine,
  agentSystemPrompt,
  BUILTIN_AGENTS,
  type DelegateAgent,
  formatAgentList,
  listAgents,
  resolveAgent,
} from './delegate/agents.js';
import { type GitRunner, taskContext } from './delegate/context.js';

let tmp: string;
let configDir: string;
let cwd: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-agents-'));
  configDir = path.join(tmp, 'config');
  cwd = path.join(tmp, 'work', 'repo');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeFile(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

describe('BUILTIN_AGENTS & agentSystemPrompt', () => {
  it('内置智能体有正确的 omit 标记，且不含宿主 / 平台 / 模型名', () => {
    const byName = new Map(BUILTIN_AGENTS.map((a) => [a.name, a]));
    expect([...byName.keys()]).toEqual(['Explore', 'Plan', 'general-purpose']);
    expect(byName.get('Explore')).toMatchObject({ omitClaudeMd: true, omitGitStatus: true, source: 'builtin' });
    expect(byName.get('Plan')).toMatchObject({ omitClaudeMd: true, omitGitStatus: true, source: 'builtin' });
    expect(byName.get('general-purpose')).toMatchObject({ omitClaudeMd: false, omitGitStatus: false, source: 'builtin' });

    const forbidden = /Claude|Anthropic|Cosyee|Antigravity|Gemini/i;
    for (const a of BUILTIN_AGENTS) {
      expect(a.description).not.toMatch(forbidden);
      expect(a.prompt).not.toMatch(forbidden);
      const sys = agentSystemPrompt(a);
      expect(sys).not.toMatch(forbidden);
      expect(sys.startsWith(a.prompt + '\n\n')).toBe(true);
      expect(sys).toContain('Messages from the agent that launched you');
      expect(sys).toContain('Notes:\n- Use absolute file paths in commands');
    }
  });
});

describe('listAgents & resolveAgent', () => {
  it('扫描优先级：project > user > plugin（带插件前缀）；同名内置就地覆盖', () => {
    writeFile(
      path.join(cwd, '.claude', 'agents', 'reviewer.md'),
      '---\nname: reviewer\ndescription: Project reviewer\neffort: high\nomitClaudeMd: true\n---\nProject body\nline2',
    );
    writeFile(
      path.join(cwd, '.claude', 'agents', 'Explore.md'),
      '---\ndescription: Custom Explore\n---\nCustom explore body',
    );
    writeFile(
      path.join(configDir, 'agents', 'reviewer.md'),
      '---\ndescription: User reviewer\n---\nUser body',
    );
    writeFile(
      path.join(configDir, 'agents', 'empty-body.md'),
      '---\ndescription: Empty body agent\neffort: bogus\n---\n   \n',
    );
    writeFile(
      path.join(configDir, 'agents', 'no-desc.md'),
      '---\nname: no-desc\n---\nBody without description',
    );
    const pluginDir = path.join(tmp, 'my-plugin');
    writeFile(
      path.join(pluginDir, 'agents', 'helper.md'),
      '---\ndescription: Plugin helper\neffort: low\n---\nPlugin body',
    );
    writeFile(
      path.join(configDir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { 'acme@1.0.0': [{ installPath: pluginDir }] } }),
    );

    const list = listAgents({ configDir, cwd, disabled: [] });
    expect(list.map((a) => a.name)).toEqual(['Explore', 'Plan', 'general-purpose', 'reviewer', 'empty-body', 'acme:helper']);

    // 同名内置就地覆盖且保持首位
    expect(list[0]).toMatchObject({ name: 'Explore', description: 'Custom Explore', prompt: 'Custom explore body', source: 'projectSettings' });
    // 项目优先于用户，body 原样透传，effort 和 omitClaudeMd 解析
    const rev = list.find((a) => a.name === 'reviewer')!;
    expect(rev).toMatchObject({
      description: 'Project reviewer',
      prompt: 'Project body\nline2',
      source: 'projectSettings',
      effort: 'high',
      omitClaudeMd: true,
      omitGitStatus: false,
    });
    // 空正文使用兜底提示词；非法 effort 忽略
    const empty = list.find((a) => a.name === 'empty-body')!;
    expect(empty.effort).toBeUndefined();
    expect(empty.omitClaudeMd).toBe(false);
    expect(empty.prompt).toContain('You are an agent that completes a task assigned by another agent.');
    // 插件前缀与 effort
    expect(list.find((a) => a.name === 'acme:helper')).toMatchObject({ source: 'plugin', effort: 'low' });
  });

  it('disabled 过滤掉指定智能体（含内置），且 resolveAgent 报“已停用”而不是未知', () => {
    const scope = { configDir, cwd, disabled: ['Explore', 'general-purpose'] };
    expect(listAgents(scope).map((a) => a.name)).toEqual(['Plan']);
    const off = { error: 'Agent "Explore" is turned off in settings. Use another agent or do the work yourself.' };
    expect(resolveAgent(scope, 'Explore')).toEqual(off);
    expect(resolveAgent(scope, 'explore')).toEqual(off);
    // 默认 general-purpose 被禁用也报错
    expect(resolveAgent(scope, undefined)).toMatchObject({ error: expect.stringContaining('"general-purpose" is turned off') });
  });

  it('resolveAgent：缺省用 general-purpose，精确优先再大小写无关，未知返回最接近的候选', () => {
    writeFile(path.join(cwd, '.claude', 'agents', 'code-reviewer.md'), '---\ndescription: Reviews code\n---\nbody');
    const scope = { configDir, cwd, disabled: [] };
    expect((resolveAgent(scope, undefined) as DelegateAgent).name).toBe('general-purpose');
    expect((resolveAgent(scope, '') as DelegateAgent).name).toBe('general-purpose');
    expect((resolveAgent(scope, 'explore') as DelegateAgent).name).toBe('Explore');
    expect((resolveAgent(scope, 'PLAN') as DelegateAgent).name).toBe('Plan');

    const miss = resolveAgent(scope, 'review');
    expect('error' in miss).toBe(true);
    if ('error' in miss) {
      expect(miss.error).toContain('Unknown agent "review".');
      expect(miss.error).toContain('- code-reviewer: Reviews code');
      expect(miss.error).toContain('Call delegate_agents for the full list.');
    }
  });

  it('agentNamesLine：只列非内置，超 600 字符截断并附 (+N more)', () => {
    expect(agentNamesLine(BUILTIN_AGENTS)).toBe('');
    const many: DelegateAgent[] = [
      ...BUILTIN_AGENTS,
      ...Array.from({ length: 40 }, (_, i) => ({
        name: `custom-agent-name-${String(i).padStart(2, '0')}`,
        description: 'd',
        prompt: 'p',
        source: 'userSettings' as const,
        omitClaudeMd: false,
        omitGitStatus: false,
      })),
    ];
    const line = agentNamesLine(many, 600);
    expect(line.length).toBeLessThanOrEqual(600);
    expect(line).toMatch(/\(\+\d+ more\)$/);
    expect(line).not.toContain('Explore');
  });

  it('formatAgentList：单行折叠 + 300 字截断 + query 过滤与无匹配兜底', () => {
    const agents: DelegateAgent[] = [
      ...BUILTIN_AGENTS,
      {
        name: 'long-one',
        description: 'line1\n  line2 ' + 'x'.repeat(350),
        prompt: 'p',
        source: 'userSettings',
        omitClaudeMd: false,
        omitGitStatus: false,
      },
    ];
    const all = formatAgentList(agents);
    const longLine = all.split('\n').find((l) => l.startsWith('- long-one:'))!;
    expect(longLine).toContain('line1 line2');
    expect(longLine.length).toBeLessThanOrEqual('- long-one: '.length + 300);

    const filtered = formatAgentList(agents, 'architect');
    expect(filtered).toContain('- Plan:');
    expect(filtered).not.toContain('- Explore:');

    const none = formatAgentList(agents, 'zzzzzz');
    expect(none).toContain('No agents matching "zzzzzz"');
    expect(none).toContain('Explore');
    expect(none).toContain('long-one');
  });
});

describe('taskContext', () => {
  const gp = BUILTIN_AGENTS.find((a) => a.name === 'general-purpose')!;
  const explore = BUILTIN_AGENTS.find((a) => a.name === 'Explore')!;
  const fixedDate = new Date(2026, 4, 9); // 2026-05-09 local

  const mkGit = (map: Record<string, string | Error>): GitRunner => async (args) => {
    const k = args.join(' ');
    const v = map[k];
    if (v instanceof Error) throw v;
    if (v === undefined) throw new Error(`unexpected git ${k}`);
    return v;
  };

  it('完整块顺序：Environment + Instructions（root->cwd + memory 200行上限）+ gitStatus + Date', async () => {
    const parent = path.dirname(cwd);
    writeFile(path.join(configDir, 'CLAUDE.md'), 'global rule');
    writeFile(path.join(parent, 'CLAUDE.md'), 'parent rule');
    writeFile(path.join(cwd, 'CLAUDE.md'), 'project rule');
    writeFile(path.join(cwd, '.claude', 'CLAUDE.md'), 'dotclaude rule');
    writeFile(path.join(cwd, 'CLAUDE.local.md'), 'local rule');
    const slug = cwd.replace(/[^A-Za-z0-9]/g, '-');
    const memLines = Array.from({ length: 250 }, (_, i) => `mem-${i + 1}`).join('\n');
    writeFile(path.join(configDir, 'projects', slug, 'memory', 'MEMORY.md'), memLines);

    const git = mkGit({
      'rev-parse --is-inside-work-tree': 'true\n',
      'rev-parse --abbrev-ref HEAD': 'feat/x\n',
      'symbolic-ref --short refs/remotes/origin/HEAD': 'origin/main\n',
      'rev-parse --verify refs/heads/main': 'abc\n',
      'status --short': ' M a.ts\n',
      'log --oneline -n 5': '1234567 init\n',
    });

    const out = await taskContext({ agent: gp, cwd, configDir, now: fixedDate, git });
    const blocks = out.split('</system-reminder>\n<system-reminder>');
    expect(blocks).toHaveLength(4);

    // 1. Environment（含 environment: 尾随空格，不含平台/OS）
    expect(blocks[0]).toContain('You have been invoked in the following environment: ');
    expect(blocks[0]).toContain(` - Primary working directory: ${cwd}`);
    expect(blocks[0]).toContain(' - Is a git repository: true');
    expect(blocks[0]).not.toMatch(/Platform:|OS Version:|Shell:|Claude Code|Anthropic|Cosyee|Antigravity|Gemini/i);

    // 2. Instructions 顺序：global -> parent -> cwd -> cwd/.claude -> cwd/local -> memory
    const b2 = blocks[1]!;
    const idx = (s: string) => b2.indexOf(s);
    expect(idx('global rule')).toBeGreaterThan(-1);
    expect(idx('global rule')).toBeLessThan(idx('parent rule'));
    expect(idx('parent rule')).toBeLessThan(idx('project rule'));
    expect(idx('project rule')).toBeLessThan(idx('dotclaude rule'));
    expect(idx('dotclaude rule')).toBeLessThan(idx('local rule'));
    expect(idx('local rule')).toBeLessThan(idx('mem-1'));
    expect(b2).toContain('mem-200');
    expect(b2).not.toContain('mem-201');
    expect(b2).toContain("(user's auto-memory, persists across conversations)");

    // 3. Git status
    expect(blocks[2]).toContain('Current branch: feat/x');
    expect(blocks[2]).toContain('Main branch (you will usually use this for PRs): main');
    expect(blocks[2]).toContain('Status:\n M a.ts');
    expect(blocks[2]).toContain('Recent commits:\n1234567 init');

    // 4. Date
    expect(blocks[3]).toContain("Today's date is 2026-05-09.");
  });

  it('Explore（omitClaudeMd & omitGitStatus）跳过指令与 git 块', async () => {
    writeFile(path.join(cwd, 'CLAUDE.md'), 'secret rule');
    const git = mkGit({ 'rev-parse --is-inside-work-tree': 'true\n' });
    const out = await taskContext({ agent: explore, cwd, configDir, now: fixedDate, git });
    expect(out).toContain('Is a git repository: true');
    expect(out).not.toContain('secret rule');
    expect(out).not.toContain('# gitStatus');
    expect(out).toContain("Today's date is 2026-05-09.");
  });

  it('非 git 仓库 / git 失败只丢弃 git 块，绝不抛错', async () => {
    const notRepo = mkGit({ 'rev-parse --is-inside-work-tree': new Error('not a git repo') });
    const out1 = await taskContext({ agent: gp, cwd, configDir, now: fixedDate, git: notRepo });
    expect(out1).toContain('Is a git repository: false');
    expect(out1).not.toContain('# gitStatus');

    const failLog = mkGit({
      'rev-parse --is-inside-work-tree': 'true\n',
      'rev-parse --abbrev-ref HEAD': 'main\n',
      'symbolic-ref --short refs/remotes/origin/HEAD': new Error('no origin'),
      'rev-parse --verify refs/heads/main': 'abc\n',
      'status --short': '',
      'log --oneline -n 5': new Error('no commits'),
    });
    const out2 = await taskContext({ agent: gp, cwd, configDir, now: fixedDate, git: failLog });
    expect(out2).toContain('Is a git repository: true');
    expect(out2).not.toContain('# gitStatus');
  });

  it('git status 超过 2000 字截断；空 status 显示 (clean)；无 origin 时回退 master', async () => {
    const bigStatus = 'M file.ts\n'.repeat(300);
    const git = mkGit({
      'rev-parse --is-inside-work-tree': 'true\n',
      'rev-parse --abbrev-ref HEAD': 'dev\n',
      'symbolic-ref --short refs/remotes/origin/HEAD': new Error('no origin'),
      'rev-parse --verify refs/heads/main': new Error('no main'),
      'status --short': bigStatus,
      'log --oneline -n 5': 'aaa first\n',
    });
    const out = await taskContext({ agent: gp, cwd, configDir, now: fixedDate, git });
    expect(out).toContain('Main branch (you will usually use this for PRs): master');
    expect(out).toContain('truncated because it exceeds 2k characters');

    const cleanGit = mkGit({
      'rev-parse --is-inside-work-tree': 'true\n',
      'rev-parse --abbrev-ref HEAD': 'main\n',
      'symbolic-ref --short refs/remotes/origin/HEAD': new Error('no origin'),
      'rev-parse --verify refs/heads/main': 'abc\n',
      'status --short': '  \n',
      'log --oneline -n 5': 'aaa first\n',
    });
    const outClean = await taskContext({ agent: gp, cwd, configDir, now: fixedDate, git: cleanGit });
    expect(outClean).toContain('Status:\n(clean)');
    expect(outClean).toContain('Main branch (you will usually use this for PRs): main');
  });
});
