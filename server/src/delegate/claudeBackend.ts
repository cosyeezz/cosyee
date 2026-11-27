// Claude CLI 无头委派后端：每次调用起一个 `claude -p --output-format stream-json --verbose` 子进程，
// 使用子代理账号的独立配置空间（CLAUDE_CONFIG_DIR 指向子代理空间，API / Kiro 环境变量仍从主代理账号目录读取），
// 禁用 Agent 工具防止递归委派，并把 stream-json 事件翻译成 ACP session/update 形状。
import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EFFORTS, PRIMARY_MODELS, type DelegateModelList, type Effort, type SubagentAvailability } from '@cosyee/shared';
import { DEFAULT_ID } from '../accounts/index.js';
import { apiFlagEnv, claudeEnv, findClaude, killTree, removePrivateSettings, spawnSpec, writePrivateSettings } from '../claude/bin.js';
import { type Json, LineSplitter, parseLine } from '../transcript.js';
import { BackendError, type BackendResult, type BackendRunOptions, type DelegateBackend } from './backend.js';
import { NATIVE_SUBAGENT_TOOLS } from './mcp.js';

const isWin = process.platform === 'win32';
const STDERR_TAIL_BYTES = 4 * 1024;
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/**
 * 与本机 Claude CLI 内置 Explore / Plan 的 disallowedTools 定义一致
 * （Agent 也在 NATIVE_SUBAGENT_TOOLS 中，合并时去重）
 */
export const READ_ONLY_DISALLOWED_TOOLS: readonly string[] = [
  'Agent',
  'Artifact',
  'ArtifactComments',
  'ArtifactData',
  'ArtifactCheck',
  'ExitPlanMode',
  'Edit',
  'Write',
  'NotebookEdit',
];

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Claude 工具名 -> ACP tool_call.kind（edit 让 DelegateJobs 统计 files_changed） */
function claudeToolKind(name: string): string {
  if (EDIT_TOOLS.has(name)) return 'edit';
  if (name === 'Read') return 'read';
  if (name === 'Bash' || name === 'PowerShell') return 'execute';
  if (name === 'Glob' || name === 'Grep') return 'search';
  return 'other';
}

function toolLocations(name: string, input: Json): { path: string }[] | undefined {
  if (!EDIT_TOOLS.has(name)) return undefined;
  const p = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : '';
  return p.trim() ? [{ path: p.trim() }] : undefined;
}

/** 把 Claude tool_result 的 content（字符串或内容块数组）压成文本 */
function normalizeToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === 'string') parts.push(item);
      else if (item && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string') parts.push(item.text);
    }
    return parts.join('\n');
  }
  if (content === undefined || content === null) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

export interface TranslatedResult {
  stopReason: string;
  response: string;
  usage?: Json;
  isError: boolean;
  errorMessage?: string;
}

export interface TranslateStep {
  updates: Json[];
  sessionId?: string;
  model?: string;
  result?: TranslatedResult;
}

/**
 * 纯函数状态机：把 Claude CLI `stream-json` 单条事件翻译成 ACP `session/update` 形状，
 * 同时汇总最终文本、完成的工具调用数与 result 帧，便于单元测试。
 */
export class ClaudeStreamTranslator {
  sessionId: string | undefined;
  model: string | undefined;
  result: TranslatedResult | undefined;
  private allText = '';
  private afterToolText = '';
  private readonly completedTools = new Set<string>();
  private readonly streamedTextForMsg = new Set<string>();
  private readonly streamedThinkForMsg = new Set<string>();
  private currentMsgId = '';
  private seq = 0;

  get toolCalls(): number {
    return this.completedTools.size;
  }

  get finalText(): string {
    return this.afterToolText.trim() ? this.afterToolText : this.allText;
  }

  push(msg: Json): TranslateStep {
    const step: TranslateStep = { updates: [] };
    if (!msg || typeof msg !== 'object') return step;

    if (msg.type === 'system' && msg.subtype === 'init') {
      if (typeof msg.session_id === 'string' && msg.session_id) {
        this.sessionId = msg.session_id;
        step.sessionId = msg.session_id;
      }
      if (typeof msg.model === 'string' && msg.model) {
        this.model = msg.model;
        step.model = msg.model;
      }
      return step;
    }

    if (msg.type === 'stream_event') {
      const ev = msg.event;
      if (ev?.type === 'message_start') {
        this.currentMsgId = typeof ev.message?.id === 'string' ? ev.message.id : '';
        if (!this.model && typeof ev.message?.model === 'string' && ev.message.model) {
          this.model = ev.message.model;
          step.model = ev.message.model;
        }
        return step;
      }
      if (ev?.type === 'message_stop') {
        this.currentMsgId = '';
        return step;
      }
      const apiMsgId = (typeof msg.api_message_id === 'string' && msg.api_message_id) || this.currentMsgId;
      if (ev?.type === 'content_block_delta' && ev.delta && typeof ev.delta === 'object') {
        const d = ev.delta as Json;
        if (d.type === 'text_delta' && typeof d.text === 'string' && d.text) {
          if (apiMsgId) this.streamedTextForMsg.add(apiMsgId);
          this.allText += d.text;
          this.afterToolText += d.text;
          step.updates.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: d.text } });
        } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string' && d.thinking) {
          if (apiMsgId) this.streamedThinkForMsg.add(apiMsgId);
          step.updates.push({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: d.thinking } });
        }
      }
      return step;
    }

    if (msg.type === 'assistant') {
      const m = msg.message;
      const mid = typeof m?.id === 'string' ? m.id : '';
      if (!this.model && typeof m?.model === 'string' && m.model) {
        this.model = m.model;
        step.model = m.model;
      }
      const blocks: Json[] = Array.isArray(m?.content) ? m.content : [];
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking) {
          if (!mid || !this.streamedThinkForMsg.has(mid)) {
            step.updates.push({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: b.thinking } });
          }
        } else if (b.type === 'text' && typeof b.text === 'string' && b.text) {
          if (!mid || !this.streamedTextForMsg.has(mid)) {
            this.allText += b.text;
            this.afterToolText += b.text;
            step.updates.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: b.text } });
          }
        } else if (b.type === 'tool_use') {
          this.afterToolText = '';
          const toolCallId = typeof b.id === 'string' && b.id ? b.id : `c${this.seq++}`;
          const name = typeof b.name === 'string' && b.name ? b.name : 'tool';
          const input: Json = b.input && typeof b.input === 'object' && !Array.isArray(b.input) ? b.input : {};
          const kind = claudeToolKind(name);
          const locations = toolLocations(name, input);
          step.updates.push({
            sessionUpdate: 'tool_call',
            toolCallId,
            name,
            title: name,
            kind,
            status: 'in_progress',
            rawInput: input,
            ...(locations ? { locations } : {}),
          });
        }
      }
      return step;
    }

    if (msg.type === 'user') {
      const blocks: Json[] = Array.isArray(msg.message?.content) ? msg.message.content : [];
      for (const b of blocks) {
        if (!b || typeof b !== 'object' || b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
        this.afterToolText = '';
        this.completedTools.add(b.tool_use_id);
        step.updates.push({
          sessionUpdate: 'tool_call_update',
          toolCallId: b.tool_use_id,
          status: b.is_error === true ? 'failed' : 'completed',
          rawOutput: normalizeToolResultContent(b.content),
        });
      }
      return step;
    }

    if (msg.type === 'result') {
      if (typeof msg.session_id === 'string' && msg.session_id) {
        this.sessionId = msg.session_id;
        step.sessionId = msg.session_id;
      }
      const subtype = typeof msg.subtype === 'string' ? msg.subtype : '';
      const isError = msg.is_error === true || (subtype !== '' && subtype !== 'success');
      const errFromList = Array.isArray(msg.errors)
        ? msg.errors.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).join('\n')
        : '';
      const text = typeof msg.result === 'string' ? msg.result : '';
      const usage = msg.usage && typeof msg.usage === 'object' ? (msg.usage as Json) : undefined;
      const stopReason = typeof msg.stop_reason === 'string' && msg.stop_reason ? msg.stop_reason : 'end_turn';
      const translated: TranslatedResult = {
        stopReason,
        response: text || this.finalText,
        ...(usage ? { usage } : {}),
        isError,
        ...(isError ? { errorMessage: text || errFromList || `Claude 委派执行失败（${subtype || 'error'}）` } : {}),
      };
      this.result = translated;
      step.result = translated;
    }

    return step;
  }
}

/** 计算本次 Claude 委派新会话实际采用的模型与强度 */
export function resolveClaudeDelegateParams(o: Pick<BackendRunOptions, 'sessionId' | 'defaults' | 'effort'>): {
  model: string | null;
  effort: Effort | null;
} {
  if (o.sessionId) return { model: null, effort: null };
  const model = o.defaults?.model ?? o.defaults?.parentModel ?? null;
  const effort = o.defaults?.effort ?? o.effort ?? o.defaults?.parentEffort ?? null;
  return { model, effort };
}

/** 构造无头 claude 委派子进程的命令行参数（不含可执行文件；prompt 经 stdin 写入） */
export function buildClaudeDelegateArgs(
  o: Pick<BackendRunOptions, 'sessionId' | 'systemPrompt' | 'defaults' | 'effort' | 'readOnly' | 'tools' | 'disallowedTools'>,
  claudePath: string,
  settingsFile?: string | null,
): string[] {
  const disallowed: string[] = [...NATIVE_SUBAGENT_TOOLS];
  if (o.disallowedTools?.length) {
    for (const t of o.disallowedTools) {
      const name = t.trim();
      if (name && !disallowed.includes(name)) disallowed.push(name);
    }
  }
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    // 禁止递归委派与原生子代理 / Agent Teams 工具（以及只读 / 自定义智能体禁用的工具）；子进程也不注册 cosyee MCP
    '--disallowedTools', disallowed.join(','),
  ];
  // --tools 只管内置工具：MCP 工具名（mcp__*）不传，带规则的写法（如 Bash(git:*)）取工具名；
  // frontmatter 写了 tools: 但为空时视为没写，免得把内置工具全部关掉
  const rawTools = (o.tools ?? []).map((t) => t.trim()).filter(Boolean);
  if (rawTools.length && !rawTools.includes('*')) {
    const allowed = [...new Set(rawTools.filter((t) => !t.startsWith('mcp__')).map((t) => t.replace(/\(.*$/, '').trim()).filter(Boolean))];
    args.push('--tools', allowed.join(','));
  }
  if (o.readOnly) {
    args.push('--permission-mode', 'plan');
  } else {
    args.push('--allow-dangerously-skip-permissions', '--permission-mode', 'bypassPermissions');
  }
  const { model, effort } = resolveClaudeDelegateParams(o);
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (!o.sessionId && o.systemPrompt) {
    // Windows 下 .cmd/.bat 经 cmd.exe 转发，换行会截断命令行
    const sp = isWin && /\.(cmd|bat)$/i.test(claudePath) ? o.systemPrompt.replace(/[\r\n]+/g, ' ') : o.systemPrompt;
    args.push('--append-system-prompt', sp);
  }
  if (settingsFile) args.push('--settings', settingsFile);
  if (o.sessionId) args.push('--resume', o.sessionId);
  return args;
}

export interface SubagentAccountContext {
  id: string;
  /** 传给 CLAUDE_CONFIG_DIR 的目录（子代理配置空间；未启用子代理空间时可为 null） */
  dir: string | null;
  /** 主代理账号目录（API / Kiro 环境变量的读取来源；默认账号为 null） */
  mainDir: string | null;
}

export interface ClaudeBackendOptions {
  /** 固定 claude 路径（null = 不可用）；不传则调用 findClaude() */
  claudePath?: string | null;
  resolve?: () => string | null;
  /** 新会话选用的子代理账号 id；不传则退回 o.account?.id 或 DEFAULT_ID */
  subagentAccountId?: () => string;
  /** 当前选中的 Claude 子代理账号是否已登录（便宜的本地检查，不启进程不联网）；不传默认为 true */
  isLoggedIn?: () => boolean;
  /** 启动子代理进程前准备其配置空间（建共享链接、同步 .claude.json、主→子同步凭据）；账号不存在返回 null */
  prepareAccount?: (accountId: string) => SubagentAccountContext | null;
  /** 子代理进程退出后回写凭据（子→主，较新者胜） */
  finishAccount?: (accountId: string) => void;
  /** 兼容旧调用：续接时按 accountId 找回账号目录；不传则只认主会话账号与默认账号 */
  resolveAccount?: (accountId: string) => { id: string; dir: string | null } | null;
  /** 测试用：替换 spawn / kill */
  spawn?: typeof nodeSpawn;
  kill?: (pid: number) => void;
  /** 收到 result / stdout 结束 / exit 后等待进程完全 close 的宽限时间（毫秒），默认 5000 */
  exitGraceMs?: number;
}

const DEFAULT_EXIT_GRACE_MS = 5000;

export class ClaudeBackend implements DelegateBackend {
  readonly id = 'claude';
  readonly label = 'Claude';
  private readonly fixedPath: string | null | undefined;
  private readonly resolveFn: () => string | null;
  private readonly subagentAccountIdFn?: () => string;
  private readonly isLoggedInFn?: () => boolean;
  private readonly prepareAccountFn?: ClaudeBackendOptions['prepareAccount'];
  private readonly finishAccountFn?: ClaudeBackendOptions['finishAccount'];
  private readonly resolveAccountFn?: ClaudeBackendOptions['resolveAccount'];
  private readonly spawnFn: typeof nodeSpawn;
  private readonly killFn: (pid: number) => void;
  private readonly exitGraceMs: number;
  /** 按账号 id 统计当前运行中的无头 Claude 子代理进程数 */
  private readonly activeByAccount = new Map<string, number>();

  constructor(opts: ClaudeBackendOptions = {}) {
    this.fixedPath = opts.claudePath;
    this.resolveFn = opts.resolve ?? findClaude;
    this.subagentAccountIdFn = opts.subagentAccountId;
    this.isLoggedInFn = opts.isLoggedIn;
    this.prepareAccountFn = opts.prepareAccount;
    this.finishAccountFn = opts.finishAccount;
    this.resolveAccountFn = opts.resolveAccount;
    this.spawnFn = opts.spawn ?? nodeSpawn;
    this.killFn = opts.kill ?? killTree;
    this.exitGraceMs = opts.exitGraceMs ?? DEFAULT_EXIT_GRACE_MS;
  }

  private getPath(): string | null {
    if (this.fixedPath !== undefined) return this.fixedPath;
    return this.resolveFn();
  }

  private pickAccount(o: BackendRunOptions): SubagentAccountContext {
    const isResume = !!(o.sessionId && o.accountId);
    const targetId = isResume ? o.accountId! : (this.subagentAccountIdFn?.() ?? o.account?.id ?? DEFAULT_ID);

    if (this.prepareAccountFn) {
      let prepared: SubagentAccountContext | null;
      try {
        prepared = this.prepareAccountFn(targetId);
      } catch (e) {
        throw new BackendError(errMsg(e), o.sessionId, targetId);
      }
      if (!prepared) {
        throw new BackendError(
          isResume ? '创建这个委派会话的账号已移除，请新建委派' : '子代理账号不存在，请在账号管理里重新选择',
          o.sessionId,
          targetId,
        );
      }
      return prepared;
    }

    if (isResume) {
      if (o.account && o.account.id === targetId) return { id: o.account.id, dir: o.account.dir, mainDir: o.account.dir };
      if (this.resolveAccountFn) {
        const found = this.resolveAccountFn(targetId);
        if (!found) throw new BackendError('创建这个委派会话的账号已移除，请新建委派', o.sessionId, targetId);
        return { id: found.id, dir: found.dir, mainDir: found.dir };
      }
      if (targetId === DEFAULT_ID) return { id: DEFAULT_ID, dir: null, mainDir: null };
      throw new BackendError('创建这个委派会话的账号已移除，请新建委派', o.sessionId, targetId);
    }
    const base = o.account ?? { id: DEFAULT_ID, dir: null };
    return { id: base.id, dir: base.dir, mainDir: base.dir };
  }

  availability(): SubagentAvailability {
    if (this.getPath() === null) return { ok: false, reason: '未安装 Claude CLI' };
    if (this.isLoggedInFn && !this.isLoggedInFn()) return { ok: false, reason: 'Claude 子代理账号未登录' };
    return { ok: true };
  }

  available(): boolean {
    return this.availability().ok;
  }

  /** 当前运行中的 Claude 委派子进程数（传 accountId 时仅统计该账号，不传返回总数） */
  runningCount(accountId?: string): number {
    if (accountId !== undefined) return this.activeByAccount.get(accountId) ?? 0;
    let total = 0;
    for (const n of this.activeByAccount.values()) total += n;
    return total;
  }

  async models(): Promise<DelegateModelList> {
    const allEfforts = EFFORTS.map((e) => e.id);
    return {
      models: PRIMARY_MODELS.map((m) => ({ value: m.id, displayName: m.label, efforts: [...allEfforts] })),
      current: null,
      at: Date.now(),
    };
  }

  async run(o: BackendRunOptions): Promise<BackendResult> {
    if (o.signal.aborted) throw new Error('已取消');
    const claudePath = this.getPath();
    if (!claudePath) throw new Error('未安装 Claude CLI');

    const account = this.pickAccount(o);
    const env = claudeEnv(account.dir, account.mainDir);
    const apiEnv = apiFlagEnv(account.mainDir);
    let settingsFile: string | null = null;
    let chosenEffort: Effort | null;
    let spec: ReturnType<typeof spawnSpec>;
    try {
      if (apiEnv) {
        settingsFile = writePrivateSettings(`delegate-${randomUUID()}`, { env: apiEnv });
      }
      ({ effort: chosenEffort } = resolveClaudeDelegateParams(o));
      const args = buildClaudeDelegateArgs(o, claudePath, settingsFile);
      spec = spawnSpec(claudePath, args);
    } catch (e) {
      removePrivateSettings(settingsFile);
      throw e;
    }

    return new Promise<BackendResult>((resolve, reject) => {
      let settled = false;
      let aborted = false;
      let finishedAccount = false;
      let activeTracked = false;
      let stderrTail = '';
      let reportedSession: string | undefined;
      let reportedModel = false;
      let exitGraceTimer: ReturnType<typeof setTimeout> | null = null;
      let resultGraceTimer: ReturnType<typeof setTimeout> | null = null;
      let proc: ReturnType<typeof nodeSpawn> | null = null;
      const translator = new ClaudeStreamTranslator();
      const splitter = new LineSplitter();

      const decActiveOnce = () => {
        if (!activeTracked) return;
        activeTracked = false;
        const n = (this.activeByAccount.get(account.id) ?? 0) - 1;
        if (n > 0) this.activeByAccount.set(account.id, n);
        else this.activeByAccount.delete(account.id);
      };

      const finishAccountOnce = () => {
        if (finishedAccount) return;
        finishedAccount = true;
        try {
          this.finishAccountFn?.(account.id);
        } catch { /* 回写失败不阻断结果返回 */ }
      };

      const onAbort = () => {
        aborted = true;
        if (proc?.pid) {
          try {
            this.killFn(proc.pid);
          } catch { /* ignore */ }
        }
        done(() => reject(new Error('已取消')));
      };

      const cleanup = () => {
        decActiveOnce();
        o.signal.removeEventListener('abort', onAbort);
        if (exitGraceTimer) {
          clearTimeout(exitGraceTimer);
          exitGraceTimer = null;
        }
        if (resultGraceTimer) {
          clearTimeout(resultGraceTimer);
          resultGraceTimer = null;
        }
        removePrivateSettings(settingsFile);
        settingsFile = null;
      };
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const settleFromExit = (code: number | null, sig: NodeJS.Signals | null, whyOverride?: string) => {
        finishAccountOnce();
        for (const line of splitter.flush()) consumeLine(line);
        if (aborted) return done(() => reject(new Error('已取消')));
        const sid = translator.sessionId ?? o.sessionId ?? '';
        const res = translator.result;
        if (res) {
          if (res.isError) {
            return done(() => reject(new BackendError(res.errorMessage ?? 'Claude 委派执行失败', sid || undefined, account.id)));
          }
          return done(() =>
            resolve({
              stopReason: res.stopReason,
              response: res.response,
              sessionId: sid,
              accountId: account.id,
              toolCalls: translator.toolCalls,
              ...(res.usage ? { usage: res.usage } : {}),
            }),
          );
        }
        if (code === 0 && translator.finalText) {
          return done(() =>
            resolve({
              stopReason: 'end_turn',
              response: translator.finalText,
              sessionId: sid,
              accountId: account.id,
              toolCalls: translator.toolCalls,
            }),
          );
        }
        const tail = stderrTail.trim();
        const why = whyOverride ?? (sig ? `被信号 ${sig} 终止` : `退出码 ${code}`);
        done(() =>
          reject(
            new BackendError(
              `Claude 委派进程异常退出（${why}）${tail ? `\n${tail}` : ''}`,
              sid || undefined,
              account.id,
            ),
          ),
        );
      };

      const armResultGrace = (reason: string) => {
        if (settled || resultGraceTimer) return;
        resultGraceTimer = setTimeout(() => {
          resultGraceTimer = null;
          if (settled) return;
          if (proc?.pid) {
            try {
              this.killFn(proc.pid);
            } catch { /* ignore */ }
          }
          settleFromExit(null, null, reason);
        }, this.exitGraceMs);
        resultGraceTimer.unref?.();
      };

      try {
        proc = this.spawnFn(spec.command, spec.args, {
          cwd: o.cwd,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          windowsVerbatimArguments: spec.verbatim,
        });
      } catch (e) {
        cleanup();
        reject(new BackendError(`无法启动 Claude 委派进程: ${errMsg(e)}`, o.sessionId, account.id));
        return;
      }

      activeTracked = true;
      this.activeByAccount.set(account.id, (this.activeByAccount.get(account.id) ?? 0) + 1);
      o.signal.addEventListener('abort', onAbort, { once: true });

      const consumeLine = (line: string) => {
        if (settled) return;
        const msg = parseLine(line);
        if (!msg) return;
        const step = translator.push(msg);
        if (step.sessionId && step.sessionId !== reportedSession) {
          reportedSession = step.sessionId;
          try {
            o.onSession?.(step.sessionId, account.id);
          } catch { /* 回调出错不影响执行 */ }
        }
        if (step.model && !reportedModel) {
          reportedModel = true;
          try {
            o.onModel?.({ model: step.model, effort: chosenEffort });
          } catch { /* 展示出错不影响执行 */ }
        }
        for (const u of step.updates) {
          try {
            o.onUpdate?.(u);
          } catch { /* 展示出错不影响执行 */ }
        }
        if (step.result) armResultGrace('输出结束后进程未退出');
      };

      proc.stdout?.on('data', (d: Buffer | string) => {
        for (const line of splitter.push(d)) consumeLine(line);
      });
      proc.stdout?.on('end', () => {
        for (const line of splitter.flush()) consumeLine(line);
        armResultGrace('stdout 结束后进程未退出');
      });
      proc.stderr?.on('data', (d: Buffer | string) => {
        stderrTail = (stderrTail + d.toString()).slice(-STDERR_TAIL_BYTES);
      });
      proc.stdin?.on('error', () => { /* 进程提前退出时的 EPIPE 由 close 处理 */ });
      proc.on('error', (err) => {
        done(() => reject(new BackendError(`无法启动 Claude 委派进程: ${err.message}`, translator.sessionId ?? o.sessionId, account.id)));
      });
      proc.on('exit', (code, sig) => {
        if (settled || exitGraceTimer) return;
        exitGraceTimer = setTimeout(() => {
          exitGraceTimer = null;
          if (settled) return;
          proc?.stdout?.destroy();
          proc?.stderr?.destroy();
          settleFromExit(code, sig);
        }, Math.min(this.exitGraceMs, 1000));
        exitGraceTimer.unref?.();
      });
      proc.on('close', (code, sig) => {
        settleFromExit(code, sig);
      });

      // 通过 stdin 传入 prompt，避开 Windows 命令行长度与换行限制
      try {
        proc.stdin?.end(o.prompt);
      } catch { /* 由 close 处理 */ }
    });
  }
}
