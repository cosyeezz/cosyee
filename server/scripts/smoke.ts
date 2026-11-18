// 手动集成测试：进程内起后端，真实调用 claude（--model haiku，临时 cwd），走一遍 WS + REST 主流程。
// 运行：npm run smoke -w server
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-smoke-home-'));
process.env.COSYEE_HOME = tmpHome; // 不写真实的 ~/.cosyee/state.json
const { startServer } = await import('../src/server.js');

const CWD = path.join(os.tmpdir(), 'cosyee-c1');
fs.mkdirSync(CWD, { recursive: true });
const CONFIG = { model: 'haiku', effort: 'low' } as const;

const results: { name: string; ok: boolean; note?: string }[] = [];
function check(name: string, ok: boolean, note?: string): void {
  results.push({ name, ok, note });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? '  -- ' + note : ''}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const srv = await startServer({ port: 0, stateFile: path.join(tmpHome, 'state.json') });
const base = `http://127.0.0.1:${srv.port}`;
const H = { 'content-type': 'application/json' };
const api = async (p: string, init?: RequestInit) => {
  const r = await fetch(base + p, { ...init, headers: { ...H, ...(init?.headers ?? {}) } });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
};

const sid = crypto.randomUUID();
const msgs: any[] = [];
const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
await new Promise<void>((res, rej) => {
  ws.on('open', () => res());
  ws.on('error', rej);
});
ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
const wsSend = (m: unknown) => ws.send(JSON.stringify(m));

async function waitFor(pred: () => boolean, ms: number, what: string): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(100);
  }
  console.log(`  (等待超时: ${what})`);
  return false;
}
const statusAfter = (from: number) => msgs.slice(from).filter((m) => m.t === 'status').map((m) => m.status);
const events = (from = 0) => msgs.slice(from).filter((m) => m.t === 'event').map((m) => m.e);

function claudeProcs(): Promise<string[]> {
  return new Promise((resolve) => {
    const ps = `Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | Where-Object { $_.CommandLine -like '*${sid}*' } | ForEach-Object { $_.ProcessId }`;
    execFile('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true }, (_e, out) => {
      resolve(String(out).split(/\s+/).filter(Boolean));
    });
  });
}

try {
  // 1. 订阅 + 新会话发消息
  wsSend({ t: 'subscribe', sessionId: sid });
  await waitFor(() => msgs.some((m) => m.t === 'status'), 3000, 'subscribe status');
  check('订阅未启动的会话得到 status idle', msgs.find((m) => m.t === 'status')?.status === 'idle');

  let mark = msgs.length;
  wsSend({ t: 'send', sessionId: sid, cwd: CWD, text: '用 Bash 执行 echo hi 然后回复 ok', config: CONFIG, isNew: true });
  const gotResult = await waitFor(() => events(mark).some((e) => e.type === 'result'), 120_000, 'result');
  const evs = events(mark);
  check('收到 cosyee_user 事件', evs.some((e) => e.type === 'cosyee_user'));
  check('收到 system init / assistant / tool_use(Bash) / result', evs.some((e) => e.type === 'system' && e.subtype === 'init') && evs.some((e) => e.type === 'assistant') && JSON.stringify(evs).includes('"name":"Bash"') && gotResult);
  check('收到 stream_event 增量', evs.some((e) => e.type === 'stream_event'));
  await waitFor(() => statusAfter(mark).includes('idle'), 10_000, 'idle');
  const st1 = statusAfter(mark);
  check('status 依次 starting/running -> idle', st1[st1.length - 1] === 'idle' && st1.includes('running'), st1.join('>'));
  const settings = msgs.find((m) => m.t === 'settings');
  check('收到 settings 广播', !!settings, settings ? JSON.stringify(settings.applied) : undefined);
  const leaked = JSON.stringify(settings?.applied ?? {});
  check('settings 只含四个允许字段', Object.keys(settings?.applied ?? {}).every((k) => ['model', 'effort', 'ultracode', 'ultracodeAvailable'].includes(k)), leaked);

  // 2. 会话列表
  const list = await api(`/api/sessions?cwd=${encodeURIComponent(CWD)}`);
  const row = (list.json as any[]).find((s) => s.id === sid);
  check('GET /api/sessions 能看到新会话', !!row, row ? `title=${row.title} dot=${row.dot}` : undefined);

  // 3. 改名（进程在线，走 rename_session）
  const rn = await api(`/api/sessions/${sid}/rename`, { method: 'POST', body: JSON.stringify({ cwd: CWD, title: 'smoke 改名 1' }) });
  check('rename（进程在线）返回 ok', rn.status === 200, String(rn.status));
  await sleep(500);
  const list2 = await api(`/api/sessions?cwd=${encodeURIComponent(CWD)}`);
  check('rename 后列表标题变化', (list2.json as any[]).find((s) => s.id === sid)?.title === 'smoke 改名 1', (list2.json as any[]).find((s) => s.id === sid)?.title);
  check('收到 sessions.changed', msgs.some((m) => m.t === 'sessions.changed'));

  // 4. history
  const hist = await api(`/api/sessions/${sid}/history?cwd=${encodeURIComponent(CWD)}`);
  const entries = (hist.json?.entries ?? []) as any[];
  const hs = JSON.stringify(entries);
  check('GET history 有 user/assistant 条目', entries.some((e) => e.type === 'user') && entries.some((e) => e.type === 'assistant'), `${entries.length} 条`);
  check('history 不含 attachment/session-owner/邮箱', !entries.some((e) => e.type === 'attachment') && !hs.includes('session-owner') && !/[\w.-]+@[\w-]+\.\w{2,}/.test(hs));

  // 5. context refresh
  const ctx = await api(`/api/context/${sid}/refresh`, { method: 'POST', body: JSON.stringify({ cwd: CWD }) });
  check('POST context/refresh 有数据', !!ctx.json && ctx.json.totalTokens > 0, ctx.json ? `used=${ctx.json.usedTokens}/${ctx.json.totalTokens} ${ctx.json.percent}%` : 'null');
  check('context 不含 path 字段', !JSON.stringify(ctx.json).includes('"path"'));
  const ctxGet = await api(`/api/context/${sid}`);
  check('GET context 命中缓存', !!ctxGet.json);

  // 6. interrupt
  mark = msgs.length;
  wsSend({ t: 'send', sessionId: sid, cwd: CWD, text: '用 Bash 执行 ping -n 31 127.0.0.1', config: CONFIG });
  await waitFor(() => JSON.stringify(events(mark)).includes('"name":"Bash"'), 60_000, 'Bash tool_use');
  await sleep(3000);
  const tInt = Date.now();
  wsSend({ t: 'interrupt', sessionId: sid });
  const ended = await waitFor(() => events(mark).some((e) => e.type === 'result') && statusAfter(mark).slice(-1)[0] === 'idle', 20_000, 'interrupt result');
  const res = events(mark).find((e) => e.type === 'result');
  check('interrupt 后本轮结束', ended, `${Date.now() - tInt}ms, subtype=${res?.subtype}`);
  check('interrupt 后进程仍在', (await claudeProcs()).length > 0);

  mark = msgs.length;
  wsSend({ t: 'send', sessionId: sid, cwd: CWD, text: '只回复 ok', config: CONFIG });
  const again = await waitFor(() => events(mark).some((e) => e.type === 'result'), 90_000, '继续对话 result');
  check('interrupt 后可以继续对话', again, events(mark).find((e) => e.type === 'result')?.subtype);
  await waitFor(() => statusAfter(mark).slice(-1)[0] === 'idle', 10_000, 'idle');

  // 7. replay：运行中的订阅者补发
  mark = msgs.length;
  wsSend({ t: 'send', sessionId: sid, cwd: CWD, text: '用 Bash 执行 ping -n 8 127.0.0.1，然后回复 done', config: CONFIG });
  await waitFor(() => JSON.stringify(events(mark)).includes('"name":"Bash"'), 60_000, 'Bash 2');
  const msgs2: any[] = [];
  const ws2 = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
  await new Promise<void>((r) => ws2.on('open', () => r()));
  ws2.on('message', (d) => msgs2.push(JSON.parse(d.toString())));
  ws2.send(JSON.stringify({ t: 'subscribe', sessionId: sid }));
  await waitFor(() => msgs2.some((m) => m.t === 'replay'), 5000, 'replay');
  const rp = msgs2.find((m) => m.t === 'replay');
  check('运行中订阅得到 replay（含 cosyee_user 起头）', !!rp && rp.events[0]?.type === 'cosyee_user' && rp.status === 'running', rp ? `${rp.events.length} 条` : undefined);
  const stIdx = msgs2.findIndex((m) => m.t === 'status');
  const rpIdx = msgs2.findIndex((m) => m.t === 'replay');
  check('status 先于 replay', stIdx >= 0 && stIdx < rpIdx);
  await waitFor(() => msgs2.some((m) => m.t === 'event' && m.e.type === 'result'), 90_000, 'ws2 result');
  ws2.close();
  await waitFor(() => statusAfter(mark).slice(-1)[0] === 'idle', 10_000, 'idle');

  // 8. 关闭后端后不应残留 claude 进程
  const before = await claudeProcs();
  console.log(`  关闭前 claude 进程: ${before.length}`);
} finally {
  ws.close();
  await srv.stop();
  await sleep(1500);
  const left = await claudeProcs();
  check('关闭后端后没有残留 claude 进程', left.length === 0, left.length ? `残留 pid: ${left.join(',')}` : undefined);
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n结果: ${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
