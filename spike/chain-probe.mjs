// 分析会话 jsonl 的消息链：attachment 是否在链上、有多少叶子（rewind 留下的废弃分支）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PROJ = path.join(os.homedir(), '.claude', 'projects', 'F--Cosyee');
const file = path.join(PROJ, `${process.argv[2]}.jsonl`);
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);

const byUuid = new Map();
const children = new Map();
const order = [];
for (const [i, l] of lines.entries()) {
  let e;
  try { e = JSON.parse(l); } catch { continue; }
  if (!e.uuid) continue;
  byUuid.set(e.uuid, { e, i });
  order.push(e);
  const p = e.parentUuid ?? null;
  if (!children.has(p)) children.set(p, []);
  children.get(p).push(e.uuid);
}

const leaves = order.filter((e) => !children.has(e.uuid));
console.log(`带 uuid 的行 ${order.length}；叶子 ${leaves.length}`);
for (const l of leaves.slice(0, 20)) console.log(`  叶子 ${l.type}/${l.subtype ?? ''} uuid=${l.uuid.slice(0, 8)} 行号=${byUuid.get(l.uuid).i}`);

// 分叉点（一个父有多个孩子）
const forks = [...children].filter(([, c]) => c.length > 1);
console.log(`\n分叉点 ${forks.length}`);
for (const [p, c] of forks.slice(0, 10)) {
  console.log(`  父 ${String(p).slice(0, 8)} -> ${c.length} 个孩子：${c.map((u) => `${u.slice(0, 8)}(${byUuid.get(u).e.type},行${byUuid.get(u).i})`).join(' ')}`);
}

// attachment 是否被引用为 parentUuid
const attUuids = order.filter((e) => e.type === 'attachment').map((e) => e.uuid);
const attRefed = attUuids.filter((u) => children.has(u));
console.log(`\nattachment ${attUuids.length} 条，被当作 parentUuid 引用的 ${attRefed.length} 条`);

// 从最后一条 user/assistant 回溯，链长 vs 文件里带 uuid 的总行数
const last = [...order].reverse().find((e) => e.type === 'user' || e.type === 'assistant');
console.log(`\n最后一条对话消息：${last.type} uuid=${last.uuid.slice(0, 8)} 行号=${byUuid.get(last.uuid).i}`);
let cur = last.uuid;
const chain = [];
while (cur && byUuid.has(cur)) {
  chain.push(cur);
  cur = byUuid.get(cur).e.parentUuid ?? null;
}
console.log(`\n从最后一行回溯链长 ${chain.length}（带 uuid 行 ${order.length}）`);
const chainSet = new Set(chain);
const offChain = order.filter((e) => !chainSet.has(e.uuid));
const offByType = {};
for (const e of offChain) offByType[e.type] = (offByType[e.type] || 0) + 1;
console.log(`不在链上的行按类型：`, offByType);
