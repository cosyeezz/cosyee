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

/**
 * 具体时间戳：今天只写 HH:mm；今年其他日子「M月D日 HH:mm」；跨年「YYYY年M月D日 HH:mm」。
 * now 为「现在」，用于判断是否今天 / 今年。
 */
export function formatStamp(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const n = new Date(now);
  const clock = formatClock(ts);
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return clock;
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return d.getFullYear() === n.getFullYear() ? `${md} ${clock}` : `${d.getFullYear()}年${md} ${clock}`;
}

/** 结束态文案：已完成 · HH:mm · 用时 3 分 5 秒（缺 endedAt 时省略对应部分；非今天带日期） */
export function formatDoneText(turn: Pick<Turn, 'startedAt' | 'endedAt'>, now: number = Date.now()): string {
  const parts = ['已完成'];
  if (turn.endedAt != null) {
    parts.push(formatStamp(turn.endedAt, now));
    if (turn.startedAt != null) parts.push(`用时 ${formatDuration(turn.endedAt - turn.startedAt)}`);
  }
  return parts.join(' · ');
}

export interface StatusLine {
  /** 对应图标 / 文字特效：active 为进行中（understanding / running 合并），其余为结束态 */
  kind: 'active' | 'done' | 'interrupted' | 'error';
  /**
   * 仅 active：understanding = 模型还没有任何文本（星轨 + 正在理解问题）；
   * text = 已有文本（神经脉冲 + 最近一段文本）。思考 / 工具调用不改变它。
   */
  phase?: 'understanding' | 'text';
  /** 主短语：active 时是「正在理解问题」或模型最近一段文本的首行（去 markdown）；结束态为固定措辞 */
  text: string;
  /** 暗色附加信息（时间、步数、用时、子代理进度、原因等），无则为空串 */
  meta: string;
  /** 悬停提示：完整原因等（可能比 meta 长） */
  title?: string;
}

export const UNDERSTANDING_TEXT = '正在理解问题';

/**
 * 一段模型文字 → 状态行里的单行纯文本：取首个非空行，跳过代码围栏 / 分隔线，
 * 去掉标题、引用、列表前缀与行内 markdown 符号（加粗 / 斜体 / 行内代码 / 链接），压缩空白。
 * 单行省略号交给 CSS，这里只按 max 兜底截断。
 */
export function plainFirstLine(text: string, max = 200): string {
  for (const raw of text.split(/\r?\n/)) {
    let s = raw.trim();
    if (!s || /^(```|~~~)/.test(s) || /^([-*_])(\s*\1){2,}$/.test(s)) continue;
    s = s
      .replace(/^#{1,6}\s+/, '')
      .replace(/^>\s?/, '')
      .replace(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/(^|[\s(（])([*_])([^*_\s][^*_]*?)\2(?=$|[\s).,，。！？!?）])/g, '$1$3')
      .replace(/`+([^`]*)`+/g, '$1')
      .replace(/~~(.+?)~~/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    if (!s) continue;
    return s.length > max ? s.slice(0, max) + '…' : s;
  }
  return '';
}

/**
 * 模型最近一段文本的单行形式：正在写的 answer 优先，否则 steps 里最后一段文字。
 * 思考 / 工具调用不参与——它们既不产生也不清掉文本。没有（或只有空白 / 纯符号）返回空串。
 */
export function latestTextLine(turn: Pick<Turn, 'answer' | 'steps'>): string {
  const fromAnswer = plainFirstLine(turn.answer);
  if (fromAnswer) return fromAnswer;
  for (let i = turn.steps.length - 1; i >= 0; i--) {
    const s = turn.steps[i]!;
    if (s.kind !== 'text') continue;
    const line = plainFirstLine(s.text);
    if (line) return line;
  }
  return '';
}

/**
 * 委派子代理的单行描述：一个「委派子代理：标题」，多个「委派 N 个子代理：A、B、C」。
 * 标题为空的不列出；没有子代理返回空串。
 */
export function delegationLine(subagents: Pick<SubagentRun, 'title'>[]): string {
  if (subagents.length === 0) return '';
  const titles = subagents.map((s) => plainFirstLine(s.title)).filter(Boolean).join('、');
  const head = subagents.length === 1 ? '委派子代理' : `委派 ${subagents.length} 个子代理`;
  return titles ? `${head}：${titles}` : head;
}

/**
 * 模型最近一次「输出」的单行形式：文字和委派子代理同等对待，谁新显示谁。
 * 正在写的 answer 一定最新；否则比较 steps 里最后一段文字的位置与最近一批委派的 afterStep
 * （同一条消息里并行发起的委派 afterStep 相同，合成一行）。都没有返回空串。
 */
export function latestOutputLine(turn: Pick<Turn, 'answer' | 'steps' | 'subagents'>): string {
  const fromAnswer = plainFirstLine(turn.answer);
  if (fromAnswer) return fromAnswer;
  let textIdx = -1;
  let textLine = '';
  for (let i = turn.steps.length - 1; i >= 0; i--) {
    const s = turn.steps[i]!;
    if (s.kind !== 'text') continue;
    const line = plainFirstLine(s.text);
    if (line) {
      textIdx = i;
      textLine = line;
      break;
    }
  }
  if (turn.subagents.length === 0) return textLine;
  const at = Math.max(...turn.subagents.map((r) => r.afterStep ?? -1));
  // afterStep = k 表示委派时已有 k 个步骤；之后的文字下标 ≥ k，所以 at > textIdx 才是委派更新
  if (textIdx >= 0 && at <= textIdx) return textLine;
  return delegationLine(turn.subagents.filter((r) => (r.afterStep ?? -1) === at));
}

/** 状态行短原因：取首个非空行，压缩空白，超长截断 */
export function shortReason(reason: string | undefined, max = 60): string {
  const line = (reason ?? '').split(/\r?\n/).find((l) => l.trim()) ?? '';
  const s = line.trim().replace(/\s+/g, ' ');
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * 状态行状态机。
 * 进行中只由模型最近一次「输出」决定——文字和委派子代理同等对待，新的替换旧的（见 latestOutputLine）；
 * 思考和普通工具调用不改变它：
 *   有输出 → phase=text，最近一段文字的首行，或最近一批委派的描述（见 delegationLine）；
 *   没有   → phase=understanding，「正在理解问题」。
 * 结束态：已完成（时间 · 共 N 步 · 用时）/ 已中断 / 出错了，meta 前带上结束的具体时间（非今天带日期）。
 * now 用于进行中的用时（组件每秒传入一次）和「是否今天」；结束态用 endedAt。
 */
export function getStatusLine(turn: Turn, now: number = Date.now()): StatusLine {
  const stamp = turn.endedAt != null ? formatStamp(turn.endedAt, now) : '';
  switch (turn.status) {
    case 'understanding':
    case 'running': {
      const parts = [formatDuration(now - turn.startedAt)];
      const sub = subagentProgress(turn.subagents);
      if (sub.total > 0 && !sub.allDone) parts.push(`子代理 ${sub.finished}/${sub.total}`);
      // 委派子代理（Agent 工具调用）与文字同等对待：显示最新的那个，同样用文字图标
      const line = latestOutputLine(turn);
      return line
        ? { kind: 'active', phase: 'text', text: line, meta: parts.join(' · '), title: line }
        : { kind: 'active', phase: 'understanding', text: UNDERSTANDING_TEXT, meta: parts.join(' · ') };
    }
    case 'done': {
      const parts: string[] = [];
      if (stamp) parts.push(stamp);
      if (turn.steps.length > 0) parts.push(`共 ${turn.steps.length} 步`);
      if (turn.endedAt != null) parts.push(`用时 ${formatDuration(turn.endedAt - turn.startedAt)}`);
      return { kind: 'done', text: '已完成', meta: parts.join(' · ') };
    }
    case 'interrupted': {
      // reducer 的默认原因就是「已中断」，与主短语重复时不再显示
      const r = shortReason(turn.reason);
      const meta = [stamp, r && r !== '已中断' ? r : ''].filter(Boolean).join(' · ');
      return { kind: 'interrupted', text: '已中断', meta, title: r && r !== '已中断' ? turn.reason : undefined };
    }
    case 'error': {
      const r = shortReason(turn.reason);
      const meta = [stamp, r && r !== '出错了' ? r : ''].filter(Boolean).join(' · ');
      return { kind: 'error', text: '出错了', meta, title: r && r !== '出错了' ? turn.reason : undefined };
    }
  }
}

/**
 * 状态行下方的模型文字：只显示模型说的话，新的一段替换上一段。
 * 进行中：只给正在写的 answer（最近一段文字已在首行显示，不再重复）；
 * 结束后折叠时 = answer，没有则取 steps 里最后一段文字；展开时展开区已按时间列出所有步骤（含文字），这里只给 answer，避免重复。
 */
export function getLiveText(
  turn: Pick<Turn, 'answer' | 'steps'>,
  expanded: boolean,
  active = false,
): { text: string; isAnswer: boolean } {
  if (turn.answer) return { text: turn.answer, isAnswer: true };
  if (expanded || active) return { text: '', isAnswer: false };
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

/** 读写文件类工具：输入里的文件路径（用于让摘要里的路径可点击预览）；没有则 undefined */
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
export function toolFilePath(step: Pick<ToolStep, 'name' | 'input'>): string | undefined {
  if (!FILE_TOOLS.has(step.name) || !step.input || typeof step.input !== 'object') return undefined;
  const o = step.input as Record<string, unknown>;
  const p = step.name === 'NotebookEdit' ? (o.notebook_path ?? o.file_path) : (o.file_path ?? o.path);
  return typeof p === 'string' && p.trim() ? p : undefined;
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
