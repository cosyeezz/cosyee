// MCP 服务列表（供 SessionDock 使用）：每个服务一行，行内列出各工具，点击工具在其下方展开每次调用的入参与结果。
import { memo, useCallback, useState } from 'react';
import type { ToolStep } from '@cosyee/shared';
import { Icon } from '../icons/Icon';
import { toolContentToText } from './format';
import type { McpServerGroup, McpToolGroup } from './mcp';
import { PanelDetail } from './PanelDetail';

function pretty(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v ?? {}, null, 2);
  } catch {
    return String(v);
  }
}

/** 结果：文本块当文字；图片块有数据就显示，否则标「[图片]」 */
function ResultView({ content }: { content: unknown }) {
  if (!Array.isArray(content)) {
    const t = toolContentToText(content);
    return t ? <pre className="cz-flow__ppre">{t}</pre> : <div className="cz-flow__pdetail-note">（无输出）</div>;
  }
  return (
    <>
      {content.map((b, i) => {
        const o = b && typeof b === 'object' ? (b as Record<string, any>) : null;
        const src =
          o?.type === 'image' && o.source?.type === 'base64' && o.source.data
            ? `data:${o.source.media_type ?? 'image/png'};base64,${o.source.data}`
            : null;
        if (src) return <img key={i} className="cz-flow__pimg" src={src} alt="MCP 返回的图片" />;
        const t = toolContentToText([b]);
        return t ? (
          <pre key={i} className="cz-flow__ppre">
            {t}
          </pre>
        ) : null;
      })}
    </>
  );
}

function CallView({ call, index, total }: { call: ToolStep; index: number; total: number }) {
  return (
    <div className="cz-flow__pcall">
      {total > 1 && <div className="cz-flow__pcall-no">第 {index + 1} 次调用</div>}
      <div className="cz-flow__io-label">入参</div>
      <pre className="cz-flow__ppre">{pretty(call.input)}</pre>
      <div className="cz-flow__io-label">结果{call.result?.isError ? '（失败）' : ''}</div>
      {call.result ? (
        <div className={call.result.isError ? 'cz-flow__pdetail-error' : undefined}>
          <ResultView content={call.result.content} />
        </div>
      ) : (
        <div className="cz-flow__pdetail-note">执行中…</div>
      )}
    </div>
  );
}

const ServerRow = memo(function ServerRow({ group: g0, turnActive }: { group: McpServerGroup; turnActive: boolean }) {
  // 本轮已结束（中断 / 出错）时，没等到结果的调用不再算「执行中」
  const group = turnActive || !g0.running ? g0 : { ...g0, running: false };
  const [openTool, setOpenTool] = useState<string | null>(null);
  const close = useCallback(() => setOpenTool(null), []);
  const active: McpToolGroup | undefined = group.tools.find((t) => t.tool === openTool);
  return (
    <li className="cz-flow__pitem">
      <div className="cz-flow__agent-row cz-flow__pitem-row cz-flow__mcp-row">
        <Icon name={group.running ? 'agent-running' : group.failed ? 'error' : 'done'} size={14} />
        <span className="cz-flow__mcp-name">
          <span className={group.running ? 'cz-st-tool' : undefined}>{group.server}</span>
        </span>
        <span className="cz-flow__mcp-tools">
          {group.tools.map((t, i) => (
            <span key={t.tool}>
              {i > 0 && <span className="cz-flow__mcp-sep">·</span>}
              <button
                type="button"
                className={`cz-flow__mcp-tool${t.failed ? ' is-error' : ''}${openTool === t.tool ? ' is-open' : ''}`}
                aria-expanded={openTool === t.tool}
                onClick={() => setOpenTool((cur) => (cur === t.tool ? null : t.tool))}
              >
                {t.tool}
                {t.calls.length > 1 ? ` ×${t.calls.length}` : ''}
              </button>
            </span>
          ))}
        </span>
      </div>
      {active && (
        <PanelDetail onClose={close} label={`${group.server} ${active.tool} 调用详情`}>
          {active.calls.map((c, i) => (
            <CallView key={c.id} call={c} index={i} total={active.calls.length} />
          ))}
        </PanelDetail>
      )}
    </li>
  );
});

export const McpList = memo(function McpList({ groups, active = true }: { groups: readonly McpServerGroup[]; active?: boolean }) {
  return (
    <ul className="cz-flow__agents-list">
      {groups.map((g) => (
        <ServerRow key={g.server} group={g} turnActive={active} />
      ))}
    </ul>
  );
});
