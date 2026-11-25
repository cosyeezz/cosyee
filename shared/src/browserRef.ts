// 内置浏览器抓取的页面元素：输入框里显示成附件标签，发出去是一行带标记的定位文字。
// 服务端生成、前端识别（历史消息还原成标签、预览卡片拆字段），cosyee:browser skill 里说明了这个写法。
//   ⟦内置浏览器元素｜<button>｜选择器 `button[aria-label="新建会话"]`｜文字「新建」｜在 iframe 里｜页面 https://x/｜身份 默认（default）⟧

export const ELEMENT_REF_HEAD = '⟦内置浏览器元素';

export interface ElementRef {
  tag: string;
  /** 页面里唯一的 CSS 选择器（在 iframe / shadow DOM 里时相对那份文档） */
  selector: string;
  /** 可见文字（截断；已经写在选择器里时为空） */
  text: string;
  where: 'iframe' | 'shadow' | null;
  url: string;
  profile: { id: string; name: string };
}

/** 识别消息文本里的元素引用（整段，含首尾括号） */
export const ELEMENT_REF_RE = /⟦内置浏览器元素｜[^⟧\n]{1,4000}⟧/g;

const TEXT_MAX = 60;
/** 字段里不能出现分隔符和换行，否则整段识别不出来 */
const clean = (s: string): string =>
  s.replace(/\s+/g, ' ').replace(/｜/g, '|').replace(/⟦/g, '[').replace(/⟧/g, ']').trim();

export function formatElementRef(r: ElementRef): string {
  const full = clean(r.text);
  const text = full.length > TEXT_MAX ? `${full.slice(0, TEXT_MAX)}…` : full;
  const parts = [
    `<${clean(r.tag).toLowerCase() || 'element'}>`,
    `选择器 \`${clean(r.selector)}\``,
    text && !r.selector.includes(full.slice(0, TEXT_MAX)) ? `文字「${text}」` : '',
    r.where === 'iframe' ? '在 iframe 里' : r.where === 'shadow' ? '在 shadow DOM 里' : '',
    r.url ? `页面 ${clean(r.url)}` : '',
    `身份 ${clean(r.profile.name) || r.profile.id}（${clean(r.profile.id)}）`,
  ].filter(Boolean);
  return `${ELEMENT_REF_HEAD}｜${parts.join('｜')}⟧`;
}

export function isElementRef(s: string): boolean {
  return s.startsWith(`${ELEMENT_REF_HEAD}｜`) && s.endsWith('⟧') && !s.includes('\n');
}

/** 拆回字段（预览卡片用）；不是元素引用返回 null，认不出的字段忽略 */
export function parseElementRef(s: string): ElementRef | null {
  if (!isElementRef(s)) return null;
  const r: ElementRef = { tag: '', selector: '', text: '', where: null, url: '', profile: { id: '', name: '' } };
  for (const f of s.slice(ELEMENT_REF_HEAD.length + 1, -1).split('｜')) {
    let m: RegExpExecArray | null;
    if ((m = /^<([^>]*)>$/.exec(f))) r.tag = m[1]!;
    else if ((m = /^选择器 `([\s\S]*)`$/.exec(f))) r.selector = m[1]!;
    else if ((m = /^文字「([\s\S]*)」$/.exec(f))) r.text = m[1]!;
    else if (f === '在 iframe 里') r.where = 'iframe';
    else if (f === '在 shadow DOM 里') r.where = 'shadow';
    else if (f.startsWith('页面 ')) r.url = f.slice(3);
    else if ((m = /^身份 ([\s\S]*)（([^（）]*)）$/.exec(f))) r.profile = { name: m[1]!, id: m[2]! };
  }
  return r.selector ? r : null;
}
