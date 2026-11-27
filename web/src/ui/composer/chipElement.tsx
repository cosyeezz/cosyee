// 创建编辑区里的标签 DOM（contenteditable=false 的内联元素）。图标用 <Icon> 渲染成静态标记。
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChipKind } from '../../core/composer';
import { Icon, type IconName } from '../icons/Icon';
import { CHIP_CLASS, PENDING_ATTR, type ChipData } from './editorDom';

export const CHIP_ICON: Record<ChipKind, IconName> = { file: 'file', img: 'image', folder: 'folder', el: 'pick' };

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

/** 「上传中」占位标签：显示文件名和进度（--p 是 0–1 的进度，CSS 画底纹）；上传完由调用方换成正式标签 */
export function createPendingChip(name: string, image: boolean): { el: HTMLElement; setProgress: (ratio: number) => void } {
  const el = document.createElement('span');
  el.className = `${CHIP_CLASS} cz-chip--pending`;
  el.contentEditable = 'false';
  el.setAttribute(PENDING_ATTR, '1');
  el.title = `正在上传 ${name}`;
  el.style.setProperty('--p', '0');
  const icon = document.createElement('span');
  icon.className = 'cz-chip__icon';
  icon.innerHTML = iconMarkup(image ? 'img' : 'file');
  const label = document.createElement('span');
  label.className = 'cz-chip__label';
  label.textContent = name;
  const pct = document.createElement('span');
  pct.className = 'cz-chip__pct';
  pct.textContent = '0%';
  el.append(icon, label, pct);
  return {
    el,
    setProgress(ratio) {
      const r = Math.max(0, Math.min(1, ratio));
      el.style.setProperty('--p', String(r));
      pct.textContent = `${Math.round(r * 100)}%`;
    },
  };
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
