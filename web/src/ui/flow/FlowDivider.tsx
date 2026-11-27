// 居中分隔提示（模型切换 / 上下文压缩）：会话流里的轮间提示与轮内（步骤之间）提示共用
import { memo } from 'react';
import type { FlowDividerItem } from './dividers';

export const FlowDivider = memo(function FlowDivider({ item }: { item: FlowDividerItem }) {
  return (
    <div className="cz-flow__divider" role="separator" data-kind={item.kind} title={item.title}>
      <span>{item.text}</span>
    </div>
  );
});
