// 把 rehype-highlight 产出的 React 节点树（hljs 的 <span>）按换行拆成逐行节点，
// 这样每行能带独立的行号、自动换行时行号仍与首行对齐。跨行的 span 在每一行里各复制一份。
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';

type Line = ReactNode[];

function join(a: Line[], b: Line[]): Line[] {
  if (!a.length) return b;
  if (!b.length) return a;
  const out = a.slice(0, -1);
  out.push([...a[a.length - 1]!, ...b[0]!]);
  return out.concat(b.slice(1));
}

function walk(node: ReactNode): Line[] {
  if (node == null || typeof node === 'boolean') return [];
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node).split('\n').map((s) => (s ? [s] : []));
  }
  if (Array.isArray(node)) return node.reduce<Line[]>((acc, n) => join(acc, walk(n)), []);
  if (isValidElement(node)) {
    const el = node as ReactElement<{ children?: ReactNode }>;
    const inner = walk(el.props.children);
    if (inner.length === 0) return [];
    return inner.map((line) => [cloneElement(el, undefined, ...line)]);
  }
  return [];
}

/** 逐行节点；末尾多出的空行（文件以换行结尾）去掉 */
export function splitHighlightedLines(children: ReactNode): ReactNode[][] {
  const lines = walk(children);
  if (lines.length > 1 && lines[lines.length - 1]!.length === 0) lines.pop();
  // 同一行里并列的多个 span 需要各自唯一的 key
  return lines.map((line) => line.map((n, i) => (isValidElement(n) ? cloneElement(n as ReactElement, { key: i }) : n)));
}

/** 纯文本逐行（统一换行符；末尾换行不产生空行） */
export function splitPlainLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
