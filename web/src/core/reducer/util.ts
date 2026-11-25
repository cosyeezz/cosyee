// reducer 的小工具：类型守卫、文本截取、工具摘要。无副作用。

export type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string => (typeof v === 'string' ? v : '');
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * CLI 自己处理完就结束、不会发给模型的内置命令（输入 `/名字` 后 transcript 里只跟着
 * local-command-stdout 或 system 条目，没有 assistant 回复）。这类输入在会话流里不成为一轮。
 * 只收录确认如此的内置命令：会产生模型回复的（/init、/review、/pr-comments、/security-review）
 * 和自定义命令 / 技能都不在内——误收会让整轮消失，宁可漏收。
 */
const LOCAL_COMMANDS = new Set([
  'add-dir', 'agents', 'bashes', 'clear', 'compact', 'config', 'context', 'cost', 'doctor',
  'exit', 'export', 'fast', 'feedback', 'help', 'hooks', 'ide', 'install-github-app', 'login',
  'logout', 'mcp', 'memory', 'migrate-installer', 'model', 'output-style', 'permissions', 'plan',
  'plugin', 'plugins', 'privacy-settings', 'quit', 'release-notes', 'reload-plugins', 'resume',
  'rewind', 'sandbox', 'status', 'statusline', 'terminal-setup', 'todos', 'upgrade', 'usage', 'vim',
]);

/**
 * 用户输入是不是上面那类本地命令（`/名字` 可带参数）。
 * 技能名与命令同名时由调用方先判技能（技能会留下加载记录，整轮不会被隐藏）。
 */
export function isLocalCommand(text: string): boolean {
  const m = /^\/(\S+)/.exec(text.trim());
  return m !== null && LOCAL_COMMANDS.has(m[1]!.toLowerCase());
}

/** 状态行文字的最大长度（UI 还会再按一行截断） */
const STATUS_MAX = 80;
const SUMMARY_MAX = 100;

/** 取文字里第一个非空行并截断，作为状态行文字；没有则返回空串 */
export function statusLine(text: string): string {
  // 逐行找，不 split 整段（流式时每个片段都会调用，整段切分是 O(n²)）
  let start = 0;
  while (start <= text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end).trim();
    if (line) return line.length > STATUS_MAX ? line.slice(0, STATUS_MAX) + '…' : line;
    start = end + 1;
  }
  return '';
}

/** 单行化并截断：多行取首个非空行并加「…」 */
function oneLine(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return '';
  let s = lines[0]!;
  if (lines.length > 1) s += ' …';
  return s.length > SUMMARY_MAX ? s.slice(0, SUMMARY_MAX) + '…' : s;
}

/** 常见工具名 → 摘要里用的参数字段（按顺序取第一个非空字符串） */
const KEYS_BY_TOOL: Record<string, string[]> = {
  Bash: ['command'],
  PowerShell: ['command'],
  Read: ['file_path', 'path'],
  Write: ['file_path', 'path'],
  Edit: ['file_path', 'path'],
  MultiEdit: ['file_path', 'path'],
  NotebookEdit: ['notebook_path', 'file_path'],
  Glob: ['pattern', 'path'],
  Grep: ['pattern', 'path'],
  Agent: ['description', 'prompt'],
  Task: ['description', 'prompt'],
  WebFetch: ['url'],
  WebSearch: ['query'],
  Skill: ['skill'],
  ToolSearch: ['query'],
  TaskStop: ['task_id', 'shell_id'],
  TaskOutput: ['task_id'],
  SendToProject: ['project_name'],
  mcp__cosyee__delegate: ['description', 'prompt'],
  mcp__cosyee__delegate_agents: ['query'],
  mcp__cosyee__delegate_send: ['message'],
  mcp__cosyee__delegate_stop: ['conversation_id'],
  mcp__cosyee__delegate_result: ['result_id'],
  // 已移除的工具，旧会话里还有
  mcp__cosyee__delegate_status: ['conversation_id'],
};
const FALLBACK_KEYS = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt', 'skill', 'name'];

/** agy 会话 id（UUID）的短写：取前 8 位 */
export const shortConversationId = (id: string): string => id.trim().slice(0, 8);

/** 工具调用的一行摘要，如 `Bash: npm test`、`Read: src/a.ts`、`Agent: <description>`；没有可展示的参数时只返回工具名 */
export function toolSummary(name: string, input: unknown): string {
  const o = isObj(input) ? input : {};
  const keys = KEYS_BY_TOOL[name] ?? FALLBACK_KEYS;
  let detail = '';
  if (name === 'SendMessage') {
    // 收件方 + 内容（优先用调用方给的短标签 summary）：「SendMessage: worker · 修一下测试」
    const to = str(o.to).trim();
    const body = str(o.summary).trim() || str(o.message).trim();
    detail = to && body ? `${to} · ${body}` : to || body;
  }
  if (name === 'mcp__cosyee__delegate_send') {
    // 会话 id 短写 + 消息摘录：「delegate_send: a1b2c3d4 · 再加上单测」
    const id = shortConversationId(str(o.conversation_id));
    const body = str(o.message).trim();
    detail = id && body ? `${id} · ${body}` : id || body;
  } else if (name === 'mcp__cosyee__delegate_stop' || name === 'mcp__cosyee__delegate_status') {
    detail = shortConversationId(str(o.conversation_id));
  } else if (name === 'mcp__cosyee__delegate_result') {
    detail = shortConversationId(str(o.result_id).replace(/^res_/, ''));
  }
  for (const k of detail ? [] : keys) {
    const v = str(o[k]).trim();
    if (v) {
      detail = v;
      break;
    }
  }
  if (!detail && !KEYS_BY_TOOL[name]) {
    // 未知工具：退而取第一个非空字符串字段
    for (const v of Object.values(o)) {
      if (typeof v === 'string' && v.trim()) {
        detail = v;
        break;
      }
    }
  }
  const label = toolLabel(name);
  const line = oneLine(detail);
  return line ? `${label}: ${line}` : label;
}

/** Cosyee 自带工具的内部前缀（经内置 MCP 服务器实现，界面不按 MCP 展示，显示名去掉前缀） */
export const COSYEE_TOOL_PREFIX = 'mcp__cosyee__';

/** 是否 Cosyee 自带工具 */
export const isCosyeeTool = (name: string): boolean => name.startsWith(COSYEE_TOOL_PREFIX);

/** 界面展示用的工具名：去掉 mcp__cosyee__ 前缀，其余原样 */
export const toolLabel = (name: string): string => (isCosyeeTool(name) ? name.slice(COSYEE_TOOL_PREFIX.length) : name);

/** 子代理工具在 init.tools 里叫 Task，实际事件里叫 Agent，两者都认 */
export const isAgentName = (name: string): boolean => name === 'Agent' || name === 'Task';

/** Cosyee 自带的委派工具：按子代理展示，进度由服务端合成为子代理事件 */
export const DELEGATE_TOOL = 'mcp__cosyee__delegate';

/** 按子代理展示的工具：原生 Agent / Task，以及 Cosyee 的 delegate */
export const isSubagentTool = (name: string): boolean => isAgentName(name) || name === DELEGATE_TOOL;

/** tool_result.content 取出纯文本（字符串或 text 块数组） */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (isObj(c) && c.type === 'text' ? str(c.text) : typeof c === 'string' ? c : ''))
      .join('\n');
  }
  return '';
}

/** 尽力解析 JSON，失败返回 undefined */
export function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** 从尚未写完的 JSON 缓冲里抠出某个字符串字段（流式期间提前拿到 Agent 的 description） */
export function peekJsonString(buf: string, field: string): string {
  // 模板字符串里反斜杠要双写
  const m = new RegExp(`"${field}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`).exec(buf);
  if (!m) return '';
  const v = tryParse(m[1]!);
  return typeof v === 'string' ? v : '';
}
