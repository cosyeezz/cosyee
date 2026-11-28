// 前端访问后端的唯一入口。UI 组件只调用这里的函数；开发阶段可以用 web/src/mock 下的数据代替。
import type {
  AgyAccountList, BrowserHistoryItem, BrowserHover, BrowserPickResult, BrowserProfileStatus, BrowserStatus, CodexAccountList, CodexLoginMethod, DelegateModelList, Account, AccountDedupeResult, AccountList, AccountLogin, AccountMode, ApiAuthType, ApiModelListing, ApiModelMap, Bootstrap, CliModelList, BrowseDir, ComponentId, ComponentList, ComponentStatus, ClientMsg, ContextUsage, DeletedSession, ExecResult, ExecStreamMsg, FilePreview, KiroBalance, KiroLoginMethod, KiroStatus, PickedItem, PreviewInfo, PriceTable, ServerMsg, SessionConfig, SessionDetail, SessionSummary, SkillContent, SkillMode, SpeechKind, SpeechStatus, SubagentConfig, SubagentState, TtsPrepared, SubagentCost, ToolStats, UsageInfo, Workspace,
} from '@cosyee/shared';
import { localPathHref } from '@cosyee/shared';
import type {
  TwoFaCreateEntryInput,
  TwoFaCreateGroupInput,
  TwoFaCreateTagInput,
  TwoFaData,
  TwoFaDeleteGroupMode,
  TwoFaEntry,
  TwoFaGroup,
  TwoFaImportInput,
  TwoFaImportResult,
  TwoFaImportPreviewInput,
  TwoFaImportPreviewResult,
  TwoFaPatchEntryInput,
  TwoFaPatchGroupInput,
  TwoFaPatchTagInput,
  TwoFaSync,
  TwoFaTag,
  TwoFaUsage,
} from './twofa/types';

/** 文件预览请求的目标：session + cwd 用于服务端确定授权范围，path 是会话里出现的路径（相对 / 绝对均可） */
export interface FileTarget {
  session: string;
  cwd?: string;
  path: string;
  line?: number;
}

/** path 按「文件系统路径」转义成 href（% # ? 不被当成 URL 语法），#L12 行号作为 fragment 附在后面 */
function fileQuery(t: FileTarget): string {
  const q = new URLSearchParams({ session: t.session, path: localPathHref(t.path) + (t.line ? `#L${t.line}` : '') });
  if (t.cwd) q.set('cwd', t.cwd);
  return q.toString();
}

async function req<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

/** 带 HTTP 状态和响应体的错误（比如切换账号时的 409 { error, running }） */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly data: Record<string, unknown>) {
    super(message);
  }
}

async function reqDetailed<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(typeof data.error === 'string' ? data.error : `HTTP ${res.status}`, res.status, data);
  return data as T;
}

const q = (o: Record<string, string>) => new URLSearchParams(o).toString();

export const api = {
  bootstrap: () => req<Bootstrap>('GET', '/api/bootstrap'),
  /** 语音：模型状态 / 触发下载 / 朗读准备 / 音频地址 / 识别 */
  speechStatus: () => req<SpeechStatus>('GET', '/api/speech/status'),
  speechPrepare: (kind: SpeechKind) => req<SpeechStatus>('POST', '/api/speech/prepare', { kind }),
  ttsPrepare: (text: string) => req<TtsPrepared>('POST', '/api/tts', { text }),
  ttsAudioUrl: (id: string, i: number) => `/api/tts/${encodeURIComponent(id)}/${i}`,
  /** 请求体是原始 PCM 而不是 JSON，所以不走 req */
  stt: async (pcm: Int16Array, rate: number): Promise<{ text: string }> => {
    const res = await fetch(`/api/stt?rate=${rate}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Blob([pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer]),
    });
    const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return { text: data.text ?? '' };
  },
  workspaces: () => req<{ current: string | null; list: Workspace[] }>('GET', '/api/workspaces'),
  pickWorkspace: () => req<{ workspace: Workspace | null }>('POST', '/api/workspaces/pick'),
  /** 远程连接：网页版选择窗口里选好的工作空间文件夹 */
  openWorkspace: (path: string) => req<{ workspace: Workspace }>('POST', '/api/workspaces/open', { path }),
  setCurrentWorkspace: (path: string) => req<{ ok: true }>('POST', '/api/workspaces/current', { path }),
  /** 置于顶部 / 从列表移除 / 在文件管理器打开：都返回最新的工作空间列表（reveal 只返回 ok） */
  moveWorkspaceTop: (path: string) => req<{ current: string | null; list: Workspace[] }>('POST', '/api/workspaces/top', { path }),
  removeWorkspace: (path: string) => req<{ current: string | null; list: Workspace[] }>('POST', '/api/workspaces/remove', { path }),
  revealWorkspace: (path: string) => req<{ ok: true }>('POST', '/api/workspaces/reveal', { path }),
  /** 全局置顶（跨工作空间）与已删除 */
  pins: () => req<SessionSummary[]>('GET', '/api/pins'),
  deleted: () => req<DeletedSession[]>('GET', '/api/deleted'),
  pinSession: (id: string, cwd: string) => req<{ ok: true }>('POST', `/api/sessions/${id}/pin`, { cwd }),
  unpinSession: (id: string) => req<{ ok: true }>('POST', `/api/sessions/${id}/unpin`, {}),
  deleteSession: (id: string, cwd: string) => req<{ ok: true }>('POST', `/api/sessions/${id}/delete`, { cwd }),
  restoreSession: (id: string) => req<{ ok: true }>('POST', `/api/sessions/${id}/restore`, {}),
  purgeSession: (id: string) => req<{ ok: true }>('POST', `/api/sessions/${id}/purge`, {}),
  /** 批量：都传界面上看到的那些 id */
  deleteSessions: (cwd: string, ids: string[]) =>
    req<{ deleted: number; skipped: number }>('POST', '/api/sessions/delete-many', { cwd, ids }),
  restoreDeleted: (ids: string[]) => req<{ restored: number }>('POST', '/api/deleted/restore', { ids }),
  purgeDeleted: (ids: string[]) =>
    req<{ purged: number; failed: number; error: string | null }>('POST', '/api/deleted/purge', { ids }),
  sessions: (cwd: string) => req<SessionSummary[]>('GET', `/api/sessions?${q({ cwd })}`),
  sessionDetail: (id: string, cwd: string) => req<SessionDetail>('GET', `/api/sessions/${id}/detail?${q({ cwd })}`),
  history: (id: string, cwd: string, since?: string) =>
    req<{ version?: string; entries?: unknown[]; unchanged?: true }>('GET', `/api/sessions/${id}/history?${q(since ? { cwd, since } : { cwd })}`),
  subagent: (id: string, toolUseId: string, cwd: string) =>
    req<{ entries: unknown[] }>('GET', `/api/sessions/${id}/subagent/${toolUseId}?${q({ cwd })}`),
  /** 会话里各子代理的花费（服务端读子代理记录、按价格表算） */
  subagentCosts: (id: string, cwd: string) => req<{ items: SubagentCost[] }>('GET', `/api/sessions/${id}/subagent-costs?${q({ cwd })}`),
  rename: (id: string, cwd: string, title: string) => req<{ ok: true }>('POST', `/api/sessions/${id}/rename`, { cwd, title }),
  /** 分支：把 targetId 这条用户消息之前（省略 targetId 则整份）的记录复制成一个新会话（源会话不变），返回新会话 id */
  forkSession: (id: string, cwd: string, targetId?: string) =>
    req<{ sessionId: string }>('POST', `/api/sessions/${id}/fork`, targetId !== undefined ? { cwd, targetId } : { cwd }),
  viewed: (id: string, cwd: string) => req<{ ok: true }>('POST', `/api/sessions/${id}/viewed`, { cwd }),
  git: (cwd: string) => req<{ branch: string | null }>('GET', `/api/git?${q({ cwd })}`),
  /** 额度：传会话 id 时取该会话所用账号的额度（并行模式下各会话账号可能不同） */
  usage: (refresh = false, session?: string | null, account?: string | null) => {
    const p: Record<string, string> = {};
    if (refresh) p.refresh = '1';
    if (session) p.session = session;
    if (account) p.account = account;
    const qs = q(p);
    return req<UsageInfo | null>('GET', `/api/usage${qs ? `?${qs}` : ''}`);
  },
  /** 账号实际可用的模型（CLI initialize 报告的）；拉不到为 null。不传 account / session = 当前账号 */
  cliModels: (o: { session?: string | null; account?: string | null; refresh?: boolean } = {}) => {
    const p: Record<string, string> = {};
    if (o.refresh) p.refresh = '1';
    if (o.session) p.session = o.session;
    if (o.account) p.account = o.account;
    const qs = q(p);
    return req<CliModelList | null>('GET', `/api/models${qs ? `?${qs}` : ''}`);
  },
  /** 子代理配置与本机可用状态（全局；传 cwd 时附带该项目级智能体） */
  subagents: (cwd?: string | null) => req<SubagentState>('GET', `/api/subagents${cwd ? `?${q({ cwd })}` : ''}`),
  saveSubagents: (c: SubagentConfig, cwd?: string | null) =>
    req<{ ok: true; state: SubagentState }>('POST', `/api/subagents${cwd ? `?${q({ cwd })}` : ''}`, c),
  /** 委派后端的可用模型；后端未安装 / 未登录时抛错 */
  /** 委派后端的模型列表：backend 缺省为 agy，account 缺省为该后端当前账号 */
  delegateModels: (o: { backend?: 'claude' | 'agy' | 'codex'; account?: string | null; refresh?: boolean } = {}) => {
    const q = new URLSearchParams();
    if (o.backend) q.set('backend', o.backend);
    if (o.account) q.set('account', o.account);
    if (o.refresh) q.set('refresh', '1');
    const qs = q.toString();
    return req<DelegateModelList>('GET', `/api/delegate/models${qs ? '?' + qs : ''}`);
  },
  /** 记住模型与思考强度（全局） */
  saveDefaults: (c: SessionConfig) => req<{ ok: true }>('POST', '/api/defaults', { model: c.model, effort: c.effort }),
  account: () => req<Account | null>('GET', '/api/account'),
  /** 多账号：列表、切换（有执行中的会话时抛 ApiError，status 409，data.running = 数量）、添加 / 重新登录、移除 */
  accounts: () => req<AccountList>('GET', '/api/accounts'),
  switchAccount: (id: string, force = false) => reqDetailed<{ ok: true }>('POST', '/api/accounts/switch', { id, force }),
  startAccountLogin: (o: { label?: string; accountId?: string }) => req<AccountLogin>('POST', '/api/accounts/login', o),
  accountLogin: (loginId: string) => req<AccountLogin>('GET', `/api/accounts/login/${encodeURIComponent(loginId)}`),
  submitAccountCode: (loginId: string, code: string) =>
    req<{ ok: true }>('POST', `/api/accounts/login/${encodeURIComponent(loginId)}/code`, { code }),
  cancelAccountLogin: (loginId: string) => req<{ ok: true }>('POST', `/api/accounts/login/${encodeURIComponent(loginId)}/cancel`, {}),
  /** 移除账号：该账号有执行中的会话时抛 ApiError 409 */
  removeAccount: (id: string) => reqDetailed<{ ok: true }>('POST', '/api/accounts/remove', { id }),
  /** 删掉列表里被隐藏的重复账号（同一个账号添加了多次）；默认 / 当前 / 忙碌的条目跳过 */
  dedupeAccounts: () => req<AccountDedupeResult>('POST', '/api/accounts/dedupe', {}),
  /** 切换模式 / 并行模式；回到切换模式时其它账号有执行中的会话抛 ApiError 409（data.running），force 强制停止 */
  setAccountMode: (mode: AccountMode, force = false) => reqDetailed<{ ok: true }>('POST', '/api/accounts/mode', { mode, force }),
  /** 设置 Claude 委派子代理使用的账号；返回最新的 AccountList */
  setSubagentAccount: (id: string) => req<AccountList>('POST', '/api/accounts/subagent', { id }),
  setAccountLabel: (id: string, label: string) => req<{ ok: true }>('POST', '/api/accounts/label', { id, label }),
  /** 添加（不带 id）或修改 API 账号；baseUrl 空 = 官方地址，修改时 apiKey 留空 = 不变，models 不传 = 不改映射 */
  saveApiAccount: (o: { id?: string; label?: string; baseUrl: string; apiKey?: string; authType: ApiAuthType; models?: ApiModelMap | null }) =>
    req<{ ok: true; id: string }>('POST', '/api/accounts/api', o),
  /** 拉取服务商的模型列表（服务端代发）；apiKey 留空 = 用该账号已存的密钥 */
  apiModelList: (o: { id?: string; baseUrl: string; apiKey?: string; authType: ApiAuthType }) =>
    req<ApiModelListing>('POST', '/api/accounts/api/models', o),
  /** Kiro 账号（本机 kiro.rs 代理）：引擎状态 / 检查更新 / 编译安装 / 登录 / 额度 */
  kiroStatus: () => req<KiroStatus>('GET', '/api/kiro'),
  kiroLogin: (o: { method: KiroLoginMethod; label?: string; accountId?: string; startUrl?: string; region?: string; apiKey?: string }) =>
    reqDetailed<AccountLogin>('POST', '/api/kiro/login', o),
  kiroLoginStatus: (loginId: string) => reqDetailed<AccountLogin>('GET', `/api/kiro/login/${encodeURIComponent(loginId)}`),
  kiroLoginCancel: (loginId: string) => req<{ ok: true }>('POST', `/api/kiro/login/${encodeURIComponent(loginId)}/cancel`, {}),
  kiroBalance: (account: string) => req<KiroBalance>('GET', `/api/kiro/balance?${q({ account })}`),
  /** Antigravity（agy）多账号：列表、切换、登录、授权码、取消、移除、改备注名 */
  agyAccounts: () => req<AgyAccountList>('GET', '/api/agy-accounts'),
  switchAgyAccount: (id: string) => req<{ ok: true }>('POST', '/api/agy-accounts/switch', { id }),
  startAgyLogin: (o: { label?: string; accountId?: string }) => reqDetailed<AccountLogin>('POST', '/api/agy-accounts/login', o),
  agyLogin: (loginId: string) => reqDetailed<AccountLogin>('GET', `/api/agy-accounts/login/${encodeURIComponent(loginId)}`),
  submitAgyCode: (loginId: string, code: string) =>
    req<{ ok: true }>('POST', `/api/agy-accounts/login/${encodeURIComponent(loginId)}/code`, { code }),
  cancelAgyLogin: (loginId: string) => req<{ ok: true }>('POST', `/api/agy-accounts/login/${encodeURIComponent(loginId)}/cancel`, {}),
  removeAgyAccount: (id: string) => reqDetailed<{ ok: true }>('POST', '/api/agy-accounts/remove', { id }),
  dedupeAgyAccounts: () => req<AccountDedupeResult>('POST', '/api/agy-accounts/dedupe', {}),
  setAgyLabel: (id: string, label: string) => req<{ ok: true }>('POST', '/api/agy-accounts/label', { id, label }),
  /** OpenAI Codex 多账号：列表、切换、登录（设备码 / 浏览器 / API Key）、取消、移除、去重、改备注名 */
  codexAccounts: (refresh = false) =>
    req<CodexAccountList>('GET', refresh ? '/api/codex-accounts?refresh=1' : '/api/codex-accounts'),
  switchCodexAccount: (id: string) => req<{ ok: true }>('POST', '/api/codex-accounts/switch', { id }),
  startCodexLogin: (o: { method: CodexLoginMethod; label?: string; accountId?: string; apiKey?: string }) =>
    reqDetailed<AccountLogin>('POST', '/api/codex-accounts/login', o),
  codexLogin: (loginId: string) => reqDetailed<AccountLogin>('GET', `/api/codex-accounts/login/${encodeURIComponent(loginId)}`),
  cancelCodexLogin: (loginId: string) => req<{ ok: true }>('POST', `/api/codex-accounts/login/${encodeURIComponent(loginId)}/cancel`, {}),
  removeCodexAccount: (id: string) => reqDetailed<{ ok: true }>('POST', '/api/codex-accounts/remove', { id }),
  dedupeCodexAccounts: () => req<AccountDedupeResult>('POST', '/api/codex-accounts/dedupe', {}),
  setCodexLabel: (id: string, label: string) => req<{ ok: true }>('POST', '/api/codex-accounts/label', { id, label }),
  /** 本机组件：列表 / 安装或更新（内置浏览器面板里装 agent-browser 用；POST 仅本机连接，非本机 403） */
  components: () => req<ComponentList>('GET', '/api/components'),
  updateComponent: (id: ComponentId) => reqDetailed<ComponentStatus>('POST', `/api/components/${id}/update`),
  pick: (mode?: 'mixed' | 'files' | 'folders') => req<{ items: PickedItem[]; supportsMixed: boolean }>('POST', '/api/pick', { mode }),
  /** 远程连接的网页版选择窗口：列出服务端目录（path 为空 = 当前工作空间）/ 登记选好的路径 */
  browse: (path?: string) => req<BrowseDir>('GET', `/api/browse${path ? `?${q({ path })}` : ''}`),
  pickPaths: (paths: string[]) => req<{ items: PickedItem[]; supportsMixed: boolean }>('POST', '/api/pick/paths', { paths }),
  /** 粘贴的图片：原始字节上传，返回与「+」选出的文件同形的项（带预览令牌） */
  paste: async (blob: Blob): Promise<PickedItem> => {
    const res = await fetch('/api/pastes', { method: 'POST', headers: { 'content-type': blob.type || 'application/octet-stream' }, body: blob });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
    return (data as { item: PickedItem }).item;
  },
  /** 按文件名读粘贴的图片（会话流里历史图片标签用，没有预览令牌）；名字见 pasteName */
  pasteInfo: (name: string) => req<PreviewInfo>('GET', `/api/pastes/${encodeURIComponent(name)}/info`),
  pasteRawUrl: (name: string) => `/api/pastes/${encodeURIComponent(name)}/raw`,
  /**
   * 从本设备上传任意文件（远程连接的手机等）：原始字节上传到宿主机的临时目录（7 天后清理），返回与「+」选出的文件同形的项。
   * 用 XHR 是为了拿上传进度。
   */
  upload: (file: Blob, name: string, onProgress?: (ratio: number) => void): Promise<PickedItem> =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/uploads?${q({ name })}`);
      xhr.setRequestHeader('content-type', 'application/octet-stream');
      xhr.responseType = 'json';
      if (onProgress) xhr.upload.onprogress = (e) => { if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        const data = (xhr.response ?? {}) as { item?: PickedItem; error?: string };
        if (xhr.status >= 200 && xhr.status < 300 && data.item) resolve(data.item);
        else reject(new ApiError(data.error ?? `HTTP ${xhr.status}`, xhr.status, data as Record<string, unknown>));
      };
      xhr.onerror = () => reject(new Error('网络错误'));
      xhr.onabort = () => reject(new Error('上传已取消'));
      xhr.send(file);
    }),
  /** 按「子目录 / 文件名」读上传的文件（会话流里历史标签用）；已清理时抛 ApiError(404) */
  uploadInfo: (dir: string, name: string) => reqDetailed<PreviewInfo>('GET', `/api/uploads/${encodeURIComponent(dir)}/${encodeURIComponent(name)}/info`),
  uploadRawUrl: (dir: string, name: string) => `/api/uploads/${encodeURIComponent(dir)}/${encodeURIComponent(name)}/raw`,
  /** 内置浏览器（agent-browser）：状态 / 身份管理 / 打开地址 / 前进后退刷新 / 视口 / 抓取模式悬停与抓取（profile 是身份 id） */
  browserStatus: () => req<BrowserStatus>('GET', '/api/browser'),
  browserCreateProfile: (name: string) => req<BrowserProfileStatus>('POST', '/api/browser/profiles', { name }),
  browserRenameProfile: (id: string, name: string) => req<BrowserProfileStatus>('POST', `/api/browser/profiles/${encodeURIComponent(id)}/rename`, { name }),
  browserDeleteProfile: (id: string) => req<{ ok: true }>('POST', `/api/browser/profiles/${encodeURIComponent(id)}/delete`),
  browserStopProfile: (id: string) => req<{ ok: true }>('POST', `/api/browser/profiles/${encodeURIComponent(id)}/stop`),
  browserOpen: (profile: string, url: string) => req<{ url: string | null; title: string | null }>('POST', '/api/browser/open', { profile, url }),
  /** 登录窗口：open 在本机桌面用同一个身份打开有界面 Chrome（Google 等拦截内置浏览器的登录），close 关掉它回到内置 */
  browserHistory: (profile: string, q: string) =>
    req<{ items: BrowserHistoryItem[] }>('GET', `/api/browser/history?profile=${encodeURIComponent(profile)}&q=${encodeURIComponent(q)}`),
  browserWindow: (profile: string, action: 'open' | 'close') => req<{ ok: true }>('POST', '/api/browser/window', { profile, action }),
  browserNav: (profile: string, action: 'back' | 'forward' | 'reload') => req<{ ok: true }>('POST', '/api/browser/nav', { profile, action }),
  browserViewport: (profile: string, width: number, height: number, scale: number) =>
    req<{ ok: true }>('POST', '/api/browser/viewport', { profile, width, height, scale }),
  browserHover: (profile: string, x: number, y: number) => req<BrowserHover | null>('POST', '/api/browser/hover', { profile, x, y }),
  browserPick: (profile: string, x: number, y: number) => req<BrowserPickResult>('POST', '/api/browser/pick', { profile, x, y }),
  browserStreamUrl: (profile: string) => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/browser/stream?profile=${encodeURIComponent(profile)}`,
  /** 按文件名读抓取的元素（会话流里历史标签用）；name 是 element-….md / element-….png */
  elementInfo: (name: string) => req<PreviewInfo>('GET', `/api/browser/elements/${encodeURIComponent(name)}/info`),
  elementRawUrl: (name: string) => `/api/browser/elements/${encodeURIComponent(name)}/raw`,
  previewInfo: (t: string) => req<PreviewInfo>('GET', `/api/preview/${t}/info`),
  /** 图片预览地址（<img src>） */
  previewRawUrl: (t: string) => `/api/preview/${t}/raw`,
  /** 会话工作目录内的文件预览（文本 / 图片 / PDF / 目录）；工作目录之外服务端返回 403 */
  filePreview: (t: FileTarget) => req<FilePreview>('GET', `/api/files/preview?${fileQuery(t)}`),
  /** 图片 / PDF 的原始内容地址（<img src> / <iframe src>） */
  fileRawUrl: (t: FileTarget) => `/api/files/raw?${fileQuery(t)}`,
  /** 下载文件到本地设备（不带行号，始终作为附件返回） */
  fileDownloadUrl: (t: FileTarget) => `/api/files/download?${fileQuery({ ...t, line: undefined })}`,
  /** 在文件管理器中显示（文件会被选中） / 在该路径所在目录打开终端 / 用系统默认应用打开 */
  revealFile: (t: FileTarget) => req<{ ok: true }>('POST', '/api/files/reveal', { session: t.session, cwd: t.cwd, path: localPathHref(t.path) }),
  openTerminalAt: (t: FileTarget) => req<{ ok: true }>('POST', '/api/files/terminal', { session: t.session, cwd: t.cwd, path: localPathHref(t.path) }),
  openFile: (t: FileTarget) => req<{ ok: true; revealed: boolean }>('POST', '/api/files/open', { session: t.session, cwd: t.cwd, path: localPathHref(t.path) }),
  /**
   * 在会话工作目录里运行代码块：流式模式，不限时，输出逐块交给 onOutput；
   * 结果里的 stdout / stderr 为空（输出已经随 onOutput 给过）。signal 中止请求后服务端会杀掉进程。
   */
  execSnippet: async (
    t: { session: string; cwd?: string; lang: string; code: string },
    onOutput: (stream: 'stdout' | 'stderr', data: string) => void,
    signal?: AbortSignal,
  ): Promise<ExecResult> => {
    const res = await fetch('/api/exec', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...t, stream: true }), signal });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buf += value;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const m = JSON.parse(line) as ExecStreamMsg;
        if (m.t === 'out') onOutput(m.stream, m.data);
        else if (m.t === 'end') return m.result;
        else throw new Error(m.message);
      }
      if (done) throw new Error('连接中断');
    }
  },
  context: (id: string) => req<ContextUsage | null>('GET', `/api/context/${id}`),
  /**
   * cwd：会话所在目录（可选；后端没有进程时据此定位会话，省去按 id 全局查找）。
   * draft：还没发过消息的新会话（磁盘上没有记录），后端用 --session-id 拉起探测进程；必须带 cwd。
   */
  refreshContext: (id: string, cwd?: string, draft = false) =>
    req<ContextUsage | null>('POST', `/api/context/${id}/refresh`, { ...(cwd ? { cwd } : {}), ...(draft ? { draft: true } : {}) }),
  /** 设置 skill 状态（全局，立即下发给运行中的会话） */
  setSkillMode: (name: string, mode: SkillMode) => req<{ ok: true }>('POST', '/api/skills', { name, mode }),
  removeSkill: (name: string, session: string | null, cwd: string | null) =>
    req<{ ok: true; backup: string }>('POST', '/api/skills/remove', { name, session, cwd }),
  /** 在服务端文件管理器中选中该 skill 的 SKILL.md（仅服务端本机） */
  revealSkill: (name: string, session: string | null, cwd: string | null) =>
    req<{ ok: true }>('POST', '/api/skills/reveal', { name, session, cwd }),
  /** 读磁盘上的 SKILL.md（技能面板兜底：实时的 /技能 输入拿不到注入正文）；cwd 用来找项目级 skill；找不到时抛错 */
  getSkillContent: (name: string, cwd?: string) => req<SkillContent>('GET', `/api/skills/content?${q(cwd ? { name, cwd } : { name })}`),
  setSkillModes: (modes: Record<string, SkillMode>) => req<{ ok: true }>('POST', '/api/skills', { modes }),
  /** 启用 / 停用一个内置工具（全局保存）；返回当前的已停用名单 */
  setTool: (name: string, enabled: boolean) => req<{ ok: true; disabledTools: string[] }>('POST', '/api/tools', { name, enabled }),
  /** 自动压缩窗口（全局，token 数；null = 不覆盖）；运行中的会话立即生效，服务端随后推送新的上下文 */
  setCompactWindow: (window: number | null) => req<{ ok: true; window: number | null }>('POST', '/api/compact-window', { window }),
  setAgent: (name: string, enabled: boolean) => req<{ ok: true; disabledAgents: string[] }>('POST', '/api/agents', { name, enabled }),
  /** 所有会话的工具累计调用次数（服务端增量扫描会话记录）；老服务端没有这个接口时抛错 */
  getToolStats: () => req<ToolStats>('GET', '/api/tools/stats'),
  /** 模型价格表（服务端定期抓官方页面，失败时是内置表） */
  getPricing: () => req<PriceTable>('GET', '/api/pricing'),
  /** 开关 MCP 服务器（按项目写进 ~/.claude.json）；返回切换后的上下文 */
  toggleMcp: (id: string, server: string, enabled: boolean, cwd?: string, draft = false) =>
    req<ContextUsage | null>('POST', `/api/context/${id}/mcp`, { server, enabled, ...(cwd ? { cwd } : {}), ...(draft ? { draft: true } : {}) }),
  /** 两步验证（2FA）：全量数据、条目/分组/标签 CRUD、使用次数、导入、同步 */
  twoFaData: () => req<TwoFaData>('GET', '/api/2fa/data'),
  twoFaCreateEntry: (input: TwoFaCreateEntryInput) =>
    reqDetailed<{ entry: TwoFaEntry }>('POST', '/api/2fa/entries', input),
  twoFaUpdateEntry: (id: string, input: TwoFaPatchEntryInput) =>
    reqDetailed<{ entry: TwoFaEntry }>('PATCH', `/api/2fa/entries/${encodeURIComponent(id)}`, input),
  twoFaDeleteEntry: (id: string, version: number) =>
    reqDetailed<{ ok: true }>('DELETE', `/api/2fa/entries/${encodeURIComponent(id)}?version=${version}`),
  twoFaCreateGroup: (input: TwoFaCreateGroupInput) =>
    reqDetailed<{ group: TwoFaGroup }>('POST', '/api/2fa/groups', input),
  twoFaUpdateGroup: (id: string, input: TwoFaPatchGroupInput) =>
    reqDetailed<{ group: TwoFaGroup }>('PATCH', `/api/2fa/groups/${encodeURIComponent(id)}`, input),
  twoFaDeleteGroup: (id: string, mode: TwoFaDeleteGroupMode, version: number) =>
    reqDetailed<{ ok: true }>('DELETE', `/api/2fa/groups/${encodeURIComponent(id)}?mode=${mode}&version=${version}`),
  twoFaCreateTag: (input: TwoFaCreateTagInput) =>
    reqDetailed<{ tag: TwoFaTag }>('POST', '/api/2fa/tags', input),
  twoFaUpdateTag: (id: string, input: TwoFaPatchTagInput) =>
    reqDetailed<{ tag: TwoFaTag }>('PATCH', `/api/2fa/tags/${encodeURIComponent(id)}`, input),
  twoFaDeleteTag: (id: string, version: number) =>
    reqDetailed<{ ok: true }>('DELETE', `/api/2fa/tags/${encodeURIComponent(id)}?version=${version}`),
  twoFaRecordUsage: (id: string) =>
    req<{ usage: TwoFaUsage }>('POST', `/api/2fa/usage/${encodeURIComponent(id)}`, {}),
  twoFaImport: (input: TwoFaImportInput) =>
    reqDetailed<TwoFaImportResult>('POST', '/api/2fa/import', input),
  twoFaImportPreview: (input: TwoFaImportPreviewInput) =>
    reqDetailed<TwoFaImportPreviewResult>('POST', '/api/2fa/import/preview', input),
  twoFaSync: () => reqDetailed<{ sync: TwoFaSync }>('POST', '/api/2fa/sync', {}),
  twoFaStatus: () => req<{ sync: TwoFaSync }>('GET', '/api/2fa/status'),
};

// ───────────── WebSocket ─────────────

type Listener = (m: ServerMsg) => void;

export class Socket {
  private ws: WebSocket | null = null;
  private queue: ClientMsg[] = [];
  private listeners = new Set<Listener>();
  private subs = new Set<string>();
  private retry = 0;
  private openListeners = new Set<() => void>();
  private opened = false;
  private connListeners = new Set<(connected: boolean) => void>();

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      for (const s of this.subs) ws.send(JSON.stringify({ t: 'subscribe', sessionId: s } satisfies ClientMsg));
      for (const m of this.queue.splice(0)) ws.send(JSON.stringify(m));
      // 断线期间的广播（sessions.changed / sidebar.changed）都丢了：重连后通知上层重新拉取
      if (this.opened) for (const l of this.openListeners) l();
      this.opened = true;
      for (const l of this.connListeners) l(true);
    };
    ws.onmessage = (ev) => {
      let m: ServerMsg;
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      for (const l of this.listeners) l(m);
    };
    ws.onclose = () => {
      this.ws = null;
      for (const l of this.connListeners) l(false);
      const delay = Math.min(5000, 300 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  send(m: ClientMsg) {
    if (m.t === 'subscribe') this.subs.add(m.sessionId);
    if (m.t === 'unsubscribe') this.subs.delete(m.sessionId);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
    // 订阅关系由 subs 在重连时统一补发，不进队列，避免重复订阅
    else if (m.t !== 'subscribe' && m.t !== 'unsubscribe') this.queue.push(m);
  }

  on(l: Listener) {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }

  /** 断线重连成功后调用（首次连接不调用） */
  onReconnect(l: () => void) {
    this.openListeners.add(l);
    return () => { this.openListeners.delete(l); };
  }

  /** 连接状态变化回调（connected = true / false） */
  onConnChange(l: (connected: boolean) => void) {
    this.connListeners.add(l);
    return () => { this.connListeners.delete(l); };
  }
}

export const socket = new Socket();
