// 探针 v5（修正 v3/v4 的解包 bug：载荷在 control_response.response.response）
//  1) 控制实验：原会话上 rewind 到各条用户消息，到底成不成
//  2) 方案 A：复制全文 + 改写 sessionId 后 rewind
//  3) 方案 B：自己截断到目标消息之前，用 get_context_usage 的消息类 token 与基线比较
// 不发用户消息 => 不调用模型。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

const PROJ = path.join(os.homedir(), '.claude', 'projects', 'F--Cosyee');
const SRC = process.argv[2];
const TARGETS = process.argv.slice(3);
const srcFile = path.join(PROJ, `${SRC}.jsonl`);
const srcLines = fs.readFileSync(srcFile, 'utf8').split('\n').filter(Boolean);

function run(extraArgs, requests, keepMs = 800) {
  return new Promise((resolve) => {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', ...extraArgs];
    const proc = spawn('claude', args, { cwd: 'F:/Cosyee', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const out = {};
    let i = 0;
    const sendNext = () => {
      if (i >= requests.length) { setTimeout(() => proc.stdin.end(), keepMs); return; }
      const [subtype, extra] = requests[i];
      proc.stdin.write(JSON.stringify({ type: 'control_request', request_id: `r${i}`, request: { subtype, ...extra } }) + '\n');
    };
    sendNext();
    readline.createInterface({ input: proc.stdout, crlfDelay: Infinity }).on('line', (line) => {
      let m;
      try { m = JSON.parse(line); } catch { return; }
      if (m.type !== 'control_response') return;
      const wrap = m.response ?? {};
      out[requests[i][0]] = wrap.subtype === 'error' ? { __error: wrap.error } : (wrap.response ?? {});
      i++;
      sendNext();
    });
    let err = '';
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('close', () => resolve({ out, err: err.trim().slice(0, 200) }));
    setTimeout(() => proc.kill(), 40000);
  });
}

/** 上下文里与对话内容相关的分类 token（排除系统提示 / 工具定义等固定开销） */
function convTokens(ctx) {
  const cats = ctx?.categories;
  if (!Array.isArray(cats)) return `?? ${JSON.stringify(ctx).slice(0, 150)}`;
  const pick = cats.filter((c) => !['system_prompt', 'system_tools', 'free_space', 'autocompact_buffer'].includes(c.id));
  return pick.map((c) => `${c.id}=${c.tokens}`).join(' ');
}

const rw = (r) => `rewound=${r.rewound} reason=${r.reason ?? r.error ?? r.__error ?? '-'} prefill=${JSON.stringify(String(r.prefillText ?? '').slice(0, 30))}`;
const cleanup = (id) => {
  fs.rmSync(path.join(PROJ, `${id}.jsonl`), { force: true });
  fs.rmSync(path.join(PROJ, id), { recursive: true, force: true });
};
const retag = (line, id) => {
  const e = JSON.parse(line);
  if (e.sessionId) e.sessionId = id;
  return JSON.stringify(e);
};

// ───── 基线 ─────
const base = await run(['--resume', SRC], [['get_context_usage', {}]]);
console.log(`基线（${srcLines.length} 行）: ${convTokens(base.out.get_context_usage)}`);

// ───── 1) 原会话 rewind ─────
console.log('\n=== 1) 原会话 rewind（控制实验）===');
for (const t of TARGETS) {
  const r = await run(['--resume', SRC], [['rewind_conversation', { target_message_uuid: t }]]);
  console.log(`  ${t.slice(0, 8)} -> ${rw(r.out.rewind_conversation ?? {})}`);
}

// ───── 2) 方案 A ─────
console.log('\n=== 2) 方案 A：复制 + 改写 sessionId + rewind ===');
const A = '44444444-5555-4666-8777-888899990000';
cleanup(A);
fs.writeFileSync(path.join(PROJ, `${A}.jsonl`), srcLines.map((l) => retag(l, A)).join('\n') + '\n', 'utf8');
const ra = await run(['--resume', A], [['rewind_conversation', { target_message_uuid: TARGETS[1] }], ['get_context_usage', {}]]);
console.log(`  rewind: ${rw(ra.out.rewind_conversation ?? {})}`);
console.log(`  上下文: ${convTokens(ra.out.get_context_usage)}`);

// ───── 3) 方案 B ─────
console.log('\n=== 3) 方案 B：自己截断 ===');
const B = '55555555-6666-4777-8888-999900001111';
cleanup(B);
const cut = srcLines.findIndex((l) => l.includes(`"uuid":"${TARGETS[1]}"`));
fs.writeFileSync(path.join(PROJ, `${B}.jsonl`), srcLines.slice(0, cut).map((l) => retag(l, B)).join('\n') + '\n', 'utf8');
const rb = await run(['--resume', B], [['get_context_usage', {}]]);
console.log(`  截断到第 ${cut}/${srcLines.length} 行（目标消息之前）`);
console.log(`  上下文: ${convTokens(rb.out.get_context_usage)}`);
if (rb.err) console.log(`  [stderr] ${rb.err}`);

cleanup(A);
cleanup(B);
console.log('\n已清理探针文件');
