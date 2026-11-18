// `/` 菜单的纯逻辑：触发判断与过滤。

/**
 * 光标前的文本（同一个文本节点内）是否处于「/ 命令」输入中。
 * 条件：`/` 在文本开头或空白之后，其后到光标之间没有空白和 `/`。
 * 返回 `/` 的位置与已输入的过滤词；不满足返回 null。
 * 注意：`/` 在节点开头时，调用方还需确认前一个兄弟不是标签（见 Composer.evalSlash）。
 */
export function matchSlash(before: string): { start: number; query: string } | null {
  const m = /(^|\s)\/([^\s/]*)$/.exec(before);
  if (!m) return null;
  return { start: m.index + m[1].length, query: m[2] };
}

export interface SlashItem {
  name: string;
  group: 'command' | 'skill';
}

/** 命令在前、skill 在后；前缀匹配优先于包含匹配；name 去掉可能带的前导 / 并去重 */
export function filterSlash(commands: string[], skills: string[], query: string): SlashItem[] {
  const q = query.toLowerCase();
  const norm = (s: string) => s.replace(/^\//, '');
  const seen = new Set<string>();
  const build = (names: string[], group: SlashItem['group']): SlashItem[] => {
    const hits = names
      .map(norm)
      .filter((n) => n && !seen.has(`${group}:${n}`) && seen.add(`${group}:${n}`))
      .filter((n) => n.toLowerCase().includes(q));
    const prefix = hits.filter((n) => n.toLowerCase().startsWith(q));
    const rest = hits.filter((n) => !n.toLowerCase().startsWith(q));
    return [...prefix, ...rest].map((name) => ({ name, group }));
  };
  return [...build(commands, 'command'), ...build(skills, 'skill')];
}
