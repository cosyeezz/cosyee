// 标签预览浮窗：贴在标签上方（空间不够则下方），无遮罩，不抢焦点。
// 不含任何可聚焦元素；容器 mousedown 默认 preventDefault，使焦点留在编辑区（路径文字除外，允许选中复制）。
import { useEffect, useLayoutEffect, useState } from 'react';
import type { PreviewInfo } from '@cosyee/shared';
import { Icon } from '../icons/Icon';
import { readChip, type ChipData } from './editorDom';
import { CHIP_ICON } from './chipElement';
import './ChipPreview.css';

export interface ChipPreviewProps {
  /** 被点击的标签元素 */
  anchor: HTMLElement;
  /** 直接给出标签数据（会话流里的附件标签没有 data- 属性）；不给则从 anchor 的 dataset 读 */
  chip?: ChipData;
  onClose: () => void;
  previewInfo: (token: string) => Promise<PreviewInfo>;
  previewRawUrl: (token: string) => string;
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

interface Place { left: number; top?: number; bottom?: number; maxHeight: number }

function place(anchor: HTMLElement): Place {
  const r = anchor.getBoundingClientRect();
  const W = 320;
  const gap = 8;
  const spaceAbove = r.top - gap - 8;
  const spaceBelow = window.innerHeight - r.bottom - gap - 8;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - W - 8));
  if (spaceAbove >= 140 || spaceAbove >= spaceBelow) {
    return { left, bottom: window.innerHeight - r.top + gap, maxHeight: Math.max(spaceAbove, 80) };
  }
  return { left, top: r.bottom + gap, maxHeight: Math.max(spaceBelow, 80) };
}

export function ChipPreview({ anchor, chip: chipProp, onClose, previewInfo, previewRawUrl }: ChipPreviewProps) {
  const chip = chipProp ?? readChip(anchor);
  const token = chip.token;
  const isImage = chip.kind === 'img';
  const [pos, setPos] = useState<Place>(() => place(anchor));
  const [info, setInfo] = useState<PreviewInfo | null>(null);
  const [imgFailed, setImgFailed] = useState(false);

  // 取文件信息（大小 / 修改时间）
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    previewInfo(token).then((i) => { if (!cancelled) setInfo(i); }).catch(() => { /* 信息拿不到就只显示路径 */ });
    return () => { cancelled = true; };
  }, [token, previewInfo]);

  // 跟随标签位置（滚动 / 缩放 / 编辑区增高）
  useLayoutEffect(() => {
    const update = () => {
      if (!anchor.isConnected) { onClose(); return; }
      const n = place(anchor);
      // 位置没变就不触发重渲染
      setPos((p) => (p.left === n.left && p.top === n.top && p.bottom === n.bottom && p.maxHeight === n.maxHeight ? p : n));
    };
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    const id = window.setInterval(update, 300);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      window.clearInterval(id);
    };
  }, [anchor, onClose]);

  // 点外面 / Esc 关闭（点标签本身由 Composer 负责切换）
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchor.contains(t)) return;
      if ((t as Element).closest?.('.cz-preview')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose(); // 只关浮窗，不动输入内容
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [anchor, onClose]);

  const rawUrl = isImage && token ? previewRawUrl(token) : '';
  const path = info?.path ?? chip.path;
  const meta: string[] = [];
  if (info?.size != null && info.kind === 'file') meta.push(formatSize(info.size));
  if (info?.mtime != null) meta.push(new Date(info.mtime).toLocaleString());

  return (
    <div
      className="cz-preview"
      style={{ left: pos.left, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxHeight }}
      onMouseDown={(e) => {
        if (!(e.target as Element).closest('.cz-preview__path')) e.preventDefault();
      }}
    >
      {isImage && rawUrl && !imgFailed && (
        <div className="cz-preview__thumb">
          <img src={rawUrl} alt={chip.label} onError={() => setImgFailed(true)} />
        </div>
      )}
      <div className="cz-preview__head">
        <Icon name={CHIP_ICON[chip.kind]} size={16} />
        <span className="cz-preview__path">{path}</span>
      </div>
      {meta.length > 0 && <div className="cz-preview__meta">{meta.join(' · ')}</div>}
    </div>
  );
}
