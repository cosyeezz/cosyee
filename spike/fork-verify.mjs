// 用服务端的 Sessions.fork 在真实会话上分支一次，再用 get_context_usage 验证 CLI 认这个新会话。
// 不发用户消息 => 不调用模型。用完删掉新会话文件。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { Sessions } from '../server/src/sessions.ts';
import { DotState } from '../server/src/state.ts';
import { StateStore } from '../server/src/workspaces.ts';

const CWD = 'F:/Cosyee';
const PROJ = path.join(os.homedir(), '.claude', 'projects', 'F--Cosyee');
const SRC = process.argv[2];
const TARGET = process.argv[3];

function ctx(sessionId) {
  return new Promise((resolve) => {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--resume', sessionId];
    const proc = spawn('claude', args, { cwd: CWD, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    proc.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'r0', request: { subtype: 'get_context_usage' } }) + '\n');
    let out = null;
    let err = '';
    readline.createInterface({ input: proc.stdout, crlfDelay: Infinity }).on('line', (line) => {
      let m;
      try { m = JSON.parse(line); } catch { return; }
      if (m.type !== 'control_response') return;
      const w = m.response ?? {};
      out = w.subtype === 'error' ? { __error: w.error } : (w.response ?? {});
      setTimeout(() => proc.stdin.end(), 600);
    });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('close', () => resolve({ out, err: err.trim().slice(0, 300) }));
    setTimeout(() => proc.kill(), 40000);
  });
}

const show = (r) => {
  const cats = r?.categories;
  if (!Array.isArray(cats)) return JSON.stringify(r).slice(0, 200);
  return cats.filter((c) => !['system_prompt', 'system_tools', 'free_space', 'autocompact_buffer'].includes(c.id))
    .map((c) => `${c.id}=${c.tokens}`).join(' ');
};

const srcFile = path.join(PROJ, `${SRC}.jsonl`);
const before = fs.statSync(srcFile);
const sessions = new Sessions(new DotState(new StateStore(path.join(os.tmpdir(), 'cosyee-fork-verify.json'))));

const base = await ctx(SRC);
console.log(`源会话基线: ${show(base.out)}`);

const { sessionId } = await sessions.fork(SRC, CWD, TARGET);
const nf = path.join(PROJ, `${sessionId}.jsonl`);
console.log(`\n分支 -> ${sessionId}  ${fs.statSync(nf).size} 字节（源 ${before.size}）`);
const r = await ctx(sessionId);
console.log(`分支上下文: ${show(r.out)}`);
if (r.err) console.log(`[stderr] ${r.err}`);
const titles = fs.readFileSync(nf, 'utf8').trim().split('\n').slice(-2).map((l) => JSON.parse(l));
console.log(`末尾标题行: ${JSON.stringify(titles)}`);

const after = fs.statSync(srcFile);
console.log(`\n源会话: ${after.size === before.size ? '未被修改' : `*** 大小变了 ${before.size}->${after.size}（resume 追加的元数据行）***`}`);
console.log('清理分支文件');
fs.rmSync(nf, { force: true });
fs.rmSync(path.join(PROJ, sessionId), { recursive: true, force: true });
