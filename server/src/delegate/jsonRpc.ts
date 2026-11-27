// 通用的按行 JSON-RPC 2.0 连接（Codex app-server 用；AcpProc 仍用自己那套，保持不动）。
// 只管线路：行拆分（UTF-8 安全）、请求 id 关联与超时、通知、服务端发起的请求（带应答）、stderr 尾部缓存（脱敏）、整体失败。
import { type Json, LineSplitter } from '../transcript.js';
import { RpcError } from './codexProtocol.js';

export type RequestId = number | string;

export interface JsonRpcOptions {
  /** 写一行（已含换行）到对端 stdin；返回 false 表示写失败（连接不再可用） */
  write: (line: string) => boolean | void;
  /** 请求默认超时（毫秒）；0 / 不传 = 不超时 */
  timeoutMs?: number;
  /** 服务端通知（没有 id 的消息） */
  onNotification?: (method: string, params: any) => void;
  /**
   * 服务端发起的请求（有 id 和 method）：返回值（可为 Promise）作为 result 回给对端；
   * 抛出 RpcError 回对应错误码，抛出其它错误回 -32603。不设置 = 一律回 -32601。
   */
  onServerRequest?: (method: string, params: any, id: RequestId) => unknown | Promise<unknown>;
  /** 收到一行无法解析为 JSON 的输出（诊断用） */
  onGarbage?: (line: string) => void;
  /** stderr 尾部保留字节数，默认 4KB */
  stderrTailBytes?: number;
}

interface Pending {
  method: string;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout | null;
  cleanup: (() => void) | null;
}

/** 脱敏：常见密钥 / token 形态替换成 ***（stderr 尾巴会进错误消息，可能展示给用户 / 模型） */
export function redactSecrets(s: string): string {
  return s
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,})/g, '***jwt***')
    .replace(/("?(?:access_token|refresh_token|id_token|api[_-]?key|authorization|token)"?\s*[:=]\s*"?)[^\s",}]{6,}/gi, '$1***');
}

export class JsonRpcConnection {
  private readonly out = new LineSplitter();
  private readonly err = new LineSplitter();
  private readonly pending = new Map<RequestId, Pending>();
  private nextId = 1;
  private failure: Error | null = null;
  private tail = '';
  /** 事件处理器可在构造后替换 */
  onNotification: JsonRpcOptions['onNotification'];
  onServerRequest: JsonRpcOptions['onServerRequest'];
  onGarbage: JsonRpcOptions['onGarbage'];

  constructor(private readonly o: JsonRpcOptions) {
    this.onNotification = o.onNotification;
    this.onServerRequest = o.onServerRequest;
    this.onGarbage = o.onGarbage;
  }

  get closed(): boolean {
    return this.failure !== null;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** 脱敏后的 stderr 尾部 */
  get stderrTail(): string {
    return this.tail.trim();
  }

  /** 喂入 stdout 数据 */
  feed(chunk: Buffer | string): void {
    for (const line of this.out.push(chunk)) this.handleLine(line);
  }

  /** stdout 结束：处理最后没有换行的残留 */
  end(): void {
    for (const line of this.out.flush()) this.handleLine(line);
  }

  /** 喂入 stderr 数据（只缓存尾部，不解析） */
  feedStderr(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const max = this.o.stderrTailBytes ?? 4 * 1024;
    this.tail = redactSecrets(this.tail + text).slice(-max);
  }

  request<T = any>(method: string, params?: unknown, opt: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const p: Pending = { method, resolve, reject, timer: null, cleanup: null };
      const ms = opt.timeoutMs ?? this.o.timeoutMs ?? 0;
      if (ms > 0) {
        p.timer = setTimeout(() => {
          this.settle(id)?.reject(new RpcError(`请求超时：${method}（${Math.round(ms / 1000)} 秒）`, -32000));
        }, ms);
      }
      if (opt.signal) {
        const sig = opt.signal;
        const onAbort = () => this.settle(id)?.reject(new Error('已取消'));
        if (sig.aborted) {
          reject(new Error('已取消'));
          return;
        }
        sig.addEventListener('abort', onAbort, { once: true });
        p.cleanup = () => sig.removeEventListener('abort', onAbort);
      }
      this.pending.set(id, p);
      if (!this.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })) {
        this.settle(id)?.reject(this.failure ?? new Error('写入失败'));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.failure) return;
    this.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  /** 连接整体失败（进程退出 / 出错）：所有未完成请求立刻 reject，之后的请求也直接 reject */
  failAll(err: Error): void {
    if (this.failure) return;
    this.failure = err;
    for (const id of [...this.pending.keys()]) this.settle(id)?.reject(err);
  }

  private settle(id: RequestId): Pending | null {
    const p = this.pending.get(id);
    if (!p) return null;
    this.pending.delete(id);
    if (p.timer) clearTimeout(p.timer);
    p.cleanup?.();
    return p;
  }

  private send(msg: Json): boolean {
    let ok: boolean | void;
    try {
      ok = this.o.write(`${JSON.stringify(msg)}\n`);
    } catch {
      ok = false;
    }
    return ok !== false;
  }

  private handleLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      this.onGarbage?.(line);
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    const hasId = msg.id !== undefined && msg.id !== null;
    if (typeof msg.method === 'string') {
      if (hasId) this.handleServerRequest(msg.id, msg.method, msg.params);
      else {
        try {
          this.onNotification?.(msg.method, msg.params);
        } catch { /* 通知处理器的错误不能打断读循环 */ }
      }
      return;
    }
    if (!hasId) return;
    const p = this.settle(msg.id);
    if (!p) return;
    if (msg.error && typeof msg.error === 'object') {
      p.reject(new RpcError(String(msg.error.message ?? `${p.method} 失败`), typeof msg.error.code === 'number' ? msg.error.code : undefined, msg.error.data));
    } else {
      p.resolve(msg.result);
    }
  }

  private handleServerRequest(id: RequestId, method: string, params: unknown): void {
    const reply = (m: Json) => {
      if (!this.failure) this.send({ jsonrpc: '2.0', id, ...m });
    };
    const handler = this.onServerRequest;
    if (!handler) {
      reply({ error: { code: -32601, message: `Method not found: ${method}` } });
      return;
    }
    let r: unknown;
    try {
      r = handler(method, params, id);
    } catch (e) {
      reply({ error: rpcErrorBody(e) });
      return;
    }
    if (r && typeof (r as Promise<unknown>).then === 'function') {
      (r as Promise<unknown>).then(
        (v) => reply({ result: v ?? null }),
        (e) => reply({ error: rpcErrorBody(e) }),
      );
    } else {
      reply({ result: r ?? null });
    }
  }
}

function rpcErrorBody(e: unknown): { code: number; message: string } {
  if (e instanceof RpcError) return { code: e.code ?? -32603, message: e.message };
  return { code: -32603, message: e instanceof Error ? e.message : String(e) };
}
