import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  LineSplitter,
  filterHistory,
  mergeScans,
  newScan,
  parseLine,
  pickLastActive,
  pickTitle,
  realUserText,
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
    const usage = { input_tokens: 3, output_tokens: 9, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000, server_tool_use: { web_search_requests: 0 }, service_tier: 'standard', cache_creation: { ephemeral_1h_input_tokens: 100 } };
    const [e] = filterHistory([JSON.stringify({ type: 'assistant', message: { id: 'm1', role: 'assistant', content: [], usage } })]);
    expect(e!.message.usage).toEqual({ input_tokens: 3, output_tokens: 9, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000 });
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
