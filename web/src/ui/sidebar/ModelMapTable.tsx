// API 账号的模型映射表：四个别名（Sonnet / Opus / Fable / Haiku）+ 子代理 + 默认兜底 + 自由添加的条目。
// 别名靠 CLI 原生的 ANTHROPIC_DEFAULT_<别名>_MODEL 重映射，所以菜单发出去的还是别名本身；
// 自由添加的条目直接作为 --model 的值。空映射 = 不介入（订阅账号与没配映射的 API 账号行为不变）。
import { useState } from 'react';
import { type ApiModelMap, type ApiModelTarget, MODEL_ALIASES, type ModelAlias, PRIMARY_MODELS } from '@cosyee/shared';
import { ModelPicker } from './ModelPicker';

/** 别名行的标题与标准显示名 */
const ALIAS_ROWS: { alias: ModelAlias; label: string }[] = MODEL_ALIASES.map((a) => ({
  alias: a,
  label: PRIMARY_MODELS.find((m) => m.id === a)?.label ?? a,
}));

export interface ModelMapTableProps {
  value: ApiModelMap;
  onChange: (m: ApiModelMap) => void;
  /** 拉取到的模型列表 */
  options: string[];
  /** 「获取模型列表」按钮 */
  onFetch: () => void;
  fetching: boolean;
  /** 拉取结果提示（成功条数或失败原因） */
  hint: string | null;
  /** hint 是失败原因（红字） */
  hintError?: boolean;
}

/** 猜别名对应的实际模型：先按别名字样匹配，再按常见第三方模型的定位退让 */
function guess(alias: ModelAlias, options: string[]): string | undefined {
  const byName = options.find((o) => o.toLowerCase().includes(alias));
  if (byName) return byName;
  // 第三方服务通常没有同名模型：Opus / Fable 给最强的，Haiku 给最小的，Sonnet 取居中的
  const rank = ['opus', 'fable', 'sonnet', 'haiku'];
  if (!options.length) return undefined;
  if (alias === 'haiku') return options.find((o) => /mini|flash|lite|small|haiku|air/i.test(o)) ?? options.at(-1);
  if (alias === 'sonnet') return options[0];
  return options[Math.min(rank.indexOf(alias), options.length - 1)] ?? options[0];
}

export function ModelMapTable({ value, onChange, options, onFetch, fetching, hint, hintError }: ModelMapTableProps) {
  const [extraDraft, setExtraDraft] = useState('');

  const setAlias = (alias: ModelAlias, patch: Partial<ApiModelTarget>) => {
    const cur = value.alias?.[alias] ?? { id: '' };
    const next: ApiModelTarget = { ...cur, ...patch };
    const alias2 = { ...value.alias };
    // 先填显示名称、后填模型时名称要留着；没有模型的条目服务端保存时会丢掉
    if (!next.id.trim() && !next.label) delete alias2[alias];
    else alias2[alias] = next;
    onChange({ ...value, alias: Object.keys(alias2).length ? alias2 : undefined });
  };

  const autoFill = () => {
    if (!options.length) return;
    const alias = { ...value.alias };
    for (const { alias: a } of ALIAS_ROWS) {
      if (alias[a]?.id) continue;
      const id = guess(a, options);
      if (id) alias[a] = { ...(alias[a] ?? {}), id };
    }
    onChange({ ...value, alias: Object.keys(alias).length ? alias : undefined });
  };

  const addExtra = () => {
    const id = extraDraft.trim();
    if (!id) return;
    const extra = value.extra ?? [];
    if (extra.some((e) => e.id === id)) { setExtraDraft(''); return; }
    onChange({ ...value, extra: [...extra, { id }] });
    setExtraDraft('');
  };

  const setExtra = (i: number, patch: Partial<ApiModelTarget>) => {
    const extra = [...(value.extra ?? [])];
    const cur = extra[i];
    if (!cur) return;
    extra[i] = { ...cur, ...patch };
    onChange({ ...value, extra });
  };

  const removeExtra = (i: number) => {
    const extra = (value.extra ?? []).filter((_, k) => k !== i);
    onChange({ ...value, extra: extra.length ? extra : undefined });
  };


  // 布局：一张五列表格「角色 | 显示名称 | 实际请求模型 | 1M | 删除」，别名行、子代理 / 兜底行、自定义行共用列宽，上下对齐。
  // 窄（容器 < 560px，手机）时每行变成一个小块：角色 + 1M 一行，下面两个输入框各带可见的小标题（data-label）。
  return (
    <section className="cz-mmap" aria-label="模型映射">
      <div className="cz-mmap__head">
        <div className="cz-mmap__intro">
          <span className="cz-mmap__title">模型映射</span>
          <span className="cz-mmap__desc">
            把 Claude Code 的模型别名指向这个服务商的实际模型。留空的别名不重映射，也不出现在模型菜单里；全部留空 = 不介入。
          </span>
        </div>
        <div className="cz-mmap__actions">
          <button type="button" className="cz-acct-dlg__btn cz-mmap__btn" disabled={fetching} onClick={onFetch}>
            {fetching ? '正在获取…' : '获取模型列表'}
          </button>
          <button
            type="button"
            className="cz-acct-dlg__btn cz-mmap__btn"
            disabled={!options.length}
            title={options.length ? '给还空着的别名按名称自动挑选模型（已填的不动）' : '先点「获取模型列表」'}
            onClick={autoFill}
          >
            一键设置
          </button>
        </div>
      </div>
      {hint && (
        <p className={`cz-acct-dlg__text cz-mmap__hint ${hintError ? 'cz-acct-dlg__text--error' : 'cz-acct-dlg__text--muted'}`} role="status">
          {hint}
        </p>
      )}

      <div className="cz-mmap__grid">
        <div className="cz-mmap__row cz-mmap__row--th" aria-hidden="true">
          <span className="cz-mmap__th">模型角色</span>
          <span className="cz-mmap__th">显示名称</span>
          <span className="cz-mmap__th">实际请求模型</span>
          <span className="cz-mmap__th cz-mmap__th--1m" title="声明该模型支持 100 万 token 上下文">1M</span>
          <span />
        </div>

        {ALIAS_ROWS.map(({ alias, label }) => {
          const t = value.alias?.[alias];
          return (
            <div key={alias} className="cz-mmap__row" role="group" aria-label={label}>
              <span className="cz-mmap__role">{label}</span>
              <div className="cz-mmap__cell cz-mmap__cell--name" data-label="显示名称">
                <input
                  className="cz-acct-dlg__input cz-mmap__input"
                  value={t?.label ?? ''}
                  maxLength={40}
                  placeholder={label}
                  aria-label={`${label} 显示名称`}
                  onChange={(e) => setAlias(alias, { label: e.target.value })}
                />
              </div>
              <div className="cz-mmap__cell cz-mmap__cell--target" data-label="实际请求模型">
                <ModelPicker
                  value={t?.id ?? ''}
                  options={options}
                  placeholder="留空 = 不重映射"
                  ariaLabel={`${label} 实际请求模型`}
                  onChange={(v) => setAlias(alias, { id: v })}
                />
              </div>
              <label className="cz-mmap__1m" title={t?.id ? '声明支持 100 万上下文' : '先填实际请求模型'}>
                <input
                  type="checkbox"
                  checked={!!t?.id && !!t.m1}
                  disabled={!t?.id}
                  aria-label={`${label} 支持 1M 上下文`}
                  onChange={(e) => setAlias(alias, { m1: e.target.checked })}
                />
                <span className="cz-mmap__1m-text" aria-hidden="true">1M 上下文</span>
              </label>
              <span className="cz-mmap__gap" />
            </div>
          );
        })}

        <div className="cz-mmap__row cz-mmap__row--sep" role="group" aria-label="子代理">
          <span className="cz-mmap__role">子代理</span>
          <span className="cz-mmap__muted">不显示在模型菜单</span>
          <div className="cz-mmap__cell cz-mmap__cell--target" data-label="实际请求模型">
            <ModelPicker
              value={value.subagent ?? ''}
              options={options}
              placeholder="留空 = 跟随会话模型"
              ariaLabel="子代理实际请求模型"
              onChange={(v) => onChange({ ...value, subagent: v.trim() || undefined })}
            />
          </div>
          <span className="cz-mmap__gap" />
          <span className="cz-mmap__gap" />
        </div>

        <div className="cz-mmap__row" role="group" aria-label="默认兜底">
          <span className="cz-mmap__role">默认兜底</span>
          <span className="cz-mmap__muted" title="映射表以外的模型名落到这里">映射表以外的模型名落到这里</span>
          <div className="cz-mmap__cell cz-mmap__cell--target" data-label="实际请求模型">
            <ModelPicker
              value={value.fallback ?? ''}
              options={options}
              placeholder="留空 = 原样发给服务商"
              ariaLabel="默认兜底模型"
              onChange={(v) => onChange({ ...value, fallback: v.trim() || undefined })}
            />
          </div>
          <span className="cz-mmap__gap" />
          <span className="cz-mmap__gap" />
        </div>
      </div>

      <div className="cz-mmap__extra">
        <div className="cz-mmap__sub">
          <span className="cz-mmap__subtitle">自定义模型</span>
          <span className="cz-mmap__desc">直接出现在模型菜单里，选中时原样作为模型名发出</span>
        </div>
        {(value.extra ?? []).map((e, i) => (
          // 用下标当 key：id 正在被编辑，拿它当 key 会每敲一个字就重挂、丢焦点
          <div key={i} className="cz-mmap__row cz-mmap__row--extra" role="group" aria-label={e.id}>
            <div className="cz-mmap__cell cz-mmap__cell--name" data-label="显示名称">
              <input
                className="cz-acct-dlg__input cz-mmap__input"
                value={e.label ?? ''}
                maxLength={40}
                placeholder={e.id}
                aria-label={`${e.id} 显示名称`}
                onChange={(ev) => setExtra(i, { label: ev.target.value })}
              />
            </div>
            <div className="cz-mmap__cell cz-mmap__cell--target" data-label="实际请求模型">
              <ModelPicker
                value={e.id}
                options={options}
                ariaLabel={`${e.id} 实际请求模型`}
                onChange={(v) => setExtra(i, { id: v })}
              />
            </div>
            <label className="cz-mmap__1m" title="声明支持 100 万上下文">
              <input
                type="checkbox"
                checked={!!e.m1}
                aria-label={`${e.id} 支持 1M 上下文`}
                onChange={(ev) => setExtra(i, { m1: ev.target.checked })}
              />
              <span className="cz-mmap__1m-text" aria-hidden="true">1M 上下文</span>
            </label>
            <button type="button" className="cz-mmap__del" title="移除" aria-label={`移除 ${e.id}`} onClick={() => removeExtra(i)}>×</button>
          </div>
        ))}
        <div className="cz-mmap__row cz-mmap__row--add">
          <div className="cz-mmap__cell cz-mmap__cell--add">
            <ModelPicker
              value={extraDraft}
              options={options}
              placeholder="添加一个模型…"
              ariaLabel="要添加的模型"
              onChange={setExtraDraft}
              onEnter={addExtra}
            />
          </div>
          <button type="button" className="cz-acct-dlg__btn cz-mmap__btn cz-mmap__add" disabled={!extraDraft.trim()} onClick={addExtra}>
            添加
          </button>
        </div>
      </div>
    </section>
  );
}
