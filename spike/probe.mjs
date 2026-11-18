// 阶段 0 验证：以 stream-json 双向模式驱动本机 claude，跑两轮对话，打印 init 信息和结果。
// 用法: node spike/probe.mjs [toolsearch值]   例: node spike/probe.mjs true
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const toolSearch = process.argv[2]; // true | false | auto | auto:N | undefined
const env = { ...process.env };
if (toolSearch) env.ENABLE_TOOL_SEARCH = toolSearch;

const args = [
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--dangerously-skip-permissions',
  '--model', 'haiku',
  '--no-session-persistence',
];

const child = spawn('claude', args, { cwd: process.cwd(), env, shell: false });
const rl = readline.createInterface({ input: child.stdout });

const prompts = [
  '只回复数字 1，不要用任何工具。',
  '用 Bash 工具运行 `echo hello-from-webui`，然后只回复命令输出。',
];
let turn = 0;
const send = (text) =>
  child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');

rl.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { console.log('[raw]', line.slice(0, 200)); return; }
  if (m.type === 'system' && m.subtype === 'init') {
    const { tools = [], mcp_servers = [], slash_commands = [], skills = [], ...rest } = m;
    console.log('== init ==');
    console.log('keys:', Object.keys(m).join(', '));
    console.log('model:', rest.model, '| permissionMode:', rest.permissionMode, '| apiKeySource:', rest.apiKeySource);
    console.log('tools:', tools.length, tools.filter(t => !t.startsWith('mcp__')).join(' '));
    console.log('mcp tools:', tools.filter(t => t.startsWith('mcp__')).length);
    console.log('mcp_servers:', JSON.stringify(mcp_servers));
    console.log('slash_commands:', slash_commands.length, '| skills:', Array.isArray(skills) ? skills.length : skills);
    return;
  }
  if (m.type === 'assistant') {
    for (const b of m.message?.content ?? []) {
      if (b.type === 'text') console.log('[assistant]', b.text);
      if (b.type === 'tool_use') console.log('[tool_use]', b.name, JSON.stringify(b.input));
    }
    return;
  }
  if (m.type === 'user') {
    for (const b of m.message?.content ?? []) if (b.type === 'tool_result') console.log('[tool_result]', JSON.stringify(b.content).slice(0, 200));
    return;
  }
  if (m.type === 'result') {
    console.log(`== result turn ${turn + 1} ==`, m.subtype, '| cost:', m.total_cost_usd, '| usage:', JSON.stringify(m.usage));
    turn++;
    if (turn < prompts.length) send(prompts[turn]);
    else child.stdin.end();
    return;
  }
  console.log('[event]', m.type, m.subtype ?? '');
});

child.stderr.on('data', (d) => process.stderr.write('[stderr] ' + d));
child.on('exit', (code) => console.log('exit', code));
send(prompts[0]);
