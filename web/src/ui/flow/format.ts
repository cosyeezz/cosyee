// 会话流用到的纯函数（无 React 依赖，便于单测）。
import type { Attachment, SubagentRun, ToolStep, Turn } from '@cosyee/shared';
import { EFFORTS, modelLabel } from '@cosyee/shared';

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 用时：<60s「12 秒」，<1h「3 分 5 秒」，否则「1 小时 2 分」 */
export function formatDuration(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0;
  if (total < 60) return `${total} 秒`;
  if (total < 3600) return `${Math.floor(total / 60)} 分 ${total % 60} 秒`;
  return `${Math.floor(total / 3600)} 小时 ${Math.floor((total % 3600) / 60)} 分`;
}

/** 本地时间 HH:mm */
export function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 结束态文案：已完成 · HH:mm · 用时 3 分 5 秒（缺 endedAt 时省略对应部分） */
export function formatDoneText(turn: Pick<Turn, 'startedAt' | 'endedAt'>): string {
  const parts = ['已完成'];
  if (turn.endedAt != null) {
    parts.push(formatClock(turn.endedAt));
    if (turn.startedAt != null) parts.push(`用时 ${formatDuration(turn.endedAt - turn.startedAt)}`);
  }
  return parts.join(' · ');
}

export interface StatusLine {
  /** 对应图标 / 文字特效：active 为进行中（understanding / running 合并），其余为结束态 */
  kind: 'active' | 'done' | 'interrupted' | 'error';
  /** 主短语：固定措辞，进行中始终是「正在处理」，绝不显示模型文字 */
  text: string;
  /** 暗色附加信息（用时、子代理进度、原因等），无则为空串 */
  meta: string;
  /** 悬停提示：完整原因等（可能比 meta 长） */
  title?: string;
}

/** 状态行短原因：取首个非空行，压缩空白，超长截断 */
export function shortReason(reason: string | undefined, max = 60): string {
  const line = (reason ?? '').split(/\r?\n/).find((l) => l.trim()) ?? '';
  const s = line.trim().replace(/\s+/g, ' ');
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * 状态行：主短语固定（正在处理 / 已完成 / 已中断 / 出错了），变化的只有暗色 meta。
 * now 用于进行中的用时（组件每秒传入一次）；结束态用 endedAt。
 */
export function getStatusLine(turn: Turn, now: number = Date.now()): StatusLine {
  switch (turn.status) {
    case 'understanding':
    case 'running': {
      const parts = [formatDuration(now - turn.startedAt)];
      const sub = subagentProgress(turn.subagents);
      if (sub.total > 0 && !sub.allDone) parts.push(`子代理 ${sub.finished}/${sub.total}`);
      return { kind: 'active', text: '正在处理', meta: parts.join(' · ') };
    }
    case 'done': {
      const parts: string[] = [];
      if (turn.steps.length > 0) parts.push(`共 ${turn.steps.length} 步`);
      if (turn.endedAt != null) parts.push(`用时 ${formatDuration(turn.endedAt - turn.startedAt)}`);
      return { kind: 'done', text: '已完成', meta: parts.join(' · ') };
    }
    case 'interrupted': {
      // reducer 的默认原因就是「已中断」，与主短语重复时不再显示
      const r = shortReason(turn.reason);
      const meta = r && r !== '已中断' ? r : '';
      return { kind: 'interrupted', text: '已中断', meta, title: meta ? turn.reason : undefined };
    }
    case 'error': {
      const r = shortReason(turn.reason);
      const meta = r && r !== '出错了' ? r : '';
      return { kind: 'error', text: '出错了', meta, title: meta ? turn.reason : undefined };
    }
  }
}

/**
 * 状态行下方的模型文字：只显示模型说的话，新的一段替换上一段。
 * 折叠时 = 正在写的 answer，没有则取 steps 里最后一段文字；
 * 展开时展开区已按时间列出所有步骤（含文字），这里只给 answer，避免重复。
 */
export function getLiveText(turn: Pick<Turn, 'answer' | 'steps'>, expanded: boolean): { text: string; isAnswer: boolean } {
  if (turn.answer) return { text: turn.answer, isAnswer: true };
  if (expanded) return { text: '', isAnswer: false };
  for (let i = turn.steps.length - 1; i >= 0; i--) {
    const s = turn.steps[i]!;
    if (s.kind === 'text' && s.text.trim()) return { text: s.text, isAnswer: false };
  }
  return { text: '', isAnswer: false };
}

/** 回合是否仍在进行 */
export const isTurnActive = (turn: Pick<Turn, 'status'>): boolean =>
  turn.status === 'understanding' || turn.status === 'running';

/** 工具结果内容（string / [{type:'text',text}] / 其他）转纯文本 */
export function toolContentToText(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          const o = item as Record<string, unknown>;
          if (o.type === 'text' && typeof o.text === 'string') return o.text;
          if (o.type === 'image') return '[图片]';
        }
        return safeStringify(item);
      })
      .join('\n');
  }
  if (typeof content === 'object') {
    const o = content as Record<string, unknown>;
    if (o.type === 'text' && typeof o.text === 'string') return o.text;
  }
  if (typeof content === 'number' || typeof content === 'boolean') return String(content);
  return safeStringify(content);
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
}

/** 截断长文本；max 以内原样返回 */
export function truncateText(text: string, max = 2000): { text: string; truncated: boolean; total: number } {
  if (text.length <= max) return { text, truncated: false, total: text.length };
  return { text: text.slice(0, max), truncated: true, total: text.length };
}

/** 工具输入：Bash 取 command 原样，其余 JSON 美化 */
export function describeToolInput(step: Pick<ToolStep, 'name' | 'input'>): { lang: string; text: string } {
  const input = step.input;
  if (step.name === 'Bash' && input && typeof input === 'object') {
    const cmd = (input as Record<string, unknown>).command;
    if (typeof cmd === 'string') return { lang: 'bash', text: cmd };
  }
  if (typeof input === 'string') return { lang: 'text', text: input };
  if (input === undefined) return { lang: 'json', text: '' };
  return { lang: 'json', text: safeStringify(input) };
}

/** 思考折叠时的预览：压成单行并截前 n 个字符 */
export function thinkingPreview(text: string, n = 40): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n) + '…' : flat;
}

/** 子代理面板进度：finished 含 error */
export function subagentProgress(subagents: Pick<SubagentRun, 'status'>[]): {
  total: number;
  finished: number;
  allDone: boolean;
} {
  const total = subagents.length;
  const finished = subagents.filter((s) => s.status !== 'running').length;
  return { total, finished, allDone: total > 0 && finished === total };
}

export type UserSegment = { type: 'text'; text: string } | { type: 'attachment'; attachment: Attachment };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 把 userText 里出现的占位名（file1 / img1 / folder1）切成文字段与附件段 */
export function splitUserText(text: string, attachments: Attachment[]): UserSegment[] {
  if (!attachments.length) return text ? [{ type: 'text', text }] : [];
  const byLabel = new Map(attachments.map((a) => [a.label, a]));
  // 长的在前，避免 file1 抢走 file10；两侧不能是字母数字，避免命中 myfile1
  const alt = [...byLabel.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
  const re = new RegExp(`(?<![A-Za-z0-9_])(${alt})(?![A-Za-z0-9_])`, 'g');
  const out: UserSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ type: 'text', text: text.slice(last, idx) });
    out.push({ type: 'attachment', attachment: byLabel.get(m[1])! });
    last = idx + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
}

// ───────────── 子代理的模型 / 思考等级 ─────────────

/** 模型 id → 显示名：别名（sonnet）查表；完整 id（claude-sonnet-5-5、claude-haiku-4-5-20251001）拼成「Sonnet 5.5」 */
export function prettyModel(id: string | undefined): string {
  if (!id) return '';
  const known = modelLabel(id);
  if (known !== id) return known;
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(id);
  if (!m) return id;
  const name = m[1][0].toUpperCase() + m[1].slice(1);
  return `${name} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

const effortName = (e: string): string => EFFORTS.find((x) => x.id === e)?.label ?? e;

/** 思考等级文案：调用时指定了用指定值；否则继承主会话（知道主会话等级时带上） */
export function effortText(effort: string | undefined, sessionEffort?: string): string {
  if (effort) return `思考 ${effortName(effort)}`;
  return sessionEffort ? `思考 ${effortName(sessionEffort)}（继承主会话）` : '思考等级继承主会话';
}
