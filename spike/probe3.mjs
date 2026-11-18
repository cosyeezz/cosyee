// B1 协议探测：用法 node probe3.mjs <scenario>
// 所有场景 --model haiku；原始 stdout 逐行存到 ../shared/fixtures/<name>.jsonl
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FIX = 'F:\\Cosyee\\shared\\fixtures';
const STATE = 'F:\\Cosyee\\spike\\probe3-state.json';
fs.mkdirSync(FIX, { recursive: true });
const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };
const saveState = (o) => fs.writeFileSync(STATE, JSON.stringify({ ...loadState(), ...o }, null, 2));

export function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE') delete env[k];
  return env;
}

// opts: name, cwd, args(额外参数), model, onStart(ctx), onMessage(m, ctx), timeoutMs
export function run(opts) {
  return new Promise((resolve) => {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--forward-subagent-text', '--dangerously-skip-permissions',
      '--model', opts.model ?? 'haiku', ...(opts.args ?? [])];
    const child = spawn('claude', args, { cwd: opts.cwd ?? process.cwd(), env: cleanEnv() });
    const out = fs.createWriteStream(path.join(FIX, opts.name + '.jsonl'));
    const errLog = [];
    const msgs = [];
    const ctx = {
      child, msgs, t0: Date.now(),
      send: (o) => { const s = JSON.stringify(o); out.write(''); child.stdin.write(s + '\n'); ctx.sent.push({ t: Date.now() - ctx.t0, o }); },
      user: (t) => ctx.send({ type: 'user', message: { role: 'user', content: t } }),
      end: () => child.stdin.end(),
      sent: [], results: 0, state: {},
    };
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      out.write(line + '\n');
      let m; try { m = JSON.parse(line); } catch { console.log('[raw]', line.slice(0, 200)); return; }
      msgs.push(m);
      if (m.type === 'result') ctx.results++;
      if (m.type !== 'stream_event') console.log(`[${((Date.now() - ctx.t0) / 1000).toFixed(1)}s]`, brief(m));
      try { opts.onMessage?.(m, ctx); } catch (e) { console.log('onMessage err', e); }
    });
    child.stderr.on('data', (d) => { errLog.push(String(d)); process.stderr.write('[stderr] ' + d); });
    const timer = setTimeout(() => { console.log('TIMEOUT -> kill'); kill(); }, opts.timeoutMs ?? 120000);
    const kill = () => { try { child.kill('SIGKILL'); } catch {} if (process.platform === 'win32') { try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F']); } catch {} } };
    child.on('exit', (code) => {
      clearTimeout(timer);
      out.end();
      fs.writeFileSync(path.join(FIX, '..', '..', 'spike', opts.name + '.stderr.txt'), errLog.join(''));
      fs.writeFileSync(path.join('F:\\Cosyee\\spike', opts.name + '.sent.json'), JSON.stringify(ctx.sent, null, 1));
      console.log('exit', code, 'after', ((Date.now() - ctx.t0) / 1000).toFixed(1) + 's');
      resolve({ code, msgs, ctx });
    });
    ctx.kill = kill;
    opts.onStart?.(ctx);
  });
}

function brief(m) {
  const b = { type: m.type, subtype: m.subtype, ptu: m.parent_tool_use_id, sid: m.session_id?.slice(0, 8) };
  if (m.type === 'assistant' || m.type === 'user') {
    const c = m.message?.content;
    b.blocks = (Array.isArray(c) ? c : [{ type: 'str', text: c }]).map((x) =>
      x.type + ':' + (x.name ?? '') + ':' + JSON.stringify(x.text ?? x.thinking ?? x.input ?? x.content ?? '').slice(0, 140));
  } else if (m.type === 'system' && m.subtype === 'init') b.model = m.model;
  else b.raw = JSON.stringify(m).slice(0, 300);
  return JSON.stringify(b);
}

const scenario = process.argv[2];
const S = {};

// 1a 会话 + 基础工具
S.basic = async () => {
  const sid = randomUUID();
  saveState({ sid, cwd: process.cwd() });
  console.log('sid', sid);
  await run({
    name: 'basic-tool', args: ['--session-id', sid, '--effort', 'low'],
    onStart: (c) => c.user('请记住暗号 banana-42。然后用 Bash 工具运行 `echo hello-from-webui`，最后回复命令输出和暗号。'),
    onMessage: (m, c) => { if (m.type === 'result') c.end(); },
  });
};
// 1b resume
S.resume = async () => {
  const { sid } = loadState();
  console.log('resume sid', sid);
  await run({
    name: 'resume', args: ['--resume', sid, '--effort', 'low'],
    onStart: (c) => c.user('我第一轮让你记住的暗号是什么？第一轮你运行了什么命令？简短回答。'),
    onMessage: (m, c) => { if (m.type === 'result') c.end(); },
  });
};
// 1c cwd 编码规则
S.cwdenc = async () => {
  const d = path.join(os.tmpdir(), 'cwd.enc_test dir 中文-x');
  fs.mkdirSync(d, { recursive: true });
  const sid = randomUUID();
  console.log('cwd', d, 'sid', sid);
  await run({
    name: 'cwdenc', cwd: d, args: ['--session-id', sid, '--effort', 'low'],
    onStart: (c) => c.user('只回复 1，不要用工具。'),
    onMessage: (m, c) => { if (m.type === 'result') c.end(); },
  });
  const proj = path.join(os.homedir(), '.claude', 'projects');
  const hit = fs.readdirSync(proj).filter((n) => fs.existsSync(path.join(proj, n, sid + '.jsonl')));
  console.log('cwd =', d, '\ndir found =', hit);
};
// 2 子代理
S.subagents = async () => {
  const sid = randomUUID();
  saveState({ subSid: sid });
  console.log('sid', sid);
  await run({
    name: 'subagents', args: ['--session-id', sid, '--effort', 'low'], timeoutMs: 240000,
    onStart: (c) => c.user('请在同一条消息里并行调用两次 Agent 工具（subagent_type 用 general-purpose），子代理一让它用 Bash 运行 `echo AAA`，子代理二让它用 Bash 运行 `echo BBB`。子代理完成后，你用一句话汇总两个输出。'),
    onMessage: (m, c) => { if (m.type === 'result') c.end(); },
  });
};

// 2b 子代理前台（显式 run_in_background:false）
S.subfg = async () => {
  const sid = randomUUID();
  await run({
    name: 'subagents-fg', args: ['--session-id', sid, '--effort', 'low'], timeoutMs: 240000,
    onStart: (c) => c.user('请调用一次 Agent 工具（subagent_type=general-purpose，必须设置 run_in_background=false 让它在前台同步运行），让子代理用 Bash 运行 `echo CCC`，把输出告诉我。'),
    onMessage: (m, c) => { if (m.type === 'result') setTimeout(() => c.end(), 3000); },
  });
};
// 4 /context /compact
S.context = async () => {
  const sid = randomUUID();
  saveState({ ctxSid: sid });
  await run({
    name: 'context', args: ['--session-id', sid], timeoutMs: 150000,
    onStart: (c) => { c.user('只回复 ok，不用工具。'); },
    onMessage: (m, c) => {
      if (m.type !== 'result') return;
      if (c.results === 1) c.user('/context');
      else if (c.results === 2) c.user('/compact');
      else if (c.results === 3) c.user('刚才压缩之后，请回复 done。');
      else c.end();
    },
  });
};
// 4b control_request 探测（用 --no-session-persistence 避免污染）
S.control = async () => {
  const subtypes = ['get_context_usage', 'get_settings', 'mcp_status', 'set_max_thinking_tokens', 'set_effort', 'set_permission_mode', 'initialize', 'get_session_info', 'apply_flag_settings', 'rewind_files', 'bogus_subtype'];
  const reqs = {
    get_context_usage: {}, get_settings: {}, mcp_status: {}, set_max_thinking_tokens: { max_thinking_tokens: 4000 },
    set_effort: { effort: 'low' }, set_permission_mode: { mode: 'bypassPermissions' }, initialize: {}, get_session_info: {}, apply_flag_settings: { settings: {} }, rewind_files: { user_message_id: "x", dry_run: true }, bogus_subtype: {},
  };
  await run({
    name: 'control-probe', args: ['--no-session-persistence'], timeoutMs: 90000,
    onStart: (c) => {
      c.user('只回复 ok，不用工具。');
      subtypes.forEach((s, i) => setTimeout(() => c.send({ type: 'control_request', request_id: 'c' + i, request: { subtype: s, ...reqs[s] } }), 1500 + i * 400));
    },
    onMessage: (m, c) => { if (m.type === 'result') setTimeout(() => c.end(), 6000); },
  });
};
// 5 中断
S.interrupt = async () => {
  const sid = randomUUID();
  await run({
    name: 'interrupt', args: ['--session-id', sid, '--effort', 'low'], timeoutMs: 150000,
    onStart: (c) => c.user('用 Bash 运行命令 `ping -n 31 127.0.0.1`（约30秒，不要改写命令，不要后台运行），然后说完成。'),
    onMessage: (m, c) => {
      if (m.type === 'assistant' && m.message?.content?.some((b) => b.type === 'tool_use') && !c.state.int) {
        c.state.int = 1;
        setTimeout(() => { console.log('>> interrupt'); c.send({ type: 'control_request', request_id: 'r1', request: { subtype: 'interrupt' } }); }, 4000);
      }
      if (m.type === 'result') {
        if (c.results === 1) setTimeout(() => c.user('只回复 alive，不用工具。'), 1000);
        else c.end();
      }
    },
  });
};
// 6 set_model / effort
S.setmodel = async () => {
  await run({
    name: 'setmodel', args: ['--no-session-persistence', '--effort', 'low'], timeoutMs: 150000,
    onStart: (c) => c.user('只回复 1，不用工具。'),
    onMessage: (m, c) => {
      if (m.type !== 'result') return;
      if (c.results === 1) {
        c.send({ type: 'control_request', request_id: 'r2', request: { subtype: 'set_model', model: 'sonnet' } });
        setTimeout(() => c.user('只回复 2，不用工具。'), 1500);
      } else if (c.results === 2) {
        c.send({ type: 'control_request', request_id: 'r3', request: { subtype: 'set_model', model: 'haiku' } });
        c.send({ type: 'control_request', request_id: 'r4', request: { subtype: 'set_max_thinking_tokens', max_thinking_tokens: 8000 } });
        c.send({ type: 'control_request', request_id: 'r5', request: { subtype: 'set_effort', effort: 'high' } });
        c.send({ type: 'control_request', request_id: 'r6', request: { subtype: 'set_effort_level', level: 'high' } });
        setTimeout(() => c.user('只回复 3，不用工具。'), 1500);
      } else c.end();
    },
  });
};
// 6b effort / ultracode via apply_flag_settings
S.effort = async () => {
  const cr = (c, id, subtype, extra = {}) => c.send({ type: 'control_request', request_id: id, request: { subtype, ...extra } });
  await run({
    name: 'effort', args: ['--no-session-persistence', '--effort', 'low'], timeoutMs: 120000,
    onStart: (c) => { c.user('只回复 1，不用工具。'); setTimeout(() => cr(c, 'e0', 'get_settings'), 1200); },
    onMessage: (m, c) => {
      if (m.type !== 'result') return;
      if (c.results === 1) {
        cr(c, 'e1', 'apply_flag_settings', { settings: { effortLevel: 'high' } });
        setTimeout(() => cr(c, 'e2', 'get_settings'), 500);
        setTimeout(() => cr(c, 'e3', 'apply_flag_settings', { settings: { ultracode: true } }), 1000);
        setTimeout(() => cr(c, 'e4', 'get_settings'), 1500);
        setTimeout(() => cr(c, 'e5', 'initialize'), 2000);
        setTimeout(() => c.user('只回复 2，不用工具。'), 2500);
      } else setTimeout(() => c.end(), 3000);
    },
  });
};
// 8 thinking
S.thinking = async () => {
  await run({
    name: 'thinking', args: ['--no-session-persistence', '--effort', 'high'], timeoutMs: 150000,
    onStart: (c) => c.user('一个房间里有 3 盏灯和 3 个开关在房间外，你只能进房间一次，如何确定哪个开关对应哪盏灯？请认真思考后简要回答。不要用工具。'),
    onMessage: (m, c) => { if (m.type === 'result') c.end(); },
  });
};

if (scenario && S[scenario]) await S[scenario]();
else if (scenario) console.log('unknown scenario');
