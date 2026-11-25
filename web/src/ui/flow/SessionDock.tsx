// 会话级活动区：放在会话流末尾（随内容滚动），依次以独立面板展示整个会话执行过的子代理、技能与 MCP。
// 每个面板各自：进行中展开，交付后收起成标题行（点标题行可再开合）；切换会话（sessionKey 变化）时通过 key 复位。
import { memo, useId, useMemo, useState, type ReactNode } from 'react';
import type { Turn } from '@cosyee/shared';
import { useFlowMeta } from './flowContext';
import { subagentProgress } from './format';
import { McpList } from './McpPanel';
import { collectActivity } from './sessionActivity';
import { groupSkills, SkillList } from './SkillPanel';
import { AgentIcon, McpIcon, SkillIcon } from './StatusIcons';
import { SubagentList } from './SubagentList';
import './flow.css';
import './status.css';
import './SessionDock.css';

export interface SessionDockProps {
  turns: readonly Turn[];
  sessionKey: string | null;
  onOpenSubagent?: (turnId: string, toolUseId: string) => void;
}

/** 一个面板：标题行 + 列表。默认跟随 live 开合；用户点过就按用户的，live 翻转时回到默认 */
function DockPanel({ className, icon, busy, label, live, children }: {
  className?: string;
  icon: ReactNode;
  /** 标题文字流光 */
  busy: boolean;
  label: string;
  live: boolean;
  children: ReactNode;
}) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const [prevLive, setPrevLive] = useState(live);
  if (prevLive !== live) {
    setPrevLive(live);
    setUserOpen(null);
  }
  const open = userOpen ?? live;
  const id = useId();
  return (
    <div className={`cz-flow__agents${className ? ` ${className}` : ''}`}>
      <button
        type="button"
        className="cz-flow__agents-head cz-dock__head"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setUserOpen(!open)}
      >
        {icon}
        <span className={`cz-dock__label${busy ? ' cz-st cz-st-compacting' : ''}`}>{label}</span>
      </button>
      {open && <div id={id}>{children}</div>}
    </div>
  );
}

export const SessionDock = memo(function SessionDock({ turns, sessionKey, onOpenSubagent }: SessionDockProps) {
  const { mcpServers } = useFlowMeta();
  const activity = useMemo(() => collectActivity(turns, mcpServers), [turns, mcpServers]);
  const skillGroups = useMemo(() => groupSkills(activity.skills), [activity.skills]);
  const subProg = useMemo(() => subagentProgress(activity.runs.map((a) => a.run)), [activity.runs]);

  const hasRuns = activity.runs.length > 0;
  const hasSkills = skillGroups.length > 0;
  const hasMcp = activity.mcp.length > 0;
  if (!hasRuns && !hasSkills && !hasMcp) return null;

  const skillLoading = hasSkills && skillGroups.some((g) => g.status === 'loading');
  const mcpRunning = hasMcp && activity.mcp.some((g) => g.running);

  return (
    <div className="cz-dock" key={sessionKey ?? ''}>
      {hasRuns && (
        <DockPanel
          icon={<AgentIcon size={18} className={subProg.allDone ? 'is-still' : undefined} />}
          busy={!subProg.allDone}
          label={
            subProg.allDone
              ? `${subProg.total} 个子代理已完成`
              : `${subProg.total} 个子代理执行中 ${subProg.finished}/${subProg.total}`
          }
          live={activity.live.runs}
        >
          <SubagentList runs={activity.runs} onOpenSubagent={onOpenSubagent} />
        </DockPanel>
      )}
      {hasSkills && (
        <DockPanel
          className="cz-flow__skills"
          icon={<SkillIcon size={18} className={skillLoading ? undefined : 'is-still'} />}
          busy={skillLoading}
          label={skillLoading ? `正在加载技能 … 共 ${skillGroups.length} 个` : `已加载 ${skillGroups.length} 个技能`}
          live={activity.live.skills}
        >
          <SkillList groups={skillGroups} />
        </DockPanel>
      )}
      {hasMcp && (
        <DockPanel
          className="cz-flow__mcp"
          icon={<McpIcon size={18} className={mcpRunning ? undefined : 'is-still'} />}
          busy={mcpRunning}
          label={`调用了 ${activity.mcp.length} 个 MCP 服务`}
          live={activity.live.mcp}
        >
          <McpList groups={activity.mcp} />
        </DockPanel>
      )}
    </div>
  );
});
