// 探针 v4：定位 stale_target 的真正原因，并确定可行的 fork 路径
//  1) 在「原会话」上对 3 条用户消息分别 rewind（每次新进程）——rewind 本身在这个会话上work 吗？
//  2) `--resume SRC --fork-session --session-id NEW`：新文件是否在 resume 时就写入完整历史？uuid 是否被重写？
// 全程不发用户消息 => 不调用模型。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

const PROJ = path.join(os.homedir(), '.claude', 'projects', 'F--Cosyee');
const SRC = process.argv[2];
const TARGETS = process.argv.slice(3);
const srcFile = path.join(PROJ, `${SRC}.jsonl`);

/** 启动 claude（可带额外参数），按顺序发 control_request，收齐后关 stdin */
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
      out[requests[i][0]] = m.response;
      i++;
      sendNext();
    });
    let err = '';
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('close', () => resolve({ out, err: err.trim().slice(0, 200) }));
    setTimeout(() => proc.kill(), 40000);
  });
}

/** 从 jsonl 取主线真实用户消息的 uuid + 文本片段 */
function userMsgs(file) {
  const out = [];
  for (const l of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    if (e.type !== 'user' || e.isMeta || e.isSidechain) continue;
    const c = e.message?.content;
    if (Array.isArray(c) && c.some((b) => b?.type === 'tool_result')) continue;
    let t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join(' ') : '';
    t = t.trim();
    if (!t || t.startsWith('<') || t.startsWith('[Request')) continue;
    out.push({ uuid: e.uuid, text: t.slice(0, 40) });
  }
  return out;
}

// ───── 1) 原会话上逐个 rewind ─────
console.log('=== 1) 原会话 rewind ===');
for (const t of TARGETS) {
  const r = await run(['--resume', SRC], [['rewind_conversation', { target_message_uuid: t }]]);
  const res = r.out.rewind_conversation ?? {};
  console.log(`  ${t.slice(0, 8)} -> rewound=${res.rewound} reason=${res.reason ?? '-'} prefill=${JSON.stringify(String(res.prefillText ?? '').slice(0, 40))}`);
}

// ───── 2) --fork-session 新文件内容 ─────
console.log('\n=== 2) --fork-session ===');
const NEW = '66666666-7777-4888-8999-000011112222';
fs.rmSync(path.join(PROJ, `${NEW}.jsonl`), { force: true });
fs.rmSync(path.join(PROJ, NEW), { recursive: true, force: true });
const rf = await run(['--resume', SRC, '--fork-session', '--session-id', NEW], [['get_context_usage', {}]], 2500);
if (rf.err) console.log(`  [stderr] ${rf.err}`);
const nf = path.join(PROJ, `${NEW}.jsonl`);
if (!fs.existsSync(nf)) {
  console.log('  新文件不存在：fork 的历史只在内存里，resume 时不落盘');
} else {
  const lines = fs.readFileSync(nf, 'utf8').split('\n').filter(Boolean);
  console.log(`  新文件 ${lines.length} 行, ${fs.statSync(nf).size} 字节`);
  const src = userMsgs(srcFile);
  const got = userMsgs(nf);
  console.log(`  原会话用户消息 ${src.length} 条，新会话 ${got.length} 条`);
  got.forEach((m, i) => {
    const same = src[i] && src[i].uuid === m.uuid;
    console.log(`    [${i}] uuid=${m.uuid.slice(0, 8)} ${same ? '(与原相同)' : `(原 ${src[i]?.uuid.slice(0, 8) ?? '-'}, 已重写)`} ${JSON.stringify(m.text)}`);
  });
  // 用新 uuid 再试 rewind
  if (got[1]) {
    const r2 = await run(['--resume', NEW], [['rewind_conversation', { target_message_uuid: got[1].uuid }]]);
    const res2 = r2.out.rewind_conversation ?? {};
    console.log(`  用新 uuid rewind: rewound=${res2.rewound} reason=${res2.reason ?? '-'} prefill=${JSON.stringify(String(res2.prefillText ?? '').slice(0, 40))}`);
  }
}
console.log('\n清理 fork 文件');
fs.rmSync(nf, { force: true });
fs.rmSync(path.join(PROJ, NEW), { recursive: true, force: true });
