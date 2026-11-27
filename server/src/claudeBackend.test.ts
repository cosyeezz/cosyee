import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BackendError } from './delegate/backend.js';
import { NATIVE_SUBAGENT_TOOLS } from './delegate/mcp.js';
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

  it('未知事件类型、工具 kind/locations 映射、tool_result 多种 content、afterToolText 兜底与多条错误 result', () => {
    const tr = new ClaudeStreamTranslator();

    // 未知事件类型静默忽略
    expect(tr.push({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })).toEqual({ updates: [] });
    expect(tr.push({ type: 'system', subtype: 'status', status: 'requesting' })).toEqual({ updates: [] });
    expect(tr.push({ type: 'unknown_future_event', payload: 123 })).toEqual({ updates: [] });

    // message_start 可提前提取 model，且 stream_event 无 api_message_id 时按 message_start.id 去重
    const ms = tr.push({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm10', model: 'claude-opus-5' } } });
    expect(ms.model).toBe('claude-opus-5');
    tr.push({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '思考' } } });
    tr.push({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '调用前文字' } } });
    const dup = tr.push({
      type: 'assistant',
      message: {
        id: 'm10',
        content: [
          { type: 'thinking', thinking: '思考' },
          { type: 'text', text: '调用前文字' },
          { type: 'tool_use', id: 'tu-w', name: 'Write', input: { file_path: 'src/b.ts' } },
          { type: 'tool_use', id: 'tu-me', name: 'MultiEdit', input: { file_path: 'src/c.ts', edits: [{ old_string: 'x', new_string: 'y' }] } },
          { type: 'tool_use', id: 'tu-nb', name: 'NotebookEdit', input: { notebook_path: 'n.ipynb' } },
          { type: 'tool_use', id: 'tu-ps', name: 'PowerShell', input: { command: 'ls' } },
          { type: 'tool_use', id: 'tu-gr', name: 'Grep', input: { pattern: 'foo' } },
          { type: 'tool_use', id: '', name: '', input: 'not-object' },
        ],
      },
    });
    expect(dup.updates.map((u) => [u.sessionUpdate, u.name, u.kind, u.locations])).toEqual([
      ['tool_call', 'Write', 'edit', [{ path: 'src/b.ts' }]],
      ['tool_call', 'MultiEdit', 'edit', [{ path: 'src/c.ts' }]],
      ['tool_call', 'NotebookEdit', 'edit', [{ path: 'n.ipynb' }]],
      ['tool_call', 'PowerShell', 'execute', undefined],
      ['tool_call', 'Grep', 'search', undefined],
      ['tool_call', 'tool', 'other', undefined],
    ]);

    // tool_result 多种 content 形态
    const trRes = tr.push({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu-w', content: null },
          { type: 'tool_result', tool_use_id: 'tu-nb', content: { ok: true } },
          { type: 'tool_result', tool_use_id: 'tu-ps', content: ['line1', { type: 'text', text: 'line2' }] },
        ],
      },
    });
    expect(trRes.updates.map((u) => u.rawOutput)).toEqual(['', '{"ok":true}', 'line1\nline2']);
    expect(tr.toolCalls).toBe(3);

    // 工具后无新文字时，finalText 回退到 allText
    expect(tr.finalText).toBe('调用前文字');

    // 工具后有新文字时，finalText 取工具后的文字
    tr.push({ type: 'assistant', message: { id: 'm11', content: [{ type: 'text', text: '最终总结' }] } });
    expect(tr.finalText).toBe('最终总结');

    // result 文本为空时回退 finalText
    const okRes = tr.push({ type: 'result', subtype: 'success', is_error: false, result: '' });
    expect(okRes.result?.response).toBe('最终总结');

    // 权限拒绝 / 额度用尽 / 登录失效 / 多条错误 result
    const errRes1 = tr.push({ type: 'result', subtype: 'error_max_turns', is_error: false, errors: ['达到最大轮次', '请拆分任务'] });
    expect(errRes1.result).toMatchObject({ isError: true, errorMessage: '达到最大轮次\n请拆分任务' });

    const errRes2 = tr.push({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Invalid API key · Please run /login' });
    expect(errRes2.result).toMatchObject({ isError: true, errorMessage: 'Invalid API key · Please run /login' });
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
    const disallowed = a[a.indexOf('--disallowedTools') + 1]!.split(',');
    expect(disallowed).toEqual([...NATIVE_SUBAGENT_TOOLS]);
    expect(disallowed).not.toContain('TaskStop');
    expect(disallowed).not.toContain('Monitor');
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
  if (prompt === 'CHUNKED_NOISE') {
    // 非 JSON 日志行 + 分块半行（含多字节中文在字节边界切断）+ \r\n + 超长行 + 最后一行无换行
    process.stdout.write('WARNING: non-json noise line\r\n');
    process.stdout.write('[1,2,3]\n');
    const initBuf = Buffer.from(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-chunk', model: 'claude-sonnet-5-5' }) + '\r\n', 'utf8');
    process.stdout.write(initBuf.subarray(0, 15));
    setTimeout(() => {
      process.stdout.write(initBuf.subarray(15));
      const big = '中'.repeat(40_000);
      const textBuf = Buffer.from(JSON.stringify({ type: 'stream_event', api_message_id: 'mc', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '你好世界' + big } } }) + '\n', 'utf8');
      // 故意在 UTF-8 多字节字符中间切开
      const mid = textBuf.indexOf(Buffer.from('你好世界', 'utf8')) + 2;
      process.stdout.write(textBuf.subarray(0, mid));
      setTimeout(() => {
        process.stdout.write(textBuf.subarray(mid));
        // 最后一行不带换行符，靠 flush() 消费
        process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', session_id: 'sid-chunk', result: '' }));
      }, 15);
    }, 15);
    return;
  }
  if (prompt === 'EXIT_ZERO_EMPTY') {
    process.exit(0);
  }
  if (prompt === 'EXIT_ZERO_NO_RESULT') {
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-nores', model: 'claude-sonnet-5-5' }) + '\n');
    process.stdout.write(JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: '仅 assistant 文本' }] } }) + '\n');
    process.exit(0);
  }
  if (prompt === 'EXIT_NONZERO') {
    process.stderr.write('fatal: auth expired');
    process.exit(42);
  }
  if (prompt.startsWith('ENV_AND_ECHO:')) {
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-env', model: 'claude-sonnet-5-5' }) + '\n');
    process.stdout.write(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      stop_reason: 'end_turn',
      session_id: 'sid-env',
      result: JSON.stringify({
        prompt,
        args: process.argv.slice(2),
        configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
        claudeCodeLeak: process.env.CLAUDECODE ?? process.env.CLAUDE_CODE_ENTRYPOINT ?? null,
      }),
    }) + '\n');
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
      fs.writeFileSync(fakeBin, `@"${process.execPath}" "%~dp0fake-claude.cjs" %*\r\n`);
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

  it('分块/半行/多字节切断/非 JSON 噪声/超长行/末尾无换行 都能正确解析', async () => {
    const b = new ClaudeBackend({ claudePath: fakeBin });
    const res = await b.run({
      cwd: tmp,
      prompt: 'CHUNKED_NOISE',
      account: { id: 'default', dir: null },
      signal: new AbortController().signal,
    });
    expect(res.sessionId).toBe('sid-chunk');
    expect(res.response.startsWith('你好世界')).toBe(true);
    expect(res.response.length).toBe(4 + 40_000);
  });

  it('进程生命周期：找不到可执行文件 / 预取消 / 退出码 0 空输出 / 退出码 0 无 result / 非零退出码带 stderr', async () => {
    const missing = new ClaudeBackend({ claudePath: null });
    await expect(
      missing.run({ cwd: tmp, prompt: 'hi', signal: new AbortController().signal }),
    ).rejects.toThrow('未安装 Claude CLI');

    const enoent = new ClaudeBackend({ claudePath: path.join(tmp, 'definitely-not-exists-claude.exe') });
    await expect(
      enoent.run({ cwd: tmp, prompt: 'hi', signal: new AbortController().signal }),
    ).rejects.toSatisfy((e: unknown) => e instanceof BackendError && e.message.includes('无法启动 Claude 委派进程'));

    const ac = new AbortController();
    ac.abort();
    const b = new ClaudeBackend({ claudePath: fakeBin });
    await expect(b.run({ cwd: tmp, prompt: 'hi', signal: ac.signal })).rejects.toThrow('已取消');

    await expect(
      b.run({ cwd: tmp, prompt: 'EXIT_ZERO_EMPTY', signal: new AbortController().signal }),
    ).rejects.toSatisfy((e: unknown) => e instanceof BackendError && e.message.includes('退出码 0'));

    const noRes = await b.run({ cwd: tmp, prompt: 'EXIT_ZERO_NO_RESULT', signal: new AbortController().signal });
    expect(noRes).toMatchObject({ sessionId: 'sid-nores', response: '仅 assistant 文本', stopReason: 'end_turn' });

    await expect(
      b.run({ cwd: tmp, prompt: 'EXIT_NONZERO', signal: new AbortController().signal }),
    ).rejects.toSatisfy((e: unknown) => e instanceof BackendError && e.message.includes('退出码 42') && e.message.includes('fatal: auth expired'));
  });

  it('多任务并行执行、特殊字符 prompt（stdin）、独立 CLAUDE_CONFIG_DIR（含空格中文）与 signal 监听器清理', async () => {
    const subDir = path.join(tmp, '独立 空间 中文');
    fs.mkdirSync(subDir, { recursive: true });
    const finished: string[] = [];
    const b = new ClaudeBackend({
      claudePath: fakeBin,
      subagentAccountId: () => 'sub1',
      prepareAccount: (id) => ({ id, dir: subDir, mainDir: null }),
      finishAccount: (id) => finished.push(id),
    });

    const specialPrompts = [
      'ENV_AND_ECHO:line1\nline2 "quoted" \'single\' %PATH% ^caret & pipe | > < 中文',
      'ENV_AND_ECHO:task-2-parallel',
      'ENV_AND_ECHO:task-3-parallel',
    ];

    const listenerCounts: { add: number; remove: number }[] = [];
    const results = await Promise.all(
      specialPrompts.map((p) => {
        const ac = new AbortController();
        const count = { add: 0, remove: 0 };
        listenerCounts.push(count);
        const origAdd = ac.signal.addEventListener.bind(ac.signal);
        const origRem = ac.signal.removeEventListener.bind(ac.signal);
        ac.signal.addEventListener = ((...a: Parameters<typeof origAdd>) => {
          count.add++;
          return origAdd(...a);
        }) as typeof origAdd;
        ac.signal.removeEventListener = ((...a: Parameters<typeof origRem>) => {
          count.remove++;
          return origRem(...a);
        }) as typeof origRem;
        return b.run({ cwd: tmp, prompt: p, signal: ac.signal });
      }),
    );

    expect(finished).toEqual(['sub1', 'sub1', 'sub1']);
    for (let i = 0; i < results.length; i++) {
      const payload = JSON.parse(results[i]!.response) as { prompt: string; configDir: string | null; claudeCodeLeak: string | null };
      expect(payload.prompt).toBe(specialPrompts[i]);
      expect(payload.configDir).toBe(subDir);
      expect(payload.claudeCodeLeak).toBeNull();
      expect(listenerCounts[i]!.add).toBe(1);
      expect(listenerCounts[i]!.remove).toBe(1);
    }
  });

  it('prepareAccount 返回 null 或抛错时抛 BackendError 且不启进程', async () => {
    const bMissing = new ClaudeBackend({
      claudePath: fakeBin,
      prepareAccount: () => null,
    });
    await expect(
      bMissing.run({ cwd: tmp, prompt: 'hi', signal: new AbortController().signal }),
    ).rejects.toSatisfy((e: unknown) => e instanceof BackendError && e.message.includes('子代理账号不存在'));

    await expect(
      bMissing.run({ cwd: tmp, prompt: 'hi', sessionId: 's1', accountId: 'acc1', signal: new AbortController().signal }),
    ).rejects.toSatisfy((e: unknown) => e instanceof BackendError && e.message.includes('账号已移除') && e.sessionId === 's1');

    const bThrow = new ClaudeBackend({
      claudePath: fakeBin,
      prepareAccount: () => { throw new Error('同步凭据失败'); },
    });
    await expect(
      bThrow.run({ cwd: tmp, prompt: 'hi', signal: new AbortController().signal }),
    ).rejects.toSatisfy((e: unknown) => e instanceof BackendError && e.message.includes('同步凭据失败'));
  });

  it('runningCount 按 accountId 准确统计运行中子进程，正常/错误/中止/启动失败后均归零', async () => {
    const b = new ClaudeBackend({ claudePath: fakeBin });
    expect(b.runningCount()).toBe(0);
    expect(b.runningCount('accA')).toBe(0);

    const ac1 = new AbortController();
    const ac2 = new AbortController();
    let seen1 = false;
    let seen2 = false;
    const p1 = b.run({
      cwd: tmp,
      prompt: 'HANG',
      account: { id: 'accA', dir: null },
      signal: ac1.signal,
      onSession: () => { seen1 = true; },
    });
    const p2 = b.run({
      cwd: tmp,
      prompt: 'HANG',
      account: { id: 'accB', dir: null },
      signal: ac2.signal,
      onSession: () => { seen2 = true; },
    });
    for (let i = 0; i < 100 && (!seen1 || !seen2); i++) await new Promise((r) => setTimeout(r, 20));
    expect(b.runningCount('accA')).toBe(1);
    expect(b.runningCount('accB')).toBe(1);
    expect(b.runningCount()).toBe(2);

    ac1.abort();
    await expect(p1).rejects.toThrow('已取消');
    expect(b.runningCount('accA')).toBe(0);
    expect(b.runningCount('accB')).toBe(1);
    expect(b.runningCount()).toBe(1);

    ac2.abort();
    await expect(p2).rejects.toThrow('已取消');
    expect(b.runningCount('accB')).toBe(0);
    expect(b.runningCount()).toBe(0);

    // ENOENT 与同步抛错不泄漏计数
    const bad = new ClaudeBackend({ claudePath: path.join(tmp, 'no-such-claude-bin') });
    await expect(bad.run({ cwd: tmp, prompt: 'hi', account: { id: 'accC', dir: null }, signal: new AbortController().signal })).rejects.toThrow();
    expect(bad.runningCount('accC')).toBe(0);

    const syncErr = new ClaudeBackend({
      claudePath: fakeBin,
      spawn: () => { throw new Error('sync boom'); },
    });
    await expect(syncErr.run({ cwd: tmp, prompt: 'hi', account: { id: 'accD', dir: null }, signal: new AbortController().signal })).rejects.toThrow();
    expect(syncErr.runningCount('accD')).toBe(0);
  });
});
