// Cosyee 自己充当进程内（SDK 类型）MCP 服务器 "cosyee"，提供 delegate 系列工具。
// claude CLI 经 control_request(mcp_message) 把 JSON-RPC 转给我们，runner 负责收发，这里只管协议层；
// 工具逻辑与任务状态在 DelegateJobs（jobs.ts，由 Manager 持有，比 runner / CLI 进程活得久）。
import type { Json } from '../transcript.js';
import { agentNamesLine, BUILTIN_AGENTS, type DelegateAgent } from './agents.js';
import type { BackendResult, BackendRunOptions } from './backend.js';
import type { DelegateCtx, DelegateJobs } from './jobs.js';

export const MCP_SERVER = 'cosyee';
export const DELEGATE_TOOL_NAME = 'mcp__cosyee__delegate';

/** 直接加载，不经 ToolSearch */
const ALWAYS_LOAD = { 'anthropic/alwaysLoad': true };
const READ_ONLY = { readOnlyHint: true };

export function delegateTool(agents: DelegateAgent[]) {
  const others = agentNamesLine(agents);
  const agentBullet =
    '- agent: which agent runs it, by name; default general-purpose. Explore: read-only search that reports evidence. Plan: read-only design. general-purpose: research and implementation.' +
    (others ? ` Others: ${others}.` : '') +
    ' Call delegate_agents to see what each one is for.';
  return {
    name: 'delegate',
    description: [
      'Launch a delegate agent on a self-contained task in the same directory. It can read and edit files and run commands there.',
      '',
      agentBullet,
      '- It starts cold and cannot see this conversation, so the prompt must be complete.',
      '- A new call starts fresh. To continue an earlier one with its context intact, use delegate_send.',
      "- The agent's final reply is not shown to the user: relay what matters, and review what it changed yourself.",
      '- Runs in the background by default: the call returns a conversation_id at once, so carry on with other work (or end your turn if there is none). On completion a <cosyee-delegate-notification> with a result_id arrives automatically; read it with delegate_result when you are ready for it.',
      '- Independent delegates launched in the same message run in parallel.',
      '- Pass run_in_background: false only when your very next action depends on the result and nothing else could usefully happen meanwhile; the call then blocks and returns the final reply.',
      "- Never fabricate or predict a pending delegate's result. If the user asks before it arrives, say it is still running.",
      '- Delegates share your working tree: do not edit the files a background one is working on, and give parallel delegates disjoint files.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Short 3-6 word label shown in the UI' },
        prompt: { type: 'string', description: 'Complete, self-contained instructions: the goal, the relevant files and any not to touch, acceptance criteria, and what to report back' },
        agent: { type: 'string', description: 'Agent name; default general-purpose' },
        conversation_id: { type: 'string', description: 'Continue an earlier delegate conversation instead of starting fresh' },
        run_in_background: { type: 'boolean', description: 'Default true: return at once and get notified when the task finishes. false blocks until it is done' },
      },
      required: ['description', 'prompt'],
    },
    annotations: READ_ONLY,
    _meta: ALWAYS_LOAD,
  };
}

export const DELEGATE_TOOL = delegateTool(BUILTIN_AGENTS);

export const DELEGATE_SEND_TOOL = {
  name: 'delegate_send',
  description: [
    'Send a message to an existing delegate conversation, keeping its context.',
    '',
    "- Running, mode steer (default): interrupts the agent's current turn and immediately re-prompts it with your message. Its history is kept; a tool call in progress gets up to 30 seconds to finish, then is aborted.",
    '- Running, mode queue: runs after the current turn ends; the final result contains every reply.',
    '- Finished or stopped: resumes the conversation in the background, and you are notified when it finishes.',
    '',
    'Returns immediately. Your plain text output is not visible to the agent; to send it a correction or more work, call this rather than launching a new delegate.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      conversation_id: { type: 'string', description: 'conversation_id of the delegate conversation' },
      message: { type: 'string', description: 'The follow-up instructions' },
      mode: { type: 'string', enum: ['steer', 'queue'], description: 'How to deliver to a running delegate; default steer' },
    },
    required: ['conversation_id', 'message'],
  },
  annotations: READ_ONLY,
  _meta: ALWAYS_LOAD,
};

export const DELEGATE_STOP_TOOL = {
  name: 'delegate_stop',
  description: [
    '- Stops a running delegate by its conversation_id, foreground or background',
    '- Returns the output it produced so far; files it already changed stay changed',
    '- No completion notification follows; resume it later with delegate_send',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: { conversation_id: { type: 'string', description: 'conversation_id of the delegate conversation' } },
    required: ['conversation_id'],
  },
  annotations: READ_ONLY,
  _meta: ALWAYS_LOAD,
};

export const DELEGATE_RESULT_TOOL = {
  name: 'delegate_result',
  description: [
    'Read the full result of a finished background delegate by the result_id in its <cosyee-delegate-notification>.',
    '',
    '- A result_id exists only once the delegate has finished, so this cannot check progress: wait for the notification.',
    '- The notification carries only the id so it does not derail you: read the result when you reach the point of using it, and before you report on or build upon that work.',
    '- Long results come in parts: pass the offset it gives you to continue.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      result_id: { type: 'string', description: 'result_id from the completion notification' },
      offset: { type: 'number', description: 'Character position to start from; default 0' },
    },
    required: ['result_id'],
  },
  annotations: READ_ONLY,
  _meta: ALWAYS_LOAD,
};

export const DELEGATE_AGENTS_TOOL = {
  name: 'delegate_agents',
  description: 'List the agents delegate can run and what each one is for. Optional query filters by name or description.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Optional filter matching agent name or description' },
    },
  },
  annotations: READ_ONLY,
};

export const DELEGATE_TOOLS = [DELEGATE_TOOL, DELEGATE_SEND_TOOL, DELEGATE_STOP_TOOL, DELEGATE_RESULT_TOOL, DELEGATE_AGENTS_TOOL];
/** 带 mcp__cosyee__ 前缀的完整工具名（放行权限用） */
export const DELEGATE_TOOL_NAMES = DELEGATE_TOOLS.map((t) => `mcp__${MCP_SERVER}__${t.name}`);

/** 告诉前端某次子代理调用实际用的模型 / 强度（调用参数里看不到补上的默认值） */
export function agentParamsEvent(toolUseId: string, model: string | null | undefined, effort: string | null | undefined): Json {
  return { type: 'system', subtype: 'cosyee_agent_params', tool_use_id: toolUseId, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

export type RunFn = (o: BackendRunOptions) => Promise<BackendResult>;

const toolError = (text: string): Json => ({ content: [{ type: 'text', text }], isError: true });

export class CosyeeMcp {
  private readonly jobs: DelegateJobs;
  private readonly ctx: () => DelegateCtx;
  private readonly tools: readonly Json[];
  /** 进行中的 tools/call（前台调用）：JSON-RPC id -> 取消器 */
  private inflight = new Map<string, AbortController>();

  /** jobs：任务状态机（共享、长寿）；ctx：每次调用时读取工作目录 / 后端 / 默认模型 / 智能体范围 */
  constructor(o: { jobs: DelegateJobs; ctx: () => DelegateCtx; agents: DelegateAgent[] }) {
    this.jobs = o.jobs;
    this.ctx = o.ctx;
    this.tools = [delegateTool(o.agents), DELEGATE_SEND_TOOL, DELEGATE_STOP_TOOL, DELEGATE_RESULT_TOOL, DELEGATE_AGENTS_TOOL];
  }

  async handle(msg: Json): Promise<Json> {
    const id = msg?.id;
    const method = msg?.method;
    const params: Json = msg?.params && typeof msg.params === 'object' ? msg.params : {};
    if (id === undefined || id === null) {
      // 通知：notifications/cancelled 中止对应调用，其余只确认
      if (method === 'notifications/cancelled') this.inflight.get(String(params.requestId))?.abort();
      return { jsonrpc: '2.0', id: 0, result: {} };
    }
    const ok = (result: Json): Json => ({ jsonrpc: '2.0', id, result });
    switch (method) {
      case 'initialize':
        return ok({
          protocolVersion: params.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: MCP_SERVER, version: '1' },
        });
      case 'tools/list':
        return ok({ tools: this.tools });
      case 'tools/call':
        return ok(await this.call(id, params));
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${String(method)}` } };
    }
  }

  /** 中止所有进行中的调用（会话进程退出时）。只中止「等待」：后台任务本身继续跑 */
  abortAll(): void {
    for (const c of this.inflight.values()) c.abort();
  }

  private async call(id: string | number, params: Json): Promise<Json> {
    const name = String(params.name);
    if (!this.tools.some((t) => t.name === name)) return toolError(`未知工具: ${name}`);
    const a: Json = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    const meta: Json = params._meta && typeof params._meta === 'object' ? params._meta : {};
    const toolUseId = typeof meta['claudecode/toolUseId'] === 'string' ? meta['claudecode/toolUseId'] : '';
    const key = String(id);
    const ctl = new AbortController();
    this.inflight.set(key, ctl);
    try {
      return await this.jobs.callTool(name, a, this.ctx(), toolUseId, ctl.signal);
    } catch (e) {
      return toolError(e instanceof Error ? e.message : String(e));
    } finally {
      if (this.inflight.get(key) === ctl) this.inflight.delete(key);
    }
  }
}
