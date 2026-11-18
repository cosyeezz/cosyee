// 用户消息气泡：占位名（file1 / img1 / folder1）渲染成内联标签。
import { memo, useMemo } from 'react';
import type { Attachment } from '@cosyee/shared';
import { Icon, type IconName } from '../icons/Icon';
import { parseQuote } from '../../core/quote';
import { splitUserText } from './format';
import './flow.css';

const KIND_ICON: Record<Attachment['kind'], IconName> = { file: 'file', img: 'image', folder: 'folder' };

export const AttachmentTag = memo(function AttachmentTag({ attachment }: { attachment: Attachment }) {
  return (
    <span className={`cz-flow__tag cz-flow__tag--${attachment.kind}`} title={attachment.path}>
      <Icon name={KIND_ICON[attachment.kind]} size={13} />
      <span>{attachment.label}</span>
    </span>
  );
});

export const UserMessage = memo(function UserMessage({
  text,
  attachments,
}: {
  text: string;
  attachments: Attachment[];
}) {
  // 开头的 `> ` 引用块（选中回复）单独渲染，正文照常还原路径标签
  const { quote, body } = useMemo(() => parseQuote(text), [text]);
  const segments = useMemo(() => splitUserText(body, attachments), [body, attachments]);
  return (
    <div className="cz-flow__user">
      <div className="cz-flow__bubble">
        {quote !== null && <div className="cz-flow__quote" title={quote}>{quote}</div>}
        {segments.map((s, i) =>
          s.type === 'text' ? (
            <span key={i}>{s.text}</span>
          ) : (
            <AttachmentTag key={i} attachment={s.attachment} />
          ),
        )}
      </div>
    </div>
  );
});
