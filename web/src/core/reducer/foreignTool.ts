// 将外部智能体（目前为 agy acp）的工具名与入参归一化为 Claude 等价形状，
// 让下游展示（图标、摘要、可点击文件路径、Bash 高亮等）统一走 Claude 工具路径。
import { isObj, str, type Obj } from './util';

function mapRead(o: Obj): Obj {
  const out: Obj = {};
  if (typeof o.Path === 'string') out.file_path = o.Path;
  if (typeof o.StartLine === 'number') {
    out.offset = o.StartLine;
    if (typeof o.EndLine === 'number') out.limit = o.EndLine - o.StartLine + 1;
  }
  return out;
}

function mapEdit(o: Obj): Obj {
  const out: Obj = {};
  if (typeof o.Path === 'string') out.file_path = o.Path;
  if (typeof o.Target === 'string') out.old_string = o.Target;
  if (typeof o.Replacement === 'string') out.new_string = o.Replacement;
  return out;
}

function mapWrite(o: Obj): Obj {
  const out: Obj = {};
  if (typeof o.Path === 'string') out.file_path = o.Path;
  if (typeof o.Content === 'string') out.content = o.Content;
  return out;
}

function mapBash(o: Obj): Obj {
  const out: Obj = {};
  if (typeof o.CommandLine === 'string') out.command = o.CommandLine;
  if (typeof o.toolSummary === 'string') out.description = o.toolSummary;
  return out;
}

function mapTodoStatus(status: unknown): 'in_progress' | 'completed' | 'pending' {
  if (status === 'in_progress') return 'in_progress';
  if (status === 'done' || status === 'completed') return 'completed';
  return 'pending';
}

function mapTodoWrite(o: Obj): Obj {
  const out: Obj = {};
  if (Array.isArray(o.steps)) {
    out.todos = o.steps.filter(isObj).map((s) => ({
      content: str(s.title),
      status: mapTodoStatus(s.status),
    }));
  }
  return out;
}

/** Foreign (agy acp) tool → Claude-equivalent tool name + input; returns null if not a known foreign tool. */
export function normalizeForeignTool(name: string, input: unknown): { name: string; input: unknown } | null {
  switch (name) {
    case 'read_file':
    case 'read':
      return { name: 'Read', input: isObj(input) ? mapRead(input) : input };
    case 'edit_file':
      return { name: 'Edit', input: isObj(input) ? mapEdit(input) : input };
    case 'write_file':
      return { name: 'Write', input: isObj(input) ? mapWrite(input) : input };
    case 'edit':
      if (isObj(input) && input.Content !== undefined && input.Target === undefined) {
        return { name: 'Write', input: mapWrite(input) };
      }
      return { name: 'Edit', input: isObj(input) ? mapEdit(input) : input };
    case 'run_command':
    case 'execute':
      return { name: 'Bash', input: isObj(input) ? mapBash(input) : input };
    case 'update_steps':
      return { name: 'TodoWrite', input: isObj(input) ? mapTodoWrite(input) : input };
    default:
      return null;
  }
}
