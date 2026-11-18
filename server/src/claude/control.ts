// control_request / control_response 的收发配对：自增 request_id、按 id 匹配响应（可乱序）、超时。

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface Pending {
  resolve: (v: Json) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  subtype: string;
}

export class ControlTracker {
  private seq = 0;
  private pending = new Map<string, Pending>();

  /** write：把一个 JSON 对象写进 CLI 的 stdin。prefix 让不同会话的 id 好区分。 */
  constructor(
    private readonly write: (obj: Json) => void,
    private readonly prefix = 'cosyee',
    private readonly defaultTimeoutMs = 30_000,
  ) {}

  get pendingCount(): number {
    return this.pending.size;
  }

  /** 发一个 control_request，返回其 response 字段（success 时）。error / 超时 / 进程退出都会 reject。 */
  request(subtype: string, extra: Json = {}, timeoutMs: number = this.defaultTimeoutMs): Promise<Json> {
    const id = `${this.prefix}-${++this.seq}`;
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`control_request ${subtype} 超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, subtype });
      try {
        this.write({ type: 'control_request', request_id: id, request: { subtype, ...extra } });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** 处理 CLI 发来的 control_response；匹配上返回 true。 */
  handleResponse(msg: Json): boolean {
    const r = msg?.response;
    const id = r?.request_id;
    if (typeof id !== 'string') return false;
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (r.subtype === 'error') {
      const detail = typeof r.error === 'string' ? r.error : r.error_code ? String(r.error_code) : 'unknown error';
      p.reject(new Error(`${p.subtype}: ${detail}`));
    } else {
      p.resolve((r.response as Json) ?? {});
    }
    return true;
  }

  /** 进程退出 / 关闭时让所有未决请求失败。 */
  rejectAll(reason: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      this.pending.delete(id);
    }
  }
}
