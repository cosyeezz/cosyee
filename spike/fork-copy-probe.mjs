// 方案 B 探针：把源会话 jsonl 复制成新 id 的文件，再 `--resume 新id` + rewind 到指定消息。
// 验证：1) 复制出的会话能被 resume；2) 原 uuid 在其中仍有效（rewind 成功）；3) 原会话文件不受影响。
// 不发用户消息 => 零花费。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

const PROJ = path.join(os.homedir(), '.claude', 'projects', 'F--Cosyee');
const [SRC, NEW, TARGET] = process.argv.slice(2);
const srcFile = path.join(PROJ, `${SRC}.jsonl`);
const newFile = path.join(PROJ, `${NEW}.jsonl`);
const before = fs.statSync(srcFile);

// 原样复制（不改内部 sessionId 字段），看 CLI 认不认
fs.copyFileSync(srcFile, newFile);
console.log(`已复制 -> ${NEW}.jsonl (${before.size} 字节)`);

const args = [
  '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--resume', NEW,
];
const proc = spawn('claude', args, { cwd: 'F:/Cosyee', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const req = { type: 'control_request', request_id: 'probe-1', request: { subtype: 'rewind_conversation', target_message_uuid: TARGET } };
proc.stdin.write(JSON.stringify(req) + '\n');
console.log(`已请求 rewind -> ${TARGET}`);

const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
rl.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.type === 'control_response') {
    console.log('rewind 响应: ' + JSON.stringify(m.response).slice(0, 700));
    setTimeout(() => proc.stdin.end(), 1200);
  }
});
proc.stderr.on('data', (d) => process.stderr.write('[stderr] ' + d));
proc.on('close', (code) => {
  console.log(`\n进程退出 code=${code}`);
  const after = fs.statSync(srcFile);
  console.log(`源会话: ${after.size === before.size && after.mtimeMs === before.mtimeMs ? '未被修改' : '*** 被改动 ***'}`);
  const st2 = fs.statSync(newFile);
  console.log(`新会话文件: ${st2.size} 字节（原 ${before.size}）`);
  const lines = fs.readFileSync(newFile, 'utf8').split('\n').filter(Boolean);
  console.log(`新会话 ${lines.length} 行；尾部 4 行：`);
  for (const l of lines.slice(-4)) {
    const e = JSON.parse(l);
    console.log(`  ${e.type}/${e.subtype ?? ''} uuid=${String(e.uuid).slice(0, 8)} parent=${String(e.parentUuid).slice(0, 8)} sessionId=${String(e.sessionId).slice(0, 8)}`);
  }
  console.log('\n清理：删除探针产生的新会话文件');
  fs.rmSync(newFile, { force: true });
  fs.rmSync(path.join(PROJ, NEW), { recursive: true, force: true });
});
setTimeout(() => { console.log('超时，杀进程'); proc.kill(); }, 45000);
