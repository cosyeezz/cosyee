import { describe, expect, it } from 'vitest';
import { ELEMENT_REF_RE, parseElementRef } from '@cosyee/shared';
import { elementText, parseRawPick, type RawPick } from './elements.js';

const make = (o: Partial<RawPick>): RawPick =>
  parseRawPick({
    tag: 'button',
    label: 'button.icon-btn',
    selector: 'button[aria-label="新建会话"]',
    text: '新建会话',
    rect: { x: 61, y: 21, width: 18, height: 18 },
    viewport: { width: 719, height: 1281 },
    scroll: { x: 0, y: 0 },
    url: 'https://example.com/',
    title: 'Example',
    ...o,
  })!;

const P = { id: 'default', name: '默认' };

describe('抓取元素的定位文字', () => {
  it('选择器里已经有文字时不重复写；带上页面和身份', () => {
    expect(elementText(make({}), P)).toBe(
      '⟦内置浏览器元素｜<button>｜选择器 `button[aria-label="新建会话"]`｜页面 https://example.com/｜身份 默认（default）⟧',
    );
  });

  it('带上可见文字，过长截断', () => {
    expect(elementText(make({ selector: '.sidebar > button:nth-of-type(2)', text: '  保存\n 设置 ' }), P)).toContain('｜文字「保存 设置」｜');
    expect(elementText(make({ selector: 'p', text: '字'.repeat(80) }), P)).toContain(`文字「${'字'.repeat(60)}…」`);
  });

  it('注明 iframe 里的元素；字段里的分隔符被换掉，整段还能拆回来', () => {
    const t = elementText(make({ selector: '#x', text: 'a｜b⟧c', inFrame: true }), { id: 'abcdef01', name: '淘宝-小号' });
    expect(t).toContain('｜在 iframe 里｜');
    expect(t.match(ELEMENT_REF_RE)).toEqual([t]);
    expect(parseElementRef(t)).toEqual({
      tag: 'button',
      selector: '#x',
      text: 'a|b]c',
      where: 'iframe',
      url: 'https://example.com/',
      profile: { id: 'abcdef01', name: '淘宝-小号' },
    });
  });
});
