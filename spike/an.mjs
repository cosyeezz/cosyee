// 分析 fixtures：node an.mjs <name|path> [sum|show] [regex] [maxlen]
import fs from 'node:fs';
import path from 'node:path';
const f = process.argv[2];
const mode = process.argv[3] ?? 'sum';
const p = fs.existsSync(f) ? f : path.join('F:\\Cosyee\\shared\\fixtures', f + '.jsonl');
const l = fs.readFileSync(p, 'utf8').trim().split('\n').map((x) => JSON.parse(x));
if (mode === 'sum') {
  const c = {};
  for (const m of l) {
    const k = m.type + '/' + (m.subtype || m.event?.type || '') + (m.parent_tool_use_id ? '  [ptu]' : '');
    c[k] = (c[k] || 0) + 1;
  }
  console.log(l.length, 'lines');
  console.log(c);
  for (const m of l.filter((m) => m.type === 'system' && m.subtype === 'init')) console.log('init', m.session_id, m.model, m.cwd);
  for (const m of l.filter((m) => m.type === 'result')) console.log('result', m.session_id, m.subtype, m.stop_reason, m.is_error);
}
if (mode === 'show') {
  const re = new RegExp(process.argv[4]);
  for (const m of l) {
    const s = JSON.stringify(m);
    if (re.test(s)) console.log(s.slice(0, +process.argv[5] || 1500));
  }
}
