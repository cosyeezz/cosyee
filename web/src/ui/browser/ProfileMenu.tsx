// 浏览器身份切换：每个身份一份独立的登录状态（同一网站可以在不同身份里登录不同账号），可以同时运行。
// 下拉里切换 / 新建 / 改名 / 停止 / 删除；删除要在行内再确认一次（登录状态会一起删掉）。
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { BrowserProfileStatus } from '@cosyee/shared';
import { api } from '../../core/api';
import { Icon } from '../icons/Icon';
import { useDismiss } from '../sidebar/useDismiss';

const DEFAULT_ID = 'default';
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface ProfileMenuProps {
  profiles: BrowserProfileStatus[];
  current: string;
  disabled?: boolean;
  onSelect: (id: string) => void;
  /** 新建成功：放进列表并切过去 */
  onCreated: (profile: BrowserProfileStatus) => void;
  /** 列表有变化：重新读状态 */
  onChanged: () => void;
  onError: (message: string) => void;
}

export function ProfileMenu({ profiles, current, disabled, onSelect, onCreated, onChanged, onError }: ProfileMenuProps) {
  const [open, setOpen] = useState(false);
  /** 正在改名的身份（'new' = 新建） */
  const [edit, setEdit] = useState<{ id: string; value: string } | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = () => {
    setOpen(false);
    setEdit(null);
    setConfirmDel(null);
  };
  useDismiss(open, wrapRef, close);
  useEffect(() => {
    if (open) onChanged(); // 打开时刷新运行状态
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (edit) inputRef.current?.focus();
  }, [edit?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const cur = profiles.find((p) => p.id === current) ?? profiles[0];

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onChanged();
      return true;
    } catch (e) {
      onError(msg(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submitEdit = async (e: FormEvent) => {
    e.preventDefault();
    if (!edit || busy) return;
    const name = edit.value.trim();
    if (!name) return setEdit(null);
    if (edit.id === 'new') {
      let created: BrowserProfileStatus | null = null;
      if (await act(async () => { created = await api.browserCreateProfile(name); }) && created) {
        onCreated(created);
        close();
        btnRef.current?.focus();
      }
    } else if (await act(() => api.browserRenameProfile(edit.id, name))) setEdit(null);
  };

  const remove = async (id: string) => {
    if (await act(() => api.browserDeleteProfile(id))) {
      setConfirmDel(null);
      if (id === current) onSelect(DEFAULT_ID);
    }
  };

  const editForm = (id: string) => (
    <form className="cz-brp__edit" onSubmit={(e) => void submitEdit(e)}>
      <input
        ref={inputRef}
        value={edit?.value ?? ''}
        maxLength={32}
        placeholder={id === 'new' ? '身份名称，比如「淘宝-小号」' : '身份名称'}
        aria-label="身份名称"
        spellCheck={false}
        disabled={busy}
        onChange={(e) => setEdit((x) => (x ? { ...x, value: e.target.value } : x))}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            setEdit(null);
          }
        }}
      />
      <button type="submit" className="cz-brp__ib" title="保存" aria-label="保存" disabled={busy || !edit?.value.trim()}>
        <Icon name="check" size={14} />
      </button>
    </form>
  );

  return (
    <div className="cz-brp" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className={`cz-br__btn cz-brp__trigger${open ? ' is-open' : ''}`}
        title={`浏览器身份：${cur?.name ?? ''}（每个身份单独保存登录状态）`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled || !cur}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Icon name="users" size={14} />
        <span className="cz-brp__name">{cur?.name ?? '—'}</span>
        <Icon name="chevron-down" size={12} />
      </button>
      {open && (
        <div className="cz-brp__menu" role="menu" aria-label="浏览器身份">
          <div className="cz-brp__cap">每个身份单独保存登录状态，可以同时开着</div>
          {profiles.map((p) => {
            const on = p.id === current;
            if (edit?.id === p.id) return <div key={p.id} className="cz-brp__row is-editing">{editForm(p.id)}</div>;
            if (confirmDel === p.id) {
              return (
                <div key={p.id} className="cz-brp__row is-confirm" role="group" aria-label="确认删除">
                  <span className="cz-brp__ask">删除「{p.name}」和它的登录状态？</span>
                  <button type="button" className="cz-brp__txt is-danger" disabled={busy} onClick={() => void remove(p.id)}>删除</button>
                  <button type="button" className="cz-brp__txt" disabled={busy} onClick={() => setConfirmDel(null)}>取消</button>
                </div>
              );
            }
            const isDefault = p.id === DEFAULT_ID;
            return (
              <div key={p.id} className={`cz-brp__row${on ? ' is-on' : ''}`}>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={on}
                  className="cz-brp__pick"
                  title={p.running ? `运行中${p.url && p.url !== 'about:blank' ? ` · ${p.url}` : ''}` : '未运行（切换过去会自动启动）'}
                  onClick={() => {
                    if (!on) onSelect(p.id);
                    close();
                    btnRef.current?.focus();
                  }}
                >
                  <span className={`cz-brp__dot${p.running ? ' is-run' : ''}`} aria-hidden="true" />
                  <span className="cz-brp__label">{p.name}</span>
                  {on && <Icon name="check" size={13} />}
                </button>
                <span className="cz-brp__acts">
                  <button
                    type="button"
                    className="cz-brp__ib"
                    title={!p.running ? '没有在运行' : on ? '正在使用的身份不能停止，先切到别的身份' : '停止（关掉它的浏览器，登录状态保留）'}
                    aria-label={`停止「${p.name}」`}
                    disabled={busy || !p.running || on}
                    onClick={() => void act(() => api.browserStopProfile(p.id))}
                  >
                    <Icon name="stop" size={12} />
                  </button>
                  <button type="button" className="cz-brp__ib" title="改名" aria-label={`改名「${p.name}」`} disabled={busy} onClick={() => { setConfirmDel(null); setEdit({ id: p.id, value: p.name }); }}>
                    <Icon name="pencil" size={13} />
                  </button>
                  <button
                    type="button"
                    className="cz-brp__ib is-danger"
                    title={isDefault ? '默认身份不能删除' : '删除（登录状态一起删掉）'}
                    aria-label={`删除「${p.name}」`}
                    disabled={busy || isDefault}
                    onClick={() => { setEdit(null); setConfirmDel(p.id); }}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </span>
              </div>
            );
          })}
          <div className="cz-brp__hr" role="separator" />
          {edit?.id === 'new' ? (
            <div className="cz-brp__row is-editing">{editForm('new')}</div>
          ) : (
            <button type="button" role="menuitem" className="cz-brp__new" disabled={busy} onClick={() => { setConfirmDel(null); setEdit({ id: 'new', value: '' }); }}>
              <Icon name="plus" size={14} />
              新建身份
            </button>
          )}
        </div>
      )}
    </div>
  );
}
