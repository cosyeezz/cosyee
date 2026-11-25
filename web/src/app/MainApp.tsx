// 主界面接线：把 api / socket / reducer 与 C3–C5 的组件连起来。组件本身不直接访问后端。
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  BUILTIN_PRICES, hasModelMapping,
  type Account, type AccountList, type AgentModelConfig, type Attachment, type Bootstrap, type BrowserPickResult, type CliModelList, type DelegateModelList, type DelegateJobInfo, type DelegateSendMode, type DeletedSession, type PendingPrompt, type PriceTable, type PromptReply, type QueueMode,
  type SessionConfig, type SessionSummary, type SkillMode, type SubagentCost, type SubagentRun, type ToolStats, type Workspace, type Turn,
} from '@cosyee/shared';
import { api, socket } from '../core/api';
import { upgradeToHttps } from '../core/speech/https';
import * as call from '../core/speech/call';
import { CallBar } from '../ui/call/CallBar';
import { resolveSessionConfig } from '../core/sessionConfig';
import { addQuote, type QuoteReply } from '../core/quote';
import { uuid } from '../core/browser';
import { expandLabels } from '../core/composer';
import { recordFuller, rewindTo, subagentEffortFromHistory, subagentModelFromHistory, subagentTurnFromHistory, withRecord } from '../core/reducer';
import { AppShell } from '../ui/layout/AppShell';
import { PinnedRail } from '../ui/sidebar/PinnedRail';
import { Sidebar } from '../ui/sidebar/Sidebar';
import { excludePinned, samePath } from '../ui/sidebar/sidebarUtil';
import { WorkspaceMenu } from '../ui/sidebar/WorkspaceMenu';
import { SessionHeader } from '../ui/header/SessionHeader';
import { ContextPanel } from '../ui/context/ContextPanel';
import { ChartRail } from '../ui/context/ChartRail';
import type { Billing } from '../ui/context/CostSection';
import { getLiveText, isHiddenTurn, isTurnActive } from '../ui/flow/format';
import { scrollBehavior } from '../ui/flow/motion';
import { ConversationView } from '../ui/flow/ConversationView';
import { FlowSkeleton, useFlowSkeleton } from '../ui/flow/FlowSkeleton';
import { SessionDock } from '../ui/flow/SessionDock';
import { SubagentOverlay } from '../ui/flow/SubagentOverlay';
import { FlowMetaContext, defaultSkillLoader, type FlowMeta } from '../ui/flow/flowContext';
import { DelegateContext, type DelegateActions } from '../ui/flow/delegateContext';
import { FilesContext, type FileOpenRequest, type FilesApi } from '../ui/files/FileContext';
import { FilePreview } from '../ui/files/FilePreview';
import { BrowserPanel } from '../ui/browser/BrowserPanel';
import { isBrowserToggle } from '../ui/browser/input';
import { PickerDialog, type PickerMode } from '../ui/files/PickerDialog';
import { Composer, type ComposerHandle } from '../ui/composer/Composer';
import { PromptPanel } from '../ui/prompt/PromptPanel';
import { useSessionStream } from './useSessionStream';
import { motionOK } from '../ui/motion/reduced';
import { useCssHeight } from '../ui/layout/useCssHeight';
import { NARROW_QUERY, useMediaQuery } from '../ui/layout/useMediaQuery';
import './MainApp.css';

let socketStarted = false;
function startSocket() {
  if (socketStarted) return;
  socketStarted = true;
  socket.connect();
}

const FALLBACK_CONFIG: SessionConfig = { model: 'sonnet', effort: 'medium' };
const NO_PROMPTS: PendingPrompt[] = [];
const NO_JOBS: DelegateJobInfo[] = [];
const NO_TURNS: Turn[] = [];

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 新会话草稿：先分配好会话 id，右侧面板据此拉起探测进程（可在发第一条消息前调整 skill / MCP），第一条消息复用它 */
const draftSel = (cwd: string) => ({ id: uuid(), cwd, fresh: true });

/** 会话列表按工作空间缓存时用的键（与 samePath 同一套规则：不区分大小写、忽略末尾分隔符） */
const pathKey = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();

export function MainApp() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  // 远程连接：服务端桌面上的窗口（系统选择对话框、文件管理器、终端）远程设备看不到。
  // 选择文件 / 文件夹改用网页版选择窗口（在远端浏览服务端的文件）；文件管理器、终端的按钮不显示
  const remote = !!boot?.remote;
  const [webPick, setWebPick] = useState<{ mode: PickerMode; title: string } | null>(null);
  const webPickDone = useRef<((paths: string[]) => void) | null>(null);
  const askPaths = useCallback(
    (mode: PickerMode, title: string) =>
      new Promise<string[]>((resolve) => {
        webPickDone.current?.([]); // 已有一个打开着：当作取消
        webPickDone.current = resolve;
        setWebPick({ mode, title });
      }),
    [],
  );
  const finishWebPick = useCallback((paths: string[]) => {
    const done = webPickDone.current;
    webPickDone.current = null;
    setWebPick(null);
    done?.(paths);
  }, []);
  /** 输入框「+」：桌面版 → Electron 原生对话框；本机浏览器 → 服务端弹对话框；远程 → 网页版选择窗口 */
  const pickFiles = useCallback<typeof api.pick>(async (mode) => {
    if (window.cosyeeDesktop?.pick) {
      const paths = await window.cosyeeDesktop.pick(mode ?? 'mixed', '选择文件或文件夹', '');
      return paths.length ? api.pickPaths(paths) : { items: [], supportsMixed: true };
    }
    if (!remote) return api.pick(mode);
    const paths = await askPaths('mixed', '添加文件或文件夹');
    return paths.length ? api.pickPaths(paths) : { items: [], supportsMixed: true };
  }, [remote, askPaths]);
  const [fatal, setFatal] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [wsConnected, setWsConnected] = useState(true);
  const [wsState, setWsState] = useState<{ current: string | null; list: Workspace[] }>({ current: null, list: [] });
  /** 各工作空间的会话（侧栏按工作空间分组显示，所以每个工作空间都要读）；键见 pathKey */
  const [sessionMap, setSessionMap] = useState<Record<string, SessionSummary[]>>({});
  /** 置顶（全局，可来自任何工作空间）与已删除（全局） */
  const [pins, setPins] = useState<SessionSummary[]>([]);
  const [deleted, setDeleted] = useState<DeletedSession[]>([]);
  /** 启动时置顶 / 工作空间是否已读完（决定「启动先打开哪个会话」要等什么） */
  const [pinsLoaded, setPinsLoaded] = useState(false);
  const [wsLoaded, setWsLoaded] = useState(false);
  /** 打开的会话。cwd 是它所属的工作空间：从「置顶」点开别的工作空间的会话时，不改变当前工作空间与列表 */
  const [sel, setSel] = useState<{ id: string; cwd: string; fresh: boolean } | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  /** 账号信息有变化但不整页刷新（并行模式下切换新会话用的账号、改模式、移除账号等）时递增：额度、账号菜单、模式开关重新读取 */
  const [accountVersion, setAccountVersion] = useState(0);
  const [branch, setBranch] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  /** 右侧上下文栏收起；新开会话、切换会话都保持当前布局 */
  const [ctxCollapsed, setCtxCollapsed] = useState(false);
  /** 窄屏（手机）：两侧栏是浮层抽屉，同一时间最多开一个；与宽屏的收起状态各管各的 */
  const narrow = useMediaQuery(NARROW_QUERY);
  const [drawer, setDrawer] = useState<'left' | 'right' | null>(null);
  const closeDrawer = useCallback(() => setDrawer(null), []);
  // 安卓客户端的返回手势（外壳脚本派发可取消的 cosyee:back）：有打开的抽屉就先关抽屉
  useEffect(() => {
    if (!narrow || !drawer) return;
    const onBack = (e: Event) => { e.preventDefault(); setDrawer(null); };
    window.addEventListener('cosyee:back', onBack);
    return () => window.removeEventListener('cosyee:back', onBack);
  }, [narrow, drawer]);
  const [config, setConfig] = useState<SessionConfig>(FALLBACK_CONFIG);
  const [openSub, setOpenSub] = useState<{ turnId: string; toolUseId: string } | null>(null);
  const [loadedSub, setLoadedSub] = useState<SubagentRun | null>(null);
  const [ctxLoading, setCtxLoading] = useState(false);
  const [toolStats, setToolStats] = useState<ToolStats | null>(null);
  /** 选中回复带来的引用文字（可累积多段）；由输入框负责拼进消息并在发送后清除 */
  const [quotes, setQuotes] = useState<readonly QuoteReply[]>([]);
  const composerRef = useRef<ComposerHandle>(null);
  /** 内置浏览器面板：标题栏地球按钮（cosyee:browser 事件）或 ⇧⌘P / Ctrl+Shift+P 开关 */
  const [browserOpen, setBrowserOpen] = useState(false);
  const closeBrowser = useCallback(() => setBrowserOpen(false), []);
  const onBrowserPick = useCallback(
    (r: BrowserPickResult) => composerRef.current?.insertChips([{ kind: 'el', path: r.text }]) ?? false,
    [],
  );
  useEffect(() => {
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    const toggle = () => setBrowserOpen((o) => !o);
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || !isBrowserToggle(e, mac)) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener('cosyee:browser', toggle);
    window.addEventListener('keydown', onKey);
    // 告诉桌面客户端的标题栏：可以显示浏览器按钮了
    (window as { __cosyeeBrowserReady?: boolean }).__cosyeeBrowserReady = true;
    window.dispatchEvent(new Event('cosyee:browser-ready'));
    return () => {
      window.removeEventListener('cosyee:browser', toggle);
      window.removeEventListener('keydown', onKey);
    };
  }, []);
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('cosyee:browser-state', { detail: { open: browserOpen } }));
  }, [browserOpen]);

  const configs = useRef(new Map<string, SessionConfig>());
  /** 本页已发过消息的会话（决定 isNew） */
  const sentIds = useRef(new Set<string>());
  /** 是否是还没发过消息的新会话草稿（磁盘上没有记录） */
  const isDraft = (s: { id: string; fresh: boolean } | null): boolean => !!s && s.fresh && !sentIds.current.has(s.id);
  /** 最近一次见到的 slash 命令与 skills（新会话还没有 init 时沿用） */
  const lastMeta = useRef<{ slash: string[]; skills: string[] }>({ slash: [], skills: [] });

  const cwd = wsState.current;
  /** 当前工作空间的会话 */
  const sessions = useMemo(() => (cwd ? sessionMap[pathKey(cwd)] ?? [] : []), [sessionMap, cwd]);
  /** 所有工作空间的会话（侧栏分组用；当前工作空间不在列表里时也算上） */
  const allSessions = useMemo(() => {
    const dirs = wsState.list.map((w) => w.path);
    if (cwd && !dirs.some((d) => samePath(d, cwd))) dirs.push(cwd);
    return dirs.flatMap((d) => sessionMap[pathKey(d)] ?? []);
  }, [sessionMap, wsState.list, cwd]);
  /** 对每个工作空间缓存的会话列表做同一个改动（比如清掉蓝点、改标题） */
  const mapSessions = useCallback((fn: (l: SessionSummary[]) => SessionSummary[]) => {
    setSessionMap((m) => Object.fromEntries(Object.entries(m).map(([k, l]) => [k, fn(l)])));
  }, []);
  /** 当前打开的会话所属的目录（没有打开会话时就是当前工作空间） */
  const selCwd = sel?.cwd ?? cwd;
  const { view, patch } = useSessionStream(sel?.id ?? null, selCwd, sel?.fresh ?? false);

  // 切换会话 / 工作空间 / 新会话时清空引用
  useEffect(() => { setQuotes((q) => (q.length ? [] : q)); }, [sel?.id]);

  const onReply = useCallback((q: string, reply: string) => {
    // 回复跟着它的引用走（不再拼进输入框，免得多段回复粘在一起、分不清对应哪段）；完全相同的引用不重复加
    setQuotes((list) => addQuote(list, q, reply));
    composerRef.current?.appendText(''); // 只聚焦输入框，Enter 即可发送
  }, []);
  const onRemoveQuote = useCallback((index: number) => setQuotes((list) => list.filter((_, i) => i !== index)), []);
  const onEditQuoteReply = useCallback(
    (index: number, reply: string) => setQuotes((list) => list.map((q, i) => (i === index ? { ...q, reply } : q))),
    [],
  );
  const onClearQuotes = useCallback(() => setQuotes((q) => (q.length ? [] : q)), []);

  const flash = useCallback((msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice((n) => (n === msg ? null : n)), 4000);
  }, []);

  // ───────────── 启动 ─────────────

  useEffect(() => {
    api.bootstrap()
      .then((b) => {
        if (b.httpsUrl) void upgradeToHttps(b.httpsUrl);
        setBoot(b);
        setConfig(b.defaults);
        startSocket();
        return Promise.all([
          api.workspaces().then(setWsState).finally(() => setWsLoaded(true)),
          api.account().then(setAccount).catch(() => setAccount(null)),
        ]);
      })
      .catch((e) => setFatal(errText(e)));
  }, []);

  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const wsListRef = useRef(wsState.list);
  wsListRef.current = wsState.list;
  /** 当前 sessions 列表属于哪个工作空间（用来判断列表是否已为当前工作空间加载完） */
  const sessionsFor = useRef<string | null>(null);
  /** 启动 / 切换工作空间后还没有做过“自动打开第一个会话”；点“新会话”后置 false，避免覆盖用户的选择 */
  const autoPick = useRef(true);
  /** 请求序号（每个工作空间各一个）：并发的重读只接受最后一次发出的结果，避免较早的旧结果后到把新数据覆盖掉 */
  const sessionsSeq = useRef(new Map<string, number>());
  const pinsSeq = useRef(0);
  const loadSessions = useCallback((dir: string | null) => {
    if (!dir) return;
    const key = pathKey(dir);
    const seq = (sessionsSeq.current.get(key) ?? 0) + 1;
    sessionsSeq.current.set(key, seq);
    api.sessions(dir).then((list) => {
      if (sessionsSeq.current.get(key) !== seq) return;
      if (samePath(cwdRef.current, dir)) sessionsFor.current = dir;
      setSessionMap((m) => ({ ...m, [key]: list }));
    }).catch((e) => {
      // 别的工作空间读不出来（比如文件夹已被删）不打扰用户，只在当前工作空间出错时提示
      if (samePath(cwdRef.current, dir)) flash(`读取会话列表失败：${errText(e)}`);
    });
  }, [flash]);

  useEffect(() => { loadSessions(cwd); }, [cwd, loadSessions]);

  // 工作空间列表变化（启动读完、新增）后，把其余工作空间的会话也读进来
  const wsPaths = wsState.list.map((w) => w.path).join('\n');
  useEffect(() => {
    for (const w of wsListRef.current) if (!samePath(w.path, cwdRef.current)) loadSessions(w.path);
  }, [wsPaths, loadSessions]);

  // 分支跟着「打开的会话」走（置顶里别的工作空间的会话也要显示它自己的分支）
  useEffect(() => {
    setBranch(null);
    if (selCwd) api.git(selCwd).then((r) => setBranch(r.branch)).catch(() => setBranch(null));
  }, [selCwd]);

  const loadPins = useCallback(() => {
    const seq = ++pinsSeq.current;
    api.pins()
      .then((list) => { if (seq === pinsSeq.current) setPins(list); })
      .catch((e) => flash(`读取置顶失败：${errText(e)}`))
      .finally(() => setPinsLoaded(true));
  }, [flash]);
  const loadDeleted = useCallback(() => {
    api.deleted().then(setDeleted).catch((e) => flash(`读取已删除列表失败：${errText(e)}`));
  }, [flash]);
  /** 置顶 / 删除 / 恢复之类的操作之后：三块数据一起重读 */
  const refreshSidebar = useCallback(() => {
    loadSessions(cwdRef.current);
    for (const w of wsListRef.current) if (!samePath(w.path, cwdRef.current)) loadSessions(w.path);
    loadPins();
    loadDeleted();
  }, [loadSessions, loadPins, loadDeleted]);

  // 启动后读一次置顶与已删除
  useEffect(() => {
    if (!boot) return;
    loadPins();
    loadDeleted();
  }, [boot, loadPins, loadDeleted]);

  // 全局消息：会话列表刷新（任何工作空间的变化都可能影响置顶里的行）、侧栏整体刷新、账号切换、错误提示
  useEffect(() => socket.on((m) => {
    if (m.t === 'sessions.changed') {
      // 侧栏显示所有工作空间的会话：列表里任何一个工作空间有变化都要重读
      if (samePath(m.cwd, cwd) || wsListRef.current.some((w) => samePath(w.path, m.cwd))) loadSessions(m.cwd);
      loadPins();
    } else if (m.t === 'sidebar.changed') {
      refreshSidebar();
    } else if (m.t === 'account.changed') {
      if (m.reload) {
        // 切换模式下换了账号（可能是别的窗口切的）：整页刷新，所有数据都从新账号重新读取，不残留旧账号的信息
        window.location.reload();
      } else {
        // 并行模式：各会话仍用各自的账号，只重读账号相关的数据（账户栏、额度、会话行上的账号名）
        api.account().then(setAccount).catch(() => setAccount(null));
        setAccountVersion((v) => v + 1);
        refreshSidebar();
      }
    } else if (m.t === 'agy.changed') {
      // Antigravity 账号变化：让开着的账号菜单重读列表，并清空已缓存的委派模型列表（不整页刷新）
      setAccountVersion((v) => v + 1);
      delegateSeq.current += 1;
      setDelegate({ list: null, error: null, loading: false });
    } else if (m.t === 'error') flash(m.message);
  }), [cwd, loadSessions, loadPins, refreshSidebar, flash]);

  // 断线重连（后端重启、电脑休眠唤醒等）：断线期间错过的列表变化全部重读
  useEffect(() => socket.onReconnect(refreshSidebar), [refreshSidebar]);

  // WebSocket 连接状态（断线时在界面上提示，避免消息默默排队、用户以为发不了）
  useEffect(() => socket.onConnChange(setWsConnected), []);

  // ───────────── 当前会话派生数据 ─────────────

  const turns = view?.conv.turns ?? NO_TURNS;
  // 会话流里真正显示的轮：本地命令（/compact、/model 等）整轮不渲染，判断「空会话」也按这个数
  const shownTurns = useMemo(() => turns.filter((t) => !isHiddenTurn(t)), [turns]);
  // 加载会话：骨架屏 → 骨架淡出、内容逐块浮现
  const skeleton = useFlowSkeleton(!!view?.loading);
  // 切换会话：新会话加载期间，旧对话留在原位淡出（不先闪成空白）；新内容到了再整体换上、逐块浮现
  const lastFlow = useRef<{ key: string; turns: typeof turns } | null>(null);
  if (view && !view.loading && !view.loadError) lastFlow.current = shownTurns.length > 0 ? { key: view.id, turns } : null;
  const heldFlow = view?.loading && motionOK() ? lastFlow.current : null;
  const meta = view?.conv.meta;
  // 未发过消息的新会话草稿与刚打开的历史会话不会收到 system/init，用探测进程采到的 context.skills / slashCommands 兜底
  const ctxSkills = useMemo(
    () => (view?.context?.skills ? view.context.skills.filter((s) => s.mode !== 'off').map((s) => s.name) : []),
    [view?.context?.skills],
  );
  const slashCommands = meta?.slashCommands?.length
    ? meta.slashCommands
    : view?.context?.slashCommands?.length
      ? view.context.slashCommands
      : lastMeta.current.slash;
  const skills = meta?.skills?.length
    ? meta.skills
    : ctxSkills.length
      ? ctxSkills
      : lastMeta.current.skills;
  if (slashCommands.length) lastMeta.current.slash = slashCommands;
  if (skills.length) lastMeta.current.skills = skills;
  const running = view?.status === 'running' || view?.status === 'starting';
  const current = sel ? allSessions.find((s) => s.id === sel.id) ?? pins.find((s) => s.id === sel.id) ?? null : null;
  /** 工作空间列表里实际显示的会话（已置顶的在「置顶」里） */
  const listed = useMemo(() => excludePinned(sessions, pins), [sessions, pins]);
  /** 额度按当前会话所用的账号取（并行模式下不同会话可能是不同账号）；会话或账号变了就换一个函数，让额度圆环重新读取 */
  const selId = sel?.id ?? null;
  const loadUsage = useCallback(
    (refresh: boolean) => api.usage(refresh, selId),
    [selId, accountVersion],
  );

  // ───────────── 工作空间与会话切换 ─────────────

  /** 新会话输入框里换工作空间：停在这个工作空间的空白新会话上（不去打开它的某个旧会话） */
  const selectWorkspace = useCallback((path: string) => {
    api.setCurrentWorkspace(path)
      .then(() => {
        autoPick.current = false;
        setWsState((w) => ({ ...w, current: path }));
        setSel(draftSel(path));
        setOpenSub(null);
      })
      .catch((e) => flash(errText(e)));
  }, [flash]);

  const openFolder = useCallback(() => {
    const picked: Promise<{ workspace: Workspace | null }> = window.cosyeeDesktop?.pick
      ? window.cosyeeDesktop.pick('folders', '选择工作空间文件夹', '').then(
          ([dir]): Promise<{ workspace: Workspace | null }> | { workspace: null } =>
            dir ? api.openWorkspace(dir) : { workspace: null })
      : remote
      ? askPaths('folder', '打开文件夹').then(([dir]): Promise<{ workspace: Workspace | null }> | { workspace: null } =>
          dir ? api.openWorkspace(dir) : { workspace: null })
      : api.pickWorkspace();
    picked
      .then(({ workspace }) => {
        if (!workspace) return;
        autoPick.current = false;
        setWsState((w) => ({
          current: workspace.path,
          list: w.list.some((x) => samePath(x.path, workspace.path)) ? w.list : [...w.list, workspace],
        }));
        setSel(draftSel(workspace.path)); // 新打开的文件夹：直接进入它的新会话
      })
      .catch((e) => flash(`打开文件夹失败：${errText(e)}`));
  }, [flash, remote, askPaths]);

  /** dirHint：列表里还没有这个会话时用它的工作目录（刚分支出来的会话，侧栏可能还没刷新到） */
  const selectSession = useCallback((id: string, dirHint?: string) => {
    // 会话可能来自当前工作空间的列表，也可能来自「置顶」（任何工作空间）
    const hit = allSessions.find((s) => s.id === id) ?? pins.find((s) => s.id === id);
    const dir = hit?.cwd ?? dirHint ?? cwd;
    if (!dir) return;
    setSel({ id, cwd: dir, fresh: false });
    setOpenSub(null);
    // 每个会话各自的配置：本页记着的 > 服务端记下的（刷新页面后也在）> 会话记录里最后用的模型 + 全局默认
    setConfig(configs.current.get(id) ?? resolveSessionConfig(hit, boot?.defaults ?? FALLBACK_CONFIG));
    const clearDot = (l: SessionSummary[]) => l.map((s) => (s.id === id && s.dot === 'unread' ? { ...s, dot: null } : s));
    mapSessions(clearDot);
    setPins(clearDot);
    api.viewed(id, dir).catch(() => { /* 蓝点下次刷新再说 */ });
  }, [cwd, boot, allSessions, pins, mapSessions]);

  const newSession = useCallback(() => {
    autoPick.current = false;
    const dir = cwdRef.current;
    // 已经停在空白的新会话上：沿用它（不再多起一个探测进程）；否则在当前打开的会话所属的工作空间里新建（没有打开会话就用当前工作空间）
    setSel((s) => {
      if (s && isDraft(s)) return s;
      const d = s?.cwd ?? dir;
      return d ? draftSel(d) : null;
    });
    setOpenSub(null);
    setConfig(boot?.defaults ?? FALLBACK_CONFIG);
  }, [boot]);

  // 启动时：有置顶就打开第一个置顶会话（置顶可来自任何工作空间，先切到它所属的工作空间）；没有置顶走下面的老逻辑。
  // 只在启动时做一次；之后用户主动切换工作空间仍打开该工作空间列表里的第一个
  const startupPick = useRef(true);
  useEffect(() => {
    if (!startupPick.current || !boot || !pinsLoaded || !wsLoaded) return;
    startupPick.current = false;
    const first = pins[0];
    if (!first) return;
    autoPick.current = false;
    if (samePath(first.cwd, cwd)) {
      selectSession(first.id);
      return;
    }
    api.setCurrentWorkspace(first.cwd)
      .then(() => setWsState((w) => ({
        current: first.cwd,
        list: w.list.some((x) => samePath(x.path, first.cwd)) ? w.list : [...w.list, { path: first.cwd, name: first.cwd.split(/[\\/]/).filter(Boolean).pop() ?? first.cwd }],
      })))
      .catch(() => { /* 工作空间已不在列表里：只打开会话，不改当前工作空间 */ })
      .finally(() => selectSession(first.id));
  }, [boot, pins, pinsLoaded, wsLoaded, cwd, selectSession]);

  // 启动 / 切换工作空间后，列表加载完且没有选中会话时，自动打开列表（显示顺序）里的第一个
  useEffect(() => {
    if (startupPick.current || !autoPick.current || !cwd || !samePath(sessionsFor.current, cwd)) return; // 列表还没为当前工作空间加载完
    autoPick.current = false; // 每次只尝试一次（空列表也算），之后不再抢用户的选择
    if (sel) return;
    const first = listed[0];
    if (first) selectSession(first.id);
    else {
      // 工作空间里还没有会话：直接进入新会话草稿
      setSel(draftSel(cwd));
    }
  }, [listed, cwd, sel, selectSession, pinsLoaded, wsLoaded]);

  // ───────────── 发送、中断、配置 ─────────────

  /** mode 只在执行中有意义：next=插话（并入当前这一轮），later=排队（这一轮结束后再发）；空闲时后端一律立即开始新一轮 */
  const sendText = useCallback((text: string, mode?: QueueMode) => {
    if (!selCwd) return;
    let id = sel?.id;
    let isNew = false;
    if (!id) {
      id = uuid();
      isNew = true;
      setSel({ id, cwd: selCwd, fresh: true });
    } else if (sel?.fresh && !sentIds.current.has(id)) {
      isNew = true;
    }
    sentIds.current.add(id);
    configs.current.set(id, config); // 这个会话此刻显示的配置就是实际执行的配置
    // 消息 id 由前端生成：CLI 以它作为 user 消息的 uuid，也是之后 rewind / 撤回 / 立即发送的目标
    socket.send({ t: 'send', sessionId: id, cwd: selCwd, isNew, text, config, id: uuid(), ...(mode ? { mode } : {}) });
  }, [selCwd, sel, config]);

  const onSend = useCallback((text: string, _attachments: Attachment[], mode?: QueueMode) => sendText(text, mode), [sendText]);

  const onQueueSendNow = useCallback((id: string) => {
    if (sel) socket.send({ t: 'queue.sendNow', sessionId: sel.id, id });
  }, [sel]);
  const onQueueCancel = useCallback((id: string) => {
    if (sel) socket.send({ t: 'queue.cancel', sessionId: sel.id, id });
  }, [sel]);

  /**
   * 双击 Esc 浮层里可回退的消息：有 userId 且不是 steering 的轮（CLI 的 rewind 列表不含插话）；
   * 会话流里没显示的本地命令轮（/compact、/model 等）也不列出
   */
  const rewindTargets = useMemo(
    () => shownTurns.filter((t) => t.userId && !t.steer).map((t) => ({ id: t.userId!, text: t.userText })),
    [shownTurns],
  );
  /** 进行中的 rewind 请求 id，用来对应 rewind.result */
  const rewindReq = useRef<string | null>(null);
  const onRewind = useCallback((targetId: string) => {
    if (!sel || !selCwd) return;
    const reqId = uuid();
    rewindReq.current = reqId;
    socket.send({ t: 'rewind', sessionId: sel.id, cwd: selCwd, config, targetId, reqId });
  }, [sel, selCwd, config]);

  // 撤回 / 回退的结果：把原文填回输入框
  const selIdRef = useRef<string | null>(null);
  selIdRef.current = sel?.id ?? null;
  useEffect(() => socket.on((m) => {
    if (m.t === 'queue.cancelled') {
      if (m.sessionId !== selIdRef.current) return;
      if (m.ok) composerRef.current?.restoreText(m.text ?? '', 'append'); // 输入框为空直接填入，否则换行追加
      else flash('这条消息已经开始执行，无法撤回');
    } else if (m.t === 'rewind.result') {
      if (m.sessionId !== selIdRef.current || m.reqId !== rewindReq.current) return;
      rewindReq.current = null;
      if (m.ok) {
        patch((v) => { if (v.id === m.sessionId) v.conv = rewindTo(v.conv, m.targetId); });
        composerRef.current?.restoreText(m.prefillText ?? '', 'replace');
      } else {
        flash(`回退失败：${m.error ?? '未知原因'}`);
      }
    }
  }), [flash, patch]);

  const onInterrupt = useCallback(() => {
    if (sel) socket.send({ t: 'interrupt', sessionId: sel.id });
  }, [sel]);
  const onRetryNow = useCallback(() => {
    if (sel) socket.send({ t: 'retry.now', sessionId: sel.id });
  }, [sel]);
  const onRetryCancel = useCallback(() => {
    if (sel) socket.send({ t: 'retry.cancel', sessionId: sel.id });
  }, [sel]);

  // 委派任务：停止 / 追加消息（子代理行与浮层里的按钮）
  const selId0 = sel?.id ?? null;
  const onDelegateStop = useCallback((toolUseId: string) => {
    if (selId0) socket.send({ t: 'delegate.stop', sessionId: selId0, toolUseId });
  }, [selId0]);
  const onDelegateSend = useCallback((toolUseId: string, text: string, mode: DelegateSendMode) => {
    if (selId0) socket.send({ t: 'delegate.send', sessionId: selId0, toolUseId, text, mode });
  }, [selId0]);
  const delegateActions = useMemo<DelegateActions>(() => ({ stop: onDelegateStop }), [onDelegateStop]);

  // ───────────── 通话模式 ─────────────
  // 说完自动发送 → 执行完念交付 → 再听。控制逻辑在 core/speech/call.ts，这里只负责发消息和判断「这一轮结束了」。

  const callState = useSyncExternalStore(call.subscribe, call.getState);
  /** 发出这句话时的最后一轮：之后出现的、已结束的新一轮就是这句话的结果 */
  const callBaseline = useRef<string | null>(null);
  const callLive = useRef({ sendText, running, lastTurnId: null as string | null, canSend: !!selCwd });
  callLive.current = { sendText, running, lastTurnId: shownTurns[shownTurns.length - 1]?.id ?? null, canSend: !!selCwd };

  const onCall = useCallback(() => {
    if (call.inCall()) { call.hangup(); return; }
    const live = callLive.current;
    // 打开时正在执行：等这一轮结束、念它的结果
    callBaseline.current = live.running ? null : live.lastTurnId;
    void call.start({
      send: (text) => {
        const cur = callLive.current;
        if (!cur.canSend) return false;
        callBaseline.current = cur.lastTurnId;
        cur.sendText(text);
        return true;
      },
      running: () => callLive.current.running,
    });
  }, []);

  useEffect(() => {
    if (callState.phase !== 'waiting' || running) return;
    const t = shownTurns[shownTurns.length - 1];
    if (!t || isTurnActive(t) || t.id === callBaseline.current) return;
    callBaseline.current = t.id;
    const text = getLiveText(t, false) || (t.status === 'error' ? '执行出错了，请看屏幕。' : '执行完了。');
    void call.turnFinished(t.id, text);
  }, [callState.phase, running, shownTurns]);

  // 离开页面（切走工作空间不算）时挂断，释放麦克风
  useEffect(() => () => call.hangup(), []);

  // 通话出错（如无法打开麦克风）时在顶部提示一下
  useEffect(() => {
    if (callState.phase === 'off' && callState.error) flash(callState.error);
  }, [callState, flash]);

  const onConfigChange = useCallback((c: SessionConfig) => {
    setConfig(c);
    // 全局记忆：下次启动 / 新会话沿用
    // 权限模式只属于当前会话：不进全局默认，新会话永远从自动模式开始
    const { permissionMode: _pm, ...persistent } = c;
    api.saveDefaults(persistent).catch(() => { /* 记忆失败不影响使用 */ });
    setBoot((b) => (b ? { ...b, defaults: persistent } : b));
    if (!sel) return;
    configs.current.set(sel.id, c);
    // 进程在就立即下发（下一轮生效）；不在则服务端只记下，随下一次 send 带上。无论哪种都要发，服务端据此持久化这个会话的配置
    socket.send({ t: 'config', sessionId: sel.id, config: c });
  }, [sel, view]);

  const onPromptReply = useCallback((id: string, reply: PromptReply) => {
    if (!sel) return;
    socket.send({ t: 'prompt.reply', sessionId: sel.id, id, reply });
    // 批准计划后回到自动模式（服务端同样会切换）
    if (reply.kind === 'approve') onConfigChange({ ...config, permissionMode: 'auto' });
  }, [sel, config, onConfigChange]);

  const onRename = useCallback((title: string) => {
    if (!sel) return;
    if (!current) { flash('会话还没有记录，发送第一条消息后才能改名'); return; }
    const rename = (l: SessionSummary[]) => l.map((s) => (s.id === sel.id ? { ...s, title } : s));
    mapSessions(rename);
    setPins(rename);
    const reload = () => { loadSessions(sel.cwd); loadPins(); };
    api.rename(sel.id, sel.cwd, title)
      .then(reload)
      .catch((e) => { flash(`改名失败：${errText(e)}`); reload(); });
  }, [sel, current, flash, loadSessions, loadPins, mapSessions]);

  /**
   * 从某条用户消息之前分支出新会话：服务端把源记录里这条消息之前的内容写成一份新记录（源会话一字不改）。
   * stay=false 时切到新会话，并把这条消息的原文填回输入框（改一改再发，等于非破坏性的「回退」）；
   * stay=true 时留在当前会话，新会话随侧栏刷新出现。
   */
  const onFork = useCallback((targetId: string, stay: boolean) => {
    if (!sel || !selCwd) return;
    const dir = selCwd;
    const turn = shownTurns.find((t) => t.userId === targetId);
    const prefill = turn ? expandLabels(turn.userText, turn.attachments) : '';
    api.forkSession(sel.id, dir, targetId)
      .then(({ sessionId }) => {
        configs.current.set(sessionId, config); // 分支沿用当前会话此刻的模型 / 思考强度
        if (stay) {
          flash('已分支出新会话，见侧栏');
          return;
        }
        selectSession(sessionId, dir);
        composerRef.current?.restoreText(prefill, 'replace');
      })
      .catch((e) => flash(`分支失败：${errText(e)}`));
  }, [sel, selCwd, shownTurns, config, selectSession, flash]);

  // ───────────── 上下文面板 ─────────────

  const refreshContext = useCallback(() => {
    if (!sel || (!current && !sel.fresh)) return;
    const id = sel.id;
    setCtxLoading(true);
    api.refreshContext(id, sel.cwd, isDraft(sel))
      .then((u) => { if (u) patch((v) => { if (v.id === id) v.context = u; }); })
      .catch((e) => flash(`刷新上下文失败：${errText(e)}`))
      .finally(() => setCtxLoading(false));
  }, [sel, current, patch, flash]);

  // 所有会话的工具累计调用次数：换会话、一轮结束（记录有新增）时重新取；服务端是增量扫描，开销很小。
  // 取不到（老服务端没有这个接口）就保持空，面板只显示本会话的次数。
  const toolStatsSeq = useRef(0);
  const loadToolStats = useCallback(() => {
    const seq = ++toolStatsSeq.current;
    api.getToolStats()
      .then((s) => { if (seq === toolStatsSeq.current) setToolStats(s); })
      .catch(() => {});
  }, []);
  const selKey = sel?.id ?? null;
  useEffect(() => {
    if (!running) loadToolStats();
  }, [selKey, running, loadToolStats]);

  // 花费：价格表（服务端定期从官方页面更新，取不到用内置表）只取一次
  const [pricing, setPricing] = useState<PriceTable>(BUILTIN_PRICES);
  useEffect(() => {
    api.getPricing().then(setPricing).catch(() => {});
  }, []);
  // 子代理的花费由服务端读子代理记录算好：换会话、一轮结束时重取（记下是哪个会话的，切走后不串到别的会话上）
  const [subCosts, setSubCosts] = useState<{ id: string; items: SubagentCost[] } | null>(null);
  const subCostSeq = useRef(0);
  const subCostCwd = sel && !isDraft(sel) ? sel.cwd : null;
  useEffect(() => {
    if (!selKey || !subCostCwd || running) return;
    const seq = ++subCostSeq.current;
    api.subagentCosts(selKey, subCostCwd)
      .then((r) => { if (seq === subCostSeq.current) setSubCosts({ id: selKey, items: r.items }); })
      .catch(() => { if (seq === subCostSeq.current) setSubCosts({ id: selKey, items: [] }); });
  }, [selKey, subCostCwd, running]);
  // 计费方式：会话用的账号是 API 账号（官方 / 第三方地址）还是订阅账号
  const [accounts, setAccounts] = useState<AccountList | null>(null);
  useEffect(() => {
    api.accounts().then(setAccounts).catch(() => setAccounts(null));
  }, [accountVersion]);
  /** 会话用的账号：并行模式下是绑定的那个，否则是当前账号 */
  const sessionAccount = useMemo(() => {
    const list = accounts?.list ?? [];
    return (current?.account ? list.find((a) => a.id === current.account) : undefined) ?? list.find((a) => a.active);
  }, [accounts, current?.account]);
  const billing = useMemo<Billing>(() => {
    const acc = sessionAccount;
    if (!acc?.api) return 'subscription';
    const base = acc.api.baseUrl.trim();
    return !base || /^https?:\/\/api\.anthropic\.com(\/|$)/i.test(base) ? 'api' : 'thirdParty';
  }, [sessionAccount]);
  /** 配了映射的 API 账号：模型菜单改用它的映射项（订阅账号与没配映射的 API 账号不变） */
  const modelMap = useMemo(() => {
    // Kiro 账号的映射是从内置 kiro.rs 服务自动拉取的，放在 kiro.models
    const m = sessionAccount?.api?.models ?? sessionAccount?.kiro?.models;
    return hasModelMapping(m) ? m! : null;
  }, [sessionAccount]);
  // 模型菜单：会话所用账号实际可用的模型（CLI 报告的）。按账号记住，切会话时不闪回内置表；拉不到 = null（菜单用内置表）
  const modelAccount = sessionAccount?.id ?? null;
  const modelLists = useRef(new Map<string, CliModelList | null>());
  const [modelListTick, setModelListTick] = useState(0);
  const storeModels = useCallback((account: string, r: CliModelList | null) => {
    // 拉取失败不覆盖已有的
    if (r || !modelLists.current.has(account)) modelLists.current.set(account, r);
    setModelListTick((n) => n + 1);
  }, []);
  useEffect(() => {
    if (!modelAccount) return;
    let alive = true;
    api.cliModels({ account: modelAccount })
      .then((r) => { if (alive) storeModels(modelAccount, r); })
      .catch(() => {});
    return () => { alive = false; };
  }, [modelAccount, accountVersion, storeModels]);
  const modelList = useMemo(
    () => (modelAccount ? modelLists.current.get(modelAccount)?.models ?? null : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [modelAccount, modelListTick],
  );
  const refreshModels = useCallback(async () => {
    if (!modelAccount) return;
    storeModels(modelAccount, await api.cliModels({ account: modelAccount, refresh: true }));
  }, [modelAccount, storeModels]);
  // 子代理模型（全局）：老服务端没有这个接口时不显示这一节
  const [agentModels, setAgentModels] = useState<AgentModelConfig | null>(null);
  useEffect(() => {
    api.agentModels().then(setAgentModels).catch(() => {});
  }, []);
  const changeAgentModels = useCallback((c: AgentModelConfig) => {
    setAgentModels(c);
    api.saveAgentModels(c).catch((e) => {
      flash(`保存子代理模型失败：${errText(e)}`);
      api.agentModels().then(setAgentModels).catch(() => {});
    });
  }, [flash]);
  // agy 的模型列表要启动 agy 才能拿到，打开菜单时才拉
  const delegateSeq = useRef(0);
  const [delegate, setDelegate] = useState<{ list: DelegateModelList | null; error: string | null; loading: boolean }>({ list: null, error: null, loading: false });
  const loadDelegate = useCallback((refresh: boolean) => {
    const seq = ++delegateSeq.current;
    setDelegate((d) => ({ ...d, loading: true, error: null }));
    api.delegateModels(refresh)
      .then((list) => { if (seq === delegateSeq.current) setDelegate({ list, error: null, loading: false }); })
      .catch((e) => { if (seq === delegateSeq.current) setDelegate((d) => ({ ...d, error: errText(e), loading: false })); });
  }, []);
  // 点花费图的柱子：滚到会话流里的这一轮，并短暂高亮
  const jumpToTurn = useCallback((index: number) => {
    const t = view?.conv.turns[index];
    if (!t) return;
    const id = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(t.id) : t.id;
    const el = document.querySelector<HTMLElement>(`.cz-app__flow .cz-flow__item[data-turn-id~="${id}"]`);
    if (!el) return;
    if (narrow) setDrawer(null);
    el.scrollIntoView({ block: 'start', behavior: scrollBehavior() });
    el.classList.remove('is-flash');
    void el.offsetWidth;
    el.classList.add('is-flash');
    window.setTimeout(() => el.classList.remove('is-flash'), 1400);
  }, [view, narrow]);

  // 打开已有会话时后端若没有缓存（例如刚重启），自动采集一次，不用再点「刷新」；
  // 新会话草稿也自动采集（后端用 --session-id 拉起探测进程），这样发第一条消息前就能调整 skill / MCP。
  // 每次打开只自动试一次（切走再切回会重试），失败 / 无数据时停在空态，由用户手动刷新。
  const ctxAutoTried = useRef<string | null>(null);
  useEffect(() => {
    if (!sel) { ctxAutoTried.current = null; return; }
    if ((!sel.fresh && !current) || view?.id !== sel.id || !view.contextChecked || view.context) return;
    if (ctxAutoTried.current === sel.id) return;
    ctxAutoTried.current = sel.id;
    refreshContext();
  }, [sel, current, view, refreshContext]);

  // skill 状态：乐观更新，后端随后推送新的 context 覆盖；失败时重新采集纠正
  const setSkillMode = useCallback((name: string, mode: SkillMode) => {
    const id = sel?.id;
    if (id) {
      patch((v) => {
        if (v.id !== id || !v.context) return;
        v.context = {
          ...v.context,
          skills: v.context.skills.map((s) => (s.name === name ? { ...s, mode, tokens: mode === 'on' ? s.tokens : null } : s)),
        };
      });
    }
    api.setSkillMode(name, mode).catch((e) => {
      flash(`设置 skill 失败：${errText(e)}`);
      refreshContext();
    });
  }, [sel, patch, flash, refreshContext]);

  // 批量设置 skill（勾选批量操作 / 撤销）：同样乐观更新
  const setSkillModes = useCallback((modes: Record<string, SkillMode>) => {
    const id = sel?.id;
    if (id) {
      patch((v) => {
        if (v.id !== id || !v.context) return;
        v.context = {
          ...v.context,
          skills: v.context.skills.map((s) => {
            const mode = modes[s.name];
            return mode ? { ...s, mode, tokens: mode === 'on' ? s.tokens : null } : s;
          }),
        };
      });
    }
    api.setSkillModes(modes).catch((e) => {
      flash(`批量设置 skill 失败：${errText(e)}`);
      refreshContext();
    });
  }, [sel, patch, flash, refreshContext]);

  // 移除 skill：先让列表里的它消失；失败则提示并重新采集
  const removeSkill = useCallback((name: string) => {
    const id = sel?.id;
    if (!sel) return;
    if (id) {
      patch((v) => {
        if (v.id !== id || !v.context) return;
        v.context = { ...v.context, skills: v.context.skills.filter((s) => s.name !== name) };
      });
    }
    api.removeSkill(name, isDraft(sel) ? null : sel.id, sel.cwd)
      .then(() => flash(`已移除 skill「${name}」，已备份到 ~/.cosyee/removed-skills；新会话生效`))
      .catch((e) => {
        flash(`移除 skill 失败：${errText(e)}`);
        refreshContext();
      });
  }, [sel, patch, flash, refreshContext]);

  // 在服务端文件管理器中选中该 skill 的 SKILL.md
  const revealSkill = useCallback((name: string) => {
    if (!sel) return;
    api.revealSkill(name, isDraft(sel) ? null : sel.id, sel.cwd)
      .catch((e) => flash(`打开文件位置失败：${errText(e)}`));
  }, [sel, flash]);

  // 内置工具开关：乐观更新；失败则提示并重新采集
  const toggleTool = useCallback((name: string, enabled: boolean) => {
    const id = sel?.id;
    if (id) {
      patch((v) => {
        if (v.id !== id || !v.context) return;
        const rest = (v.context.disabledTools ?? []).filter((n) => n !== name);
        v.context = { ...v.context, disabledTools: enabled ? rest : [...rest, name] };
      });
    }
    api.setTool(name, enabled).catch((e) => {
      flash(`${enabled ? '启用' : '停用'}工具失败：${errText(e)}`);
      refreshContext();
    });
  }, [sel, patch, flash, refreshContext]);

  // 智能体开关：同工具开关，乐观更新；失败则提示并重新采集
  const toggleAgent = useCallback((name: string, enabled: boolean) => {
    const id = sel?.id;
    if (id) {
      patch((v) => {
        if (v.id !== id || !v.context) return;
        const rest = (v.context.disabledAgents ?? []).filter((n) => n !== name);
        v.context = { ...v.context, disabledAgents: enabled ? rest : [...rest, name] };
      });
    }
    api.setAgent(name, enabled).catch((e) => {
      flash(`${enabled ? '开启' : '关闭'}智能体失败：${errText(e)}`);
      refreshContext();
    });
  }, [sel, patch, flash, refreshContext]);

  // 原生子代理开关（全局）：乐观更新；失败则回滚、提示并重新采集
  const toggleNativeAgents = useCallback((enabled: boolean) => {
    const id = sel?.id;
    if (id) {
      patch((v) => {
        if (v.id !== id || !v.context) return;
        v.context = { ...v.context, nativeAgents: enabled };
      });
    }
    api.setNativeAgents(enabled).catch((e) => {
      if (id) {
        patch((v) => {
          if (v.id === id && v.context) v.context = { ...v.context, nativeAgents: !enabled };
        });
      }
      flash(`${enabled ? '开启' : '关闭'}原生子代理失败：${errText(e)}`);
      refreshContext();
    });
  }, [sel, patch, flash, refreshContext]);

  // MCP 开关：切换期间禁用该开关，等后端返回切换后的上下文
  const [mcpBusy, setMcpBusy] = useState<string | null>(null);
  const toggleMcp = useCallback((server: string, enabled: boolean) => {
    if (!sel || (!current && !sel.fresh) || mcpBusy) return;
    const id = sel.id;
    setMcpBusy(server);
    api.toggleMcp(id, server, enabled, sel.cwd, isDraft(sel))
      .then((u) => { if (u) patch((v) => { if (v.id === id) v.context = u; }); })
      .catch((e) => flash(`${enabled ? '启用' : '停用'} MCP 失败：${errText(e)}`))
      .finally(() => setMcpBusy(null));
  }, [sel, current, mcpBusy, patch, flash]);

  // 自动压缩窗口（全局）：乐观更新显示值；运行中的会话由服务端重新采集后推送新的触发点
  const setCompactWindow = useCallback((w: number | null) => {
    const id = sel?.id;
    if (id) patch((v) => { if (v.id === id && v.context) v.context = { ...v.context, compactWindow: w }; });
    api.setCompactWindow(w)
      .then(() => { if (w === null) flash('已恢复默认压缩窗口；运行中的会话可能要重启后才完全回到默认'); })
      .catch((e) => {
        flash(`设置压缩窗口失败：${errText(e)}`);
        refreshContext();
      });
  }, [sel, patch, flash, refreshContext]);

  const compact = useCallback(() => {
    if (!sel || running || isDraft(sel)) return;
    sendText('/compact');
  }, [sel, running, sendText]);

  // ───────────── 侧栏：置顶 / 删除 / 恢复 / 工作空间管理 ─────────────

  const togglePin = useCallback((s: SessionSummary) => {
    (s.pinned ? api.unpinSession(s.id) : api.pinSession(s.id, s.cwd))
      .then(refreshSidebar)
      .catch((e) => flash(`${s.pinned ? '取消置顶' : '置顶'}失败：${errText(e)}`));
  }, [refreshSidebar, flash]);

  const deleteSession = useCallback((s: SessionSummary) => {
    const wasOpen = sel?.id === s.id;
    api.deleteSession(s.id, s.cwd)
      .then(() => {
        if (wasOpen) {
          // 删掉的正是打开的会话：换成列表里的下一个，没有就回到空白的新会话
          const next = listed.find((x) => x.id !== s.id) ?? pins.find((x) => x.id !== s.id);
          if (next) selectSession(next.id);
          else newSession();
        }
        refreshSidebar();
      })
      .catch((e) => { flash(`删除失败：${errText(e)}`); refreshSidebar(); });
  }, [sel, listed, pins, selectSession, newSession, refreshSidebar, flash]);

  const restoreSession = useCallback((id: string) => {
    api.restoreSession(id).then(refreshSidebar).catch((e) => flash(`恢复失败：${errText(e)}`));
  }, [refreshSidebar, flash]);

  const purgeSession = useCallback((id: string) => {
    api.purgeSession(id).then(refreshSidebar).catch((e) => { flash(`永久删除失败：${errText(e)}`); refreshSidebar(); });
  }, [refreshSidebar, flash]);

  // 批量删除一个工作空间分组里的会话（ids 由侧栏给出：组里当前显示、不在执行中的）
  const deleteSessions = useCallback((dir: string, ids: string[]) => {
    const gone = new Set(ids);
    const wasOpen = !!sel && gone.has(sel.id);
    api.deleteSessions(dir, ids)
      .then((r) => {
        if (wasOpen) {
          const next = listed.find((x) => !gone.has(x.id)) ?? pins.find((x) => !gone.has(x.id));
          if (next) selectSession(next.id);
          else newSession();
        }
        if (r.skipped > 0) flash(`已删除 ${r.deleted} 个会话，${r.skipped} 个正在执行的已跳过`);
        refreshSidebar();
      })
      .catch((e) => { flash(`删除失败：${errText(e)}`); refreshSidebar(); });
  }, [sel, listed, pins, selectSession, newSession, refreshSidebar, flash]);

  const restoreSessions = useCallback((ids: string[]) => {
    api.restoreDeleted(ids).then(refreshSidebar).catch((e) => flash(`恢复失败：${errText(e)}`));
  }, [refreshSidebar, flash]);

  const purgeSessions = useCallback((ids: string[]) => {
    api.purgeDeleted(ids)
      .then((r) => { if (r.failed > 0) flash(`${r.failed} 个会话永久删除失败：${r.error ?? '未知原因'}`); })
      .catch((e) => flash(`永久删除失败：${errText(e)}`))
      .finally(refreshSidebar);
  }, [refreshSidebar, flash]);

  const moveWorkspaceTop = useCallback((path: string) => {
    api.moveWorkspaceTop(path)
      .then((r) => setWsState((w) => ({ ...w, list: r.list })))
      .catch((e) => flash(`置于顶部失败：${errText(e)}`));
  }, [flash]);

  const removeWorkspace = useCallback((path: string) => {
    api.removeWorkspace(path)
      .then((r) => {
        // 只改 Cosyee 的最近列表；移除的是当前工作空间时，服务端已切到下一个（或没有）
        if (!samePath(r.current, cwd)) {
          autoPick.current = true;
          setSel(null);
          setOpenSub(null);
        } else if (sel && samePath(sel.cwd, path)) {
          setSel(r.current ? draftSel(r.current) : null);
          setOpenSub(null);
        }
        setWsState({ current: r.current, list: r.list });
      })
      .catch((e) => flash(`移除失败：${errText(e)}`));
  }, [cwd, sel, flash]);

  const revealWorkspace = useCallback((path: string) => {
    api.revealWorkspace(path).catch((e) => flash(`打开文件夹失败：${errText(e)}`));
  }, [flash]);

  // ───────────── 子代理浮层 ─────────────

  const liveRun = useMemo(() => {
    if (!openSub) return null;
    return turns.find((t) => t.id === openSub.turnId)?.subagents.find((s) => s.toolUseId === openSub.toolUseId) ?? null;
  }, [openSub, turns]);

  // 历史里的子代理只有一条 Agent 调用，过程在单独的 jsonl 里，按需加载
  useEffect(() => {
    setLoadedSub(null);
    if (!liveRun || !sel || liveRun.delegate === true) return;
    const empty = liveRun.turn.steps.length === 0 && !liveRun.turn.answer;
    if (!empty || liveRun.status === 'running') return;
    let alive = true;
    api.subagent(sel.id, liveRun.toolUseId, sel.cwd)
      .then(({ entries }) => {
        if (!alive) return;
        const turn = subagentTurnFromHistory(entries, { title: liveRun.title, toolUseId: liveRun.toolUseId });
        const model = subagentModelFromHistory(entries) ?? liveRun.model;
        const effort = subagentEffortFromHistory(entries) ?? liveRun.effort;
        setLoadedSub({ ...liveRun, turn, ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
      })
      .catch(() => { /* 没有子代理记录就显示空 */ });
    return () => { alive = false; };
    // 只在打开的目标变化时加载
  }, [openSub?.turnId, openSub?.toolUseId, sel?.id, sel?.cwd, liveRun?.status]);

  // 委派的过程：会话记录里没有，刷新 / 重启后从服务端的过程记录补。
  // 运行中且页面上的不全（中途刷新过）就轮询；从头看着的只查一次，之后用实时推送
  const [delegateRec, setDelegateRec] = useState<{ id: string; turn: Turn; model?: string; effort?: string } | null>(null);
  const liveRunRef = useRef(liveRun);
  liveRunRef.current = liveRun;
  const recId = liveRun?.delegate === true ? liveRun.toolUseId : null;
  useEffect(() => {
    if (!recId || !sel) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      api.subagent(sel.id, recId, sel.cwd)
        .then(({ entries }) => {
          const run = liveRunRef.current;
          if (!alive || run?.toolUseId !== recId) return;
          const turn = subagentTurnFromHistory(entries, { title: run.title, toolUseId: recId });
          setDelegateRec({ id: recId, turn, model: subagentModelFromHistory(entries), effort: subagentEffortFromHistory(entries) });
          if (run.status === 'running' && recordFuller(run, turn)) timer = setTimeout(load, 1500);
        })
        .catch(() => { /* 没有过程记录（旧的委派）就只显示结果 */ });
    };
    load();
    return () => { alive = false; clearTimeout(timer); };
  }, [recId, sel?.id, sel?.cwd, liveRun?.status]);

  const overlayRun = useMemo(() => {
    if (loadedSub && liveRun && loadedSub.toolUseId === liveRun.toolUseId) return loadedSub;
    if (!liveRun || delegateRec?.id !== liveRun.toolUseId) return liveRun;
    const run = withRecord(liveRun, delegateRec.turn);
    const model = run.model ?? delegateRec.model;
    const effort = run.effort ?? delegateRec.effort;
    return model === run.model && effort === run.effort ? run : { ...run, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
  }, [loadedSub, liveRun, delegateRec]);
  const onOpenSubagent = useCallback((turnId: string, toolUseId: string) => setOpenSub({ turnId, toolUseId }), []);
  const closeSub = useCallback(() => setOpenSub(null), []);

  // ───────────── 本地文件预览 ─────────────

  /** 当前打开的预览（nonce：同一路径再次点击也会重新定位 / 刷新） */
  const [preview, setPreview] = useState<{ path: string; line?: number; nonce: number } | null>(null);
  /** 触发预览的元素：关闭后焦点还给它 */
  const openerRef = useRef<HTMLElement | null>(null);
  const previewOpen = useRef(false);
  previewOpen.current = preview != null;
  const selDir = sel?.cwd ?? null;

  const openPreview = useCallback((req: FileOpenRequest, opener?: HTMLElement | null) => {
    // 预览里再点链接时不覆盖最初的触发元素
    if (!previewOpen.current) openerRef.current = opener ?? (document.activeElement as HTMLElement | null);
    setPreview((p) => ({ path: req.path, ...(req.line ? { line: req.line } : {}), nonce: (p?.nonce ?? 0) + 1 }));
  }, []);
  const closePreview = useCallback((restoreFocus: boolean) => {
    setPreview(null);
    const el = openerRef.current;
    openerRef.current = null;
    if (restoreFocus && el && el.isConnected) el.focus();
  }, []);
  // 切换会话 / 工作空间：预览属于旧会话，直接关掉
  useEffect(() => { setPreview(null); openerRef.current = null; }, [selId]);

  const filesApi = useMemo<FilesApi | null>(() => {
    if (!selId || !selDir) return null;
    return {
      cwd: selDir,
      session: selId,
      open: openPreview,
      platform: boot?.platform,
      exec: (lang: string, code: string, signal: AbortSignal) => api.execSnippet({ session: selId, cwd: selDir, lang, code }, signal),
      ...(remote
        ? {
            downloadUrl: (path: string) => api.fileDownloadUrl({ session: selId, cwd: selDir, path }),
          }
        : {
            reveal: (path: string) => { api.revealFile({ session: selId, cwd: selDir, path }).catch((e) => flash(`打开文件管理器失败：${errText(e)}`)); },
            terminal: (path: string) => { api.openTerminalAt({ session: selId, cwd: selDir, path }).catch((e) => flash(`打开终端失败：${errText(e)}`)); },
            openLocal: (path: string) => {
              api.openFile({ session: selId, cwd: selDir, path }).then(
                (r) => { if (r.revealed) flash('可执行文件和脚本不直接运行，已在文件管理器中显示'); },
                (e) => flash(`打开文件失败：${errText(e)}`),
              );
            },
          }),
    };
  }, [selId, selDir, openPreview, flash, remote, boot?.platform]);

  // 技能 / MCP 面板用：MCP 服务器名（解析 mcp__ 工具名）
  const mcpKey = JSON.stringify(meta?.mcpServers?.map((m) => m.name) ?? []);
  const flowMeta = useMemo<FlowMeta>(
    () => ({ mcpServers: JSON.parse(mcpKey) as string[], loadSkill: defaultSkillLoader }),
    [mcpKey],
  );

  // 输入框是浮在会话流上的磨砂卡片：量出它的高度，会话流底部按 --composer-h 让出位置
  const mainRef = useRef<HTMLDivElement>(null);
  const composerWrapRef = useRef<HTMLDivElement>(null);
  useCssHeight(mainRef, composerWrapRef, '--composer-h', [!!boot, !!cwd]);

  // ───────────── 渲染 ─────────────

  if (fatal) {
    return (
      <div className="cz-app__fatal">
        无法连接后端：{fatal}
      </div>
    );
  }
  if (!boot) return <div className="cz-app__fatal">正在连接…</div>;

  const showWorkspacePicker = !sel || isDraft(sel);

  const main = !cwd ? (
    <div className="cz-app__empty">
      <p>先打开一个文件夹作为工作空间</p>
      <button type="button" className="cz-app__btn" onClick={openFolder}>打开文件夹…</button>
    </div>
  ) : (
    <div className="cz-app__main" ref={mainRef}>
      <div className={`cz-app__flow${heldFlow ? ' is-leaving' : ''}`}>
        {heldFlow ? (
          <ConversationView
            key={heldFlow.key}
            turns={heldFlow.turns}
            sessionKey={heldFlow.key}
          />
        ) : view?.loading ? null : view?.loadError ? (
          <div className="cz-app__hint">加载会话失败：{view.loadError}</div>
        ) : shownTurns.length === 0 ? (
          <div className="cz-app__hint">{!sel || isDraft(sel) ? '新会话：输入消息开始' : ''}</div>
        ) : (
          <ConversationView
            key={view?.id ?? 'none'}
            turns={turns}
            onReply={onReply}
            onFork={onFork}
            sessionKey={sel?.id ?? null}
            reveal={skeleton.reveal}
            stop={view?.stop ?? null}
            onRetryNow={onRetryNow}
            onRetryCancel={onRetryCancel}
            footer={
              // 会话活动区（子代理 / 技能 / MCP）放在会话流末尾，跟着内容一起滚动
              <SessionDock turns={turns} sessionKey={sel?.id ?? null} onOpenSubagent={onOpenSubagent} />
            }
          />
        )}
        {/* 骨架固定在这个位置渲染：加载中 → 淡出是同一个元素，不会重新挂载闪一下 */}
        {skeleton.phase !== 'off' && <FlowSkeleton leaving={skeleton.phase === 'leaving'} />}
      </div>
      {/* 侧栏收起时左侧浮出置顶会话，只能点了切换；窄屏用抽屉，不显示 */}
      <PinnedRail
        open={collapsed && !narrow}
        pinned={pins}
        workspaces={wsState.list}
        currentSessionId={sel?.id ?? null}
        onSelectSession={selectSession}
      />
      {/* 上下文栏收起时右侧留白里浮出上下文占用和几张图（留白够宽才出现）；窄屏用抽屉，不显示 */}
      <ChartRail
        open={ctxCollapsed && !narrow}
        usage={sel && view?.id === sel.id ? view.context : null}
        cache={sel && view?.id === sel.id ? view.conv.meta.cache : undefined}
        turns={sel && view?.id === sel.id ? view.conv.turns : undefined}
        compactions={sel && view?.id === sel.id ? view.conv.meta.compactions : undefined}
        subCosts={sel && subCosts?.id === sel.id ? subCosts.items : null}
        pricing={pricing}
        model={sel && view?.id === sel.id ? view.conv.meta.model : undefined}
        billing={billing}
        onJumpTurn={jumpToTurn}
      />
      {!wsConnected && <div className="cz-app__notice cz-app__notice--warn" role="status">连接已断开，正在重连…</div>}
      {notice && <div className="cz-app__notice" role="status">{notice}</div>}
      <div className="cz-app__composer" ref={composerWrapRef}>
        {/* 一直挂着：空了以后自己先播完退场再消失 */}
        <PromptPanel
          items={view?.prompts ?? NO_PROMPTS}
          onReply={onPromptReply}
          editor={{ pick: pickFiles, paste: api.paste, supportsMixed: boot.supportsMixedPick, previewInfo: api.previewInfo, previewRawUrl: api.previewRawUrl }}
        />
        <CallBar
          state={callState}
          needsAttention={!!view?.prompts?.length}
          onHangup={call.hangup}
          onSkip={call.skipSpeaking}
          onInterrupt={onInterrupt}
        />
        <Composer
          ref={composerRef}
          quotes={quotes}
          onRemoveQuote={onRemoveQuote}
          onEditQuoteReply={onEditQuoteReply}
          onClearQuotes={onClearQuotes}
          onSend={onSend}
          queue={view?.queue}
          onQueueSendNow={onQueueSendNow}
          onQueueCancel={onQueueCancel}
          rewindTargets={rewindTargets}
          onRewind={onRewind}
          onInterrupt={onInterrupt}
          running={running}
          onCall={onCall}
          callActive={callState.phase !== 'off'}
          sessionKey={view?.id ?? null}
          pick={pickFiles}
          paste={api.paste}
          supportsMixed={boot.supportsMixedPick}
          previewInfo={api.previewInfo}
          previewRawUrl={api.previewRawUrl}
          slashCommands={slashCommands}
          skills={skills}
          config={config}
          onConfigChange={onConfigChange}
          loadUsage={loadUsage}
          disabled={!!view?.loading}
          ultracodeAvailable={view?.applied?.ultracodeAvailable}
          modelMap={modelMap}
          modelList={modelList}
          onRefreshModels={refreshModels}
          footLeft={showWorkspacePicker ? (
            // 只在新会话（还没发出第一条消息）时显示；会话开始后工作空间就固定了
            <WorkspaceMenu
              workspaces={wsState.list}
              currentWorkspace={selCwd}
              onSelectWorkspace={selectWorkspace}
              onOpenFolder={openFolder}
              onMoveToTop={moveWorkspaceTop}
              onRemove={removeWorkspace}
              onReveal={remote ? undefined : revealWorkspace}
            />
          ) : undefined}
        />
      </div>
    </div>
  );

  return (
    <FilesContext.Provider value={filesApi}>
    <FlowMetaContext.Provider value={flowMeta}>
    <DelegateContext.Provider value={delegateActions}>
      <AppShell
        narrow={narrow}
        onDismiss={closeDrawer}
        sidebarCollapsed={narrow ? drawer !== 'left' : collapsed}
        onToggleSidebar={() => (narrow ? setDrawer((d) => (d === 'left' ? null : 'left')) : setCollapsed((v) => !v))}
        onNewSession={newSession}
        contextCollapsed={narrow ? drawer !== 'right' : ctxCollapsed}
        onToggleContext={() => (narrow ? setDrawer((d) => (d === 'right' ? null : 'right')) : setCtxCollapsed((v) => !v))}
        sidebar={
          <Sidebar
            workspaces={wsState.list}
            sessions={allSessions}
            pinned={pins}
            deleted={deleted}
            currentSessionId={sel?.id ?? null}
            account={account}
            accountVersion={accountVersion}
            onNewSession={narrow ? () => { closeDrawer(); newSession(); } : newSession}
            onCollapse={narrow ? closeDrawer : () => setCollapsed(true)}
            onSelectSession={narrow ? (id: string) => { closeDrawer(); selectSession(id); } : selectSession}
            onTogglePin={togglePin}
            onDeleteSession={deleteSession}
            onRestoreSession={restoreSession}
            onPurgeSession={purgeSession}
            onDeleteSessions={deleteSessions}
            onRestoreSessions={restoreSessions}
            onPurgeSessions={purgeSessions}
          />
        }
        header={selCwd ? <SessionHeader title={current?.title ?? null} cwd={selCwd} branch={branch} session={current} onRename={onRename} /> : null}
        main={main}
        context={
          <ContextPanel
            usage={sel && view?.id === sel.id ? view.context : null}
            cache={sel && view?.id === sel.id ? view.conv.meta.cache : undefined}
            turns={sel && view?.id === sel.id ? view.conv.turns : undefined}
            toolStats={toolStats}
            loading={ctxLoading}
            onRefresh={refreshContext}
            onCompact={compact}
            onCompactWindow={setCompactWindow}
            compactDisabled={!sel || isDraft(sel) || running}
            onCollapse={narrow ? closeDrawer : () => setCtxCollapsed(true)}
            onSkillMode={setSkillMode}
            onSkillModes={setSkillModes}
            onSkillRemove={removeSkill}
            onSkillReveal={remote ? undefined : revealSkill}
            tools={sel && view?.id === sel.id ? view.conv.meta.tools : undefined}
            onToolToggle={toggleTool}
            agents={sel && view?.id === sel.id ? view.conv.meta.agents : undefined}
            onAgentToggle={toggleAgent}
            onMcpToggle={toggleMcp}
            mcpBusy={mcpBusy}
            compactions={sel && view?.id === sel.id ? view.conv.meta.compactions : undefined}
            cliCost={sel && view?.id === sel.id ? view.conv.meta.cliCost : undefined}
            model={sel && view?.id === sel.id ? view.conv.meta.model : undefined}
            subCosts={sel && subCosts?.id === sel.id ? subCosts.items : null}
            pricing={pricing}
            billing={billing}
            onJumpTurn={jumpToTurn}
            agentModels={agentModels && {
              config: agentModels,
              onChange: changeAgentModels,
              modelList,
              modelMap,
              delegate: delegate.list,
              delegateError: delegate.error,
              delegateLoading: delegate.loading,
              onLoadDelegate: loadDelegate,
              nativeAgents: sel && view?.id === sel.id ? view.context?.nativeAgents : undefined,
              onNativeAgents: toggleNativeAgents,
            }}
          />
        }
      />
      {webPick && <PickerDialog mode={webPick.mode} title={webPick.title} onDone={finishWebPick} />}
      <SubagentOverlay
        run={overlayRun}
        onClose={closeSub}
        agentModels={agentModels}
        delegates={view?.delegates ?? NO_JOBS}
        onDelegateStop={onDelegateStop}
        onDelegateSend={onDelegateSend}
      />
      {preview && selId && selDir && (
        <FilePreview session={selId} cwd={selDir} path={preview.path} line={preview.line} nonce={preview.nonce} onClose={closePreview} />
      )}
      {browserOpen && <BrowserPanel onClose={closeBrowser} onPick={onBrowserPick} />}
    </DelegateContext.Provider>
    </FlowMetaContext.Provider>
    </FilesContext.Provider>
  );
}
