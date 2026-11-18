// 主界面接线：把 api / socket / reducer 与 C3–C5 的组件连起来。组件本身不直接访问后端。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Account, Attachment, Bootstrap, DeletedSession, SessionConfig, SessionSummary, SkillMode, SubagentRun, Workspace,
} from '@cosyee/shared';
import { api, socket } from '../core/api';
import { subagentModelFromHistory, subagentTurnFromHistory } from '../core/reducer';
import { AppShell } from '../ui/layout/AppShell';
import { Sidebar } from '../ui/sidebar/Sidebar';
import { excludePinned, samePath } from '../ui/sidebar/sidebarUtil';
import { SessionHeader } from '../ui/header/SessionHeader';
import { ContextPanel } from '../ui/context/ContextPanel';
import { ConversationView } from '../ui/flow/ConversationView';
import { SubagentOverlay } from '../ui/flow/SubagentOverlay';
import { Composer, type ComposerHandle } from '../ui/composer/Composer';
import { useSessionStream } from './useSessionStream';
import './MainApp.css';

let socketStarted = false;
function startSocket() {
  if (socketStarted) return;
  socketStarted = true;
  socket.connect();
}

const FALLBACK_CONFIG: SessionConfig = { model: 'sonnet', effort: 'medium' };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 新会话草稿：先分配好会话 id，右侧面板据此拉起探测进程（可在发第一条消息前调整 skill / MCP），第一条消息复用它 */
const draftSel = (cwd: string) => ({ id: crypto.randomUUID(), cwd, fresh: true });

export function MainApp() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [wsState, setWsState] = useState<{ current: string | null; list: Workspace[] }>({ current: null, list: [] });
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  /** 置顶（全局，可来自任何工作空间）与已删除（全局） */
  const [pins, setPins] = useState<SessionSummary[]>([]);
  const [deleted, setDeleted] = useState<DeletedSession[]>([]);
  /** 打开的会话。cwd 是它所属的工作空间：从「置顶」点开别的工作空间的会话时，不改变当前工作空间与列表 */
  const [sel, setSel] = useState<{ id: string; cwd: string; fresh: boolean } | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  /** 账号信息有变化但不整页刷新（并行模式下切换新会话用的账号、改模式、移除账号等）时递增：额度、账号菜单、模式开关重新读取 */
  const [accountVersion, setAccountVersion] = useState(0);
  const [branch, setBranch] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  /** 右侧上下文栏收起；新开会话时自动展开 */
  const [ctxCollapsed, setCtxCollapsed] = useState(false);
  const [config, setConfig] = useState<SessionConfig>(FALLBACK_CONFIG);
  const [openSub, setOpenSub] = useState<{ turnId: string; toolUseId: string } | null>(null);
  const [loadedSub, setLoadedSub] = useState<SubagentRun | null>(null);
  const [ctxLoading, setCtxLoading] = useState(false);
  /** 选中回复带来的引用文字（同时只保留一个）；由输入框负责拼进消息并在发送后清除 */
  const [quote, setQuote] = useState<string | null>(null);
  const composerRef = useRef<ComposerHandle>(null);

  const configs = useRef(new Map<string, SessionConfig>());
  /** 本页已发过消息的会话（决定 isNew） */
  const sentIds = useRef(new Set<string>());
  /** 是否是还没发过消息的新会话草稿（磁盘上没有记录） */
  const isDraft = (s: { id: string; fresh: boolean } | null): boolean => !!s && s.fresh && !sentIds.current.has(s.id);
  /** 最近一次见到的 slash 命令与 skills（新会话还没有 init 时沿用） */
  const lastMeta = useRef<{ slash: string[]; skills: string[] }>({ slash: [], skills: [] });

  const cwd = wsState.current;
  /** 当前打开的会话所属的目录（没有打开会话时就是当前工作空间） */
  const selCwd = sel?.cwd ?? cwd;
  const { view, patch } = useSessionStream(sel?.id ?? null, selCwd, sel?.fresh ?? false);

  // 切换会话 / 工作空间 / 新会话时清空引用
  useEffect(() => { setQuote(null); }, [sel?.id]);

  const onReply = useCallback((q: string, reply: string) => {
    setQuote(q);
    composerRef.current?.appendText(reply);
  }, []);
  const onClearQuote = useCallback(() => setQuote(null), []);

  const flash = useCallback((msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice((n) => (n === msg ? null : n)), 4000);
  }, []);

  // ───────────── 启动 ─────────────

  useEffect(() => {
    api.bootstrap()
      .then((b) => {
        setBoot(b);
        setConfig(b.defaults);
        startSocket();
        return Promise.all([
          api.workspaces().then(setWsState),
          api.account().then(setAccount).catch(() => setAccount(null)),
        ]);
      })
      .catch((e) => setFatal(errText(e)));
  }, []);

  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  /** 当前 sessions 列表属于哪个工作空间（用来判断列表是否已为当前工作空间加载完） */
  const sessionsFor = useRef<string | null>(null);
  /** 启动 / 切换工作空间后还没有做过“自动打开第一个会话”；点“新会话”后置 false，避免覆盖用户的选择 */
  const autoPick = useRef(true);
  /** 请求序号：并发的重读只接受最后一次发出的结果，避免较早的旧结果后到把新数据覆盖掉 */
  const sessionsSeq = useRef(0);
  const pinsSeq = useRef(0);
  const loadSessions = useCallback((dir: string | null) => {
    const seq = ++sessionsSeq.current;
    if (!dir) { setSessions([]); return; }
    api.sessions(dir).then((list) => {
      // 只接受仍是当前工作空间、且是最新一次请求的结果
      if (seq === sessionsSeq.current && samePath(cwdRef.current, dir)) {
        sessionsFor.current = dir;
        setSessions(list);
      }
    }).catch((e) => flash(`读取会话列表失败：${errText(e)}`));
  }, [flash]);

  useEffect(() => { loadSessions(cwd); }, [cwd, loadSessions]);

  // 分支跟着「打开的会话」走（置顶里别的工作空间的会话也要显示它自己的分支）
  useEffect(() => {
    setBranch(null);
    if (selCwd) api.git(selCwd).then((r) => setBranch(r.branch)).catch(() => setBranch(null));
  }, [selCwd]);

  const loadPins = useCallback(() => {
    const seq = ++pinsSeq.current;
    api.pins()
      .then((list) => { if (seq === pinsSeq.current) setPins(list); })
      .catch((e) => flash(`读取置顶失败：${errText(e)}`));
  }, [flash]);
  const loadDeleted = useCallback(() => {
    api.deleted().then(setDeleted).catch((e) => flash(`读取已删除列表失败：${errText(e)}`));
  }, [flash]);
  /** 置顶 / 删除 / 恢复之类的操作之后：三块数据一起重读 */
  const refreshSidebar = useCallback(() => {
    loadSessions(cwdRef.current);
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
      if (samePath(m.cwd, cwd)) loadSessions(cwd);
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
    } else if (m.t === 'error') flash(m.message);
  }), [cwd, loadSessions, loadPins, refreshSidebar, flash]);

  // 断线重连（后端重启、电脑休眠唤醒等）：断线期间错过的列表变化全部重读
  useEffect(() => socket.onReconnect(refreshSidebar), [refreshSidebar]);

  // ───────────── 当前会话派生数据 ─────────────

  const turns = view?.conv.turns ?? [];
  const meta = view?.conv.meta;
  if (meta?.slashCommands?.length) lastMeta.current.slash = meta.slashCommands;
  if (meta?.skills?.length) lastMeta.current.skills = meta.skills;
  const running = view?.status === 'running' || view?.status === 'starting';
  const current = sel ? sessions.find((s) => s.id === sel.id) ?? pins.find((s) => s.id === sel.id) ?? null : null;
  /** 工作空间列表里实际显示的会话（已置顶的在「置顶」里） */
  const listed = useMemo(() => excludePinned(sessions, pins), [sessions, pins]);
  /** 额度按当前会话所用的账号取（并行模式下不同会话可能是不同账号）；会话或账号变了就换一个函数，让额度圆环重新读取 */
  const selId = sel?.id ?? null;
  const loadUsage = useCallback(
    (refresh: boolean) => api.usage(refresh, selId),
    [selId, accountVersion],
  );

  // ───────────── 工作空间与会话切换 ─────────────

  const selectWorkspace = useCallback((path: string) => {
    api.setCurrentWorkspace(path)
      .then(() => { autoPick.current = true; setWsState((w) => ({ ...w, current: path })); setSel(null); })
      .catch((e) => flash(errText(e)));
  }, [flash]);

  const openFolder = useCallback(() => {
    api.pickWorkspace()
      .then(({ workspace }) => {
        if (!workspace) return;
        autoPick.current = true;
        setWsState((w) => ({
          current: workspace.path,
          list: w.list.some((x) => samePath(x.path, workspace.path)) ? w.list : [...w.list, workspace],
        }));
        setSel(null);
      })
      .catch((e) => flash(`打开文件夹失败：${errText(e)}`));
  }, [flash]);

  const selectSession = useCallback((id: string) => {
    // 会话可能来自当前工作空间的列表，也可能来自「置顶」（任何工作空间）
    const hit = sessions.find((s) => s.id === id) ?? pins.find((s) => s.id === id);
    const dir = hit?.cwd ?? cwd;
    if (!dir) return;
    setSel({ id, cwd: dir, fresh: false });
    setOpenSub(null);
    setConfig(configs.current.get(id) ?? boot?.defaults ?? FALLBACK_CONFIG);
    const clearDot = (l: SessionSummary[]) => l.map((s) => (s.id === id && s.dot === 'unread' ? { ...s, dot: null } : s));
    setSessions(clearDot);
    setPins(clearDot);
    api.viewed(id, dir).catch(() => { /* 蓝点下次刷新再说 */ });
  }, [cwd, boot, sessions, pins]);

  const newSession = useCallback(() => {
    autoPick.current = false;
    const dir = cwdRef.current;
    // 已经停在同一工作空间的空白新会话上：沿用它（不再多起一个探测进程）
    setSel((s) => (!dir ? null : s && isDraft(s) && samePath(s.cwd, dir) ? s : draftSel(dir)));
    setOpenSub(null);
    setCtxCollapsed(false);
    setConfig(boot?.defaults ?? FALLBACK_CONFIG);
  }, [boot]);

  // 启动 / 切换工作空间后，列表加载完且没有选中会话时，自动打开列表（显示顺序）里的第一个
  useEffect(() => {
    if (!autoPick.current || !cwd || !samePath(sessionsFor.current, cwd)) return; // 列表还没为当前工作空间加载完
    autoPick.current = false; // 每次只尝试一次（空列表也算），之后不再抢用户的选择
    if (sel) return;
    const first = listed[0];
    if (first) selectSession(first.id);
    else {
      // 工作空间里还没有会话：直接进入新会话草稿
      setSel(draftSel(cwd));
      setCtxCollapsed(false);
    }
  }, [listed, cwd, sel, selectSession]);

  // ───────────── 发送、中断、配置 ─────────────

  const sendText = useCallback((text: string) => {
    if (!selCwd) return;
    let id = sel?.id;
    let isNew = false;
    if (!id) {
      id = crypto.randomUUID();
      isNew = true;
      setSel({ id, cwd: selCwd, fresh: true });
      configs.current.set(id, config);
    } else if (sel?.fresh && !sentIds.current.has(id)) {
      isNew = true;
    }
    sentIds.current.add(id);
    socket.send({ t: 'send', sessionId: id, cwd: selCwd, isNew, text, config });
  }, [selCwd, sel, config]);

  const onSend = useCallback((text: string, _attachments: Attachment[]) => sendText(text), [sendText]);

  const onInterrupt = useCallback(() => {
    if (sel) socket.send({ t: 'interrupt', sessionId: sel.id });
  }, [sel]);

  const onConfigChange = useCallback((c: SessionConfig) => {
    setConfig(c);
    // 全局记忆：下次启动 / 新会话沿用
    api.saveDefaults(c).catch(() => { /* 记忆失败不影响使用 */ });
    setBoot((b) => (b ? { ...b, defaults: c } : b));
    if (!sel) return;
    configs.current.set(sel.id, c);
    // 进程在就立即下发，下一轮生效；不在则随下一次 send 带上
    if (view && view.status && view.status !== 'exited') socket.send({ t: 'config', sessionId: sel.id, config: c });
  }, [sel, view]);

  const onRename = useCallback((title: string) => {
    if (!sel) return;
    if (!current) { flash('会话还没有记录，发送第一条消息后才能改名'); return; }
    const rename = (l: SessionSummary[]) => l.map((s) => (s.id === sel.id ? { ...s, title } : s));
    setSessions(rename);
    setPins(rename);
    const reload = () => { loadSessions(cwdRef.current); loadPins(); };
    api.rename(sel.id, sel.cwd, title)
      .then(reload)
      .catch((e) => { flash(`改名失败：${errText(e)}`); reload(); });
  }, [sel, current, flash, loadSessions, loadPins]);

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
    if (!liveRun || !sel) return;
    const empty = liveRun.turn.steps.length === 0 && !liveRun.turn.answer;
    if (!empty || liveRun.status === 'running') return;
    let alive = true;
    api.subagent(sel.id, liveRun.toolUseId, sel.cwd)
      .then(({ entries }) => {
        if (!alive) return;
        const turn = subagentTurnFromHistory(entries, { title: liveRun.title, toolUseId: liveRun.toolUseId });
        const model = subagentModelFromHistory(entries) ?? liveRun.model;
        setLoadedSub(model ? { ...liveRun, turn, model } : { ...liveRun, turn });
      })
      .catch(() => { /* 没有子代理记录就显示空 */ });
    return () => { alive = false; };
    // 只在打开的目标变化时加载
  }, [openSub?.turnId, openSub?.toolUseId, sel?.id, sel?.cwd, liveRun?.status]);

  const overlayRun = loadedSub && liveRun && loadedSub.toolUseId === liveRun.toolUseId ? loadedSub : liveRun;
  const onOpenSubagent = useCallback((turnId: string, toolUseId: string) => setOpenSub({ turnId, toolUseId }), []);
  const closeSub = useCallback(() => setOpenSub(null), []);

  // ───────────── 渲染 ─────────────

  if (fatal) {
    return (
      <div className="cz-app__fatal">
        无法连接后端：{fatal}
      </div>
    );
  }
  if (!boot) return <div className="cz-app__fatal">正在连接…</div>;

  const main = !cwd ? (
    <div className="cz-app__empty">
      <p>先打开一个文件夹作为工作空间</p>
      <button type="button" className="cz-app__btn" onClick={openFolder}>打开文件夹…</button>
    </div>
  ) : (
    <div className="cz-app__main">
      <div className="cz-app__flow">
        {view?.loading ? (
          <div className="cz-app__hint">正在加载会话…</div>
        ) : view?.loadError ? (
          <div className="cz-app__hint">加载会话失败：{view.loadError}</div>
        ) : turns.length === 0 ? (
          <div className="cz-app__hint">{!sel || isDraft(sel) ? '新会话：输入消息开始' : ''}</div>
        ) : (
          <ConversationView turns={turns} onOpenSubagent={onOpenSubagent} onReply={onReply} sessionKey={sel?.id ?? null} />
        )}
      </div>
      {notice && <div className="cz-app__notice" role="status">{notice}</div>}
      <div className="cz-app__composer">
        <Composer
          ref={composerRef}
          quote={quote}
          onClearQuote={onClearQuote}
          onSend={onSend}
          onInterrupt={onInterrupt}
          running={running}
          pick={api.pick}
          paste={api.paste}
          supportsMixed={boot.supportsMixedPick}
          previewInfo={api.previewInfo}
          previewRawUrl={api.previewRawUrl}
          slashCommands={meta?.slashCommands ?? lastMeta.current.slash}
          skills={meta?.skills ?? lastMeta.current.skills}
          config={config}
          onConfigChange={onConfigChange}
          loadUsage={loadUsage}
          disabled={!!view?.loading}
          ultracodeAvailable={view?.applied?.ultracodeAvailable}
        />
      </div>
    </div>
  );

  return (
    <>
      <AppShell
        sidebarCollapsed={collapsed}
        onToggleSidebar={() => setCollapsed((v) => !v)}
        contextCollapsed={ctxCollapsed}
        onToggleContext={() => setCtxCollapsed((v) => !v)}
        sidebar={
          <Sidebar
            workspaces={wsState.list}
            currentWorkspace={cwd}
            sessions={sessions}
            pinned={pins}
            deleted={deleted}
            currentSessionId={sel?.id ?? null}
            account={account}
            accountVersion={accountVersion}
            onNewSession={newSession}
            onCollapse={() => setCollapsed(true)}
            onSelectWorkspace={selectWorkspace}
            onOpenFolder={openFolder}
            onMoveWorkspaceTop={moveWorkspaceTop}
            onRemoveWorkspace={removeWorkspace}
            onRevealWorkspace={revealWorkspace}
            onSelectSession={selectSession}
            onTogglePin={togglePin}
            onDeleteSession={deleteSession}
            onRestoreSession={restoreSession}
            onPurgeSession={purgeSession}
          />
        }
        header={selCwd ? <SessionHeader title={current?.title ?? null} cwd={selCwd} branch={branch} onRename={onRename} /> : null}
        main={main}
        context={
          <ContextPanel
            usage={sel && view?.id === sel.id ? view.context : null}
            loading={ctxLoading}
            onRefresh={refreshContext}
            onCompact={compact}
            compactDisabled={!sel || isDraft(sel) || running}
            onCollapse={() => setCtxCollapsed(true)}
            onSkillMode={setSkillMode}
            onMcpToggle={toggleMcp}
            mcpBusy={mcpBusy}
          />
        }
      />
      <SubagentOverlay run={overlayRun} onClose={closeSub} sessionEffort={config.effort} />
    </>
  );
}
