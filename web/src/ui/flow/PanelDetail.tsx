// 技能 / MCP 面板的行内展开区：最高半屏、内部滚动，底部「收起」按钮。
import type { ReactNode } from 'react';

export function PanelDetail({ onClose, children, label }: { onClose: () => void; children: ReactNode; label?: string }) {
  return (
    <div className="cz-flow__pdetail" role="region" aria-label={label}>
      <div className="cz-flow__pdetail-scroll">{children}</div>
      <button type="button" className="cz-flow__pdetail-close" onClick={onClose}>
        收起
      </button>
    </div>
  );
}
