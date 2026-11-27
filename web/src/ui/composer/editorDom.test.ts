import { describe, expect, it } from 'vitest';
import { insertNodesAt, isEditorEmpty, readSegments, relabelChips } from './editorDom';
import { createChipElement, createPendingChip } from './chipElement';
import { parseUserText, serialize, labelChips } from '../../core/composer';

function editor(html: string): HTMLElement {
  const el = document.createElement('div');
  el.contentEditable = 'true';
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

describe('readSegments', () => {
  it('文本、<br>、块级换行', () => {
    expect(readSegments(editor('a<br>b'))).toEqual([{ t: 'text', text: 'a\nb' }]);
    expect(readSegments(editor('a<div>b</div><div><br></div><div>c</div>'))).toEqual([{ t: 'text', text: 'a\nb\n\nc' }]);
  });
  it('最后一个 <br> 是占位符，不算换行', () => {
    expect(readSegments(editor('a<br>'))).toEqual([{ t: 'text', text: 'a' }]);
    expect(readSegments(editor('a<br><br>'))).toEqual([{ t: 'text', text: 'a\n' }]);
  });
  it('空内容', () => {
    expect(isEditorEmpty(editor('<br>'))).toBe(true);
    expect(isEditorEmpty(editor('  '))).toBe(true);
    expect(isEditorEmpty(editor('x'))).toBe(false);
  });
});

describe('标签', () => {
  it('创建、读取、重新编号、发送序列化', () => {
    const ed = editor('比较 ');
    const a = createChipElement({ kind: 'file', path: 'C:\\a b\\x.ts', label: 'file9', token: 't1' });
    const b = createChipElement({ kind: 'img', path: '/p/图.png', label: 'img7' });
    const c = createChipElement({ kind: 'file', path: '/p/y.ts', label: 'file9' });
    ed.append(a, document.createTextNode(' 和 '), b, document.createTextNode(' '), c);
    relabelChips(ed);
    expect([a, b, c].map((e) => e.dataset.label)).toEqual(['file1', 'img1', 'file2']);
    expect(c.querySelector('.cz-chip__label')!.textContent).toBe('file2');
    expect(a.dataset.token).toBe('t1');
    const segs = labelChips(readSegments(ed));
    const text = serialize(segs);
    expect(text).toBe('比较 @"C:\\a b\\x.ts" 和 @"/p/图.png" @"/p/y.ts"');
    expect(parseUserText(text).userText).toBe('比较 file1 和 img1 file2');
  });

  it('在保存的光标位置插入', () => {
    const ed = editor('abcd');
    const range = document.createRange();
    range.setStart(ed.firstChild!, 2);
    range.collapse(true);
    const chip = createChipElement({ kind: 'folder', path: '/x', label: 'folder1' });
    insertNodesAt(ed, range, [chip, document.createTextNode(' ')]);
    const segs = readSegments(ed);
    expect(segs.map((s) => s.t)).toEqual(['text', 'chip', 'text']);
    expect((segs[0] as { text: string }).text).toBe('ab ');
    expect((segs[2] as { text: string }).text).toBe(' cd');
  });

  it('上传中的占位标签：读内容时跳过，不参与编号', () => {
    const ed = editor('看 ');
    const p = createPendingChip('截图.png', true);
    const a = createChipElement({ kind: 'file', path: '/x', label: 'file5' });
    ed.append(p.el, document.createTextNode(' '), a);
    relabelChips(ed);
    expect(a.dataset.label).toBe('file1');
    expect(p.el.dataset.label).toBeUndefined();
    expect(readSegments(ed).map((s) => s.t)).toEqual(['text', 'chip']);
    p.setProgress(0.5);
    expect(p.el.textContent).toContain('50%');
  });

  it('没有保存位置时插到末尾', () => {
    const ed = editor('hi ');
    insertNodesAt(ed, null, [createChipElement({ kind: 'file', path: '/x', label: 'file1' })]);
    expect(readSegments(ed).map((s) => s.t)).toEqual(['text', 'chip']);
  });
});
