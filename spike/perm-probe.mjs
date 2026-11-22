// 权限模式 / AskUserQuestion / ExitPlanMode 协议探测：node perm-probe.mjs <scenario>
// plan：--permission-mode plan，要求先问问题再出计划；bypass：bypassPermissions 下调 AskUserQuestion
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scenario = process.argv[2] ?? 'plan';
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'permprobe-'));
const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE') delete env[k];

const mode = scenario === 'plan' ? 'plan' : 'bypassPermissions';
const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--allow-dangerously-skip-permissions', '--permission-mode', mode,
  '--model', 'haiku', '--session-id', randomUUID()];
if (process.argv[3] === 'stdio') args.push('--permission-prompt-tool', 'stdio');
if (scenario === 'legacy') args.splice(args.indexOf('--allow-dangerously-skip-permissions'), 1, '--dangerously-skip-permissions');
const child = spawn('claude', args, { cwd, env, shell: true });
const t0 = Date.now();
const log = [];
const send = (o) => { log.push({ dir: '->', o }); child.stdin.write(JSON.stringify(o) + '\n'); };
const T = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';

const prompt = scenario === 'plan'
  ? 'First use the AskUserQuestion tool to ask me ONE question: which greeting to put in hello.txt (options "Hi" and "Hello"). Then write a plan to create hello.txt with that greeting and call ExitPlanMode. After approval, create the file.'
  : 'Use the AskUserQuestion tool to ask me ONE question: favorite color, options "Red" and "Blue". Then tell me what I chose.';

let results = 0;
const rl = readline.createInterface({ input: child.stdout });
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  log.push({ dir: '<-', t: T(), o: m });
  if (m.type === 'control_request') {
    console.log(T(), 'CONTROL_REQUEST', JSON.stringify(m).slice(0, 1500));
    const r = m.request;
    if (r.subtype === 'can_use_tool') {
      let response;
      if (r.tool_name === 'AskUserQuestion') {
        const q = r.input.questions[0];
        response = { behavior: 'allow', updatedInput: { ...r.input, answers: { [q.question]: q.options[1].label } } };
      } else if (r.tool_name === 'ExitPlanMode') {
        response = { behavior: 'allow', updatedInput: r.input };
        setTimeout(() => send({ type: 'control_request', request_id: 'm1', request: { subtype: 'set_permission_mode', mode: 'bypassPermissions' } }), 10);
      } else {
        response = { behavior: 'allow', updatedInput: r.input };
      }
      send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } });
    }
    return;
  }
  if (m.type === 'system') console.log(T(), 'system', m.subtype, m.permissionMode ?? '', m.subtype === 'status' ? JSON.stringify(m) : '');
  else if (m.type === 'assistant') for (const c of m.message.content) console.log(T(), 'assistant', c.type, c.type === 'text' ? c.text.slice(0, 200) : c.type === 'tool_use' ? c.name + ' ' + JSON.stringify(c.input).slice(0, 300) : '');
  else if (m.type === 'user') for (const c of (Array.isArray(m.message.content) ? m.message.content : [])) if (c.type === 'tool_result') console.log(T(), 'tool_result', JSON.stringify(c.content).slice(0, 400));
  else if (m.type === 'control_response') console.log(T(), 'control_response', JSON.stringify(m));
  else if (m.type === 'result') { console.log(T(), 'result', m.subtype, (m.result ?? '').slice(0, 200)); if (++results >= 1) child.stdin.end(); }
  else if (m.type !== 'stream_event') console.log(T(), m.type, JSON.stringify(m).slice(0, 200));
});
child.stderr.on('data', (d) => process.stderr.write('[stderr] ' + d));
setTimeout(() => { console.log('TIMEOUT'); child.kill(); }, 180000).unref();
child.on('exit', (c) => {
  fs.writeFileSync(path.join('F:\\Cosyee\\spike', `perm-${scenario}-${process.argv[3] ?? ""}.log.json`), JSON.stringify(log, null, 1));
  console.log('exit', c, 'files:', fs.readdirSync(cwd));
  process.exit(0);
});
send({ type: 'user', message: { role: 'user', content: prompt } });
