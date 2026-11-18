// 思考块用到的纯函数（无 React 依赖，便于单测）。
import type { ThinkingStep } from '@cosyee/shared';

/** 思考是否带文本（有的模型 / 显示模式只给 token 计数，文本为空串） */
export const hasThinkingText = (text: string): boolean => text.trim().length > 0;

/**
 * 折叠态预览：思考内容的第一行（首个非空行）。
 * 去掉行首的 Markdown 标题符号与整行加粗（摘要常以「**小标题**」开头），压缩空白；
 * 单行省略号截断交给 CSS，这里只按 max 兜底截断，避免把超长单行整个塞进 DOM。
 */
export function thinkingFirstLine(text: string, max = 200): string {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? '';
  let s = line.trim().replace(/^#{1,6}\s+/, '');
  const bold = /^(\*\*|__)(.+)\1$/.exec(s);
  if (bold) s = bold[2]!.trim();
  s = s.replace(/\s+/g, ' ');
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * 思考行里没有文本时的附注：只有 token 数（「1,234 tokens」），未知则为空串。
 * 不再带「思考中 / 已思考」之类的措辞——进行中直接显示内容，完成后显示第一行。
 */
export function thinkingTokensLabel(step: Pick<ThinkingStep, 'text' | 'tokens'>): string {
  if (hasThinkingText(step.text)) return '';
  const tokens = typeof step.tokens === 'number' && step.tokens > 0 ? step.tokens : undefined;
  return tokens === undefined ? '' : `${tokens.toLocaleString('en-US')} tokens`;
}
