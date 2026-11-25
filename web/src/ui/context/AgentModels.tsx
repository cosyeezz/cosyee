// 上下文栏最底部的「子代理模型」：Claude 子代理与委派各一行，模型与思考强度两个下拉。
// 全局设置（GET / POST /api/agent-models），改动对运行中的会话立即生效。
import { useRef, useState } from 'react';
import {
  EFFORTS, clampEffort, effortsFor, menuModelLabel, menuModels,
  type AgentModelConfig, type ApiModelMap, type CliModel, type DelegateModelList, type Effort, type ModelAlias,
} from '@cosyee/shared';
import { Icon } from '../icons/Icon';
import { Menu, type MenuEntry } from '../menus/Menu';
import { Fold } from './Fold';
import { Switch } from './Switch';

export interface AgentModelsProps {
  config: AgentModelConfig;
  onChange: (c: AgentModelConfig) => void;
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
  /** 是否允许使用 Claude 原生子代理（Agent 工具）；undefined = 老服务端，不显示 */
  nativeAgents?: boolean;
  onNativeAgents?: (enabled: boolean) => void;
}

const effortLabel = (e: Effort) => EFFORTS.find((x) => x.id === e)?.label ?? e;

/** 换模型后强度落到支持的档位；模型不分强度就回到默认；不知道支持哪些时保留 */
function fit(effort: Effort | null, efforts: Effort[] | undefined): Effort | null {
  if (!effort || !efforts) return effort;
  return efforts.length ? clampEffort(effort, efforts) : null;
}

export function AgentModels({
  config, onChange, modelList, modelMap, delegate, delegateError, delegateLoading, onLoadDelegate, nativeAgents, onNativeAgents,
}: AgentModelsProps) {
  const [open, setOpen] = useState(false);
  const { claude, agy } = config;
  const setClaude = (p: Partial<AgentModelConfig['claude']>) => onChange({ ...config, claude: { ...claude, ...p } });
  const setAgy = (p: Partial<AgentModelConfig['agy']>) => onChange({ ...config, agy: { ...agy, ...p } });

  // Claude：只有别名可选（Agent 工具的 model 参数是枚举），menuModels 的常用项就是别名
  const levels = effortsFor(claude.model, modelList);
  const claudeModels: MenuEntry[] = menuModels(modelList, modelMap).primary.map((m) => ({
    key: `m:${m.id}`,
    label: m.label,
    note: m.note,
    checked: claude.model === m.id,
    onSelect: () => setClaude({ model: m.id as ModelAlias, effort: clampEffort(claude.effort, effortsFor(m.id, modelList)) }),
  }));
  const claudeEfforts: MenuEntry[] = EFFORTS.filter((e) => levels?.includes(e.id)).map((e) => ({
    key: `e:${e.id}`,
    label: e.label,
    checked: claude.effort === e.id,
    onSelect: () => setClaude({ effort: e.id }),
  }));

  // 委派
  const models = delegate?.models ?? [];
  const cur = delegate?.current ?? null;
  const nameOf = (v: string) => models.find((m) => m.value === v)?.displayName ?? v;
  const effortsOf = (v: string | undefined) => models.find((m) => m.value === v)?.efforts;
  const efforts = effortsOf(agy.model ?? cur?.model);
  const status: MenuEntry[] = [];
  if (delegateError) status.push({ kind: 'text', key: 'err', text: `读取模型列表失败：${delegateError}` });
  else if (!delegate) status.push({ kind: 'text', key: 'load', text: '正在读取模型列表…' });
  const agyModels: MenuEntry[] = [
    {
      key: 'default',
      label: '默认',
      note: cur ? `跟随后端默认：${nameOf(cur.model)}` : '跟随后端自己的设置',
      checked: agy.model === null,
      onSelect: () => setAgy({ model: null, effort: fit(agy.effort, effortsOf(cur?.model)) }),
    },
    ...models.map((m): MenuEntry => ({
      key: `m:${m.value}`,
      label: m.displayName,
      checked: agy.model === m.value,
      onSelect: () => setAgy({ model: m.value, effort: fit(agy.effort, m.efforts) }),
    })),
  ];
  // 存着的模型已经不在列表里：照样列出来，看得到当前选的是什么
  if (agy.model && delegate && !effortsOf(agy.model)) {
    agyModels.push({ key: 'gone', label: agy.model, note: '不在当前模型列表里', checked: true, disabled: true });
  }
  agyModels.push(
    ...status,
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
      note: agy.model === null && cur?.effort ? `跟随后端默认：${effortLabel(cur.effort)}` : undefined,
      checked: agy.effort === null,
      onSelect: () => setAgy({ effort: null }),
    },
    ...(efforts ?? []).map((e): MenuEntry => ({
      key: `e:${e}`,
      label: effortLabel(e),
      checked: agy.effort === e,
      onSelect: () => setAgy({ effort: e }),
    })),
  ];
  if (efforts && !efforts.length) agyEfforts.push({ kind: 'text', key: 'none', text: '该模型不分思考强度' });
  agyEfforts.push(...status);
  const loadAgy = () => {
    if (!delegate && !delegateLoading) onLoadDelegate(false);
  };

  const claudeLabel = menuModelLabel(claude.model, modelList, modelMap);
  const agyLabel = agy.model ? nameOf(agy.model) : '默认';

  return (
    <Fold
      title="子代理模型"
      className="cz-ctx__agents"
      // 收起时也看得到当前用的是什么；agy 跟随默认时不占地方
      extra={[claudeLabel, agy.model && agyLabel].filter(Boolean).join(' · ')}
      open={open}
      onToggle={() => setOpen((v) => !v)}
    >
      <p className="cz-ctx__note">对所有会话生效；派发时点名的模型优先。</p>
      <ul className="cz-ctx__list cz-ctx__list--plain">
        <li className={`cz-ctx__agent${nativeAgents === false ? ' is-dim' : ''}`}>
          <span className="cz-ctx__agent-name">Claude</span>
          <Pick name="Claude 子代理模型" label={claudeLabel} items={claudeModels} />
          {levels && <Pick name="Claude 子代理思考强度" label={effortLabel(claude.effort)} items={claudeEfforts} effort />}
        </li>
        {nativeAgents !== undefined && onNativeAgents && (
          <li className="cz-ctx__agent cz-ctx__agent--switch">
            <span className="cz-ctx__agent-name">原生子代理</span>
            <Switch
              on={nativeAgents}
              label="原生子代理"
              title={nativeAgents ? '关闭后停用 Claude 自带的 Agent 工具，改由委派完成' : '重新开启 Claude 自带的 Agent 工具'}
              onChange={() => onNativeAgents(!nativeAgents)}
            />
            <p className="cz-ctx__note cz-ctx__agent-note">关闭后停用 Claude 自带的 Agent 工具，改由委派完成；WebFetch 会自动恢复。没有可用的委派时不生效。</p>
          </li>
        )}
        <li className="cz-ctx__agent">
          <span className="cz-ctx__agent-name">委派</span>
          <Pick name="委派模型" label={agyLabel} items={agyModels} onOpen={loadAgy} />
          <Pick name="委派思考强度" label={agy.effort ? effortLabel(agy.effort) : '默认'} items={agyEfforts} onOpen={loadAgy} effort />
        </li>
      </ul>
    </Fold>
  );
}

function Pick({ name, label, items, onOpen, effort }: { name: string; label: string; items: MenuEntry[]; onOpen?: () => void; /** 思考强度：固定窄列 */ effort?: boolean }) {
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
