// 添加 / 编辑 2FA 记录表单：支持粘贴 otpauth:// URI 自动填充、选择分组、多选/当场新建标签、高级参数与备注。
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { decodeBase32, normalizeSecret, parseOtpAuthUri } from '../../core/twofa/totp';
import { normalizeTagColor } from '../../core/twofa/tree';
import {
  TWOFA_TAG_COLORS,
  type Algorithm,
  type TwoFaCreateEntryInput,
  type TwoFaEntry,
  type TwoFaGroup,
  type TwoFaTag,
  type TwoFaTagColor,
} from '../../core/twofa/types';
import { Icon } from '../icons/Icon';
import { GroupPicker } from './GroupPicker';

export interface EntryFormProps {
  mode: 'add' | 'edit';
  initial?: TwoFaEntry;
  defaultGroupId: string | null;
  groups: TwoFaGroup[];
  tags: TwoFaTag[];
  onCreateTag: (name: string, color: TwoFaTagColor) => Promise<TwoFaTag>;
  onSubmit: (values: TwoFaCreateEntryInput) => Promise<void>;
  onCancel: () => void;
}

export function EntryForm({
  mode,
  initial,
  defaultGroupId,
  groups,
  tags,
  onCreateTag,
  onSubmit,
  onCancel,
}: EntryFormProps) {
  const [issuer, setIssuer] = useState(initial?.issuer ?? '');
  const [account, setAccount] = useState(initial?.account ?? '');
  const [secret, setSecret] = useState(initial?.secret ?? '');
  const [groupId, setGroupId] = useState<string | null>(initial ? initial.groupId : defaultGroupId);
  const [selectedTags, setSelectedTags] = useState<string[]>(initial?.tags ?? []);
  const [algorithm, setAlgorithm] = useState<Algorithm>(initial?.algorithm ?? 'SHA1');
  const [digits, setDigits] = useState<6 | 8>(initial?.digits ?? 6);
  const [period, setPeriod] = useState<number>(initial?.period ?? 30);
  const [note, setNote] = useState(initial?.note ?? '');
  const [showAdvanced, setShowAdvanced] = useState(
    !!initial && (initial.algorithm !== 'SHA1' || initial.digits !== 6 || initial.period !== 30),
  );
  const [showNewTag, setShowNewTag] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState<TwoFaTagColor>('blue');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const issuerRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setTimeout(() => issuerRef.current?.focus(), 30);
  }, []);

  const handleSecretChange = (raw: string) => {
    if (raw.trim().toLowerCase().startsWith('otpauth://')) {
      try {
        const parsed = parseOtpAuthUri(raw.trim());
        if (parsed.issuer) setIssuer(parsed.issuer);
        if (parsed.account) setAccount(parsed.account);
        setSecret(parsed.secret);
        setAlgorithm(parsed.algorithm);
        setDigits(parsed.digits);
        setPeriod(parsed.period);
        if (parsed.algorithm !== 'SHA1' || parsed.digits !== 6 || parsed.period !== 30) {
          setShowAdvanced(true);
        }
        setError(null);
        return;
      } catch (e) {
        setError(e instanceof Error ? e.message : 'otpauth 链接解析失败');
      }
    }
    setSecret(raw);
  };

  const toggleTag = (id: string) => {
    setSelectedTags((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const handleCreateTag = async () => {
    const t = newTagName.trim();
    if (!t || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await onCreateTag(t, newTagColor);
      setSelectedTags((prev) => [...prev, created.id]);
      setNewTagName('');
      setShowNewTag(false);
    } catch (ex) {
      setError(ex instanceof Error ? ex.message : '创建标签失败');
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmedIssuer = issuer.trim();
    const trimmedAccount = account.trim();
    if (!trimmedIssuer && !trimmedAccount) {
      setError('请至少填写网站名或账号');
      return;
    }
    let cleanSecret: string;
    try {
      cleanSecret = normalizeSecret(secret);
      decodeBase32(cleanSecret);
    } catch (ex) {
      setError(ex instanceof Error ? ex.message : '密钥格式无效');
      return;
    }
    const p = Math.floor(Number(period));
    if (!Number.isFinite(p) || p < 5 || p > 300) {
      setError('周期需在 5～300 秒之间');
      return;
    }
    setBusy(true);
    try {
      await onSubmit({
        issuer: trimmedIssuer || trimmedAccount,
        account: trimmedAccount,
        secret: cleanSecret,
        algorithm,
        digits,
        period: p,
        groupId,
        tags: selectedTags,
        note: note.trim() || undefined,
      });
    } catch (ex) {
      setError(ex instanceof Error ? ex.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="cz-2fa-form" onSubmit={handleSubmit}>
      <div className="cz-2fa-form__head">
        <button type="button" className="cz-2fa-ib" onClick={onCancel} aria-label="返回">
          <Icon name="arrow-left" size={15} />
        </button>
        <span className="cz-2fa-form__title">{mode === 'add' ? '添加验证码' : '编辑验证码'}</span>
      </div>

      <div className="cz-2fa-form__scroll">
        <div className="cz-2fa-fgroup">
          <label className="cz-2fa-field">
            <span className="cz-2fa-label">网站 / 服务名</span>
            <input
              ref={issuerRef}
              className="cz-2fa-input"
              value={issuer}
              onChange={(e) => setIssuer(e.target.value)}
              placeholder="例如：GitHub、AWS"
            />
          </label>

          <label className="cz-2fa-field">
            <span className="cz-2fa-label">账号</span>
            <input
              className="cz-2fa-input"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              placeholder="例如：dev@example.com"
            />
          </label>

          <label className="cz-2fa-field">
            <span className="cz-2fa-label">密钥</span>
            <input
              className="cz-2fa-input is-mono"
              value={secret}
              onChange={(e) => handleSecretChange(e.target.value)}
              placeholder="JBSWY3DPEHPK3PXP"
              autoComplete="off"
              spellCheck={false}
            />
            <span className="cz-2fa-hint">Base32 密钥，也可以直接粘贴 otpauth:// 链接自动填充</span>
          </label>
        </div>

        <div className="cz-2fa-fgroup">
          <div className="cz-2fa-field">
            <span className="cz-2fa-label">分组</span>
            <GroupPicker groups={groups} value={groupId} onChange={setGroupId} aria-label="选择分组" />
          </div>

          <div className="cz-2fa-field">
          <span className="cz-2fa-label">标签</span>
          <div className="cz-2fa-tag-checks">
            {tags.map((t) => {
              const on = selectedTags.includes(t.id);
              const c = normalizeTagColor(t.color);
              return (
                <button
                  key={t.id}
                  type="button"
                  className={`cz-2fa-chip is-c-${c}${on ? ' is-on' : ''}`}
                  aria-pressed={on}
                  onClick={() => toggleTag(t.id)}
                >
                  <span className="cz-2fa-chip__dot" />
                  <span>{t.name}</span>
                  {on && <Icon name="check" size={11} />}
                </button>
              );
            })}
            <button
              type="button"
              className="cz-2fa-chip is-add"
              onClick={() => setShowNewTag((v) => !v)}
            >
              <Icon name="plus" size={11} />
              <span>新建</span>
            </button>
          </div>
          {showNewTag && (
            <div className="cz-2fa-newtag-box">
              <div className="cz-2fa-inline-tag">
                <input
                  className="cz-2fa-input"
                  value={newTagName}
                  onChange={(e) => setNewTagName(e.target.value)}
                  placeholder="标签名…"
                  maxLength={24}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void handleCreateTag();
                    }
                  }}
                />
                <button
                  type="button"
                  className="cz-2fa-btn is-sm is-primary"
                  disabled={busy || !newTagName.trim()}
                  onClick={() => void handleCreateTag()}
                >
                  创建
                </button>
              </div>
              <div className="cz-2fa-palette is-compact">
                {TWOFA_TAG_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`cz-2fa-swatch is-c-${c}${newTagColor === c ? ' is-selected' : ''}`}
                    onClick={() => setNewTagColor(c)}
                    aria-label={c}
                  />
                ))}
              </div>
            </div>
          )}
          </div>

          <label className="cz-2fa-field">
            <span className="cz-2fa-label">备注 <em>可选</em></span>
            <input
              className="cz-2fa-input"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="例如：生产环境管理员"
              maxLength={120}
            />
          </label>
        </div>

        <div className="cz-2fa-adv">
          <button
            type="button"
            className="cz-2fa-adv__toggle"
            aria-expanded={showAdvanced}
            onClick={() => setShowAdvanced((v) => !v)}
          >
            <Icon name="chevron-right" size={13} className="cz-2fa-adv__chev" />
            <span>高级参数</span>
            <span className="cz-2fa-adv__sum">{algorithm} · {digits} 位 · {period}s</span>
          </button>
          {/* 始终渲染，用 grid 行高 0fr → 1fr 做展开收起，关闭时 inert 防止 Tab 进入 */}
          <div className={`cz-2fa-adv__wrap${showAdvanced ? ' is-open' : ''}`}>
            <div className="cz-2fa-adv__clip" {...(showAdvanced ? {} : { inert: true as unknown as undefined })}>
              <div className="cz-2fa-adv__grid">
                <label className="cz-2fa-field">
                  <span className="cz-2fa-label">算法</span>
                  <select
                    className="cz-2fa-input"
                    value={algorithm}
                    onChange={(e) => setAlgorithm(e.target.value as Algorithm)}
                  >
                    <option value="SHA1">SHA1</option>
                    <option value="SHA256">SHA256</option>
                    <option value="SHA512">SHA512</option>
                  </select>
                </label>
                <label className="cz-2fa-field">
                  <span className="cz-2fa-label">位数</span>
                  <select
                    className="cz-2fa-input"
                    value={digits}
                    onChange={(e) => setDigits(Number(e.target.value) === 8 ? 8 : 6)}
                  >
                    <option value={6}>6 位</option>
                    <option value={8}>8 位</option>
                  </select>
                </label>
                <label className="cz-2fa-field">
                  <span className="cz-2fa-label">周期（秒）</span>
                  <input
                    type="number"
                    min={5}
                    max={300}
                    className="cz-2fa-input"
                    value={period}
                    onChange={(e) => setPeriod(Number(e.target.value) || 30)}
                  />
                </label>
              </div>
            </div>
          </div>
        </div>

        {error && <div className="cz-2fa-err">{error}</div>}
      </div>

      <div className="cz-2fa-form__foot">
        <button type="button" className="cz-2fa-btn" onClick={onCancel}>取消</button>
        <button type="submit" className="cz-2fa-btn is-primary" disabled={busy}>
          {busy ? '保存中…' : mode === 'add' ? '添加' : '保存修改'}
        </button>
      </div>
    </form>
  );
}
