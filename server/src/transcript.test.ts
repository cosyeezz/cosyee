import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DETAIL_TEXT_MAX,
  LineSplitter,
  filterHistory,
  mergeScans,
  newScan,
  parseLine,
  pickLastActive,
  pickTitle,
  realUserText,
  scanDetail,
  scanLines,
  splitLines,
} from './transcript.js';

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../shared/fixtures');
const sampleLines = fs.readFileSync(path.join(FIX, 'transcript-sample.jsonl'), 'utf8').split('\n').filter(Boolean);

describe('LineSplitter', () => {
  it('处理被切开的半行', () => {
    const s = new LineSplitter();
    expect(s.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(s.push(':2}\n')).toEqual(['{"b":2}']);
    expect(s.flush()).toEqual([]);
  });

  it('flush 取出没有换行结尾的残留，并兼容 \\r\\n 与空行', () => {
    const s = new LineSplitter();
    expect(s.push('x\r\n\r\ny')).toEqual(['x']);
    expect(s.flush()).toEqual(['y']);
  });

  it('多字节字符被切在两个 chunk 之间也不乱码', () => {
    const buf = Buffer.from('{"t":"中文"}\n', 'utf8');
    const s = new LineSplitter();
    const out = [...s.push(buf.subarray(0, 7)), ...s.push(buf.subarray(7))];
    expect(out).toEqual(['{"t":"中文"}']);
  });
});

describe('splitLines / parseLine', () => {
  it('丢弃窗口边缘的残行', () => {
    expect(splitLines('cut\nA\nB\ncu', { dropFirst: true, dropLast: true })).toEqual(['A', 'B']);
  });
  it('坏 JSON 返回 null', () => {
    expect(parseLine('{"a":')).toBeNull();
    expect(parseLine('123')).toBeNull();
    expect(parseLine('{"a":1}')).toEqual({ a: 1 });
  });
});

describe('标题与活动时间', () => {
  const id = '356bef19-b6ff-4428-a37c-12134e4e2bfd';

  it('样例：agent-name 优先', () => {
    const s = scanLines(sampleLines);
    expect(s.hasMessages).toBe(true);
    expect(s.firstPrompt).toBe('只回复 ok');
    expect(pickTitle(s, id)).toBe('示例标题');
  });

  it('优先级 agent-name > custom-title > ai-title > 第一条用户消息 > id 前 8 位', () => {
    const user = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' }, timestamp: '2026-01-01T00:00:00Z' });
    const s = scanLines([user]);
    expect(pickTitle(s, id)).toBe('hello');
    scanLines([JSON.stringify({ type: 'ai-title', aiTitle: 'AI' })], s);
    expect(pickTitle(s, id)).toBe('AI');
    scanLines([JSON.stringify({ type: 'custom-title', customTitle: 'Custom' })], s);
    expect(pickTitle(s, id)).toBe('Custom');
    scanLines([JSON.stringify({ type: 'agent-name', agentName: 'Agent' })], s);
    expect(pickTitle(s, id)).toBe('Agent');
    expect(pickTitle(newScan(), id)).toBe('356bef19');
  });

  it('用户标题以最后出现的 custom-title / agent-name 为准，且高于 ai-title', () => {
    const s = scanLines([
      JSON.stringify({ type: 'agent-name', agentName: '旧名' }),
      JSON.stringify({ type: 'custom-title', customTitle: 'SDK 新名' }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'AI' }),
    ]);
    expect(pickTitle(s, id)).toBe('SDK 新名');
    const head = scanLines([JSON.stringify({ type: 'custom-title', customTitle: '头部' })], newScan());
    const tail = scanLines([JSON.stringify({ type: 'agent-name', agentName: '尾部' })], newScan());
    expect(pickTitle(mergeScans(head, tail), id)).toBe('尾部');
  });

  it('标题取最后一条', () => {
    const s = scanLines([
      JSON.stringify({ type: 'custom-title', customTitle: 'old' }),
      JSON.stringify({ type: 'custom-title', customTitle: 'new' }),
    ]);
    expect(s.customTitle).toBe('new');
  });

  it('跳过 meta / 命令回显 / 工具结果类用户消息', () => {
    const mk = (content: unknown, extra: object = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });
    expect(realUserText(mk('<local-command-stdout>x</local-command-stdout>'))).toBeNull();
    expect(realUserText(mk('hi', { isMeta: true }))).toBeNull();
    expect(realUserText(mk([{ type: 'tool_result', tool_use_id: 't', content: 'x' }]))).toBeNull();
    expect(realUserText(mk([{ type: 'text', text: '你好' }]))).toEqual({ text: '你好', command: false });
    // 委派任务完成通知是 Cosyee 注入的系统消息，不能当标题 / 预览
    expect(realUserText(mk('<cosyee-delegate-notification>\nDelegate job x done\n</cosyee-delegate-notification>'))).toBeNull();
    const n = scanLines([
      JSON.stringify(mk('<cosyee-delegate-notification>x</cosyee-delegate-notification>', { timestamp: '2026-01-01T00:00:00Z' })),
      JSON.stringify(mk('真正的问题', { timestamp: '2026-01-01T00:00:01Z' })),
    ]);
    expect(n.firstPrompt).toBe('真正的问题');
    expect(realUserText(mk('<command-name>/rename</command-name><command-args>abc</command-args>'))).toEqual({
      text: '/rename abc',
      command: true,
    });
  });

  it('长标题截断到 200 字符', () => {
    const s = scanLines([JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(500) } })]);
    expect(Array.from(pickTitle(s, id)).length).toBe(201);
  });

  it('lastActiveAt = min(最后消息时间, mtime)', () => {
    expect(pickLastActive(1000, 5000)).toBe(1000);
    expect(pickLastActive(9000, 5000)).toBe(5000);
    expect(pickLastActive(undefined, 5000)).toBe(5000);
  });

  it('样例的 lastTs 取最大时间戳', () => {
    const s = scanLines(sampleLines);
    expect(s.lastTs).toBeGreaterThan(Date.parse('2026-11-16T13:07:00Z'));
  });
});

describe('历史过滤', () => {
  it('只留 user/assistant/system，剔除个人信息条目', () => {
    const out = filterHistory(sampleLines);
    const types = new Set(out.map((e) => e.type));
    for (const bad of ['attachment', 'session-owner', 'queue-operation', 'cost-state', 'mode', 'last-prompt', 'atis-latch', 'tools-used']) {
      expect(types.has(bad)).toBe(false);
    }
    expect(types.has('user')).toBe(true);
    expect(types.has('assistant')).toBe(true);
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/accountUuid|organizationUuid|session-owner/);
    // 不含邮箱特征
    expect(text).not.toMatch(/[A-Za-z0-9._-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
    expect(text).not.toContain('"attachment"');
  });

  it('执行中送达的消息（queued_command 附件：插话、委派通知）保留文字与链；其它附件照丢', () => {
    const att = (attachment: unknown, typeFirst = false) =>
      JSON.stringify(
        typeFirst
          ? { type: 'attachment', attachment, uuid: 'u1', parentUuid: 'p1', timestamp: 'T', sessionId: 'S' }
          : { parentUuid: 'p1', isSidechain: false, attachment, type: 'attachment', uuid: 'u1', timestamp: 'T', cwd: '/x', rendered: [{ content: 'R' }], sessionId: 'S' },
      );
    const note = '<cosyee-delegate-notification>\nconversation_id: c\n</cosyee-delegate-notification>';
    for (const text of ['先别改，讨论一下', note]) {
      const want = [{
        type: 'attachment', uuid: 'u1', parentUuid: 'p1', sessionId: 'S', timestamp: 'T',
        attachment: { type: 'queued_command', commandMode: 'prompt', prompt: text, source_uuid: 'x' },
      }];
      const a = { type: 'queued_command', source_uuid: 'x', delivery_id: 'd', commandMode: 'prompt' };
      expect(filterHistory([att({ ...a, prompt: [{ type: 'text', text }, { type: 'image', source: {} }] })])).toEqual(want);
      expect(filterHistory([att({ ...a, prompt: text, origin: { kind: 'human' } }, true)])).toEqual(want);
    }
    expect(filterHistory([
      att({ type: 'queued_command', prompt: '<task-notification>', commandMode: 'task-notification' }),
      att({ type: 'queued_command', prompt: [{ type: 'image', source: {} }], commandMode: 'prompt' }),
      att({ type: 'file', content: 'queued_command' }, true),
    ])).toEqual([]);
  });

  it('标题条目每种只留最后一条且放在末尾', () => {
    const out = filterHistory(sampleLines);
    const tail = out.slice(-3).map((e) => e.type);
    expect(tail).toEqual(['custom-title', 'agent-name', 'ai-title']);
    expect(out.filter((e) => e.type === 'custom-title')).toHaveLength(1);
  });

  it('丢弃 system 的 session_context / prompt_snapshot，保留 turn_duration', () => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'session_context', content: 'env' }),
      JSON.stringify({ type: 'system', subtype: 'prompt_snapshot', content: 'p' }),
      JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 1 }),
      JSON.stringify({ type: 'api-request-body', body: 'x' }),
    ];
    const out = filterHistory(lines);
    expect(out.map((e) => e.subtype)).toEqual(['turn_duration']);
  });

  it('toolUseResult 只保留子代理相关的摘要字段；没有可留的字段就整个去掉', () => {
    const agent = { type: 'user', message: { role: 'user', content: [] }, toolUseResult: { status: 'completed', agentId: 'a1', content: 'x'.repeat(80_000) } };
    const read = { type: 'user', message: { role: 'user', content: [] }, toolUseResult: { type: 'text', file: { filePath: 'a', content: 'y'.repeat(1000) } } };
    const err = { type: 'user', message: { role: 'user', content: [] }, toolUseResult: 'Error: boom' };
    const [a, r, x] = filterHistory([agent, read, err].map((o) => JSON.stringify(o)));
    expect(a!.toolUseResult).toEqual({ status: 'completed', agentId: 'a1' });
    expect(r).not.toHaveProperty('toolUseResult');
    expect(x).not.toHaveProperty('toolUseResult');
  });

  it('非 MCP 工具结果里的图片去掉数据，MCP 的保留；用户自己贴的图不动', () => {
    const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(5000) } };
    const lines = [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }, { type: 'tool_use', id: 't2', name: 'mcp__browser__screenshot', input: {} }] } },
      { type: 'user', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: [img, { type: 'text', text: 'ok' }] },
        { type: 'tool_result', tool_use_id: 't2', content: [img] },
      ] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '看图' }, img] } },
    ].map((o) => JSON.stringify(o));
    const [, res, mine] = filterHistory(lines);
    const [read, mcp] = res!.message.content;
    expect(read.content).toEqual([{ type: 'image', omitted: true }, { type: 'text', text: 'ok' }]);
    expect(mcp.content).toEqual([img]);
    expect(mine!.message.content[1]).toEqual(img);
  });

  it('assistant 的 usage 只留 token 计数', () => {
    const usage = { input_tokens: 3, output_tokens: 9, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000, server_tool_use: { web_search_requests: 0 }, service_tier: 'standard' };
    const [e] = filterHistory([JSON.stringify({ type: 'assistant', message: { id: 'm1', role: 'assistant', content: [], usage } })]);
    expect(e!.message.usage).toEqual({ input_tokens: 3, output_tokens: 9, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000 });
  });

  it('assistant 的 usage 保留缓存写入明细、speed、inference_geo（算花费用）', () => {
    const usage = {
      input_tokens: 3, output_tokens: 9, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000,
      cache_creation: { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 0 }, speed: 'fast', inference_geo: 'us', service_tier: 'standard',
    };
    const [e] = filterHistory([JSON.stringify({ type: 'assistant', message: { id: 'm1', role: 'assistant', content: [], usage } })]);
    expect(e!.message.usage).toEqual({
      input_tokens: 3, output_tokens: 9, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000,
      cache_creation: { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 0 }, speed: 'fast', inference_geo: 'us',
    });
  });

  it('剥离 wireToolInputs', () => {
    const [e] = filterHistory([JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [] }, wireToolInputs: { t1: { a: 1 } } })]);
    expect(e).not.toHaveProperty('wireToolInputs');
  });

  it('剥离 rendered / attachment 字段', () => {
    const [e] = filterHistory([JSON.stringify({ type: 'user', message: { role: 'user', content: 'x' }, rendered: 'R', renderedRole: 'user', attachment: { a: 1 } })]);
    expect(e).not.toHaveProperty('rendered');
    expect(e).not.toHaveProperty('renderedRole');
    expect(e).not.toHaveProperty('attachment');
  });
});

describe('DetailScan（会话详情统计）', () => {
  const j = (o: object) => JSON.stringify(o);
  const user = (uuid: string, parentUuid: string | null, content: unknown, extra: object = {}) =>
    j({ type: 'user', uuid, parentUuid, message: { role: 'user', content }, ...extra });
  const asst = (uuid: string, parentUuid: string | null, content: unknown[], extra: object = {}, msgExtra: object = {}) =>
    j({ type: 'assistant', uuid, parentUuid, message: { role: 'assistant', model: 'claude-sonnet-5-5', content, ...msgExtra }, ...extra });

  it('样例与只有一条用户消息：lastPrompt 为 null，HEAD 分支为 null', () => {
    const d = scanDetail(sampleLines);
    expect(d.userMessages).toBe(1);
    expect(d.firstPrompt).toBe('只回复 ok');
    expect(d.lastPrompt).toBeNull();
    expect(d.lastReply).toBe('ok');
    expect(d.toolCalls).toBe(1);
    expect(d.model).toBe('claude-haiku-5-5');
    expect(d.branch).toBeNull();
    expect(d.contextTokens).toBe(2);
    expect(d.createdAt).toBe(Date.parse('2026-11-16T13:07:00.714Z'));
    expect(d.lastMessageAt).toBe(Date.parse('2026-11-16T13:09:00.100Z'));
  });

  it('rewind 分支排除：旧支的用户消息 / 工具 / 回复 / 用量 / 分支全部不计入', () => {
    const lines = [
      user('u1', null, '第一问', { timestamp: '2026-01-01T00:00:00Z', gitBranch: 'main' }),
      asst('a1', 'u1', [{ type: 'text', text: '第一答' }, { type: 'tool_use', id: 't1', name: 'Read', input: {} }],
        { timestamp: '2026-01-01T00:00:01Z', gitBranch: 'main' },
        { usage: { input_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 300 } }),
      // 被 rewind 废弃的旧支
      user('u2-old', 'a1', '废弃提问', { timestamp: '2026-01-01T00:01:00Z', gitBranch: 'old-branch' }),
      asst('a2-old', 'u2-old', [{ type: 'text', text: '废弃回答' }, { type: 'tool_use', id: 't-old', name: 'Bash', input: {} }],
        { timestamp: '2026-01-01T00:01:05Z', gitBranch: 'old-branch' },
        { model: 'claude-opus-5-5', usage: { input_tokens: 9999 } }),
      // rewind 后从 a1 起的新支
      user('u2-new', 'a1', '新提问', { timestamp: '2026-01-01T00:02:00Z', gitBranch: 'feat/new' }),
      asst('a2-new', 'u2-new', [{ type: 'text', text: '新回答' }],
        { timestamp: '2026-01-01T00:02:05Z', gitBranch: 'feat/new' },
        { usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30 } }),
    ];
    const d = scanDetail(lines);
    expect(d).toEqual({
      createdAt: Date.parse('2026-01-01T00:00:00Z'),
      lastMessageAt: Date.parse('2026-01-01T00:02:05Z'),
      userMessages: 2,
      toolCalls: 1,
      firstPrompt: '第一问',
      lastPrompt: '新提问',
      lastReply: '新回答',
      model: 'claude-sonnet-5-5',
      branch: 'feat/new',
      contextTokens: 60,
    });
  });

  it('并行工具的旁支不算废弃，且 tool_use 按 id 去重', () => {
    const lines = [
      user('u1', null, '查两个文件', { timestamp: '2026-01-01T00:00:00Z' }),
      asst('a1', 'u1', [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }], { timestamp: '2026-01-01T00:00:01Z' }),
      // 同一条消息分多行写出，重复出现 t1，外加并行分支 a1b 的 t2
      asst('a1b', 'a1', [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }, { type: 'tool_use', id: 't2', name: 'Grep', input: {} }], { timestamp: '2026-01-01T00:00:02Z' }),
      // 兄弟 tool_result 旁支（非用户输入起点，不算废弃）
      user('tr-side', 'a1', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }], { timestamp: '2026-01-01T00:00:03Z' }),
      asst('a-side', 'tr-side', [{ type: 'tool_use', id: 't3', name: 'Glob', input: {} }], { timestamp: '2026-01-01T00:00:04Z' }),
      // 主链从 a1b 继续
      user('tr-main', 'a1b', [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }], { timestamp: '2026-01-01T00:00:05Z' }),
      asst('a2', 'tr-main', [{ type: 'text', text: '查完了' }], { timestamp: '2026-01-01T00:00:06Z' }),
    ];
    const d = scanDetail(lines);
    expect(d.userMessages).toBe(1);
    expect(d.toolCalls).toBe(3);
    expect(d.lastReply).toBe('查完了');
  });

  it('compact 边界：沿 logicalParentUuid 接上链，且清空之前的 contextTokens', () => {
    const base = [
      user('u1', null, '压缩前问题', { timestamp: '2026-01-01T00:00:00Z' }),
      asst('a1', 'u1', [{ type: 'text', text: '压缩前回答' }],
        { timestamp: '2026-01-01T00:00:05Z' },
        { usage: { input_tokens: 50000, cache_read_input_tokens: 100000 } }),
      // 废弃分支，验证 compact 边界接链后 rewind 过滤仍然生效
      user('u-dead', 'a1', '被回退的问题', { timestamp: '2026-01-01T00:00:10Z' }),
      j({ type: 'system', subtype: 'compact_boundary', uuid: 'cb1', parentUuid: null, logicalParentUuid: 'a1', timestamp: '2026-01-01T00:01:00Z' }),
      user('u-sum', 'cb1', '压缩摘要正文', { isCompactSummary: true, timestamp: '2026-01-01T00:01:01Z' }),
    ];
    const afterCompact = scanDetail(base);
    expect(afterCompact.userMessages).toBe(1);
    expect(afterCompact.firstPrompt).toBe('压缩前问题');
    expect(afterCompact.contextTokens).toBeNull();
    expect(afterCompact.createdAt).toBe(Date.parse('2026-01-01T00:00:00Z'));

    // 压缩后再发一次请求，contextTokens 恢复为新请求的值
    const afterNewReq = scanDetail([
      ...base,
      user('u2', 'u-sum', '压缩后继续', { timestamp: '2026-01-01T00:02:00Z' }),
      asst('a2', 'u2', [{ type: 'text', text: '继续回答' }],
        { timestamp: '2026-01-01T00:02:05Z' },
        { usage: { input_tokens: 1200, cache_creation_input_tokens: 300, cache_read_input_tokens: 500 } }),
    ]);
    expect(afterNewReq.userMessages).toBe(2);
    expect(afterNewReq.firstPrompt).toBe('压缩前问题');
    expect(afterNewReq.lastPrompt).toBe('压缩后继续');
    expect(afterNewReq.contextTokens).toBe(2000);
  });

  it('跳过 <synthetic>、isSidechain 与坏行', () => {
    const lines = [
      'not valid json {',
      '',
      user('u1', null, '你好', { timestamp: '2026-01-01T00:00:00Z', gitBranch: 'dev' }),
      asst('a1', 'u1', [{ type: 'text', text: '正常回复' }],
        { timestamp: '2026-01-01T00:00:01Z' },
        { model: 'claude-opus-5-5', usage: { input_tokens: 500 } }),
      // synthetic 消息：回复、模型、用量均不算
      asst('a-syn', 'a1', [{ type: 'text', text: 'No response requested.' }],
        { timestamp: '2026-01-01T00:00:02Z' },
        { model: '<synthetic>', usage: { input_tokens: 999 } }),
      // sidechain 全部不统计
      user('u-sub', 'a-syn', '子代理问题', { isSidechain: true, timestamp: '2026-01-01T00:05:00Z', gitBranch: 'sub-branch' }),
      asst('a-sub', 'u-sub', [{ type: 'text', text: '子代理回复' }, { type: 'tool_use', id: 't-sub', name: 'Read', input: {} }],
        { isSidechain: true, timestamp: '2026-01-01T00:05:01Z' },
        { model: 'claude-haiku-5-5', usage: { input_tokens: 888 } }),
      // 末尾切换到 detached HEAD
      j({ type: 'system', subtype: 'turn_duration', uuid: 's1', parentUuid: 'a-syn', timestamp: '2026-01-01T00:00:03Z', gitBranch: 'HEAD' }),
    ];
    const d = scanDetail(lines);
    expect(d).toEqual({
      createdAt: Date.parse('2026-01-01T00:00:00Z'),
      lastMessageAt: Date.parse('2026-01-01T00:00:03Z'),
      userMessages: 1,
      toolCalls: 0,
      firstPrompt: '你好',
      lastPrompt: null,
      lastReply: '正常回复',
      model: 'claude-opus-5-5',
      branch: null,
      contextTokens: 500,
    });
  });

  it('执行中插话（queued_command prompt）计为用户消息，系统通知除外；超 240 字单行截断', () => {
    const longPrompt = '甲\n  乙' + '字'.repeat(300);
    const longReply = '第一段' + 'a'.repeat(10);
    const longReply2 = '最终\r\n回复' + '🎉'.repeat(260);
    const lines = [
      user('u1', null, longPrompt, { timestamp: '2026-01-01T00:00:00Z' }),
      asst('a1', 'u1', [{ type: 'text', text: longReply }], { timestamp: '2026-01-01T00:00:01Z' }),
      // 系统通知插话：不算用户消息，但仍保留链节点
      j({
        type: 'attachment', uuid: 'att-note', parentUuid: 'a1', timestamp: '2026-01-01T00:00:02Z',
        attachment: { type: 'queued_command', commandMode: 'prompt', prompt: '<cosyee-delegate-notification>done</cosyee-delegate-notification>' },
      }),
      // 真实用户插话（数组格式）
      j({
        type: 'attachment', uuid: 'att-steer', parentUuid: 'att-note', timestamp: '2026-01-01T00:00:03Z',
        attachment: { type: 'queued_command', commandMode: 'prompt', prompt: [{ type: 'text', text: '先别改，\n讨论一下' }] },
      }),
      asst('a2', 'att-steer', [{ type: 'text', text: '   ' }, { type: 'text', text: longReply2 }], { timestamp: '2026-01-01T00:00:04Z' }),
    ];
    const d = scanDetail(lines);
    expect(d.userMessages).toBe(2);
    expect(d.firstPrompt).not.toContain('\n');
    expect(Array.from(d.firstPrompt!).length).toBe(DETAIL_TEXT_MAX + 1);
    expect(d.firstPrompt!.endsWith('…')).toBe(true);
    expect(d.lastPrompt).toBe('先别改， 讨论一下');
    expect(d.lastReply).not.toContain('\n');
    expect(Array.from(d.lastReply!).length).toBe(DETAIL_TEXT_MAX + 1);
    expect(d.lastReply!.endsWith('…')).toBe(true);
  });

  it('空记录返回全空默认值', () => {
    expect(scanDetail([])).toEqual({
      createdAt: null,
      lastMessageAt: null,
      userMessages: 0,
      toolCalls: 0,
      firstPrompt: null,
      lastPrompt: null,
      lastReply: null,
      model: null,
      branch: null,
      contextTokens: null,
    });
  });
});
