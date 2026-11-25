// 侧栏收起时浮在会话流左上角的置顶列表：只显示状态点和标题，点一下切换会话，没有置顶 / 删除等操作。
// 高度夹在顶栏和输入框之间（由父级 .cz-app__main 的 --composer-h 决定），放不下时在里面滚动。
// 动效：整列从左侧淡入滑出，各行错开 30ms 跟上；选中项用液态玻璃胶囊（与侧栏一致）；收回时短淡出后再卸载。
// 鼠标悬停的那一块按标题长度展开、字号放大，可以盖到会话流上；其他块不变。
import { useRef, useState, type CSSProperties } from 'react';
import type { SessionSummary, Workspace } from '@cosyee/shared';
import { LiquidCapsule } from '../motion/LiquidCapsule';
import { leavingProps, usePresence } from '../motion/usePresence';
import { displayTitle, workspaceName } from './sidebarUtil';
import { usePendingSelect } from './usePendingSelect';
import './PinnedRail.css';

const ACTIVE_ROW = '.cz-prail__row.is-active';
/** 错开入场最多算到第 8 行，后面的行和第 8 行一起出现 */
const STAGGER_MAX = 8;

export interface PinnedRailProps {
  /** 是否显示（侧栏收起、且不是窄屏抽屉模式） */
  open: boolean;
  pinned: SessionSummary[];
  workspaces: Workspace[];
  currentSessionId: string | null;
  onSelectSession: (id: string) => void;
}

const STATUS: Record<'running' | 'unread', string> = { running: '执行中', unread: '有新回复' };

export function PinnedRail({ open, pinned, workspaces, currentSessionId, onSelectSession }: PinnedRailProps) {
  const ref = useRef<HTMLElement>(null);
  const show = open && pinned.length > 0;
  const { mounted, leaving } = usePresence(show, ref, 140);
  // 退场途中置顶被清空时，保留最后一份列表淡出，而不是先变成空框
  const [shown, setShown] = useState(pinned);
  if (show && shown !== pinned) setShown(pinned);
  const { activeId, select } = usePendingSelect(currentSessionId, onSelectSession);

  if (!mounted) return null;
  const list = show ? pinned : shown;
  return (
    <nav
      ref={ref}
      className={`cz-prail${leaving ? ' is-leaving' : ''}`}
      aria-label="置顶会话"
      {...leavingProps(leaving)}
    >
      <div className="cz-prail__list" role="list">
        <LiquidCapsule activeKey={activeId} selector={ACTIVE_ROW} />
        {list.map((s, i) => {
          const active = s.id === activeId;
          const title = displayTitle(s.title);
          const status = s.dot ? STATUS[s.dot] : null;
          const tip = [title, workspaceName(s.cwd, workspaces), status].filter(Boolean).join('\n');
          return (
            <div key={s.id} role="listitem" className={`cz-prail__row${active ? ' is-active' : ''}`} style={{ '--i': Math.min(i, STAGGER_MAX) } as CSSProperties}>
              <button
                type="button"
                className="cz-prail__btn"
                onClick={() => select(s.id)}
                aria-current={active ? 'true' : undefined}
                title={tip}
              >
                <span className="cz-prail__mag">
                  {/* 没有状态时不占位，标题顶格 */}
                  {s.dot && (
                    <span className="cz-prail__dot-slot">
                      <span className={`cz-prail__dot cz-prail__dot--${s.dot}`} />
                    </span>
                  )}
                  <span className="cz-prail__title">{title}</span>
                </span>
                {status && <span className="cz-sr-only">（{status}）</span>}
              </button>
            </div>
          );
        })}
      </div>
    </nav>
  );
}
