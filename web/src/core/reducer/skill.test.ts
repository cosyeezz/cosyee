import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SkillLoad } from '@cosyee/shared';
import { applyEvent, fromHistory, initState, type ConvState } from '../reducer';

const FIX = path.resolve(__dirname, '../../../../shared/fixtures');
const lines = (name: string): unknown[] =>
  readFileSync(path.join(FIX, name), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const user = (text: string) => ({ type: 'cosyee_user', text, at: 1_000_000 });

const TEXTS = [
  '请用 Skill 工具调用 probe-skill 技能，参数是 alpha，然后按技能要求回复。',
  '/probe-skill beta',
  '请用 Skill 工具调用一个叫 no-such-skill 的技能（它不存在也没关系，照调），然后一句话告诉我结果。',
];
// skill.jsonl 里三个回放 user 事件所在行；cosyee_user 在它们之前补（第一轮在最前）
const USER_AT = [26, 38];

function playLive(): ConvState {
  let s = initState();
  lines('skill.jsonl').forEach((e, i) => {
    if (i === 0) s = applyEvent(s, user(TEXTS[0]!), 1_000_000);
    const k = USER_AT.indexOf(i);
    if (k >= 0) s = applyEvent(s, user(TEXTS[k + 1]!), 1_000_000);
    s = applyEvent(s, e, 2_000_000);
  });
  return s;
}

const live = playLive();
const hist = fromHistory(lines('skill.transcript.jsonl'));
const BODY = '# Probe skill\n\n收到参数：alpha\n\n回复必须以 `PROBE-OK` 开头，然后复述参数。\n';
const DIR = String.raw`C:\work\skill-demo\.claude\skills\probe-skill`;

describe('技能加载：实时 fixture', () => {
  it('三轮；Skill 调用仍是工具步骤', () => {
    expect(live.turns).toHaveLength(3);
    expect(live.turns[0]!.steps.some((x) => x.kind === 'tool' && x.name === 'Skill')).toBe(true);
  });
  it('模型调用：带参数、已加载、正文去掉 Base directory 首行并记 dir', () => {
    expect(live.turns[0]!.skills).toEqual([
      { id: 'toolu_01WfbtW9mkWzsx4gVxMnWZag', name: 'probe-skill', args: 'alpha', source: 'model', status: 'loaded', body: BODY, dir: DIR, afterStep: 0 },
    ]);
  });
  it('用户 /技能：source=user，没有正文', () => {
    expect(live.turns[1]!.skills).toEqual([{ id: 'user:t1', name: 'probe-skill', args: 'beta', source: 'user', status: 'loaded', afterStep: 0 }]);
  });
  it('不存在的技能：error，去掉 tool_use_error 标签', () => {
    const [k] = live.turns[2]!.skills!;
    expect(k).toMatchObject({ name: 'no-such-skill', source: 'model', status: 'error', error: 'Unknown skill: no-such-skill' });
    expect(k!.body).toBeUndefined();
  });
  it('工具刚开始：loading，result 之前没有结果', () => {
    const all = lines('skill.jsonl');
    let s = applyEvent(initState(), user(TEXTS[0]!), 1_000_000);
    for (const e of all.slice(0, 11)) s = applyEvent(s, e, 2_000_000);
    expect(s.turns[0]!.skills![0]).toMatchObject({ name: 'probe-skill', status: 'loading' });
  });
  it('第一轮就是 /技能（init 还没带来 skills 列表）：靠回放的 command-name 补记', () => {
    const all = lines('skill.jsonl');
    let s = initState();
    s = applyEvent(s, user('/probe-skill beta'), 1_000_000);
    for (const e of all.slice(26, 34)) s = applyEvent(s, e, 2_000_000);
    expect(s.turns[0]!.skills).toEqual([{ id: 'user:t0', name: 'probe-skill', args: 'beta', source: 'user', status: 'loaded', afterStep: 0 }]);
  });
  it('不是技能的 /命令（如 /compact）不产生加载', () => {
    let s = applyEvent(initState(), { type: 'system', subtype: 'init', skills: ['probe-skill'] }, 1);
    s = applyEvent(s, user('/compact'), 1);
    expect(s.turns[0]!.skills).toEqual([]);
  });
});

describe('技能加载：历史 fixture', () => {
  it('三轮；/技能 的正文条目建出 user 来源记录，带正文', () => {
    expect(hist.turns).toHaveLength(3);
    expect(hist.turns[0]!.skills).toEqual([
      { id: 'toolu_01WfbtW9mkWzsx4gVxMnWZag', name: 'probe-skill', args: 'alpha', source: 'model', status: 'loaded', body: BODY, dir: DIR, afterStep: 0 },
    ]);
    expect(hist.turns[1]!.skills).toEqual([
      { id: 'user:t1', name: 'probe-skill', args: 'beta', source: 'user', status: 'loaded', body: BODY.replace('alpha', 'beta'), dir: DIR, afterStep: 0 },
    ]);
    expect(hist.turns[2]!.skills![0]).toMatchObject({ status: 'error', error: 'Unknown skill: no-such-skill' });
  });
  it('与实时等价（除了实时的 /技能 没有 body / dir）', () => {
    const strip = (k: SkillLoad): SkillLoad => (k.source === 'user' ? { ...k, body: undefined, dir: undefined } : k);
    const norm = (s: ConvState) => s.turns.map((t) => (t.skills ?? []).map(strip).map((k) => JSON.parse(JSON.stringify(k))));
    expect(norm(hist)).toEqual(norm(live));
  });
  it('/compact 之类的命令没有正文条目，不产生加载；其它 isMeta 条目被忽略', () => {
    const s = fromHistory([
      { type: 'user', uuid: 'u1', message: { role: 'user', content: '<command-name>/compact</command-name>\n<command-args></command-args>' } },
      { type: 'user', uuid: 'u2', parentUuid: 'u1', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: '别的 meta 内容' }] } },
    ]);
    expect(s.turns[0]!.skills).toEqual([]);
  });
});

describe('技能加载：子代理', () => {
  it('子代理里调用 Skill：落在子代理自己的轮；正文按 parent_tool_use_id 归属', () => {
    const sub = (e: Record<string, unknown>) => ({ ...e, parent_tool_use_id: 'toolu_agent' });
    const evs: unknown[] = [
      user('干活'),
      { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { description: 'd', prompt: 'p' } }] } },
      sub({ type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', id: 'toolu_sk', name: 'Skill', input: { skill: 'probe-skill' } }] } }),
      sub({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_sk', content: 'Launching skill: probe-skill' }] } }),
      sub({ type: 'user', isSynthetic: true, message: { content: [{ type: 'text', text: 'Base directory for this skill: /d\n\nBODY' }] } }),
    ];
    let s = initState();
    for (const e of evs) s = applyEvent(s, e, 1);
    expect(s.turns[0]!.skills).toEqual([]);
    expect(s.turns[0]!.subagents[0]!.turn.skills).toEqual([
      { id: 'toolu_sk', name: 'probe-skill', source: 'model', status: 'loaded', body: 'BODY', dir: '/d', afterStep: 0 },
    ]);
  });
});
