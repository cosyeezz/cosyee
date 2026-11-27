// 后台委派的收尾：委派任务快照（delegates）与完成通知（cosyee-delegate-notification）。
// 后台委派不随主轮结束，它的最终状态只来自这两处。同一个 delegate 调用在多轮里可能有多份副本
// （resolveRun 把旧轮的子代理复制进当前轮），所以按 toolUseId 更新所有轮里的同名运行。
// 对外函数都是不可变更新：没变化的轮 / 运行保持原引用。

import type { CachePoint, DelegateJobInfo, DelegateNotification, SubagentRun, Turn } from '@cosyee/shared';
import { cloneTurn, finishTurn, type ConvState } from './core';
import { mergeCachePoints } from './cacheHit';

/** 停止的任务：回答为空时给尾部加这个前缀，让人看出不是正常做完 */
export const STOPPED_PREFIX = '（已停止）';
/** 服务端快照里已经没有这个后台任务（例如服务端重启）：不会再有结果了 */
export const LOST_TEXT = '任务已丢失（服务端重启？）';

interface Settle {
  status: 'done' | 'error';
  /** 回答为空时用它补；空串表示不补 */
  answer: string;
  reason?: string;
}

const isDelegate = (r: SubagentRun): boolean => r.delegate === true;

/**
 * 停止 → done（回答带前缀）；其它按字面。text 为空时 answer 为空（不覆盖已有内容）。
 * fill：回答为空时是否仍要给「已停止」留个标记（快照用；完成通知的结果为空就不动回答）
 */
function settleOf(state: 'done' | 'error' | 'stopped', text: string, error?: string, fill = false): Settle {
  if (state === 'error') return { status: 'error', answer: text, reason: error || '出错了' };
  if (state === 'stopped') return { status: 'done', answer: text ? STOPPED_PREFIX + text : fill ? STOPPED_PREFIX : '' };
  return { status: 'done', answer: text };
}

/** 在克隆出来的运行上落定结果（原地修改，调用方保证传入的是副本）。overwrite：用 answer 覆盖已有回答（完成通知的最终结果优先） */
function settle(run: SubagentRun, st: Settle, now: number, overwrite: boolean): void {
  run.status = st.status;
  if (st.answer && (overwrite || !run.turn.answer.trim())) run.turn.answer = st.answer;
  finishTurn(run.turn, st.status, now, st.status === 'error' ? st.reason : undefined);
}

/** 运行是否已经处在目标状态（避免无谓的克隆 / 重复刷新） */
function settled(run: SubagentRun, st: Settle, overwrite: boolean): boolean {
  if (run.status !== st.status || run.turn.status !== st.status) return false;
  return !(st.answer && (overwrite || !run.turn.answer.trim()) && run.turn.answer !== st.answer);
}

function mapTurns(turns: Turn[], fn: (r: SubagentRun) => SubagentRun): Turn[] {
  let out: Turn[] | null = null;
  turns.forEach((t, i) => {
    let subs: SubagentRun[] | null = null;
    t.subagents.forEach((r, j) => {
      const n = fn(r);
      if (n === r) return;
      subs ??= t.subagents.slice();
      subs[j] = n;
    });
    if (!subs) return;
    out ??= turns.slice();
    out[i] = { ...t, subagents: subs };
  });
  return out ?? turns;
}

/**
 * 应用委派任务快照（ServerMsg.delegates，完整快照）：
 * - 快照里有的：标记 background；running → 运行中；done / stopped → done；error → error，回答为空时用 tail 补；
 * - 快照里没有、仍是 running 的后台委派 → error「任务已丢失」。
 * 调用方只应在确认快照有效（订阅后收到过 delegates 消息）之后调用，否则「丢失」判断会误伤刚加载的历史。
 */
export function applyDelegates(s: ConvState, jobs: DelegateJobInfo[], now: number = Date.now()): ConvState {
  const byId = new Map(jobs.map((j) => [j.toolUseId, j]));
  const turns = mapTurns(s.turns, (run) => {
    if (!isDelegate(run)) return run;
    const job = byId.get(run.toolUseId);
    if (!job) {
      // 快照里没有：只有「后台且仍在运行」的才算丢失；前台调用的结果由 tool_result 收尾
      if (!(run.background && run.status === 'running')) return run;
      const c: SubagentRun = { ...run, turn: cloneTurn(run.turn) };
      settle(c, { status: 'error', answer: LOST_TEXT, reason: LOST_TEXT }, now, true);
      return c;
    }
    const bg = job.background && !run.background;
    if (job.state === 'running') {
      // 前台调用不「复活」（主轮中断时它已被收尾为出错）；后台任务（含 delegate_send 续跑）才回到运行中
      if ((run.status === 'running' && !bg) || !job.background) return run;
      const c: SubagentRun = { ...run, background: job.background || run.background, turn: cloneTurn(run.turn) };
      c.status = 'running';
      c.turn.status = 'running';
      delete c.turn.endedAt;
      delete c.turn.reason;
      return c;
    }
    const st = settleOf(job.state, job.tail, job.error, true);
    if (!bg && settled(run, st, false)) return run;
    const c: SubagentRun = { ...run, ...(job.background ? { background: true } : {}), turn: cloneTurn(run.turn) };
    settle(c, st, job.endedAt ?? now, false);
    return c;
  });
  return turns === s.turns ? s : { ...s, turns };
}

/** 现在的通知没有正文，出错时只有一行原因 */
function settleNote(n: DelegateNotification, fill = false): Settle {
  return n.status === 'error' ? settleOf('error', n.result || n.error || '', n.error || n.result, fill) : settleOf(n.status, n.result, undefined, fill);
}

/** 一次后台委派完成通知：找到所有轮里 toolUseId 相同的运行，落定状态（回答保留流式收到的；旧通知带正文才覆盖） */
export function applyDelegateNotification(s: ConvState, n: DelegateNotification, now: number = Date.now()): ConvState {
  const st = settleNote(n);
  const turns = mapTurns(s.turns, (run) => {
    if (run.toolUseId !== n.toolUseId || !isDelegate(run)) return run;
    if (settled(run, st, true)) return run;
    const c: SubagentRun = { ...run, turn: cloneTurn(run.turn) };
    settle(c, st, now, true);
    return c;
  });
  return turns === s.turns ? s : { ...s, turns };
}

/**
 * 模型自己用 delegate_stop 停掉的任务不发完成通知，记录里只有这个工具的结果：取出其中的 tool_use_id 与部分输出。
 * 不是停止结果返回 null。
 */
export function parseDelegateStop(text: string): { toolUseId: string; result: string } | null {
  if (!/^Stopped delegate [\w-]+\./.test(text)) return null;
  const id = /\n\[tool_use_id: ([\w-]+)\]\s*$/.exec(text)?.[1];
  if (!id) return null;
  return { toolUseId: id, result: /\nPartial output \(tail\):\n([\s\S]*)\n\n\[conversation_id: /.exec(text)?.[1] ?? '' };
}

/** 一轮里有多少过程：先比步骤数，再比文字量 */
function fullness(t: Turn, withAnswer: boolean): [number, number] {
  let chars = withAnswer ? t.answer.length : 0;
  for (const s of t.steps) if (s.kind === 'text') chars += s.text.length;
  return [t.steps.length, chars];
}

/**
 * 服务端的过程记录是否比页面上的更全。页面中途刷新 / 重新加载历史后，之前的过程只在记录里；
 * 从头看到尾的委派页面上至少和记录一样全，直接用实时的（逐字流式）。
 */
export function recordFuller(run: SubagentRun, rec: Turn): boolean {
  const [a, b] = [fullness(rec, run.status === 'running'), fullness(run.turn, run.status === 'running')];
  return a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
}

/** 用过程记录补全委派子代理：补步骤、正在写的文字、最终结果与历史用量；状态、任务文字仍以页面上的为准 */
export function withRecord(
  run: SubagentRun,
  rec: Turn,
  extra?: { cache?: readonly CachePoint[]; contextWindow?: number },
): SubagentRun {
  const fuller = recordFuller(run, rec);
  const answer = run.status === 'running' ? (fuller ? rec.answer : run.turn.answer) : finalAnswer(run, rec.answer);
  const mergedCache = extra?.cache?.length ? mergeCachePoints(extra.cache, run.cache) : run.cache;
  const cacheChanged = mergedCache !== run.cache;
  const contextWindow = run.contextWindow ?? extra?.contextWindow;
  const winChanged = contextWindow !== run.contextWindow;
  if (!fuller && answer === run.turn.answer && !cacheChanged && !winChanged) return run;
  return {
    ...run,
    ...(cacheChanged && mergedCache ? { cache: mergedCache } : {}),
    ...(winChanged && contextWindow !== undefined ? { contextWindow } : {}),
    ...(fuller || answer !== run.turn.answer ? { turn: { ...run.turn, ...(fuller ? { steps: rec.steps } : {}), answer } } : {}),
  };
}

/** 已结束的委派：完成通知不带正文，页面上的回答可能是空的或任务快照里截过的尾部，记录里的更长就用记录的 */
function finalAnswer(run: SubagentRun, rec: string): string {
  const cur = run.turn.answer;
  if (run.status === 'error') return cur || rec;
  const prefix = cur.startsWith(STOPPED_PREFIX) ? STOPPED_PREFIX : '';
  return rec.length > cur.length - prefix.length ? prefix + rec : cur;
}

/** 历史回放用：原地更新（turns 是正在构建的、没人持有引用的数组） */
export function settleFromNotification(turns: Turn[], n: DelegateNotification, at: number): void {
  const st = settleNote(n, true);
  for (const t of turns) {
    for (const run of t.subagents) {
      if (run.toolUseId === n.toolUseId && isDelegate(run)) settle(run, st, at, true);
    }
  }
}
