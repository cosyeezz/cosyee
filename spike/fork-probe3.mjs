// 探针 v3：比较两种 fork 实现
//   A 复制全文 + 改写每行 sessionId -> 新 id，再 resume + rewind 到目标消息（让 CLI 自己裁，能拿到 prefillText）
//   B 自己截断：只写目标用户消息之前的行（同样改写 sessionId），resume 后看 get_context_usage
// 都用 get_context_usage 验证历史确实被加载（零花费，不调用模型）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

const PROJ = path.join(os.homedir(), '.claude', 'projects', 'F--Cosyee');
const [SRC, TARGET] = process.argv.slice(2);
const srcFile = path.join(PROJ, `${SRC}.jsonl`);
const srcLines = fs.readFileSync(srcFile, 'utf8').split('\n').filter(Boolean);
const srcStat = fs.statSync(srcFile);

/** 改写一行的 sessionId 字段 */
function retag(line, newId) {
  const e = JSON.parse(line);
  if (e.sessionId) e.sessionId = newId;
  return JSON.stringify(e);
}

/** 启动 claude 并按顺序发若干 control_request，收齐响应后退出 */
function run(sessionId, requests) {
  return new Promise((resolve) => {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--resume', sessionId];
    const proc = spawn('claude', args, { cwd: 'F:/Cosyee', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const out = {};
    let i = 0;
    const sendNext = () => {
      if (i >= requests.length) { setTimeout(() => proc.stdin.end(), 800); return; }
      const [subtype, extra] = requests[i];
      proc.stdin.write(JSON.stringify({ type: 'control_request', request_id: `r${i}`, request: { subtype, ...extra } }) + '\n');
    };
    sendNext();
    const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      let m;
      try { m = JSON.parse(line); } catch { return; }
      if (m.type !== 'control_response') return;
      out[requests[i][0]] = m.response;
      i++;
      sendNext();
    });
    let err = '';
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('close', () => resolve({ out, err: err.trim().slice(0, 300) }));
    setTimeout(() => proc.kill(), 40000);
  });
}

const ctxOf = (r) => {
  const u = r?.usage ?? r;
  if (!u || typeof u !== 'object') return JSON.stringify(r).slice(0, 200);
  const keys = ['total_tokens', 'totalTokens', 'used', 'input_tokens', 'context_tokens'];
  const hit = keys.find((k) => typeof u[k] === 'number');
  return hit ? `${hit}=${u[hit]}` : JSON.stringify(u).slice(0, 240);
};

const cleanup = (id) => {
  fs.rmSync(path.join(PROJ, `${id}.jsonl`), { force: true });
  fs.rmSync(path.join(PROJ, id), { recursive: true, force: true });
};

// ───── 基线：原会话（只读上下文，不 rewind） ─────
console.log(`源会话 ${SRC}：${srcLines.length} 行, ${srcStat.size} 字节`);
const base = await run(SRC, [['get_context_usage', {}]]);
console.log(`基线 上下文: ${ctxOf(base.out.get_context_usage)}`);
if (base.err) console.log(`  [stderr] ${base.err}`);

// ───── 方案 A：全文复制 + 改 sessionId + rewind ─────
const A = '44444444-5555-4666-8777-888899990000';
cleanup(A);
fs.writeFileSync(path.join(PROJ, `${A}.jsonl`), srcLines.map((l) => retag(l, A)).join('\n') + '\n', 'utf8');
const ra = await run(A, [['rewind_conversation', { target_message_uuid: TARGET }], ['get_context_usage', {}]]);
console.log(`\n方案 A rewind: ${JSON.stringify(ra.out.rewind_conversation).slice(0, 400)}`);
console.log(`方案 A 上下文: ${ctxOf(ra.out.get_context_usage)}`);
if (ra.err) console.log(`  [stderr] ${ra.err}`);

// ───── 方案 B：自己截断到目标消息之前 ─────
const B = '55555555-6666-4777-8888-999900001111';
cleanup(B);
const cut = srcLines.findIndex((l) => l.includes(`"uuid":"${TARGET}"`));
console.log(`\n目标消息在第 ${cut} 行（共 ${srcLines.length}）`);
fs.writeFileSync(path.join(PROJ, `${B}.jsonl`), srcLines.slice(0, cut).map((l) => retag(l, B)).join('\n') + '\n', 'utf8');
const rb = await run(B, [['get_context_usage', {}]]);
console.log(`方案 B 上下文: ${ctxOf(rb.out.get_context_usage)}`);
if (rb.err) console.log(`  [stderr] ${rb.err}`);

const after = fs.statSync(srcFile);
console.log(`\n源会话: ${after.size === srcStat.size ? '未被修改' : `*** 大小变了 ${srcStat.size}->${after.size} ***`}`);
console.log('清理探针文件');
cleanup(A);
cleanup(B);
