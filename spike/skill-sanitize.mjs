// 精简 + 脱敏 skill-probe 录下的 fixture：去掉 hook / 环境附件 / 系统提示词等与技能无关、含隐私的条目，临时目录换成固定路径。
import fs from 'node:fs';

const dir = new URL('../shared/fixtures/', import.meta.url);
const read = (f) => fs.readFileSync(new URL(f, dir), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const write = (f, rows) => {
  let s = rows.map((m) => JSON.stringify(m)).join('\n') + '\n';
  // JSON 里的反斜杠是转义后的 \\
  s = s
    .replace(/C:(\\\\|\\|\/)Users\1[^\\/"]+\1AppData\1Local\1Temp\1cz-skill-\w+/g, (_m, sep) => `C:${sep}work${sep}skill-demo`)
    .replace(/C--Users-[^-"]+-AppData-Local-Temp-cz-skill-\w+/g, 'C--work-skill-demo')
    .replace(/\/tmp\/cz-skill-\w+/g, '/work/skill-demo');
  fs.writeFileSync(new URL(f, dir), s);
};

const live = read('skill.jsonl')
  .filter((m) => !(m.type === 'system' && /^hook_|^notification$/.test(m.subtype ?? '')) && m.type !== 'rate_limit_event')
  .map((m) => {
    if (m.type === 'system' && m.subtype === 'init') {
      return {
        type: 'system', subtype: 'init', session_id: m.session_id, cwd: m.cwd, model: m.model, tools: m.tools,
        skills: ['probe-skill', 'code-review', 'anthropic-skills:pdf'],
        slash_commands: ['probe-skill', 'code-review', 'context', 'compact'],
        mcp_servers: [],
      };
    }
    if (m.type === 'result') {
      const { type, subtype, is_error, duration_ms, num_turns, result, session_id, terminal_reason } = m;
      return { type, subtype, is_error, duration_ms, num_turns, result, session_id, terminal_reason };
    }
    return m;
  });
write('skill.jsonl', live);

const KEEP = ['parentUuid', 'isSidechain', 'type', 'subtype', 'message', 'uuid', 'timestamp', 'isMeta', 'sourceToolUseID', 'toolUseResult', 'sourceToolAssistantUUID', 'sessionId', 'cwd', 'durationMs'];
let prev = null;
const tr = read('skill.transcript.jsonl')
  .filter((m) => m.type === 'user' || m.type === 'assistant' || (m.type === 'system' && m.subtype === 'turn_duration'))
  .map((m) => {
    const o = {};
    for (const k of KEEP) if (m[k] !== undefined) o[k] = m[k];
    // 去掉的附件条目会让 parentUuid 链断开：按保留下来的顺序重新串
    if ('parentUuid' in o) o.parentUuid = prev;
    if (o.uuid) prev = o.uuid;
    return o;
  });
write('skill.transcript.jsonl', tr);
console.log('live', live.length, 'transcript', tr.length);
