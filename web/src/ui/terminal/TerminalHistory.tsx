// 历史命令搜索浮层（Ctrl+R 或点击历史按钮）：支持模糊搜索、键盘上下选、Enter 填入、单条删除、清空全部。
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from '../icons/Icon';
import { fuzzyMatchHistory } from './terminalUtil';

export interface TerminalHistoryProps {
  open: boolean;
  history: readonly string[];
  onSelect: (cmd: string) => void;
  onRemove: (cmd: string) => void;
  onClear: () => void;
  onClose: () => void;
}

function HighlightCmd({ cmd, indices }: { cmd: string; indices: number[] }) {
  if (indices.length === 0) return <>{cmd}</>;
  const set = new Set(indices);
  const parts: { text: string; hit: boolean }[] = [];
  let cur = '';
  let curHit = set.has(0);
  for (let i = 0; i < cmd.length; i++) {
    const h = set.has(i);
    if (h === curHit) {
      cur += cmd[i];
    } else {
      if (cur) parts.push({ text: cur, hit: curHit });
      cur = cmd[i]!;
      curHit = h;
    }
  }
  if (cur) parts.push({ text: cur, hit: curHit });
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? <mark key={i} className="cz-term-hist__hit">{p.text}</mark> : <span key={i}>{p.text}</span>,
      )}
    </>
  );
}

export function TerminalHistory({ open, history, onSelect, onRemove, onClear, onClose }: TerminalHistoryProps) {
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const [confirmClear, setConfirmClear] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo(() => fuzzyMatchHistory(history, query), [history, query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIdx(0);
    setConfirmClear(false);
    // 下一帧聚焦搜索框
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  useEffect(() => {
    if (activeIdx >= items.length) {
      setActiveIdx(Math.max(0, items.length - 1));
    }
  }, [items.length, activeIdx]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-hist-idx="${activeIdx}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeIdx]);

  if (!open) return null;

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (items.length > 0) setActiveIdx((i) => (i + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length > 0) setActiveIdx((i) => (i - 1 + items.length) % items.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const picked = items[activeIdx];
      if (picked) onSelect(picked.cmd);
    }
  };

  return (
    <div className="cz-term-hist cz-term-pop" role="dialog" aria-label="历史命令">
      <div className="cz-term-hist__top">
        <Icon name="search" size={14} className="cz-term-hist__sicon" />
        <input
          ref={inputRef}
          className="cz-term-hist__input"
          value={query}
          placeholder="搜索历史命令…"
          aria-label="搜索历史命令"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIdx(0);
          }}
          onKeyDown={onKeyDown}
        />
        {history.length > 0 && (
          confirmClear ? (
            <div className="cz-term-hist__confirm">
              <button
                type="button"
                className="cz-term-hist__cbtn is-danger"
                onClick={() => {
                  onClear();
                  setConfirmClear(false);
                }}
              >
                确认清空
              </button>
              <button type="button" className="cz-term-hist__cbtn" onClick={() => setConfirmClear(false)}>
                取消
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="cz-term-hist__clear"
              title="清空全部历史"
              onClick={() => setConfirmClear(true)}
            >
              清空
            </button>
          )
        )}
        <button type="button" className="cz-term-hist__close" aria-label="关闭历史列表" title="关闭 (Esc)" onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </div>

      <div className="cz-term-hist__list" ref={listRef} role="listbox" aria-label="命令历史">
        {items.length === 0 ? (
          <div className="cz-term-hist__empty">
            {history.length === 0 ? '暂无历史命令' : '没有匹配的命令'}
          </div>
        ) : (
          items.map((item, idx) => (
            <div
              key={item.cmd}
              data-hist-idx={idx}
              role="option"
              aria-selected={idx === activeIdx}
              className={`cz-term-hist__row${idx === activeIdx ? ' is-active' : ''}`}
              onMouseEnter={() => setActiveIdx(idx)}
            >
              <button
                type="button"
                className="cz-term-hist__pick"
                onClick={() => onSelect(item.cmd)}
                title={item.cmd}
              >
                <code className="cz-term-hist__cmd">
                  <HighlightCmd cmd={item.cmd} indices={item.indices} />
                </code>
              </button>
              <button
                type="button"
                className="cz-term-hist__del"
                aria-label={`删除历史命令 ${item.cmd}`}
                title="删除此条"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(item.cmd);
                }}
              >
                <Icon name="trash" size={13} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
