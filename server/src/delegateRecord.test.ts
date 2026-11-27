import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AcpProgress } from './delegate/progress.js';
import { DelegateRecorder } from './delegate/record.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-rec-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const SID = '11111111-1111-4111-8111-111111111111';
const chunk = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const thought = (text: string) => ({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } });

describe('DelegateRecorder', () => {
  it('文字段合并成一条、工具调用与结果原样，顺序不变；正在输出的文字读得到', async () => {
    const rec = new DelegateRecorder(dir);
    const p = new AcpProgress('toolu_1', 'gemini');
    rec.write(SID, [{ type: 'system', subtype: 'cosyee_agent_params', tool_use_id: 'toolu_1', model: 'gemini', effort: 'high' }]);
    for (const u of [chunk('先'), chunk('看看'), { sessionUpdate: 'tool_call', toolCallId: 'c1', name: 'run', rawInput: { cmd: 'ls' } }, { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', rawOutput: 'a.ts' }, chunk('还在写')]) {
      rec.write(SID, p.push(u));
    }
    const mid = (await rec.read(SID, 'toolu_1'))!;
    expect(mid.map((e) => e.type)).toEqual(['assistant', 'assistant', 'user', 'assistant']);
    expect(mid[0]).toMatchObject({ effort: 'high', message: { model: 'gemini', content: [{ type: 'text', text: '先看看' }] } });
    expect(mid[1]!.message.content[0]).toMatchObject({ type: 'tool_use', name: 'run', input: { cmd: 'ls' } });
    expect(mid[2]!.message.content[0]).toMatchObject({ type: 'tool_result', content: 'a.ts', is_error: false });
    expect(mid[3]!.message.content[0].text).toBe('还在写');
    expect(mid.every((e) => typeof e.timestamp === 'string')).toBe(true);

    // 服务重启：新实例只有盘上的内容，收尾前的文字还没写盘
    expect(await new DelegateRecorder(dir).read(SID, 'toolu_1')).toHaveLength(3);
    rec.write(SID, p.finish());
    await rec.read(SID, 'toolu_1');
    expect(await new DelegateRecorder(dir).read(SID, 'toolu_1')).toEqual(await rec.read(SID, 'toolu_1'));
  });

  it('先思考后文字：同一消息内 thinking 块关闭后不丢失后续文字，顺序与元信息完整保留', async () => {
    const rec = new DelegateRecorder(dir);
    const p = new AcpProgress('toolu_t1', 'claude-sonnet-5-5');
    rec.write(SID, [{ type: 'system', subtype: 'cosyee_agent_params', tool_use_id: 'toolu_t1', model: 'claude-sonnet-5-5', effort: 'medium' }]);
    for (const u of [thought('先想'), thought('清楚'), chunk('再回答'), chunk('完整')]) {
      rec.write(SID, p.push(u));
    }
    // 未 finish 前：思考块已落盘，文字块在内存中可读
    const mid = (await rec.read(SID, 'toolu_t1'))!;
    expect(mid).toHaveLength(2);
    expect(mid[0]).toMatchObject({
      type: 'assistant',
      effort: 'medium',
      message: { id: 'agy-toolu_t1-t0', model: 'claude-sonnet-5-5', content: [{ type: 'thinking', thinking: '先想清楚' }] },
    });
    expect(mid[1]).toMatchObject({
      type: 'assistant',
      effort: 'medium',
      message: { id: 'agy-toolu_t1-t0', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: '再回答完整' }] },
    });

    // finish 后全部落盘，新实例重读一致
    rec.write(SID, p.finish());
    await rec.read(SID, 'toolu_t1');
    expect(await new DelegateRecorder(dir).read(SID, 'toolu_t1')).toEqual(mid);
  });

  it('文字 / 思考 / 工具交替与只有思考的 finish 收尾落盘', async () => {
    const rec = new DelegateRecorder(dir);
    const p = new AcpProgress('toolu_t2', 'gemini-4');
    for (const u of [
      chunk('第一段'),
      thought('中途思考'),
      { sessionUpdate: 'tool_call', toolCallId: 'c1', name: 'Read', rawInput: { file_path: 'a.ts' } },
      { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', rawOutput: 'ok' },
      thought('工具后思考'),
      chunk('最终结论'),
    ]) {
      rec.write(SID, p.push(u));
    }
    rec.write(SID, p.finish());
    await rec.read(SID, 'toolu_t2');
    const disk = (await new DelegateRecorder(dir).read(SID, 'toolu_t2'))!;
    expect(disk.map((e) => [e.type, e.message.content[0].type, e.message.content[0].thinking ?? e.message.content[0].text ?? e.message.content[0].name ?? e.message.content[0].content])).toEqual([
      ['assistant', 'text', '第一段'],
      ['assistant', 'thinking', '中途思考'],
      ['assistant', 'tool_use', 'Read'],
      ['user', 'tool_result', 'ok'],
      ['assistant', 'thinking', '工具后思考'],
      ['assistant', 'text', '最终结论'],
    ]);

    // 只有思考：finish 关闭未闭合思考块并落盘
    const pOnly = new AcpProgress('toolu_t3', 'gemini-4');
    rec.write(SID, pOnly.push(thought('仅思考未输出文字')));
    expect((await rec.read(SID, 'toolu_t3'))![0]!.message.content[0]).toEqual({ type: 'thinking', thinking: '仅思考未输出文字' });
    expect(await new DelegateRecorder(dir).read(SID, 'toolu_t3')).toBeNull();
    rec.write(SID, pOnly.finish());
    await rec.read(SID, 'toolu_t3');
    const diskOnly = (await new DelegateRecorder(dir).read(SID, 'toolu_t3'))!;
    expect(diskOnly).toHaveLength(1);
    expect(diskOnly[0]).toMatchObject({
      type: 'assistant',
      message: { id: 'agy-toolu_t3-t0', model: 'gemini-4', content: [{ type: 'thinking', thinking: '仅思考未输出文字' }] },
    });
  });

  it('兼容旧流：仅有 message_start + text_delta + content_block_stop（无 content_block_start）照常落盘', async () => {
    const rec = new DelegateRecorder(dir);
    rec.write(SID, [
      { type: 'stream_event', parent_tool_use_id: 'toolu_old', api_message_id: 'm-old', event: { type: 'message_start', message: { id: 'm-old', model: 'legacy' } } },
      { type: 'stream_event', parent_tool_use_id: 'toolu_old', api_message_id: 'm-old', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '旧格式文字' } } },
      { type: 'stream_event', parent_tool_use_id: 'toolu_old', api_message_id: 'm-old', event: { type: 'content_block_stop', index: 0 } },
    ]);
    await rec.read(SID, 'toolu_old');
    const disk = (await new DelegateRecorder(dir).read(SID, 'toolu_old'))!;
    expect(disk).toHaveLength(1);
    expect(disk[0]).toMatchObject({
      type: 'assistant',
      message: { id: 'm-old', model: 'legacy', content: [{ type: 'text', text: '旧格式文字' }] },
    });
  });

  it('结果存取：重启后仍可读；不合法的 id 不碰磁盘', async () => {
    const id = `res_${'a'.repeat(32)}`;
    await new DelegateRecorder(dir).saveResult(id, '结果');
    expect(await new DelegateRecorder(dir).readResult(id)).toBe('结果');
    expect(await new DelegateRecorder(dir).readResult('../x')).toBeNull();
    await new DelegateRecorder(dir).saveResult('../x', 'y');
    expect(fs.readdirSync(dir)).toEqual(['results']);
  });

  it('会话 id 映射存取：重启后仍可读；accountId 白名单校验；不合法的 id 不碰磁盘', async () => {
    const id = `dlg_${'b'.repeat(24)}`;
    const rec = { backend: 'agy', sessionId: 'sess-1', accountId: 'acc12345', agent: 'Explore', cwd: '/work', createdAt: 123 };
    await new DelegateRecorder(dir).saveId(id, rec);
    expect(await new DelegateRecorder(dir).readId(id)).toEqual(rec);
    // 非法 accountId 被白名单过滤
    const idBad = `dlg_${'e'.repeat(24)}`;
    await new DelegateRecorder(dir).saveId(idBad, { ...rec, accountId: '../evil' });
    expect((await new DelegateRecorder(dir).readId(idBad))?.accountId).toBeUndefined();
    // default 允许
    const idDef = `dlg_${'f'.repeat(24)}`;
    await new DelegateRecorder(dir).saveId(idDef, { ...rec, accountId: 'default' });
    expect((await new DelegateRecorder(dir).readId(idDef))?.accountId).toBe('default');
    expect(await new DelegateRecorder(dir).readId('../x')).toBeNull();
    await new DelegateRecorder(dir).saveId('../x', rec);
    expect(fs.readdirSync(dir)).toEqual(['ids']);
  });

  it('没有记录返回 null；不合法的 id 不碰磁盘；超过上限不再写', async () => {
    const rec = new DelegateRecorder(dir, 400);
    expect(await rec.read(SID, 'toolu_none')).toBeNull();
    expect(await rec.read('../x', 'toolu_1')).toBeNull();
    rec.write(SID, [{ type: 'user', parent_tool_use_id: '../../evil', message: { content: 'x' } }]);
    for (let i = 0; i < 20; i++) rec.write(SID, [{ type: 'user', parent_tool_use_id: 'toolu_2', message: { content: 'x'.repeat(50) } }]);
    const n = (await rec.read(SID, 'toolu_2'))!.length;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(5);
    expect(fs.readdirSync(dir)).toEqual([SID]);
  });

  it('jobs.json 原子存取往返与 deleteSession 删除目录', async () => {
    const rec = new DelegateRecorder(dir);
    expect(rec.readJobs(SID)).toBeNull();
    const data = {
      jobs: [
        {
          conversationId: `dlg_${'c'.repeat(24)}`,
          toolUseId: 'toolu_1',
          description: '写代码',
          agent: 'general-purpose',
          background: true,
          state: 'running' as const,
          startedAt: 1000,
        },
      ],
      pendingNotifications: [
        {
          conversationId: `dlg_${'c'.repeat(24)}`,
          toolUseId: 'toolu_1',
          status: 'done' as const,
          description: '写代码',
          resultId: `res_${'d'.repeat(32)}`,
          result: 'ok',
        },
      ],
    };
    await rec.saveJobs(SID, data);
    expect(rec.readJobs(SID)).toEqual(data);
    // 原子写不残留 .tmp 文件
    expect(fs.readdirSync(path.join(dir, SID))).toEqual(['jobs.json']);

    await rec.deleteSession(SID);
    expect(fs.existsSync(path.join(dir, SID))).toBe(false);
    expect(rec.readJobs(SID)).toBeNull();
  });

  it('构造时异步清理超过 30 天的 results/res_*.txt 与 ids/*.json，保留未过期的', async () => {
    const resDir = path.join(dir, 'results');
    const idsDir = path.join(dir, 'ids');
    fs.mkdirSync(resDir, { recursive: true });
    fs.mkdirSync(idsDir, { recursive: true });

    const nowMs = Date.now();
    const oldSec = (nowMs - 31 * 24 * 60 * 60 * 1000) / 1000;
    const freshSec = (nowMs - 5 * 24 * 60 * 60 * 1000) / 1000;

    const oldRes = path.join(resDir, `res_${'1'.repeat(32)}.txt`);
    const freshRes = path.join(resDir, `res_${'2'.repeat(32)}.txt`);
    const otherTxt = path.join(resDir, 'keep.txt');
    const oldId = path.join(idsDir, `dlg_${'1'.repeat(24)}.json`);
    const freshId = path.join(idsDir, `dlg_${'2'.repeat(24)}.json`);

    for (const f of [oldRes, freshRes, otherTxt, oldId, freshId]) fs.writeFileSync(f, 'x');
    for (const f of [oldRes, otherTxt, oldId]) fs.utimesSync(f, oldSec, oldSec);
    for (const f of [freshRes, freshId]) fs.utimesSync(f, freshSec, freshSec);

    const rec = new DelegateRecorder(dir, undefined, { now: () => nowMs });
    await rec.cleanupDone;

    expect(fs.existsSync(oldRes)).toBe(false);
    expect(fs.existsSync(freshRes)).toBe(true);
    expect(fs.existsSync(otherTxt)).toBe(true); // 不匹配 res_*.txt 不删
    expect(fs.existsSync(oldId)).toBe(false);
    expect(fs.existsSync(freshId)).toBe(true);
  });
});
