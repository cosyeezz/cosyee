// 强制自动标题。CLI 自带的 ai-title 只在首条用户消息 >= 10 个字符时才生成（中文短句常常不够），
// 模型回空时只重试两次，之后整个进程都不再尝试，所以很多会话一直没有标题。
// 这里在每轮结束后检查：会话仍没有任何标题（用户标题 / ai-title）就主动发 control_request
// generate_session_title（persist: true）。CLI 用同一套提示词生成，并自己写入 ai-title
// （更新内存状态，不会被后续的元数据重写覆盖；已有标题或已有在途请求时直接返回那个结果）。

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** 素材上限（字符）：CLI 自己生成标题时也只取约 1000 字 */
export const MATERIAL_MAX = 2000;
/** 每个会话（本后端进程生命周期内）最多主动尝试几次；模型回空 / 请求失败都算一次 */
export const MAX_ATTEMPTS = 3;
/** generate_session_title 请求的超时（毫秒）：要调一次小模型 */
export const TITLE_TIMEOUT_MS = 60_000;

export interface AutoTitleDeps {
  /** 会话当前是否已有标题（用户标题或 ai-title）；读不到会话返回 null */
  hasTitle(id: string, cwd: string): Promise<boolean | null>;
  /** 会话首条真实用户消息（素材为空时兜底，例如重启后续聊、本进程没见过前面的对话） */
  firstPrompt(id: string, cwd: string): Promise<string | undefined>;
  /** 标题已写入：通知前端刷新列表 */
  onTitled(id: string, cwd: string): void;
}

/** 正在运行的会话进程里能发 control_request 的那部分 */
export interface TitleTarget {
  readonly sessionId: string;
  readonly alive: boolean;
  request(subtype: string, extra?: Json, timeoutMs?: number): Promise<Json>;
}

interface State {
  material: string;
  attempts: number;
  done: boolean;
  busy: boolean;
}

/** 从一个 CLI / 合成事件里取出可作素材的文本：用户发的消息 + assistant 的正文 */
export function eventText(e: unknown): string | null {
  const m = e as Json | null;
  if (!m || typeof m !== 'object') return null;
  if (m.type === 'cosyee_user') return typeof m.text === 'string' ? m.text : null;
  if (m.type === 'assistant' && !m.parent_tool_use_id) {
    const c = m.message?.content;
    if (!Array.isArray(c)) return null;
    const parts = c.filter((b: Json) => b?.type === 'text' && typeof b.text === 'string').map((b: Json) => b.text as string);
    return parts.length ? parts.join('\n') : null;
  }
  return null;
}

export class AutoTitle {
  private states = new Map<string, State>();

  constructor(private readonly deps: AutoTitleDeps) {}

  private state(id: string): State {
    let s = this.states.get(id);
    if (!s) this.states.set(id, (s = { material: '', attempts: 0, done: false, busy: false }));
    return s;
  }

  /** 每个事件都喂进来；只攒到 MATERIAL_MAX 为止（标题看开头就够） */
  collect(id: string, e: unknown): void {
    const s = this.state(id);
    if (s.done || s.material.length >= MATERIAL_MAX) return;
    const t = eventText(e)?.trim();
    if (!t) return;
    s.material = (s.material ? s.material + '\n\n' : '') + t;
    if (s.material.length > MATERIAL_MAX) s.material = s.material.slice(0, MATERIAL_MAX);
  }

  /** 一轮结束后调用：仍没有标题就让 CLI 生成一个。不抛错。 */
  async ensure(r: TitleTarget, cwd: string): Promise<void> {
    const id = r.sessionId;
    const s = this.state(id);
    if (s.done || s.busy || s.attempts >= MAX_ATTEMPTS || !r.alive) return;
    s.busy = true;
    try {
      const has = await this.deps.hasTitle(id, cwd);
      if (has !== false) {
        // 已有标题（CLI 自己生成了 / 用户改过名）；读不到会话文件则下一轮再看
        if (has) s.done = true;
        return;
      }
      const description = s.material || (await this.deps.firstPrompt(id, cwd))?.trim() || '';
      if (!description || !r.alive) return;
      s.attempts++;
      const res = await r.request('generate_session_title', { description, persist: true }, TITLE_TIMEOUT_MS);
      const title = typeof res?.title === 'string' ? res.title.trim() : '';
      if (title) {
        s.done = true;
        s.material = '';
        this.deps.onTitled(id, cwd);
      }
    } catch {
      /* 进程退出 / 超时 / 模型出错：下一轮再试（受 MAX_ATTEMPTS 限制） */
    } finally {
      s.busy = false;
    }
  }

  /** 会话被删除等场景可清理状态 */
  forget(id: string): void {
    this.states.delete(id);
  }
}
