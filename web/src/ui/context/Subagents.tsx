// 上下文栏最底部的「子代理」：三种类型互斥（原生 / Claude / Antigravity），选中后展开说明卡片与该类型的模型 / 思考强度。
// 全局设置（GET / POST /api/subagents），改动对运行中的会话立即生效。
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  EFFORTS, SUBAGENT_KINDS, clampEffort, effortsFor, menuModelLabel, menuModels,
  type ApiModelMap, type CliModel, type DelegateModelList, type Effort, type ModelAlias,
  type SubagentConfig, type SubagentKind, type SubagentState,
} from '@cosyee/shared';
import { Icon, type IconName } from '../icons/Icon';
import { Menu, type MenuEntry } from '../menus/Menu';
import { LiquidCapsule } from '../motion/LiquidCapsule';
import { reducedMotion } from '../motion/reduced';
import { Fold } from './Fold';

export interface SubagentsProps {
  state: SubagentState;
  onChange: (c: SubagentConfig) => void;
  /** 当前账号的 Claude 模型列表 / 映射表（与模型菜单同源） */
  modelList?: readonly CliModel[] | null;
  modelMap?: ApiModelMap | null;
  /** agy 报告的模型；null = 还没拉到 */
  delegate: DelegateModelList | null;
  /** 拉取失败的原因（未安装 / 未登录） */
  delegateError?: string | null;
  delegateLoading?: boolean;
  /** 打开 agy 菜单时按需拉取；refresh = 强制重新拉 */
  onLoadDelegate: (refresh: boolean) => void;
  /** 各类型子代理当前使用的账号名（只读展示）；拿不到时不传或对应项为 null */
  accounts?: { claude?: string | null; agy?: string | null };
  /** 初始展开状态（调试页使用） */
  defaultOpen?: boolean;
}

interface KindMeta {
  label: string;
  icon: IconName;
  desc: string;
  agentToolOn: boolean;
  delegateToolOn: boolean;
}

const KIND_META: Record<SubagentKind, KindMeta> = {
  native: {
    label: '原生',
    icon: 'subagent-native',
    desc: '使用 Claude 自带的 Agent 工具派发子代理。',
    agentToolOn: true,
    delegateToolOn: false,
  },
  claude: {
    label: 'Claude',
    icon: 'subagent-claude',
    desc: '通过自定义委派工具调用 Claude CLI（独立执行环境）。',
    agentToolOn: false,
    delegateToolOn: true,
  },
  agy: {
    label: 'Antigravity',
    icon: 'subagent-agy',
    desc: '通过自定义委派工具调用 Antigravity（agy）。',
    agentToolOn: false,
    delegateToolOn: true,
  },
};

const effortLabel = (e: Effort) => EFFORTS.find((x) => x.id === e)?.label ?? e;

/** 换模型后强度落到支持的档位；模型不分强度就回到默认；不知道支持哪些时保留 */
function fit(effort: Effort | null, efforts: Effort[] | null | undefined): Effort | null {
  if (!effort || efforts === undefined) return effort;
  if (!efforts || !efforts.length) return null;
  return clampEffort(effort, efforts);
}

export function Subagents({
  state, onChange, modelList, modelMap, delegate, delegateError, delegateLoading, onLoadDelegate, accounts, defaultOpen = false,
}: SubagentsProps) {
  const [open, setOpen] = useState(defaultOpen);
  const { config, available, effective } = state;
  const fallback = effective !== config.kind;

  // 记录切换方向（-1 向左、+1 向右、0 首次渲染）与高度平滑过渡
  const prevKind = useRef<SubagentKind>(config.kind);
  const dirRef = useRef<number>(0);
  if (prevKind.current !== config.kind) {
    dirRef.current = SUBAGENT_KINDS.indexOf(config.kind) > SUBAGENT_KINDS.indexOf(prevKind.current) ? 1 : -1;
    prevKind.current = config.kind;
  }
  const panelRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const lastHeight = useRef<number | null>(null);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const stage = stageRef.current;
    if (!open || !panel || !stage) {
      lastHeight.current = null;
      return;
    }
    const toH = stage.scrollHeight;
    const fromH = lastHeight.current;
    lastHeight.current = toH;
    if (fromH === null || Math.abs(toH - fromH) < 1 || reducedMotion()) {
      panel.style.height = '';
      panel.style.overflow = '';
      return;
    }
    panel.style.height = `${fromH}px`;
    panel.style.overflow = 'hidden';
    // 强制同步起始高度，随后过渡到目标高度
    void panel.offsetHeight;
    panel.style.height = `${toH}px`;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      panel.style.height = '';
      panel.style.overflow = '';
      lastHeight.current = stage.scrollHeight;
    };
    const onEnd = (e: TransitionEvent) => {
      if (e.target === panel && e.propertyName === 'height') finish();
    };
    panel.addEventListener('transitionend', onEnd);
    const timer = window.setTimeout(finish, 240);
    return () => {
      panel.removeEventListener('transitionend', onEnd);
      window.clearTimeout(timer);
      // 中途被打断时，记录此刻真实视觉高度作为下一次起点
      const curH = panel.getBoundingClientRect().height;
      if (curH > 0) lastHeight.current = curH;
    };
  }, [config.kind, open, fallback]);

  // 每次展开且同类型内容尺寸改变（如 agy 模型加载完）时同步最新高度基准
  useEffect(() => {
    if (open && stageRef.current) lastHeight.current = stageRef.current.scrollHeight;
  });

  const btnRefs = useRef<Partial<Record<SubagentKind, HTMLButtonElement | null>>>({});

  const setKind = (kind: SubagentKind) => {
    if (kind === config.kind || !available[kind]?.ok) return;
    onChange({ ...config, kind });
  };
  const setNative = (p: Partial<SubagentConfig['native']>) => onChange({ ...config, native: { ...config.native, ...p } });
  const setClaude = (p: Partial<SubagentConfig['claude']>) => onChange({ ...config, claude: { ...config.claude, ...p } });
  const setAgy = (p: Partial<SubagentConfig['agy']>) => onChange({ ...config, agy: { ...config.agy, ...p } });

  // 原生：只有别名可选（Agent 工具的 model 参数是枚举）
  const primaryModels = menuModels(modelList, modelMap).primary;
  const nativeLevels = effortsFor(config.native.model, modelList);
  const nativeModels: MenuEntry[] = primaryModels.map((m) => ({
    key: `nm:${m.id}`,
    label: m.label,
    note: m.note,
    checked: config.native.model === m.id,
    onSelect: () => setNative({ model: m.id as ModelAlias, effort: clampEffort(config.native.effort, effortsFor(m.id, modelList)) }),
  }));
  const nativeEfforts: MenuEntry[] = EFFORTS.filter((e) => nativeLevels?.includes(e.id)).map((e) => ({
    key: `ne:${e.id}`,
    label: e.label,
    checked: config.native.effort === e.id,
    onSelect: () => setNative({ effort: e.id }),
  }));

  // Claude 委派：别名 + 「跟随主会话」(= null)
  const claudeLevels = config.claude.model ? effortsFor(config.claude.model, modelList) : EFFORTS.map((e) => e.id);
  const claudeModels: MenuEntry[] = [
    {
      key: 'cm:follow',
      label: '跟随主会话',
      note: '使用主会话当前的模型',
      checked: config.claude.model === null,
      onSelect: () => setClaude({ model: null }),
    },
    ...primaryModels.map((m): MenuEntry => ({
      key: `cm:${m.id}`,
      label: m.label,
      note: m.note,
      checked: config.claude.model === m.id,
      onSelect: () => {
        const nextLevels = effortsFor(m.id, modelList);
        setClaude({ model: m.id as ModelAlias, effort: fit(config.claude.effort, nextLevels) });
      },
    })),
  ];
  const claudeEfforts: MenuEntry[] = [
    {
      key: 'ce:follow',
      label: '跟随主会话',
      note: '使用主会话当前的思考强度',
      checked: config.claude.effort === null,
      onSelect: () => setClaude({ effort: null }),
    },
    ...EFFORTS.filter((e) => claudeLevels?.includes(e.id)).map((e): MenuEntry => ({
      key: `ce:${e.id}`,
      label: e.label,
      checked: config.claude.effort === e.id,
      onSelect: () => setClaude({ effort: e.id }),
    })),
  ];

  // Antigravity 委派：按需拉取模型列表
  const agyList = delegate?.models ?? [];
  const cur = delegate?.current ?? null;
  const nameOf = (v: string) => agyList.find((m) => m.value === v)?.displayName ?? v;
  const effortsOf = (v: string | undefined) => agyList.find((m) => m.value === v)?.efforts;
  const agyEffortsList = effortsOf(config.agy.model ?? cur?.model);
  const agyStatus: MenuEntry[] = [];
  if (delegateError) agyStatus.push({ kind: 'text', key: 'err', text: `读取模型列表失败：${delegateError}` });
  else if (!delegate) agyStatus.push({ kind: 'text', key: 'load', text: '正在读取模型列表…' });
  const agyModels: MenuEntry[] = [
    {
      key: 'default',
      label: '默认',
      note: cur ? `跟随后端默认：${nameOf(cur.model)}` : '跟随后端自己的设置',
      checked: config.agy.model === null,
      onSelect: () => setAgy({ model: null, effort: fit(config.agy.effort, effortsOf(cur?.model)) }),
    },
    ...agyList.map((m): MenuEntry => ({
      key: `m:${m.value}`,
      label: m.displayName,
      checked: config.agy.model === m.value,
      onSelect: () => setAgy({ model: m.value, effort: fit(config.agy.effort, m.efforts) }),
    })),
  ];
  if (config.agy.model && delegate && !effortsOf(config.agy.model)) {
    agyModels.push({ key: 'gone', label: config.agy.model, note: '不在当前模型列表里', checked: true, disabled: true });
  }
  agyModels.push(
    ...agyStatus,
    { kind: 'sep', key: 'sep' },
    {
      key: 'refresh',
      label: delegateLoading ? '正在刷新模型列表…' : '刷新模型列表',
      disabled: delegateLoading,
      keepOpen: true,
      onSelect: () => onLoadDelegate(true),
    },
  );
  const agyEfforts: MenuEntry[] = [
    {
      key: 'default',
      label: '默认',
      note: config.agy.model === null && cur?.effort ? `跟随后端默认：${effortLabel(cur.effort)}` : undefined,
      checked: config.agy.effort === null,
      onSelect: () => setAgy({ effort: null }),
    },
    ...(agyEffortsList ?? []).map((e): MenuEntry => ({
      key: `e:${e}`,
      label: effortLabel(e),
      checked: config.agy.effort === e,
      onSelect: () => setAgy({ effort: e }),
    })),
  ];
  if (agyEffortsList && !agyEffortsList.length) agyEfforts.push({ kind: 'text', key: 'none', text: '该模型不分思考强度' });
  agyEfforts.push(...agyStatus);
  const loadAgy = () => {
    if (!delegate && !delegateLoading) onLoadDelegate(false);
  };

  // 收起时标题右侧的摘要：类型 · 模型
  const nativeLabel = menuModelLabel(config.native.model, modelList, modelMap);
  const claudeLabel = config.claude.model ? menuModelLabel(config.claude.model, modelList, modelMap) : '跟随主会话';
  const agyLabel = config.agy.model ? nameOf(config.agy.model) : '默认';
  const modelOfKind: Record<SubagentKind, string> = { native: nativeLabel, claude: claudeLabel, agy: agyLabel };
  const extra = fallback
    ? `已退回原生 · ${nativeLabel}`
    : `${KIND_META[effective].label} · ${modelOfKind[effective]}`;

  // 键盘 roving tabindex：若当前配置项已不可用，焦点落到实际生效项或首个可用项
  const enabledKinds = SUBAGENT_KINDS.filter((k) => available[k]?.ok);
  const focusKind = available[config.kind]?.ok ? config.kind : (available[effective]?.ok ? effective : enabledKinds[0] ?? 'native');

  const onRadioKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!enabledKinds.length) return;
    let next: SubagentKind | undefined;
    const curIdx = enabledKinds.indexOf(config.kind);
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      next = enabledKinds[(curIdx + 1 + enabledKinds.length) % enabledKinds.length];
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      next = enabledKinds[(curIdx - 1 + enabledKinds.length) % enabledKinds.length];
    } else if (e.key === 'Home') {
      next = enabledKinds[0];
    } else if (e.key === 'End') {
      next = enabledKinds[enabledKinds.length - 1];
    }
    if (!next) return;
    e.preventDefault();
    setKind(next);
    btnRefs.current[next]?.focus();
  };

  // 其他不可用项的原因说明（已被退回横幅说明的不重复列）
  const unavailNotes = SUBAGENT_KINDS.filter((k) => !available[k]?.ok && !(fallback && k === config.kind));
  const meta = KIND_META[config.kind];
  const effMeta = KIND_META[effective];
  const fallbackReason = available[config.kind]?.reason;
  const accountLabel =
    config.kind === 'native'
      ? '跟随主代理账号'
      : config.kind === 'claude'
        ? (accounts?.claude || null)
        : (accounts?.agy || null);

  return (
    <Fold
      title="子代理"
      className="cz-ctx__agents"
      extra={extra}
      open={open}
      onToggle={() => setOpen((v) => !v)}
    >
      <div className="cz-sub">
        <div
          className={`cz-sub__seg${fallback ? ' is-fallback' : ''}`}
          role="radiogroup"
          aria-label="子代理类型"
          onKeyDown={onRadioKeyDown}
        >
          <LiquidCapsule activeKey={config.kind} selector=".cz-sub__opt.is-active" axis="x" />
          {SUBAGENT_KINDS.map((k) => {
            const avail = available[k] ?? { ok: false };
            const active = config.kind === k;
            const m = KIND_META[k];
            return (
              <button
                key={k}
                ref={(el) => { btnRefs.current[k] = el; }}
                type="button"
                role="radio"
                aria-checked={active}
                tabIndex={k === focusKind ? 0 : -1}
                disabled={!avail.ok}
                className={`cz-sub__opt${active ? ' is-active' : ''}`}
                title={!avail.ok ? (avail.reason || `${m.label} 不可用`) : m.desc}
                onClick={() => setKind(k)}
              >
                <Icon name={m.icon} size={15} />
                <span className="cz-sub__opt-label">{m.label}</span>
              </button>
            );
          })}
        </div>

        {fallback && (
          <div className="cz-sub__banner" role="status">
            <Icon name="info" size={14} />
            <span className="cz-sub__banner-text">
              <strong>已退回原生</strong>
              <span>
                {' · '}
                {KIND_META[config.kind].label} 不可用
                {fallbackReason ? `（${fallbackReason}）` : ''}
              </span>
            </span>
          </div>
        )}

        {unavailNotes.length > 0 && (
          <div className="cz-sub__unavail">
            {unavailNotes.map((k) => (
              <div key={k} className="cz-sub__unavail-item">
                {KIND_META[k].label} 不可用：{available[k]?.reason || '当前环境不可用'}
              </div>
            ))}
          </div>
        )}

        <div ref={panelRef} className="cz-sub__panel">
          <div
            key={config.kind}
            ref={stageRef}
            className="cz-sub__stage"
            style={{ '--sub-dir': dirRef.current } as React.CSSProperties}
          >
            <div className={`cz-sub__card${fallback ? ' is-dim' : ''}`}>
              <p className="cz-sub__desc">{meta.desc}</p>
              <div className="cz-sub__tools" aria-label="工具状态">
                {/* 工具开关按实际生效的类型显示：退回原生时这里要和提示条一致 */}
                <span className={`cz-sub__pill${effMeta.agentToolOn ? ' is-on' : ' is-off'}`}>
                  <span className="cz-sub__dot" aria-hidden="true" />
                  Agent 工具 {effMeta.agentToolOn ? '开' : '关'}
                </span>
                <span className={`cz-sub__pill${effMeta.delegateToolOn ? ' is-on' : ' is-off'}`}>
                  <span className="cz-sub__dot" aria-hidden="true" />
                  委派工具 {effMeta.delegateToolOn ? '开' : '关'}
                </span>
              </div>

              {accountLabel && (
                <div className="cz-sub__acct">
                  <span className="cz-sub__acct-k">账号：</span>
                  <span className="cz-sub__acct-v" title={accountLabel}>{accountLabel}</span>
                </div>
              )}

              <div className="cz-sub__fields">
                {config.kind === 'native' && (
                  <>
                    <div className={`cz-sub__field${nativeLevels ? '' : ' is-full'}`}>
                      <span className="cz-sub__field-label">模型</span>
                      <Pick name="原生子代理模型" label={nativeLabel} items={nativeModels} />
                    </div>
                    {nativeLevels && (
                      <div className="cz-sub__field">
                        <span className="cz-sub__field-label">思考强度</span>
                        <Pick name="原生子代理思考强度" label={effortLabel(config.native.effort)} items={nativeEfforts} effort />
                      </div>
                    )}
                  </>
                )}

                {config.kind === 'claude' && (
                  <>
                    <div className={`cz-sub__field${claudeLevels ? '' : ' is-full'}`}>
                      <span className="cz-sub__field-label">模型</span>
                      <Pick name="Claude 委派模型" label={claudeLabel} items={claudeModels} />
                    </div>
                    {claudeLevels && (
                      <div className="cz-sub__field">
                        <span className="cz-sub__field-label">思考强度</span>
                        <Pick name="Claude 委派思考强度" label={config.claude.effort ? effortLabel(config.claude.effort) : '跟随主会话'} items={claudeEfforts} effort />
                      </div>
                    )}
                  </>
                )}

                {config.kind === 'agy' && (
                  <>
                    <div className="cz-sub__field">
                      <span className="cz-sub__field-label">模型</span>
                      <Pick name="Antigravity 模型" label={agyLabel} items={agyModels} onOpen={loadAgy} />
                    </div>
                    <div className="cz-sub__field">
                      <span className="cz-sub__field-label">思考强度</span>
                      <Pick name="Antigravity 思考强度" label={config.agy.effort ? effortLabel(config.agy.effort) : '默认'} items={agyEfforts} onOpen={loadAgy} effort />
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        <p className="cz-ctx__note cz-sub__foot-note">对所有会话生效；派发时点名的模型优先。</p>
      </div>
    </Fold>
  );
}

function Pick({ name, label, items, onOpen, effort }: { name: string; label: string; items: MenuEntry[]; onOpen?: () => void; effort?: boolean }) {
  const [at, setAt] = useState<HTMLElement | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`cz-ctx__mode cz-ctx__pick${effort ? ' is-effort' : ''}${at ? ' is-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={!!at}
        aria-label={`${name}：${label}`}
        title={label}
        onClick={() => {
          if (!at) onOpen?.();
          setAt(at ? null : ref.current);
        }}
      >
        <span className="cz-ctx__pick-label">{label}</span>
        <Icon name="chevron-down" size={11} />
      </button>
      {at && <Menu anchor={at} items={items} onClose={() => setAt(null)} placement="top" align="end" minWidth={180} />}
    </>
  );
}
