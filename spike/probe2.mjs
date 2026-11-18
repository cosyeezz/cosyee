// 阶段 0 补充验证：--session-id、子代理事件、/context、control_request 中断
// 用法: node probe2.mjs <case>   case = subagent | context | interrupt
import { spawn, execSync } from 'node:child_process';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

const which = process.argv[2] ?? 'subagent';
const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE') delete env[k];
const sid = randomUUID();
const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--dangerously-skip-permissions', '--model', 'haiku', '--session-id', sid,
  '--include-partial-messages', '--forward-subagent-text', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
const child = spawn('claude', args, { cwd: process.cwd(), env });
const log = fs.createWriteStream(`probe2-${which}.jsonl`);
const rl = readline.createInterface({ input: child.stdout });
const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
const user = (t) => send({ type: 'user', message: { role: 'user', content: t } });

const prompts = {
  subagent: ['用 Agent 工具并行启动两个子代理（subagent_type 用 general-purpose），一个用 Bash 运行 `echo A`，另一个运行 `echo B`，最后汇总一句话。'],
  context: ['/context'],
  interrupt: ['用 Bash 运行 `sleep 30`，然后说完成。'],
};
let turns = 0;
rl.on('line', (line) => {
  log.write(line + '\n');
  let m; try { m = JSON.parse(line); } catch { console.log('[raw]', line.slice(0, 300)); return; }
  if (m.type === 'stream_event') return; // 只记录到文件
  const brief = { type: m.type, subtype: m.subtype, ptu: m.parent_tool_use_id, sid: m.session_id };
  if (m.type === 'assistant' || m.type === 'user') {
    brief.blocks = (Array.isArray(m.message?.content) ? m.message.content : [{ type: 'str', text: m.message?.content }])
      .map((b) => b.type + ':' + (b.name ?? '') + ':' + JSON.stringify(b.text ?? b.input ?? b.content ?? '').slice(0, 160));
  } else if (m.type === 'system' && m.subtype === 'init') {
    brief.extra = 'init';
  } else {
    brief.raw = JSON.stringify(m).slice(0, 400);
  }
  console.log(JSON.stringify(brief));
  if (m.type === 'result') { turns++; child.stdin.end(); }
  if (which === 'interrupt' && m.type === 'assistant' && m.message?.content?.some((b) => b.type === 'tool_use')) {
    setTimeout(() => { console.log('>> sending interrupt'); send({ type: 'control_request', request_id: 'r1', request: { subtype: 'interrupt' } }); }, 3000);
  }
});
child.stderr.on('data', (d) => process.stderr.write('[stderr] ' + d));
child.on('exit', (c) => {
  console.log('exit', c, 'sid', sid);
  const dir = process.env.USERPROFILE + '\\.claude\\projects\\F--Cosyee-spike';
  try { console.log('transcript exists:', fs.existsSync(`${dir}\\${sid}.jsonl`), fs.existsSync(`${dir}\\${sid}`) ? fs.readdirSync(`${dir}\\${sid}`, { recursive: true }) : ''); } catch (e) { console.log(e.message); }
});
for (const p of prompts[which]) user(p);
