// 跨轮的子代理：SendMessage 恢复已结束的子代理，或后台子代理在用户发新消息后继续输出。
// CLI 的事件特征（实测）：
//   - 恢复时发 task_started：task_id = 子代理 agent id，tool_use_id = 本次 SendMessage 的 id；
//   - 子代理之后的输出 parent_tool_use_id 仍是「最初那次 Agent 调用」的 id（可能在更早的轮里）；
//   - 恢复后的 task_progress / task_notification 的 tool_use_id 是 SendMessage 的 id，task_updated 只有 task_id。
// 处理方式：已结束的子代理重新标记为运行中；若它在更早的轮里，复制进当前轮，之后的事件都能在当前轮找到它。
import type { SubagentRun } from '@cosyee/shared';
import { cloneTurn, type ConvState, type Draft } from './core';

export interface RunKey {
  toolUseId?: string;
  taskId?: string;
  /** 兜底：按标题匹配（历史加载的会话可能没有 taskId） */
  title?: string;
}

function find(list: SubagentRun[], k: RunKey, byTitle: boolean): SubagentRun | undefined {
  for (let j = list.length - 1; j >= 0; j--) {
    const r = list[j];
    if (byTitle ? r.title === k.title : (!!k.toolUseId && r.toolUseId === k.toolUseId) || (!!k.taskId && r.taskId === k.taskId)) return r;
  }
  return undefined;
}

/** 当前轮之后从新到旧依次是更早的轮（s.turns 最后一项是 d.turn 的原件） */
function locate(s: ConvState, d: Draft, k: RunKey): { run: SubagentRun; here: boolean } | undefined {
  const passes = k.title ? [false, true] : [false];
  for (const byTitle of passes) {
    const here = find(d.turn.subagents, k, byTitle);
    if (here) return { run: here, here: true };
    for (let i = s.turns.length - 2; i >= 0; i--) {
      const old = find(s.turns[i].subagents, k, byTitle);
      if (old) return { run: old, here: false };
    }
  }
  return undefined;
}

/** 找到子代理并确保它在当前轮、处于运行中；找不到返回 undefined */
export function resolveRun(s: ConvState, d: Draft, k: RunKey): SubagentRun | undefined {
  const hit = locate(s, d, k);
  if (!hit) return undefined;
  let run = hit.run;
  if (!hit.here) {
    run = { ...run, afterStep: d.turn.steps.length, turn: cloneTurn(run.turn) };
    d.turn.subagents.push(run);
  }
  if (k.taskId && !run.taskId) run.taskId = k.taskId;
  if (run.status !== 'running') {
    // 已结束的 delegate 又有进度：只会是 delegate_send 让服务端在后台续跑，主轮不等它
    if (run.delegate === true) run.background = true;
    run.status = 'running';
    run.turn.status = 'running';
    delete run.turn.endedAt;
    delete run.turn.reason;
  }
  return run;
}
