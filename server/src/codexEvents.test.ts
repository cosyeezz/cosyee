import { describe, expect, it } from 'vitest';
import { CodexTurnTranslator, parseCodexModels, unwrapShellCommand } from './delegate/codexEvents.js';
import { parseModelPage } from './delegate/codexProtocol.js';

const T = 'th1';
const tr = (o: Partial<ConstructorParameters<typeof CodexTurnTranslator>[0]> = {}) => new CodexTurnTranslator({ threadId: T, cwd: '/w', ...o });
const item = (type: string, id: string, extra: Record<string, any> = {}) => ({ threadId: T, turnId: 'tu1', item: { type, id, ...extra } });
const done = (status = 'completed', error?: any) => ({ threadId: T, turn: { id: 'tu1', status, ...(error ? { error } : {}) } });
const usage = (total: number, last: number) => ({
  threadId: T,
  tokenUsage: {
    total: { totalTokens: total, inputTokens: total - 10, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 },
    last: { totalTokens: last, inputTokens: last - 5, cachedInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 },
  },
});

describe('CodexTurnTranslator 条目映射', () => {
  it('agentMessage：delta 流式输出，completed 只补缺的部分（去重）', () => {
    const t = tr();
    const a = t.push('item/agentMessage/delta', { threadId: T, itemId: 'm1', delta: '你' });
    expect(a).toEqual([{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你' } }]);
    t.push('item/agentMessage/delta', { threadId: T, itemId: 'm1', delta: '好' });
    expect(t.push('item/completed', item('agentMessage', 'm1', { text: '你好' }))).toEqual([]);
    const rest = t.push('item/completed', item('agentMessage', 'm1', { text: '你好呀' }));
    expect(rest.map((u) => u.content.text)).toEqual(['呀']);
    expect(t.allText).toBe('你好呀');
  });

  it('没有 delta 的 completed 整段输出；第二条消息前加分隔', () => {
    const t = tr();
    t.push('item/completed', item('agentMessage', 'm1', { text: 'A' }));
    const o = t.push('item/completed', item('agentMessage', 'm2', { text: 'B' }));
    expect(o.map((u) => u.content.text)).toEqual(['\n\n', 'B']);
    expect(t.allText).toBe('A\n\nB');
  });

  it('afterToolText：工具之后有新文字就只取新文字，否则回退全部文字', () => {
    const t = tr();
    t.push('item/agentMessage/delta', { threadId: T, itemId: 'm1', delta: '先说一句' });
    t.push('item/started', item('commandExecution', 'c1', { command: 'ls' }));
    t.push('item/completed', item('commandExecution', 'c1', { command: 'ls', status: 'completed', exitCode: 0 }));
    expect(t.result().response).toBe('先说一句');
    t.push('item/agentMessage/delta', { threadId: T, itemId: 'm2', delta: '结论' });
    expect(t.result().response.trim()).toBe('结论');
  });

  it('reasoning：delta 走 agent_thought_chunk；没流式过的 completed 补 summary', () => {
    const t = tr();
    expect(t.push('item/reasoning/summaryTextDelta', { threadId: T, itemId: 'r1', delta: '想' })).toEqual([{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '想' } }]);
    expect(t.push('item/completed', item('reasoning', 'r1', { summary: ['想'] }))).toEqual([]);
    const o = t.push('item/completed', item('reasoning', 'r2', { summary: ['总结'], content: [] }));
    expect(o).toEqual([{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '总结' } }]);
  });

  it('commandExecution → Bash；失败带 exit code；输出取尾部', () => {
    const t = tr();
    const s = t.push('item/started', item('commandExecution', 'c1', { command: 'ls -la', cwd: '/w' }));
    expect(s[0]).toMatchObject({ sessionUpdate: 'tool_call', toolCallId: 'c1', name: 'Bash', kind: 'execute', rawInput: { command: 'ls -la', cwd: '/w' }, status: 'in_progress' });
    expect(t.activeTools.has('c1')).toBe(true);
    t.push('item/commandExecution/outputDelta', { threadId: T, itemId: 'c1', delta: 'boom' });
    const e = t.push('item/completed', item('commandExecution', 'c1', { command: 'ls -la', status: 'completed', exitCode: 2 }));
    expect(e[0]).toMatchObject({ sessionUpdate: 'tool_call_update', status: 'failed', rawOutput: 'boom\n[exit code 2]' });
    expect(t.activeTools.size).toBe(0);
    const big = 'x'.repeat(100_000);
    const t2 = tr();
    const e2 = t2.push('item/completed', item('commandExecution', 'c2', { command: 'y', status: 'completed', exitCode: 0, aggregatedOutput: big }));
    expect(e2[e2.length - 1].rawOutput.length).toBeLessThanOrEqual(33 * 1024);
    expect(e2[e2.length - 1].status).toBe('completed');
  });

  it('被拒绝的命令标记 failed 与已拒绝', () => {
    const t = tr();
    const e = t.push('item/completed', item('commandExecution', 'c1', { command: 'rm -rf x', status: 'declined' }));
    expect(e[e.length - 1]).toMatchObject({ status: 'failed', rawOutput: '[已拒绝执行]' });
  });

  it('fileChange：单文件修改 → Edit，locations 在完成时也带上', () => {
    const t = tr();
    const changes = [{ path: '/w/a.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1,2 +1,2 @@\n ctx\n-old\n+new' }];
    const s = t.push('item/started', item('fileChange', 'f1', { changes }));
    expect(s[0]).toMatchObject({ name: 'Edit', kind: 'edit', rawInput: { file_path: '/w/a.ts', old_string: 'ctx\nold', new_string: 'ctx\nnew' }, locations: [{ path: '/w/a.ts' }] });
    const e = t.push('item/completed', item('fileChange', 'f1', { changes, status: 'completed' }));
    expect(e[0]).toMatchObject({ sessionUpdate: 'tool_call_update', status: 'completed', kind: 'edit', locations: [{ path: '/w/a.ts' }] });
  });

  it('fileChange：新增 → Write，删除 → Delete(kind delete)，多文件拆成每个文件一个步骤', () => {
    const add = tr().push('item/started', item('fileChange', 'f1', { changes: [{ path: '/w/n.txt', kind: { type: 'add' }, diff: 'hello' }] }));
    expect(add[0]).toMatchObject({ name: 'Write', rawInput: { file_path: '/w/n.txt', content: 'hello' } });
    const del = tr().push('item/started', item('fileChange', 'f2', { changes: [{ path: '/w/d.txt', kind: { type: 'delete' }, diff: '' }] }));
    expect(del[0]).toMatchObject({ name: 'Delete', kind: 'delete', rawInput: { file_path: '/w/d.txt' } });
    const changes = [
      { path: '/w/a', kind: { type: 'add' }, diff: 'x' },
      { path: '/w/b', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-old\n+new\n' },
    ];
    const t = tr();
    const multi = t.push('item/started', item('fileChange', 'f3', { changes }));
    expect(multi).toHaveLength(2);
    expect(multi[0]).toMatchObject({ sessionUpdate: 'tool_call', toolCallId: 'f3:0', name: 'Write', kind: 'edit', locations: [{ path: '/w/a' }] });
    expect(multi[1]).toMatchObject({ sessionUpdate: 'tool_call', toolCallId: 'f3:1', name: 'Edit', rawInput: { file_path: '/w/b', old_string: 'old', new_string: 'new' } });
    const done = t.push('item/completed', item('fileChange', 'f3', { changes, status: 'completed' }));
    expect(done.map((u: any) => [u.sessionUpdate, u.toolCallId, u.status])).toEqual([
      ['tool_call_update', 'f3:0', 'completed'],
      ['tool_call_update', 'f3:1', 'completed'],
    ]);
  });

  it('fileChange：开始时一个文件、完成时多个 → 原步骤也收尾，不会一直算工具运行中', () => {
    const t = tr();
    t.push('item/started', item('fileChange', 'f1', { changes: [{ path: '/w/a', kind: { type: 'add' }, diff: 'x' }] }));
    const done = t.push('item/completed', item('fileChange', 'f1', {
      status: 'completed',
      changes: [{ path: '/w/a', kind: { type: 'add' }, diff: 'x' }, { path: '/w/b', kind: { type: 'add' }, diff: 'y' }],
    }));
    expect(done.filter((u: any) => u.sessionUpdate === 'tool_call_update').map((u: any) => u.toolCallId)).toEqual(['f1:0', 'f1:1', 'f1']);
  });

  it('unwrapShellCommand：去掉外层 pwsh / bash 调用并还原转义；认不出原样返回', () => {
    expect(unwrapShellCommand(String.raw`"C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe" -Command 'node math.test.js'`)).toBe('node math.test.js');
    expect(unwrapShellCommand(String.raw`"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile -Command "Get-Content -LiteralPath 'C:\\w\\a.js'; echo \"hi\""`))
      .toBe(String.raw`Get-Content -LiteralPath 'C:\w\a.js'; echo "hi"`);
    expect(unwrapShellCommand(`/bin/bash -lc 'echo it'\\''s'`)).toBe("echo it's");
    expect(unwrapShellCommand('bash -c ls')).toBe('ls');
    expect(unwrapShellCommand('node -e "1"')).toBe('node -e "1"');
    expect(unwrapShellCommand('ls -la')).toBe('ls -la');
  });

  it('fileChange 被拒绝 → failed', () => {
    const t = tr();
    const changes = [{ path: '/w/a', kind: { type: 'add' }, diff: 'x' }];
    const e = t.push('item/completed', item('fileChange', 'f1', { changes, status: 'declined' }));
    expect(e[e.length - 1]).toMatchObject({ status: 'failed', rawOutput: '[已拒绝修改]' });
  });

  it('mcpToolCall / webSearch / imageView / dynamicToolCall / 未知条目', () => {
    const t = tr();
    expect(t.push('item/started', item('mcpToolCall', 'k1', { server: 'fs', tool: 'read', arguments: { p: 1 } }))[0]).toMatchObject({ name: 'mcp__fs__read', rawInput: { p: 1 } });
    const ek = t.push('item/completed', item('mcpToolCall', 'k1', { server: 'fs', tool: 'read', status: 'completed', result: { content: [{ type: 'text', text: '内容' }] } }));
    expect(ek[0]).toMatchObject({ status: 'completed', rawOutput: '内容' });
    const mf = tr().push('item/completed', item('mcpToolCall', 'k2', { server: 's', tool: 't', status: 'failed', error: { message: '坏了' } }));
    expect(mf[mf.length - 1]).toMatchObject({ status: 'failed', rawOutput: '坏了' });
    expect(tr().push('item/started', item('webSearch', 'w1', { query: 'q', action: { type: 'search', query: 'q' } }))[0]).toMatchObject({ name: 'WebSearch', kind: 'search', rawInput: { query: 'q' } });
    expect(tr().push('item/started', item('webSearch', 'w2', { query: '', action: { type: 'openPage', url: 'http://x' } }))[0]).toMatchObject({ name: 'WebFetch', rawInput: { url: 'http://x' } });
    expect(tr().push('item/started', item('imageView', 'i1', { path: '/w/a.png' }))[0]).toMatchObject({ name: 'Read', rawInput: { file_path: '/w/a.png' } });
    expect(tr().push('item/started', item('dynamicToolCall', 'd1', { namespace: 'ns', tool: 'go', arguments: {} }))[0]).toMatchObject({ name: 'ns__go' });
    expect(tr().push('item/started', item('somethingNew', 'u1'))[0]).toMatchObject({ name: 'somethingNew' });
    expect(tr().push('item/started', item('somethingNew', ''))).toEqual([]);
  });

  it('不展示的条目被忽略', () => {
    const t = tr();
    for (const ty of ['userMessage', 'hookPrompt', 'plan', 'contextCompaction', 'enteredReviewMode', 'exitedReviewMode', 'sleep']) {
      expect(t.push('item/completed', item(ty, 'x1', { text: 'a' }))).toEqual([]);
    }
  });

  it('toolCalls 按 id 去重计数', () => {
    const t = tr();
    for (let i = 0; i < 2; i++) t.push('item/completed', item('commandExecution', 'c1', { command: 'a', status: 'completed', exitCode: 0 }));
    t.push('item/completed', item('commandExecution', 'c2', { command: 'b', status: 'completed', exitCode: 0 }));
    expect(t.toolCalls).toBe(2);
  });

  it('turn/plan/updated → plan 条目', () => {
    const o = tr().push('turn/plan/updated', { threadId: T, turnId: 'tu1', plan: [{ step: 'A', status: 'completed' }, { step: 'B', status: 'inProgress' }, { step: 'C', status: 'pending' }] });
    expect(o).toEqual([{ sessionUpdate: 'plan', entries: [{ content: 'A', priority: 'medium', status: 'completed' }, { content: 'B', priority: 'medium', status: 'in_progress' }, { content: 'C', priority: 'medium', status: 'pending' }] }]);
  });
});

describe('CodexTurnTranslator 收尾 / 过滤 / 用量', () => {
  it('turn/completed：状态映射；未结束的工具补 failed', () => {
    const t = tr();
    t.push('item/started', item('commandExecution', 'c1', { command: 'sleep 9' }));
    const o = t.push('turn/completed', done('interrupted'));
    expect(o[0]).toMatchObject({ toolCallId: 'c1', status: 'failed', rawOutput: '已中断' });
    expect(t.done).toBe(true);
    expect(t.result().stopReason).toBe('cancelled');
    const f = tr();
    f.push('turn/completed', done('failed', { message: 'x', codexErrorInfo: 'unauthorized' }));
    expect(f.result()).toMatchObject({ stopReason: 'error' });
    expect(f.result().error).toContain('登录');
  });

  it('失败原因：额度 / 上下文 / 繁忙 / 原文；willRetry 的 error 忽略', () => {
    const mk = (info: any, msg = 'm') => {
      const t = tr();
      t.push('error', { threadId: T, error: { message: msg, codexErrorInfo: info }, willRetry: false });
      t.push('turn/completed', done('failed'));
      return t.result().error!;
    };
    expect(mk('usageLimitExceeded')).toContain('额度');
    expect(mk('contextWindowExceeded')).toContain('上下文');
    expect(mk('serverOverloaded')).toContain('繁忙');
    expect(mk(null, '原文错误')).toBe('原文错误');
    const t = tr();
    t.push('error', { threadId: T, error: { message: '重试中' }, willRetry: true });
    t.push('turn/completed', done('failed'));
    expect(t.result().error).toBe('Codex 执行失败');
  });

  it('按 threadId / turnId 过滤其它事件', () => {
    const t = tr();
    expect(t.push('item/agentMessage/delta', { threadId: 'other', itemId: 'm', delta: 'x' })).toEqual([]);
    t.push('turn/started', { threadId: T, turn: { id: 'tu1', status: 'inProgress' } });
    expect(t.turnId).toBe('tu1');
    expect(t.push('item/agentMessage/delta', { threadId: T, turnId: 'tuX', itemId: 'm', delta: 'x' })).toEqual([]);
    expect(t.push('turn/completed', { threadId: T, turn: { id: 'tuX', status: 'completed' } })).toEqual([]);
    expect(t.done).toBe(false);
  });

  it('用量：多个 turn 取累计差值；基线已知用基线，未知用 total-last 反推', () => {
    const t1 = tr({ usageBaseline: { totalTokens: 100, inputTokens: 90, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 } });
    t1.push('thread/tokenUsage/updated', usage(150, 20));
    t1.push('thread/tokenUsage/updated', usage(180, 30));
    expect(t1.result().usage).toMatchObject({ totalTokens: 80 });
    const t2 = tr();
    t2.push('thread/tokenUsage/updated', usage(500, 40));
    t2.push('thread/tokenUsage/updated', usage(560, 60));
    // 基线 = 500-40 = 460
    expect(t2.result().usage).toMatchObject({ totalTokens: 100 });
    expect(t2.totalUsage?.totalTokens).toBe(560);
    expect(tr().result().usage).toBeUndefined();
  });
});

describe('parseCodexModels', () => {
  const page = (data: any[], nextCursor: string | null = null) => parseModelPage({ data, nextCursor });
  it('隐藏的不列，保留 DelegateEffort（含 none/minimal/ultra），default 取 isDefault，跨页合并', () => {
    const p1 = page(
      [
        { id: 'a', model: 'a', displayName: 'A', hidden: false, isDefault: false, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'minimal' }, { reasoningEffort: 'low' }, { reasoningEffort: 'high' }, { reasoningEffort: 'ultra' }] },
        { id: 'h', model: 'h', displayName: 'H', hidden: true, isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [] },
      ],
      'c2',
    );
    const p2 = page([{ id: 'b', model: 'b', displayName: 'B', hidden: false, isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'xhigh' }, { reasoningEffort: 'none' }] }]);
    const r = parseCodexModels([p1, p2], 7);
    expect(r.models).toEqual([
      { value: 'a', displayName: 'A', efforts: ['minimal', 'low', 'high', 'ultra'] },
      { value: 'b', displayName: 'B', efforts: ['none', 'medium', 'xhigh'] },
    ]);
    expect(r.current).toEqual({ model: 'b', effort: 'medium' });
    expect(r.at).toBe(7);
  });
  it('没有 isDefault 时取第一个可见模型；默认强度支持 minimal，未知强度为 null', () => {
    const r = parseCodexModels([page([{ id: 'a', model: 'a', displayName: 'A', defaultReasoningEffort: 'minimal', supportedReasoningEfforts: [] }])]);
    expect(r.current).toEqual({ model: 'a', effort: 'minimal' });
    const r2 = parseCodexModels([page([{ id: 'a', model: 'a', displayName: 'A', defaultReasoningEffort: 'bogus', supportedReasoningEfforts: [] }])]);
    expect(r2.current).toEqual({ model: 'a', effort: null });
    expect(parseCodexModels([page([])]).current).toBeNull();
  });
});
