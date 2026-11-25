// 技能列表（供 SessionDock 使用）：展示会话中加载过的技能，点击一行在其下方展开技能正文（没有则读磁盘 SKILL.md 兜底）。
import { memo, useCallback, useEffect, useState, type ReactNode } from 'react';
import type { SkillContent, SkillLoad } from '@cosyee/shared';
import { Icon, type IconName } from '../icons/Icon';
import { skillInfo } from '../context/skillCatalog';
import { useFiles } from '../files/FileContext';
import { useFlowMeta, type SkillLoader } from './flowContext';
import { Markdown } from './Markdown';
import { PanelDetail } from './PanelDetail';

export interface SkillGroup {
  name: string;
  loads: SkillLoad[];
  /** 最近一次加载的状态 */
  status: SkillLoad['status'];
  manual: boolean;
  args: string[];
  /** 最近一次带正文的加载 */
  body?: string;
  error?: string;
}

/** 按技能名合并，保持首次加载的顺序 */
export function groupSkills(skills: readonly SkillLoad[]): SkillGroup[] {
  const map = new Map<string, SkillGroup>();
  for (const s of skills) {
    let g = map.get(s.name);
    if (!g) {
      g = { name: s.name, loads: [], status: s.status, manual: false, args: [] };
      map.set(s.name, g);
    }
    g.loads.push(s);
    g.status = s.status;
    if (s.source === 'user') g.manual = true;
    if (s.args && !g.args.includes(s.args)) g.args.push(s.args);
    if (s.body) g.body = s.body;
    g.error = s.status === 'error' ? s.error : undefined;
  }
  return [...map.values()];
}

const STATUS_ICON: Record<SkillLoad['status'], IconName> = {
  loading: 'agent-running',
  loaded: 'done',
  error: 'error',
};
const TITLE_CLASS: Record<SkillLoad['status'], string> = {
  loading: 'cz-st-tool',
  loaded: '',
  error: 'cz-st-error',
};

type Disk =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ok'; content: SkillContent }
  | { state: 'fail'; message: string };

const SkillRow = memo(function SkillRow({ group, cwd, loader }: { group: SkillGroup; cwd?: string; loader: SkillLoader }) {
  const [open, setOpen] = useState(false);
  const [disk, setDisk] = useState<Disk>({ state: 'idle' });
  const needDisk = group.status !== 'error' && !group.body;
  const toggle = useCallback(() => setOpen((v) => !v), []);
  const close = useCallback(() => setOpen(false), []);

  // 展开时才读磁盘（成功后只读一次；失败后收起再展开会重试）
  useEffect(() => {
    if (!open || !needDisk || disk.state !== 'idle') return;
    setDisk({ state: 'loading' });
    loader(group.name, cwd).then(
      (content) => setDisk({ state: 'ok', content }),
      (e: unknown) => setDisk({ state: 'fail', message: e instanceof Error ? e.message : String(e) }),
    );
  }, [open, needDisk, disk.state, loader, group.name, cwd]);
  useEffect(() => {
    if (!open && disk.state === 'fail') setDisk({ state: 'idle' });
  }, [open, disk.state]);

  const count = group.loads.length;
  const purpose = skillInfo(group.name)?.purpose ?? (disk.state === 'ok' ? disk.content.description : undefined);
  const argsText = group.args.join('、');

  let detail: ReactNode;
  if (group.status === 'error') {
    detail = <div className="cz-flow__pdetail-error">{group.error || '加载失败'}</div>;
  } else if (group.body) {
    detail = <Markdown text={group.body} className="cz-flow__md--small" />;
  } else if (disk.state === 'ok') {
    detail = (
      <>
        <div className="cz-flow__pdetail-note">来自磁盘 SKILL.md</div>
        <Markdown text={disk.content.body} className="cz-flow__md--small" />
      </>
    );
  } else if (disk.state === 'fail') {
    detail = <div className="cz-flow__pdetail-error">读取 SKILL.md 失败：{disk.message}</div>;
  } else {
    detail = <div className="cz-flow__pdetail-note">正在读取…</div>;
  }

  return (
    <li className="cz-flow__pitem">
      <button type="button" className="cz-flow__agent-row cz-flow__pitem-row" aria-expanded={open} onClick={toggle}>
        <Icon name={STATUS_ICON[group.status]} size={14} />
        <span className="cz-flow__agent-title">
          <span className={TITLE_CLASS[group.status]}>{group.name}</span>
          {count > 1 && <span className="cz-flow__pcount">×{count}</span>}
          {group.manual && <span className="cz-flow__ptag">手动</span>}
          {purpose && <span className="cz-flow__psub">{purpose}</span>}
        </span>
        <Icon name="chevron" size={14} open={open} />
      </button>
      {open && (
        <PanelDetail onClose={close} label={`${group.name} 技能内容`}>
          {argsText && <div className="cz-flow__pdetail-note">参数：{argsText}</div>}
          {detail}
        </PanelDetail>
      )}
    </li>
  );
});

export const SkillList = memo(function SkillList({ groups }: { groups: readonly SkillGroup[] }) {
  const cwd = useFiles()?.cwd;
  const { loadSkill } = useFlowMeta();
  return (
    <ul className="cz-flow__agents-list">
      {groups.map((g) => (
        <SkillRow key={g.name} group={g} cwd={cwd} loader={loadSkill} />
      ))}
    </ul>
  );
});
