// 技能加载的事件形态：模型调用 Skill 工具 / 用户输入 /技能名 / 调用不存在的技能。
// 在临时目录里放一个项目级 skill，参数与服务端 runner 一致（含 --replay-user-messages）。
// 输出：shared/fixtures/skill.jsonl（实时 stdout）与 skill.transcript.jsonl（会话 jsonl）
// 用法: node spike/skill-probe.mjs
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const out = path.resolve(here, '../shared/fixtures');
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cz-skill-'));
const skillDir = path.join(cwd, '.claude', 'skills', 'probe-skill');
fs.mkdirSync(skillDir, { recursive: true });
fs.writeFileSync(
  path.join(skillDir, 'SKILL.md'),
  ['---', 'name: probe-skill', 'description: 测试用技能，回复时以 PROBE-OK 开头', '---', '', '# Probe skill', '', '收到参数：$ARGUMENTS', '', '回复必须以 `PROBE-OK` 开头，然后复述参数。', ''].join('\n'),
);

const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE') delete env[k];
const sid = randomUUID();
const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--include-partial-messages', '--forward-subagent-text', '--replay-user-messages',
  '--dangerously-skip-permissions', '--model', 'haiku', '--session-id', sid,
  '--strict-mcp-config'];
const child = spawn('claude', args, { cwd, env, shell: process.platform === 'win32' });
const log = fs.createWriteStream(path.join(out, 'skill.jsonl'));
const rl = readline.createInterface({ input: child.stdout });
const send = (t) => child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: t } }) + '\n');

const prompts = [
  '请用 Skill 工具调用 probe-skill 技能，参数是 alpha，然后按技能要求回复。',
  '/probe-skill beta',
  '请用 Skill 工具调用一个叫 no-such-skill 的技能（它不存在也没关系，照调），然后一句话告诉我结果。',
];
let turn = 0;
rl.on('line', (line) => {
  log.write(line + '\n');
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.type === 'stream_event') return;
  const brief = { type: m.type, subtype: m.subtype, ptu: m.parent_tool_use_id ?? undefined, isMeta: m.isMeta, replay: m.isReplay };
  if (m.type === 'assistant' || m.type === 'user') {
    const c = m.message?.content;
    brief.blocks = (Array.isArray(c) ? c : [{ type: 'str', text: c }])
      .map((b) => b.type + ':' + (b.name ?? '') + ':' + JSON.stringify(b.text ?? b.input ?? b.content ?? '').slice(0, 200));
    if (m.tool_use_result) brief.tur = JSON.stringify(m.tool_use_result).slice(0, 200);
  } else if (m.type === 'system' && m.subtype === 'init') {
    brief.skills = m.skills; brief.cmds = (m.slash_commands ?? []).filter((c) => c.includes('probe'));
  }
  console.log(JSON.stringify(brief));
  if (m.type === 'result') {
    turn++;
    if (turn < prompts.length) send(prompts[turn]);
    else child.stdin.end();
  }
});
child.stderr.on('data', (d) => process.stderr.write('[stderr] ' + d));
child.on('exit', (code) => {
  log.end();
  const roots = [process.env.CLAUDE_CONFIG_DIR, path.join(os.homedir(), '.claude')].filter(Boolean);
  for (const r of roots) {
    const proj = path.join(r, 'projects');
    if (!fs.existsSync(proj)) continue;
    for (const d of fs.readdirSync(proj)) {
      const f = path.join(proj, d, `${sid}.jsonl`);
      if (fs.existsSync(f)) {
        fs.copyFileSync(f, path.join(out, 'skill.transcript.jsonl'));
        console.log('transcript:', f);
      }
    }
  }
  console.log('exit', code, 'cwd', cwd);
});
send(prompts[0]);
