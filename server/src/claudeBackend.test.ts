import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BackendError } from './delegate/backend.js';
import {
  buildClaudeDelegateArgs,
  ClaudeBackend,
  ClaudeStreamTranslator,
  resolveClaudeDelegateParams,
} from './delegate/claudeBackend.js';
import type { Json } from './transcript.js';

describe('ClaudeStreamTranslator（stream-json -> ACP update）', () => {
  it('翻译 init / stream_event（去重）/ tool_use（含 edit locations）/ tool_result / result', () => {
    const tr = new ClaudeStreamTranslator();

    const s1 = tr.push({ type: 'system', subtype: 'init', session_id: 'sid-1', model: 'claude-sonnet-5-5' });
    expect(s1).toEqual({ updates: [], sessionId: 'sid-1', model: 'claude-sonnet-5-5' });

    const s2 = tr.push({
      type: 'stream_event',
      api_message_id: 'm1',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '先看文件' } },
    });
    expect(s2.updates).toEqual([{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '先看文件' } }]);

    const s3 = tr.push({
      type: 'stream_event',
      api_message_id: 'm1',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '正在修改' } },
    });
    expect(s3.updates).toEqual([{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '正在修改' } }]);

    // 同一个 message.id 的 assistant 帧不再重复发 text / thinking，但发出 tool_use
    const s4 = tr.push({
      type: 'assistant',
      message: {
        id: 'm1',
        content: [
          { type: 'thinking', thinking: '先看文件' },
          { type: 'text', text: '正在修改' },
          { type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' } },
        ],
      },
    });
    expect(s4.updates).toEqual([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'tu1',
        name: 'Edit',
        title: 'Edit',
        kind: 'edit',
        status: 'in_progress',
        rawInput: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' },
        locations: [{ path: 'src/a.ts' }],
      },
    ]);

    // tool_result（数组 content + 成功）
    const s5 = tr.push({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'ok' }], is_error: false }],
      },
    });
    expect(s5.updates).toEqual([
      { sessionUpdate: 'tool_call_update', toolCallId: 'tu1', status: 'completed', rawOutput: 'ok' },
    ]);
    expect(tr.toolCalls).toBe(1);

    // 没有 stream_event 的 assistant 帧照常产出文字
    const s6 = tr.push({
      type: 'assistant',
      message: { id: 'm2', content: [{ type: 'text', text: '改完了' }] },
    });
    expect(s6.updates).toEqual([{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '改完了' } }]);

    const s7 = tr.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      stop_reason: 'end_turn',
      session_id: 'sid-1',
      result: '最终答复',
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    expect(s7.result).toEqual({
      stopReason: 'end_turn',
      response: '最终答复',
      usage: { input_tokens: 10, output_tokens: 20 },
      isError: false,
    });
  });

  it('翻译失败的 tool_result 与错误 result', () => {
    const tr = new ClaudeStreamTranslator();
    const u1 = tr.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'boom', is_error: true }] },
    });
    expect(u1.updates).toEqual([
      { sessionUpdate: 'tool_call_update', toolCallId: 'tu2', status: 'failed', rawOutput: 'boom' },
    ]);
    const r = tr.push({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['额度不足'] });
    expect(r.result).toMatchObject({ isError: true, errorMessage: '额度不足' });
  });
});

describe('Claude 委派参数解析', () => {
  it('模型 / 强度回退：配置优先，其次智能体强度，最后主会话', () => {
    expect(
      resolveClaudeDelegateParams({
        defaults: { model: null, effort: null, parentModel: 'opus', parentEffort: 'high' },
      }),
    ).toEqual({ model: 'opus', effort: 'high' });

    expect(
      resolveClaudeDelegateParams({
        defaults: { model: 'haiku', effort: null, parentModel: 'opus', parentEffort: 'high' },
        effort: 'low',
      }),
    ).toEqual({ model: 'haiku', effort: 'low' });

    expect(
      resolveClaudeDelegateParams({
        defaults: { model: 'sonnet', effort: 'max', parentModel: 'opus', parentEffort: 'low' },
        effort: 'medium',
      }),
    ).toEqual({ model: 'sonnet', effort: 'max' });

    // 续接不覆盖模型与强度
    expect(
      resolveClaudeDelegateParams({
        sessionId: 's1',
        defaults: { model: 'sonnet', effort: 'max', parentModel: 'opus', parentEffort: 'low' },
      }),
    ).toEqual({ model: null, effort: null });
  });

  it('buildClaudeDelegateArgs：新会话 / 续接 / 只读权限 / 禁止 Agent', () => {
    const a = buildClaudeDelegateArgs(
      {
        systemPrompt: 'sys prompt',
        defaults: { model: null, effort: null, parentModel: 'sonnet', parentEffort: 'medium' },
      },
      'claude',
    );
    expect(a).toContain('-p');
    expect(a).toContain('--disallowedTools');
    expect(a[a.indexOf('--disallowedTools') + 1]).toBe('Agent');
    expect(a[a.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
    expect(a[a.indexOf('--model') + 1]).toBe('sonnet');
    expect(a[a.indexOf('--effort') + 1]).toBe('medium');
    expect(a[a.indexOf('--append-system-prompt') + 1]).toBe('sys prompt');

    const ro = buildClaudeDelegateArgs({ readOnly: true }, 'claude');
    expect(ro[ro.indexOf('--permission-mode') + 1]).toBe('plan');
    expect(ro).not.toContain('--allow-dangerously-skip-permissions');

    const resume = buildClaudeDelegateArgs({ sessionId: 'sid-9', systemPrompt: 'ignored' }, 'claude');
    expect(resume[resume.indexOf('--resume') + 1]).toBe('sid-9');
    expect(resume).not.toContain('--append-system-prompt');
    expect(resume).not.toContain('--model');
  });
});

describe('ClaudeBackend.run / models / available', () => {
  let tmp: string;
  let fakeBin: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-claude-backend-'));
    const js = path.join(tmp, 'fake-claude.cjs');
    fs.writeFileSync(
      js,
      String.raw`
let prompt = '';
process.stdin.on('data', (d) => { prompt += d.toString('utf8'); });
process.stdin.on('end', () => {
  if (prompt === 'HANG') {
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-hang', model: 'claude-sonnet-5-5' }) + '\n');
    setInterval(() => {}, 1000);
    return;
  }
  if (prompt === 'FAIL') {
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-fail', model: 'claude-sonnet-5-5' }) + '\n');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'sid-fail', result: '模拟失败' }) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-ok', model: 'claude-haiku-5-5' }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'stream_event', api_message_id: 'm1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'echo:' + prompt } } }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } }] } }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file content', is_error: false }] } }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', session_id: 'sid-ok', result: 'done:' + prompt, usage: { input_tokens: 3, output_tokens: 7 } }) + '\n');
});
`,
    );
    if (process.platform === 'win32') {
      fakeBin = path.join(tmp, 'fake-claude.cmd');
      fs.writeFileSync(fakeBin, `@"${process.execPath}" "${js}" %*\r\n`);
    } else {
      fakeBin = path.join(tmp, 'fake-claude.sh');
      fs.writeFileSync(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`, { mode: 0o755 });
    }
  });

  afterAll(async () => {
    // Windows 上 taskkill 异步结束进程，给一点时间释放 tmp 目录句柄
    for (let i = 0; i < 10; i++) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  });

  it('available 与 models', async () => {
    expect(new ClaudeBackend({ claudePath: null }).available()).toBe(false);
    const b = new ClaudeBackend({ claudePath: fakeBin });
    expect(b.available()).toBe(true);
    const list = await b.models();
    expect(list.models.map((m) => m.value)).toEqual(['opus', 'sonnet', 'fable', 'haiku']);
  });

  it('正常执行：通过 stdin 传 prompt，上报 session / model / updates 与最终结果', async () => {
    const b = new ClaudeBackend({ claudePath: fakeBin });
    const updates: Json[] = [];
    let gotSession: [string, string | undefined] | null = null;
    let gotModel: { model: string; effort?: string | null } | null = null;
    const res = await b.run({
      cwd: tmp,
      prompt: 'hello',
      account: { id: 'default', dir: null },
      defaults: { model: 'haiku', effort: 'low' },
      signal: new AbortController().signal,
      onSession: (sid, acc) => { gotSession = [sid, acc]; },
      onModel: (m) => { gotModel = m; },
      onUpdate: (u) => updates.push(u),
    });
    expect(gotSession).toEqual(['sid-ok', 'default']);
    expect(gotModel).toEqual({ model: 'claude-haiku-5-5', effort: 'low' });
    expect(updates.map((u) => u.sessionUpdate)).toEqual(['agent_message_chunk', 'tool_call', 'tool_call_update']);
    expect(res).toEqual({
      stopReason: 'end_turn',
      response: 'done:hello',
      sessionId: 'sid-ok',
      accountId: 'default',
      toolCalls: 1,
      usage: { input_tokens: 3, output_tokens: 7 },
    });
  });

  it('错误 result 抛 BackendError 并保留 sessionId / accountId', async () => {
    const b = new ClaudeBackend({ claudePath: fakeBin });
    await expect(
      b.run({
        cwd: tmp,
        prompt: 'FAIL',
        account: { id: 'default', dir: null },
        signal: new AbortController().signal,
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof BackendError && e.message === '模拟失败' && e.sessionId === 'sid-fail' && e.accountId === 'default');
  });

  it('signal 中止时杀掉进程并抛 已取消', async () => {
    const b = new ClaudeBackend({ claudePath: fakeBin });
    const ac = new AbortController();
    const p = b.run({
      cwd: tmp,
      prompt: 'HANG',
      account: { id: 'default', dir: null },
      signal: ac.signal,
      onSession: () => ac.abort(),
    });
    await expect(p).rejects.toThrow('已取消');
  });
});
