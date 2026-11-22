// 网页版选择窗口：远程连接时代替服务端桌面上的系统对话框（远程设备看不到那个窗口）。
// 浏览的是服务端的文件（Claude 在服务端运行，选的路径要在服务端上）。
// - 文件模式（「+」添加）：点文件夹进入，勾选文件 / 文件夹，可以跨目录多选；
// - 文件夹模式（打开工作空间）：只列文件夹，进入要的文件夹后点「打开此文件夹」。
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BrowseDir } from '@cosyee/shared';
import { api } from '../../core/api';
import { Icon } from '../icons/Icon';
import './PickerDialog.css';

export type PickerMode = 'mixed' | 'folder';

export interface PickerDialogProps {
  mode: PickerMode;
  title: string;
  /** 选好的绝对路径；取消为 [] */
  onDone: (paths: string[]) => void;
  /** 测试注入 */
  browse?: (path?: string) => Promise<BrowseDir>;
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + name;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function PickerDialog({ mode, title, onDone, browse = api.browse }: PickerDialogProps) {
  const [dir, setDir] = useState<BrowseDir | null>(null);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** 已勾选（绝对路径 → 是否文件夹），跨目录保留 */
  const [picked, setPicked] = useState<Map<string, boolean>>(() => new Map());
  const seq = useRef(0);
  const listRef = useRef<HTMLUListElement>(null);

  const go = useCallback((path?: string) => {
    const n = ++seq.current;
    setLoading(true);
    setError(null);
    browse(path).then(
      (d) => {
        if (n !== seq.current) return;
        setDir(d);
        setInput(d.path);
        setLoading(false);
        listRef.current?.scrollTo?.({ top: 0 });
      },
      (e) => {
        if (n !== seq.current) return;
        setError(msg(e));
        setLoading(false);
      },
    );
  }, [browse]);

  useEffect(() => { go(); }, [go]);

  const cancel = useCallback(() => onDone([]), [onDone]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        cancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [cancel]);

  const toggle = (path: string, isDir: boolean) =>
    setPicked((m) => {
      const n = new Map(m);
      if (n.has(path)) n.delete(path);
      else n.set(path, isDir);
      return n;
    });

  const entries = (dir?.entries ?? []).filter((e) => mode === 'mixed' || e.isDir);
  const confirm = () => {
    if (mode === 'folder') {
      if (dir) onDone([dir.path]);
    } else if (picked.size) onDone([...picked.keys()]);
  };

  return createPortal(
    <div className="cz-pick__scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) cancel(); }}>
      <div className="cz-pick" role="dialog" aria-modal="true" aria-label={title}>
        <div className="cz-pick__head">
          <span className="cz-pick__title">{title}</span>
          <button type="button" className="cz-pick__icon" aria-label="关闭" title="关闭" onClick={cancel}>
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="cz-pick__bar">
          <button
            type="button"
            className="cz-pick__icon"
            aria-label="上一级"
            title="上一级"
            disabled={!dir?.parent}
            onClick={() => dir?.parent && go(dir.parent)}
          >
            <Icon name="arrow-up" size={14} />
          </button>
          {dir && dir.roots.length > 1 && (
            <select className="cz-pick__roots" aria-label="磁盘" value="" onChange={(e) => e.target.value && go(e.target.value)}>
              <option value="">盘</option>
              {dir.roots.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          )}
          <input
            className="cz-pick__path"
            aria-label="路径"
            value={input}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && input.trim()) go(input.trim());
            }}
          />
        </div>
        <ul ref={listRef} className="cz-pick__list" aria-busy={loading}>
          {error && <li className="cz-pick__state cz-pick__state--error" role="alert">{error}</li>}
          {!error && dir && entries.map((e) => {
            const full = joinPath(dir.path, e.name);
            const on = picked.has(full);
            return (
              <li key={e.name} className={`cz-pick__row${on ? ' is-on' : ''}`}>
                {mode === 'mixed' && (
                  <input type="checkbox" className="cz-pick__check" aria-label={`选择 ${e.name}`} checked={on} onChange={() => toggle(full, e.isDir)} />
                )}
                <button
                  type="button"
                  className="cz-pick__entry"
                  onClick={() => (e.isDir ? go(full) : toggle(full, false))}
                >
                  <Icon name={e.isDir ? 'folder' : 'file'} size={14} />
                  <span className="cz-pick__name">{e.name}</span>
                  {e.isDir && <Icon name="chevron-right" size={12} />}
                </button>
              </li>
            );
          })}
          {!error && dir && !loading && entries.length === 0 && (
            <li className="cz-pick__state">{mode === 'folder' ? '（没有子文件夹）' : '（空文件夹）'}</li>
          )}
          {!error && dir?.truncated && <li className="cz-pick__state">仅显示前 {dir.entries.length} 项</li>}
        </ul>
        <div className="cz-pick__foot">
          <span className="cz-pick__count">
            {mode === 'mixed' ? (picked.size ? `已选 ${picked.size} 项` : '勾选文件或文件夹，点文件夹进入') : '进入要打开的文件夹'}
          </span>
          <button type="button" className="cz-pick__btn" onClick={cancel}>取消</button>
          <button
            type="button"
            className="cz-pick__btn cz-pick__btn--primary"
            disabled={mode === 'mixed' ? picked.size === 0 : !dir || !!error}
            onClick={confirm}
          >
            {mode === 'mixed' ? '添加' : '打开此文件夹'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
