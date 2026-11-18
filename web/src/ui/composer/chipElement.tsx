// 创建编辑区里的标签 DOM（contenteditable=false 的内联元素）。图标用 <Icon> 渲染成静态标记。
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChipKind } from '../../core/composer';
import { Icon, type IconName } from '../icons/Icon';
import { CHIP_CLASS, type ChipData } from './editorDom';

export const CHIP_ICON: Record<ChipKind, IconName> = { file: 'file', img: 'image', folder: 'folder' };

const iconCache = new Map<string, string>();
export function iconMarkup(kind: ChipKind, size = 14): string {
  const k = `${kind}:${size}`;
  let s = iconCache.get(k);
  if (s === undefined) {
    s = renderToStaticMarkup(<Icon name={CHIP_ICON[kind]} size={size} />);
    iconCache.set(k, s);
  }
  return s;
}

export function createChipElement(c: ChipData): HTMLElement {
  const el = document.createElement('span');
  el.className = CHIP_CLASS;
  el.contentEditable = 'false';
  el.dataset.kind = c.kind;
  el.dataset.path = c.path;
  el.dataset.label = c.label;
  if (c.token) el.dataset.token = c.token;
  el.title = c.path;
  const icon = document.createElement('span');
  icon.className = 'cz-chip__icon';
  icon.innerHTML = iconMarkup(c.kind);
  const label = document.createElement('span');
  label.className = 'cz-chip__label';
  label.textContent = c.label;
  el.append(icon, label);
  return el;
}
