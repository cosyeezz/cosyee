// 消息队列 / steering / 回退 协议探测。用法：node queue-probe.mjs <A|B|C|D|E|E2|F|G>
// 每个场景单独一个 claude 进程（新 session-id），cwd 为 os.tmpdir() 下新建的空目录，模型 haiku、effort low。
// 产物：
//   shared/fixtures/queue-<name>.jsonl            原始 stdout（逐行，不带时间戳）
//   shared/fixtures/queue-<name>.transcript.jsonl 会话 transcript 精简副本（丢弃 api-request*/系统提示词类条目，长字符串截断）
//   spike/queue-<name>.sent.json                  发给 stdin 的内容（带相对毫秒时间）
//   spike/queue-<name>.timeline.txt               stdout 每行的相对时间戳 + 摘要（流式 delta 省略）
//   spike/queue-<name>.stderr.txt
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FIX = 'F:\\Cosyee\\shared\\fixtures';
const SPK = 'F:\\Cosyee\\spike';

function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    const key = k.toUpperCase();
    if (key.startsWith('CLAUDE_CODE_') || key === 'CLAUDECODE') continue;
    env[k] = v;
  }
  return env;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function brief(m) {
  const b = { type: m.type };
  if (m.subtype) b.subtype = m.subtype;
  if (m.type === 'stream_event') {
    const e = m.event;
    return `stream_event:${e.type}${e.delta?.type ? ':' + e.delta.type : ''}${e.delta?.stop_reason ? ':' + e.delta.stop_reason : ''}`;
  }
  if (m.type === 'assistant' || m.type === 'user') {
    const c = m.message?.content;
    b.keys = Object.keys(m).filter((k) => !['type', 'message', 'session_id', 'parent_tool_use_id'].includes(k)).join(',');
    if (m.isReplay) b.isReplay = true;
    if (m.uuid) b.uuid = m.uuid.slice(0, 8);
    b.blocks = (Array.isArray(c) ? c : [{ type: 'str', text: c }]).map((x) =>
      x.type + ':' + (x.name ?? '') + ':' + JSON.stringify(x.text ?? x.input ?? x.content ?? '').slice(0, 100));
    return JSON.stringify(b);
  }
  if (m.type === 'system' && m.subtype === 'init') return JSON.stringify({ ...b, capabilities: m.capabilities, model: m.model });
  if (m.type === 'result') return JSON.stringify({ ...b, subtype: m.subtype, stop_reason: m.stop_reason, terminal_reason: m.terminal_reason, is_error: m.is_error, result: String(m.result ?? '').slice(0, 80), num_turns: m.num_turns });
  const s = JSON.stringify(m);
  return s.length > 400 ? s.slice(0, 400) + '…' : s;
}

function findTranscript(sid) {
  const roots = [];
  if (process.env.CLAUDE_CONFIG_DIR) roots.push(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects'));
  roots.push(path.join(os.homedir(), '.claude', 'projects'));
  for (const r of roots) {
    try {
      for (const d of fs.readdirSync(r)) {
        const p = path.join(r, d, sid + '.jsonl');
        if (fs.existsSync(p)) return p;
      }
    } catch { /* ignore */ }
  }
  return null;
}

const DROP = new Set(['api-request', 'api-request-blob', 'api-request-shape', 'session-owner', 'cost-state']);
function trunc(v) {
  if (typeof v === 'string') return v.length > 300 ? v.slice(0, 300) + `…(${v.length})` : v;
  if (Array.isArray(v)) return v.map(trunc);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trunc(x)]));
  return v;
}
function filterTranscript(file) {
  const out = [];
  const stats = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (DROP.has(o.type)) continue;
    if (o.type === 'attachment') {
      const t = o.attachment?.type;
      stats[t] = (stats[t] ?? 0) + 1;
      if (t !== 'queued_command') { out.push({ type: 'attachment', attachment: { type: t }, uuid: o.uuid, parentUuid: o.parentUuid, timestamp: o.timestamp, _body: 'omitted' }); continue; }
    }
    out.push(trunc(o));
  }
  return { lines: out.map((o) => JSON.stringify(o)), attachmentTypes: stats };
}

async function runScenario(name, args, driver) {
  const sid = randomUUID();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `cosyee-queue-${name.toLowerCase()}-`));
  const cliArgs = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--forward-subagent-text', '--replay-user-messages', '--dangerously-skip-permissions',
    '--model', 'haiku', '--effort', 'low', '--session-id', sid, ...args];
  const child = spawn('C:\\Users\\dane\\.local\\bin\\claude.exe', cliArgs, { cwd, env: cleanEnv() });
  const fixName = 'queue-' + name.toLowerCase();
  const out = fs.createWriteStream(path.join(FIX, fixName + '.jsonl'));
  const tl = [];
  const errLog = [];
  const sent = [];
  const msgs = [];
  const waiters = [];
  let lastLine = Date.now();
  const t0 = Date.now();
  const T = () => ((Date.now() - t0) / 1000).toFixed(2);
  const ctx = {
    sid, cwd, msgs, t0, sleep,
    get results() { return msgs.filter((m) => m.type === 'result').length; },
    mark: (s) => { tl.push(`+${T()}s ## ${s}`); console.log(`[${T()}s] ## ${s}`); },
    send(o) {
      child.stdin.write(JSON.stringify(o) + '\n');
      sent.push({ t: Date.now() - t0, o });
      tl.push(`+${T()}s -> ${JSON.stringify(o).slice(0, 300)}`);
      console.log(`[${T()}s] ->`, JSON.stringify(o).slice(0, 200));
    },
    user(text, extra = {}) {
      const uuid = extra.uuid ?? randomUUID();
      this.send({ type: 'user', ...extra, uuid, message: { role: 'user', content: text } });
      return uuid;
    },
    ctl(subtype, fields = {}, timeoutMs = 20000) {
      const request_id = 'q' + Math.random().toString(36).slice(2, 8);
      const p = this.wait((m) => m.type === 'control_response' && m.response?.request_id === request_id, timeoutMs, true).then((m) => m, () => ({ timeout: true }));
      this.send({ type: 'control_request', request_id, request: { subtype, ...fields } });
      return p;
    },
    // 等待满足条件的消息（含已到达的）；fromNow=true 只看之后到达的
    wait(pred, ms = 60000, fromNow = false) {
      return new Promise((resolve, reject) => {
        if (!fromNow) { const hit = msgs.find(pred); if (hit) return resolve(hit); }
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error('wait timeout')); } }, ms);
      });
    },
    async until(fn, ms = 90000) { const e = Date.now() + ms; while (Date.now() < e) { if (fn()) return true; await sleep(100); } return false; },
    async settle(quietMs = 5000, maxMs = 30000) { const e = Date.now() + maxMs; while (Date.now() < e) { if (Date.now() - lastLine > quietMs) return; await sleep(200); } },
    end() { try { child.stdin.end(); } catch { /* ignore */ } },
  };
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    lastLine = Date.now();
    out.write(line + '\n');
    let m; try { m = JSON.parse(line); } catch { tl.push(`+${T()}s [raw] ${line.slice(0, 200)}`); return; }
    msgs.push(m);
    const b = brief(m);
    if (m.type !== 'stream_event' || !/content_block_delta/.test(b) || /text_delta/.test(b)) tl.push(`+${T()}s <- ${b}`);
    if (m.type !== 'stream_event') console.log(`[${T()}s] <-`, b.slice(0, 260));
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  child.stderr.on('data', (d) => errLog.push(String(d)));
  const exited = new Promise((res) => child.on('exit', res));
  const killer = setTimeout(() => { console.log('HARD TIMEOUT'); spawn('taskkill', ['/PID', String(child.pid), '/T', '/F']); }, 240000);
  console.log('scenario', name, 'sid', sid, 'cwd', cwd);
  try { await driver(ctx); } catch (e) { console.log('driver error', e); ctx.mark('driver error ' + e.message); }
  ctx.end();
  const code = await Promise.race([exited, sleep(15000).then(() => 'kill')]);
  if (code === 'kill') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F']);
  clearTimeout(killer);
  out.end();
  await sleep(500);
  fs.writeFileSync(path.join(SPK, fixName + '.sent.json'), JSON.stringify(sent, null, 1));
  fs.writeFileSync(path.join(SPK, fixName + '.stderr.txt'), errLog.join(''));
  fs.writeFileSync(path.join(SPK, fixName + '.timeline.txt'), tl.join('\n') + '\n');
  const tf = findTranscript(sid);
  if (tf) {
    const { lines, attachmentTypes } = filterTranscript(tf);
    fs.writeFileSync(path.join(FIX, fixName + '.transcript.jsonl'), lines.join('\n') + '\n');
    console.log('transcript', tf, lines.length, 'lines; attachment types', attachmentTypes);
  } else console.log('transcript NOT FOUND');
  console.log('exit', code, 'results', ctx.results);
}

const M1 = '请用 Bash 工具依次运行 3 次命令 `sleep 4`（每次单独一次工具调用，不要合并、不要后台运行），每次完成后用一句话报告进度，最后说 DONE-M1。';
const firstToolUse = (m) => m.type === 'assistant' && Array.isArray(m.message?.content) && m.message.content.some((b) => b.type === 'tool_use');
const toolResult = (m) => m.type === 'user' && Array.isArray(m.message?.content) && m.message.content.some((b) => b.type === 'tool_result');

const S = {};

S.A = () => runScenario('A', [], async (c) => {
  c.user(M1, { uuid: randomUUID() });
  await c.wait(firstToolUse, 60000);
  await c.sleep(800);
  c.mark('send M2 next');
  c.user('另外请在最后说一句 STEER-OK', { priority: 'next' });
  await c.until(() => c.results >= 1, 90000);
  await c.settle(6000, 40000);
});

S.B = () => runScenario('B', [], async (c) => {
  c.user(M1);
  await c.wait(firstToolUse, 60000);
  await c.sleep(800);
  c.mark('send M2 later');
  c.user('请只回复 FOLLOW-OK，不要用工具。', { priority: 'later' });
  await c.until(() => c.results >= 2, 120000);
  await c.settle(5000, 30000);
});

S.C = () => runScenario('C', [], async (c) => {
  c.user(M1);
  await c.wait(firstToolUse, 60000);
  await c.sleep(800);
  c.mark('send M2 (no priority)');
  c.user('另外请在最后说一句 NOPRIO-OK');
  await c.until(() => c.results >= 1, 90000);
  await c.settle(7000, 40000);
});

S.D = () => runScenario('D', [], async (c) => {
  const u1 = c.user(M1);
  await c.wait(firstToolUse, 60000);
  await c.sleep(800);
  c.mark('send M2 later');
  const u2 = c.user('请只回复 LATER-OK，不要用工具。', { priority: 'later' });
  await c.sleep(400);
  c.mark('cancel_async_message u2');
  await c.ctl('cancel_async_message', { message_uuid: u2 });
  await c.sleep(300);
  c.mark('cancel u2 again (expect fail)');
  await c.ctl('cancel_async_message', { message_uuid: u2 });
  c.mark('cancel unknown uuid');
  await c.ctl('cancel_async_message', { message_uuid: randomUUID() });
  await c.until(() => c.results >= 1, 90000);
  await c.settle(7000, 40000);
  c.mark('cancel u1 after consumed');
  await c.ctl('cancel_async_message', { message_uuid: u1 });
});

S.E = () => runScenario('E', [], async (c) => {
  c.user(M1);
  await c.wait(firstToolUse, 60000);
  await c.sleep(800);
  c.mark('send M2 later');
  const u2 = c.user('请只回复 SENDNOW-OK，不要用工具。', { priority: 'later' });
  await c.sleep(500);
  c.mark('interrupt send_now u2');
  await c.ctl('interrupt', { send_now: true, message_uuid: u2 });
  await c.until(() => c.results >= 2, 90000);
  await c.settle(6000, 30000);
  c.mark('interrupt send_now with nothing waiting');
  await c.ctl('interrupt', { send_now: true, message_uuid: randomUUID() });
});

S.E2 = () => runScenario('E2', [], async (c) => {
  c.user(M1);
  await c.wait(firstToolUse, 60000);
  await c.sleep(800);
  c.mark('send M2 now');
  c.user('请只回复 NOW-OK，不要用工具。', { priority: 'now' });
  await c.until(() => c.results >= 2, 90000);
  await c.settle(6000, 30000);
});

// G：cancel_queued（顺带）
S.G = () => runScenario('G', [], async (c) => {
  c.user(M1);
  await c.wait(firstToolUse, 60000);
  await c.sleep(800);
  c.mark('send M2 later + M3 next');
  c.user('请只回复 Q2-OK，不要用工具。', { priority: 'later' });
  c.user('最后说一句 Q3-OK', { priority: 'next' });
  await c.sleep(400);
  c.mark('interrupt cancel_queued');
  await c.ctl('interrupt', { cancel_queued: true });
  await c.until(() => c.results >= 1, 90000);
  await c.settle(7000, 40000);
});

S.F = () => runScenario('F', [], async (c) => {
  const u1 = c.user('记住数字 1，回复 OK', { uuid: randomUUID() });
  await c.until(() => c.results >= 1, 60000); await c.settle(1500);
  const u2 = c.user('记住数字 2，回复 OK', { uuid: randomUUID() });
  await c.until(() => c.results >= 2, 60000); await c.settle(1500);
  c.mark('rewind_files dry_run u2');
  await c.ctl('rewind_files', { user_message_id: u2, dry_run: true });
  c.mark('rewind_conversation u2');
  const r = await c.ctl('rewind_conversation', { target_message_uuid: u2 });
  c.mark('rewind response: ' + JSON.stringify(r).slice(0, 400));
  await c.settle(2000);
  const u3 = c.user('我让你记住过哪些数字？只回答数字。', { uuid: randomUUID() });
  await c.until(() => c.results >= 3, 60000); await c.settle(1500);
  // 运行中 rewind
  const u4 = c.user(M1, { uuid: randomUUID() });
  await c.wait(firstToolUse, 60000);
  await c.sleep(800);
  c.mark('rewind_conversation u4 interrupt_if_running while running');
  const r2 = await c.ctl('rewind_conversation', { target_message_uuid: u4, interrupt_if_running: true });
  c.mark('rewind(running) response: ' + JSON.stringify(r2).slice(0, 400));
  await c.settle(6000, 40000);
  c.mark('post-rewind probe');
  c.user('我让你记住过哪些数字？以及我刚才让你做过什么事？一句话。', { uuid: randomUUID() });
  await c.until(() => c.results >= 5, 60000); await c.settle(1500);
  c.mark('rewind_files non-dry u1 (expect error?)');
  await c.ctl('rewind_files', { user_message_id: u1, dry_run: true });
});


// H：rewind 的错误形态 + 空闲时发 priority next
S.H = () => runScenario('H', [], async (c) => {
  const u1 = c.user('只回复 OK，不要用工具。');
  await c.until(() => c.results >= 1, 60000); await c.settle(1500);
  const asst = c.msgs.find((m) => m.type === 'assistant' && !m.parent_tool_use_id);
  c.mark('rewind unknown uuid');
  await c.ctl('rewind_conversation', { target_message_uuid: randomUUID() });
  c.mark('rewind assistant uuid');
  await c.ctl('rewind_conversation', { target_message_uuid: asst.uuid });
  c.mark('rewind_files non-dry');
  await c.ctl('rewind_files', { user_message_id: u1 });
  c.mark('rewind u1 (first message)');
  await c.ctl('rewind_conversation', { target_message_uuid: u1 });
  await c.settle(1500);
  c.mark('idle send priority next');
  c.user('只回复 IDLE-NEXT-OK，不要用工具。', { priority: 'next' });
  await c.until(() => c.results >= 2, 60000); await c.settle(2000);
});

const which = process.argv[2];
if (!S[which]) { console.log('scenarios:', Object.keys(S).join(' ')); process.exit(1); }
await S[which]();
