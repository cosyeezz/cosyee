// reducer 的小工具：类型守卫、文本截取、工具摘要。无副作用。

export type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string => (typeof v === 'string' ? v : '');
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

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
};
const FALLBACK_KEYS = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt', 'skill', 'name'];

/** 工具调用的一行摘要，如 `Bash: npm test`、`Read: src/a.ts`、`Agent: <description>`；没有可展示的参数时只返回工具名 */
export function toolSummary(name: string, input: unknown): string {
  const o = isObj(input) ? input : {};
  const keys = KEYS_BY_TOOL[name] ?? FALLBACK_KEYS;
  let detail = '';
  for (const k of keys) {
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
  const line = oneLine(detail);
  return line ? `${name}: ${line}` : name;
}

/** 子代理工具在 init.tools 里叫 Task，实际事件里叫 Agent，两者都认 */
export const isAgentName = (name: string): boolean => name === 'Agent' || name === 'Task';

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
