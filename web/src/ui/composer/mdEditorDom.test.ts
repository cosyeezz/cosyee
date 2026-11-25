// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { readSegments } from './editorDom';
import { serialize } from '../../core/composer';
import { createChipElement } from './chipElement';
import { applyTextEdit, getSelectionOffsets, highlightEditor, scanEditor, setSelectionOffsets } from './mdEditorDom';

const hosts: HTMLElement[] = [];
function editor(...nodes: (string | HTMLElement)[]): HTMLElement {
  const ed = document.createElement('div');
  ed.contentEditable = 'true';
  document.body.appendChild(ed);
  hosts.push(ed);
  for (const n of nodes) ed.append(typeof n === 'string' ? document.createTextNode(n) : n);
  return ed;
}
afterEach(() => {
  hosts.splice(0).forEach((h) => h.remove());
  window.getSelection()?.removeAllRanges();
});
const chip = (path: string) => createChipElement({ kind: 'file', path, label: '' });
const ser = (ed: HTMLElement) => serialize(readSegments(ed));

describe('mdEditorDom', () => {
  it('着色后序列化文本不变，标签保留且是同一个元素', () => {
    const c = chip('/a/b.ts');
    const ed = editor('# 标题 **粗**\n- 项 ', c, ' `x`\n\n结尾\n');
    const before = ser(ed);
    expect(highlightEditor(ed)).toBe(true);
    expect(ser(ed)).toBe(before);
    expect(ed.contains(c)).toBe(true);
    expect(ed.querySelectorAll('.cz-md-b').length).toBe(1);
    expect(ed.querySelector('.cz-md-h1')).not.toBeNull();
    expect(ed.querySelector('.cz-md-icode')?.textContent).toBe('x');
  });

  it('再次着色没有变化（幂等，不写 DOM）', () => {
    const ed = editor('a **b**\n- c');
    highlightEditor(ed);
    const html = ed.innerHTML;
    expect(highlightEditor(ed)).toBe(false);
    expect(ed.innerHTML).toBe(html);
  });

  it('只改中间一行时前后行的 DOM 节点保持不变', () => {
    const ed = editor('第一行\n第二行\n第三行');
    highlightEditor(ed);
    const lines = Array.from(ed.children);
    const mid = lines[1].firstChild as Text;
    mid.data = '第二行 **粗**\n'; // 模拟用户在中间行输入（行尾换行仍在）
    highlightEditor(ed);
    expect(ed.children[0]).toBe(lines[0]);
    expect(ed.children[ed.children.length - 1]).toBe(lines[2]);
    expect(ser(ed)).toBe('第一行\n第二行 **粗**\n第三行');
  });

  it('光标偏移在重新着色前后保持不变', () => {
    const ed = editor('abc **def** ghi\n- 列表项');
    const node = ed.firstChild as Text;
    const sel = window.getSelection()!;
    sel.collapse(node, 8);
    expect(getSelectionOffsets(ed)).toEqual({ anchor: 8, focus: 8 });
    highlightEditor(ed);
    expect(getSelectionOffsets(ed)).toEqual({ anchor: 8, focus: 8 });
    setSelectionOffsets(ed, 20);
    expect(getSelectionOffsets(ed)).toEqual({ anchor: 20, focus: 20 });
  });

  it('末尾换行 + 占位 br：序列化不多出换行', () => {
    const ed = editor('- a\n');
    highlightEditor(ed);
    expect(ed.lastChild?.nodeName).toBe('BR');
    expect(ser(ed)).toBe('- a\n');
  });

  it('applyTextEdit：替换文本并把光标放到 caret，标签不丢', () => {
    const c = chip('/x.png');
    const ed = editor('- 看 ', c, ' 这个');
    highlightEditor(ed);
    const { text } = scanEditor(ed);
    applyTextEdit(ed, { from: text.length, to: text.length, insert: '\n- ', caret: text.length + 3 });
    expect(ser(ed)).toBe('- 看 @"/x.png" 这个\n- ');
    expect(ed.contains(c)).toBe(true);
    expect(getSelectionOffsets(ed)).toEqual({ anchor: text.length + 3, focus: text.length + 3 });
  });

  it('删除范围覆盖标签时标签一并被删', () => {
    const c = chip('/y.ts');
    const ed = editor('- ', c);
    const { text } = scanEditor(ed);
    applyTextEdit(ed, { from: 0, to: text.length, insert: '', caret: 0 });
    expect(ed.querySelector('.cz-chip')).toBeNull();
    expect(ser(ed)).toBe('');
  });

  it('几千字符的着色耗时可接受', () => {
    const ed = editor(Array.from({ length: 400 }, (_, i) => `- 第 ${i} 项 **粗** \`c\``).join('\n'));
    const t = performance.now();
    highlightEditor(ed);
    expect(performance.now() - t).toBeLessThan(1500);
  });
});

describe('删空后的占位 <br>', () => {
  const html = (s: string) => {
    const ed = editor();
    ed.innerHTML = s;
    return ed;
  };

  it('唯一一行被删空只剩 <br>：不算换行，编辑区清空', () => {
    const ed = html('<span class="cz-md-line"><br></span>');
    expect(scanEditor(ed).text).toBe('');
    highlightEditor(ed);
    expect(ed.innerHTML).toBe('');
  });

  it('最后一行被删空：只保留上一行的换行', () => {
    const ed = html('<span class="cz-md-line">a\n</span><span class="cz-md-line"><br></span>');
    expect(scanEditor(ed).text).toBe('a\n');
  });

  it('中间行的 <br> 仍按换行算', () => {
    const ed = html('<span class="cz-md-line"><br></span><span class="cz-md-line">b</span>');
    expect(scanEditor(ed).text).toBe('\nb');
  });
});
