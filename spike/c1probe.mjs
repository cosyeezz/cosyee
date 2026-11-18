import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs';
const cwd = path.join(os.tmpdir(), 'cosyee-c1'); fs.mkdirSync(cwd, { recursive: true });
function env() { const e = { ...process.env }; for (const k of Object.keys(e)) if (k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE') delete e[k]; return e; }
const base = ['-p','--input-format','stream-json','--output-format','stream-json','--verbose','--include-partial-messages','--forward-subagent-text','--dangerously-skip-permissions','--model','haiku'];
function run(extra, script, ms = 30000) {
  return new Promise((res) => {
    const c = spawn('claude', [...base, ...extra], { cwd, env: env(), windowsHide: true });
    const t0 = Date.now(); const out = [];
    let buf = '';
    c.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); out.push(m); console.log(((Date.now()-t0)/1000).toFixed(1), m.type, m.subtype ?? '', m.type==='control_response' ? JSON.stringify(m.response).slice(0,200):''); } catch {} } });
    c.stderr.on('data', (d) => console.log('ERR', String(d).slice(0, 300)));
    c.on('exit', (code) => { console.log('exit', code, ((Date.now()-t0)/1000).toFixed(1)); res(out); });
    script(c);
    setTimeout(() => { try { c.stdin.end(); } catch {} }, ms - 5000);
    setTimeout(() => c.kill(), ms);
  });
}
const sid = randomUUID(); console.log('sid', sid);
const send = (c, o) => c.stdin.write(JSON.stringify(o) + '\n');
await run(['--session-id', sid], (c) => { send(c, { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '只回复 ok，不要用工具' }] } }); }, 40000).then(() => {});
console.log('---- resume w/o message');
await run(['--resume', sid], (c) => {
  send(c, { type: 'control_request', request_id: 'a1', request: { subtype: 'get_context_usage' } });
  send(c, { type: 'control_request', request_id: 'a2', request: { subtype: 'get_settings' } });
  setTimeout(() => c.stdin.end(), 6000);
}, 25000);
