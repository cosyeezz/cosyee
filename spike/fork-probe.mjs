// fork + rewind 探针：验证 `--resume SRC --fork-session --session-id NEW` 后，
// 能否用 rewind_conversation 把新会话裁到指定用户消息，且原会话文件不变。
// 不发任何用户消息 => 不调用模型，零花费。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

const PROJ = path.join(os.homedir(), '.claude', 'projects', 'F--Cosyee');
const SRC = process.argv[2];
const NEW = process.argv[3];
const TARGET = process.argv[4];

const file = path.join(PROJ, `${SRC}.jsonl`);
const before = fs.statSync(file);
console.log(`源会话 ${SRC}: ${before.size} 字节, mtime ${before.mtimeMs}`);

const args = [
  '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--resume', SRC, '--fork-session', '--session-id', NEW,
];
const proc = spawn('claude', args, { cwd: 'F:/Cosyee', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

let done = false;
// CLI 在收到第一条用户消息前就能响应 control_request（runner 的 get_settings 就是这样发的）
const req = { type: 'control_request', request_id: 'probe-1', request: { subtype: 'rewind_conversation', target_message_uuid: TARGET } };
proc.stdin.write(JSON.stringify(req) + '\n');
console.log(`已请求 rewind -> ${TARGET}`);

const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
rl.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.type === 'system' && m.subtype === 'init') {
    console.log(`init: session_id=${m.session_id}`);
  } else if (m.type === 'control_response') {
    console.log('rewind 响应: ' + JSON.stringify(m.response).slice(0, 600));
    done = true;
    setTimeout(() => proc.stdin.end(), 1500);
  }
});
proc.stderr.on('data', (d) => process.stderr.write('[stderr] ' + d));
proc.on('close', (code) => {
  console.log(`\n进程退出 code=${code}, 收到 rewind 响应=${done}`);
  const after = fs.statSync(file);
  console.log(`源会话事后: ${after.size} 字节, mtime ${after.mtimeMs} -> ${after.size === before.size && after.mtimeMs === before.mtimeMs ? '未被修改' : '*** 被改动 ***'}`);
  const nf = path.join(PROJ, `${NEW}.jsonl`);
  if (!fs.existsSync(nf)) { console.log(`新会话文件: 不存在（${NEW}.jsonl）`); return; }
  const lines = fs.readFileSync(nf, 'utf8').split('\n').filter(Boolean);
  console.log(`新会话文件: ${lines.length} 行`);
  for (const l of lines) {
    const e = JSON.parse(l);
    const c = e.message?.content;
    let t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join(' ') : '';
    console.log(`  ${e.type}/${e.subtype ?? ''} uuid=${String(e.uuid).slice(0, 8)} parent=${String(e.parentUuid).slice(0, 8)} ${JSON.stringify(t.slice(0, 60))}`);
  }
});
setTimeout(() => { console.log('超时，杀进程'); proc.kill(); }, 60000);
