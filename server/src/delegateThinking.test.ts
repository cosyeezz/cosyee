import { describe, expect, it } from 'vitest';
import { ClaudeStreamTranslator } from './delegate/claudeBackend.js';
import { AcpProgress } from './delegate/progress.js';

const thought = (text: string) => ({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } });
const textChunk = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const toolCall = (id: string) => ({ sessionUpdate: 'tool_call', toolCallId: id, name: 'Read', rawInput: { file_path: 'a.ts' }, status: 'in_progress' });

describe('AcpProgress 思考块（agent_thought_chunk）', () => {
  it('将 agent_thought_chunk 翻译成带 parent_tool_use_id 的 thinking stream_event，连续思考复用同一块', () => {
    const p = new AcpProgress('toolu_sub1', 'claude-sonnet-5-5');

    const a = p.push(thought('先分析'));
    expect(a).toEqual([
      {
        type: 'stream_event',
        parent_tool_use_id: 'toolu_sub1',
        api_message_id: 'agy-toolu_sub1-t0',
        event: { type: 'message_start', message: { id: 'agy-toolu_sub1-t0', model: 'claude-sonnet-5-5' } },
      },
      {
        type: 'stream_event',
        parent_tool_use_id: 'toolu_sub1',
        api_message_id: 'agy-toolu_sub1-t0',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      },
      {
        type: 'stream_event',
        parent_tool_use_id: 'toolu_sub1',
        api_message_id: 'agy-toolu_sub1-t0',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先分析' } },
      },
    ]);

    const b = p.push(thought('再动手'));
    expect(b).toEqual([
      {
        type: 'stream_event',
        parent_tool_use_id: 'toolu_sub1',
        api_message_id: 'agy-toolu_sub1-t0',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '再动手' } },
      },
    ]);

    // 空思考片段忽略，不产生事件也不影响当前块
    expect(p.push(thought(''))).toEqual([]);
    expect(p.push({ sessionUpdate: 'agent_thought_chunk', content: null })).toEqual([]);
  });

  it('思考与文字交替时正确 content_block_stop 关旧块并递增 index；工具调用切段后重置 index', () => {
    const p = new AcpProgress('P', 'gemini-4');

    // index 0: thinking
    const s1 = p.push(thought('想一想'));
    expect(s1.map((e) => [e.api_message_id, e.event.type, e.event.index])).toEqual([
      ['agy-P-t0', 'message_start', undefined],
      ['agy-P-t0', 'content_block_start', 0],
      ['agy-P-t0', 'content_block_delta', 0],
    ]);

    // 切到 text：关 index 0，开 index 1
    const s2 = p.push(textChunk('结论如下'));
    expect(s2).toEqual([
      { type: 'stream_event', parent_tool_use_id: 'P', api_message_id: 'agy-P-t0', event: { type: 'content_block_stop', index: 0 } },
      { type: 'stream_event', parent_tool_use_id: 'P', api_message_id: 'agy-P-t0', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } },
      { type: 'stream_event', parent_tool_use_id: 'P', api_message_id: 'agy-P-t0', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '结论如下' } } },
    ]);

    // 再切回 thinking：关 index 1，开 index 2
    const s3 = p.push(thought('补充思考'));
    expect(s3).toEqual([
      { type: 'stream_event', parent_tool_use_id: 'P', api_message_id: 'agy-P-t0', event: { type: 'content_block_stop', index: 1 } },
      { type: 'stream_event', parent_tool_use_id: 'P', api_message_id: 'agy-P-t0', event: { type: 'content_block_start', index: 2, content_block: { type: 'thinking', thinking: '' } } },
      { type: 'stream_event', parent_tool_use_id: 'P', api_message_id: 'agy-P-t0', event: { type: 'content_block_delta', index: 2, delta: { type: 'thinking_delta', thinking: '补充思考' } } },
    ]);

    // 工具调用：关掉当前 thinking 块（index 2）并切段
    const s4 = p.push(toolCall('c1'));
    expect(s4[0]).toEqual({
      type: 'stream_event',
      parent_tool_use_id: 'P',
      api_message_id: 'agy-P-t0',
      event: { type: 'content_block_stop', index: 2 },
    });
    expect(s4[1]).toMatchObject({ type: 'assistant', parent_tool_use_id: 'P' });

    // 工具调用之后再思考：新消息 t1，index 从 0 重新开始
    const s5 = p.push(thought('工具后思考'));
    expect(s5.map((e) => [e.api_message_id, e.event.type, e.event.index])).toEqual([
      ['agy-P-t1', 'message_start', undefined],
      ['agy-P-t1', 'content_block_start', 0],
      ['agy-P-t1', 'content_block_delta', 0],
    ]);
  });

  it('finish() 关闭未闭合的思考块，且重复调用幂等', () => {
    const p = new AcpProgress('P');
    p.push(thought('思考中断'));

    const fin = p.finish();
    expect(fin).toEqual([
      {
        type: 'stream_event',
        parent_tool_use_id: 'P',
        api_message_id: 'agy-P-t0',
        event: { type: 'content_block_stop', index: 0 },
      },
    ]);
    expect(p.finish()).toEqual([]);
  });

  it('ClaudeStreamTranslator -> AcpProgress 串联：thinking_delta 与 text_delta 端到端产出合法事件序列', () => {
    const tr = new ClaudeStreamTranslator();
    const prog = new AcpProgress('toolu_c', 'claude-opus-5');

    const step1 = tr.push({
      type: 'stream_event',
      api_message_id: 'm1',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '检查 MultiEdit' } },
    });
    const step2 = tr.push({
      type: 'stream_event',
      api_message_id: 'm1',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '准备修改' } },
    });

    const evs = [...step1.updates.flatMap((u) => prog.push(u)), ...step2.updates.flatMap((u) => prog.push(u)), ...prog.finish()];
    expect(evs.map((e) => [e.event.type, e.event.index, e.event.content_block?.type ?? e.event.delta?.type])).toEqual([
      ['message_start', undefined, undefined],
      ['content_block_start', 0, 'thinking'],
      ['content_block_delta', 0, 'thinking_delta'],
      ['content_block_stop', 0, undefined],
      ['content_block_start', 1, 'text'],
      ['content_block_delta', 1, 'text_delta'],
      ['content_block_stop', 1, undefined],
    ]);
  });
});
