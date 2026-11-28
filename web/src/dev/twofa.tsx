// 2FA 面板独立调试页（?dev=twofa）：纯内存 mock，不依赖后端，支持多场景、深浅主题与窄屏验收截图。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../core/api';
import type { TwoFaClient } from '../core/twofa/store';
import {
  hasCosyeeTitlebar,
  installTitlebarTwoFaCompat,
  syncInjectedTitlebarState,
} from '../core/twofa/titlebarCompat';
import type { TwoFaData, TwoFaEntry, TwoFaGroup, TwoFaTag } from '../core/twofa/types';
import { Icon } from '../ui/icons/Icon';
import '../ui/layout/AppShell.css';
import TwoFactorPanel from '../ui/twofa/TwoFactorPanel';

const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const NOW = '2026-11-27T08:30:00.000Z';

function buildScenarioData(scenario: string): {
  data: TwoFaData;
  initialGroupId?: string | null;
  fixedNowMs?: number;
  initialCopiedId?: string | null;
} {
  if (scenario === 'empty') {
    return {
      data: {
        entries: [],
        groups: [],
        tags: [],
        usage: {},
        sync: { configured: false, syncing: false },
      },
    };
  }

  const baseGroups: TwoFaGroup[] = [
    { id: 'g-work', parentId: null, name: '工作账号', sort: 0, updatedAt: NOW, version: 1 },
    { id: 'g-cloud', parentId: 'g-work', name: '云基础设施与运维平台', sort: 0, updatedAt: NOW, version: 1 },
    { id: 'g-prod', parentId: 'g-cloud', name: '生产集群（ap-southeast）', sort: 0, updatedAt: NOW, version: 1 },
    { id: 'g-empty', parentId: 'g-work', name: '临时归档', sort: 1, updatedAt: NOW, version: 1 },
    { id: 'g-life', parentId: null, name: '个人生活', sort: 1, updatedAt: NOW, version: 1 },
  ];

  const baseTags: TwoFaTag[] = [
    { id: 't-prod', name: '生产', color: 'red', updatedAt: NOW, version: 1 },
    { id: 't-ssh', name: 'SSH', color: 'blue', updatedAt: NOW, version: 1 },
    { id: 't-cloud', name: '云服务', color: 'teal', updatedAt: NOW, version: 1 },
    { id: 't-fin', name: '金融', color: 'amber', updatedAt: NOW, version: 1 },
    { id: 't-dev', name: '开发', color: 'violet', updatedAt: NOW, version: 1 },
    { id: 't-mail', name: '邮箱', color: 'green', updatedAt: NOW, version: 1 },
  ];

  const manyTags: TwoFaTag[] = [
    ...baseTags,
    { id: 't-sec', name: '安全审计', color: 'indigo', updatedAt: NOW, version: 1 },
    { id: 't-ops', name: '值班运维', color: 'orange', updatedAt: NOW, version: 1 },
    { id: 't-pay', name: '支付通道', color: 'pink', updatedAt: NOW, version: 1 },
    { id: 't-bk', name: '冷备份', color: 'slate', updatedAt: NOW, version: 1 },
    { id: 't-ci', name: 'CI/CD', color: 'blue', updatedAt: NOW, version: 1 },
    { id: 't-db', name: '数据库主库', color: 'red', updatedAt: NOW, version: 1 },
  ];

  const baseEntriesRaw: Omit<TwoFaEntry, 'sort'>[] = [
    {
      id: 'e-gh',
      issuer: 'GitHub',
      account: 'dane.chen@cosyee.dev',
      secret: SECRET,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      groupId: 'g-work',
      pinned: true,
      tags: ['t-dev', 't-ssh'],
      createdAt: NOW,
      updatedAt: NOW,
      version: 1,
    },
    {
      id: 'e-aws',
      issuer: 'Amazon Web Services Production Console',
      account: 'infra-root-administrator@enterprise-cloud-platform.internal',
      secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      groupId: 'g-prod',
      pinned: true,
      tags: ['t-prod', 't-cloud'],
      note: '核心生产账号',
      createdAt: NOW,
      updatedAt: NOW,
      version: 1,
    },
    {
      id: 'e-cf',
      issuer: 'Cloudflare',
      account: 'dns-admin@cosyee.dev',
      secret: 'MZXW6YTBOI======',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      groupId: 'g-cloud',
      pinned: false,
      tags: ['t-cloud', 't-prod'],
      createdAt: NOW,
      updatedAt: NOW,
      version: 1,
    },
    {
      id: 'e-google',
      issuer: 'Google',
      account: 'dane.personal@gmail.com',
      secret: SECRET,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      groupId: null,
      pinned: false,
      tags: ['t-mail'],
      createdAt: NOW,
      updatedAt: NOW,
      version: 1,
    },
    {
      id: 'e-npm',
      issuer: 'npm Registry',
      account: 'cosyee-release-bot@cosyee.dev',
      secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      groupId: null,
      pinned: false,
      tags: ['t-dev'],
      createdAt: NOW,
      updatedAt: NOW,
      version: 1,
    },
    {
      id: 'e-stripe',
      issuer: 'Stripe',
      account: 'billing@cosyee.dev',
      secret: SECRET,
      algorithm: 'SHA256',
      digits: 8,
      period: 30,
      groupId: 'g-life',
      pinned: false,
      tags: ['t-fin'],
      createdAt: NOW,
      updatedAt: NOW,
      version: 1,
    },
    {
      id: 'e-steam',
      issuer: 'Steam Guard',
      account: 'dane-gaming',
      secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1',
      digits: 6,
      period: 60,
      groupId: null,
      pinned: false,
      tags: [],
      createdAt: NOW,
      updatedAt: NOW,
      version: 1,
    },
  ];
  // 手动排序值：按数组顺序依次递增（与服务端「新条目追加到末尾」一致）
  const baseEntries: TwoFaEntry[] = baseEntriesRaw.map((e, i) => ({ ...e, sort: i * 1024 }));

  const baseUsage: TwoFaData['usage'] = {
    'e-gh': { count: 42, lastUsedAt: '2026-11-27T08:25:00.000Z' },
    'e-aws': { count: 29, lastUsedAt: '2026-11-27T08:10:00.000Z' },
    'e-google': { count: 18, lastUsedAt: '2026-11-26T22:00:00.000Z' },
    'e-npm': { count: 9, lastUsedAt: '2026-11-26T15:00:00.000Z' },
  };

  if (scenario === 'stress') {
    const issuers = [
      'GitLab Enterprise Self-Hosted',
      'DigitalOcean',
      'Vercel',
      'Linear',
      'Figma',
      'Slack Workspace',
      'Notion',
      'Tailscale',
      '1Password',
      'Aliyun 阿里云主账号控制台超长名称测试',
      'Tencent Cloud',
      'Docker Hub',
      'Sentry',
      'Datadog',
      'Supabase',
    ];
    const extra: TwoFaEntry[] = Array.from({ length: 50 }, (_, i) => ({
      sort: i * 1024,
      id: `e-stress-${i + 1}`,
      issuer: `${issuers[i % issuers.length]!} #${i + 1}`,
      account: `operator-${i + 1}.very.long.email.address@organization-domain.example.com`,
      secret: SECRET,
      algorithm: 'SHA1',
      digits: i % 9 === 0 ? 8 : 6,
      period: 30,
      groupId: i < 5 ? 'g-prod' : null,
      pinned: i === 0,
      tags: [manyTags[i % manyTags.length]!.id],
      createdAt: NOW,
      updatedAt: NOW,
      version: 1,
    }));
    return {
      data: {
        entries: extra,
        groups: baseGroups,
        tags: manyTags,
        usage: { 'e-stress-1': { count: 99, lastUsedAt: NOW } },
        sync: { configured: true, repo: 'dane/cosyee-2fa-vault', syncing: false, lastSyncAt: NOW },
      },
    };
  }

  if (scenario === 'unconfigured') {
    return {
      data: {
        entries: baseEntries,
        groups: baseGroups,
        tags: baseTags,
        usage: baseUsage,
        sync: { configured: false, syncing: false },
      },
    };
  }

  if (scenario === 'empty-group') {
    return {
      data: {
        entries: baseEntries,
        groups: baseGroups,
        tags: baseTags,
        usage: baseUsage,
        sync: { configured: true, repo: 'dane/cosyee-2fa-vault', syncing: false, lastSyncAt: NOW },
      },
      initialGroupId: 'g-empty',
    };
  }

  if (scenario === 'deep') {
    return {
      data: {
        entries: baseEntries,
        groups: baseGroups,
        tags: baseTags,
        usage: baseUsage,
        sync: { configured: true, repo: 'dane/cosyee-2fa-vault', syncing: false, lastSyncAt: NOW },
      },
      initialGroupId: 'g-prod',
    };
  }

  if (scenario === 'warn') {
    // 精确落在 30s 周期的第 27.2 秒 → 剩余 3 秒（最后 5 秒警示红环）+ 第一条处于已复制变形态
    const periodStartMs = Math.floor(1_700_000_000 / 30) * 30_000;
    return {
      data: {
        entries: baseEntries,
        groups: baseGroups,
        tags: baseTags,
        usage: baseUsage,
        sync: { configured: true, repo: 'dane/cosyee-2fa-vault', syncing: false, lastSyncAt: NOW },
      },
      fixedNowMs: periodStartMs + 27_200,
      initialCopiedId: 'e-gh',
    };
  }

  return {
    data: {
      entries: baseEntries,
      groups: baseGroups,
      tags: baseTags,
      usage: baseUsage,
      sync: { configured: true, repo: 'dane/cosyee-2fa-vault', syncing: false, lastSyncAt: NOW },
    },
  };
}

function createMockClient(initial: TwoFaData): TwoFaClient {
  let state: TwoFaData = structuredClone(initial);
  let seq = 1000;
  const uid = (p: string) => `${p}-${++seq}`;
  const nowIso = () => new Date().toISOString();

  return {
    getData: async () => structuredClone(state),
    createEntry: async (input) => {
      const entry: TwoFaEntry = {
        id: uid('e'),
        issuer: input.issuer,
        account: input.account ?? '',
        secret: input.secret,
        algorithm: input.algorithm ?? 'SHA1',
        digits: input.digits ?? 6,
        period: input.period ?? 30,
        groupId: input.groupId ?? null,
        pinned: !!input.pinned,
        tags: input.tags ?? [],
        note: input.note,
        // 新建追加到同级末尾
        sort: state.entries.reduce((m, e) => Math.max(m, e.sort), -1024) + 1024,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        version: 1,
      };
      state.entries.push(entry);
      return { entry: structuredClone(entry) };
    },
    updateEntry: async (id, input) => {
      const idx = state.entries.findIndex((e) => e.id === id);
      if (idx < 0) throw new ApiError('记录不存在', 404, {});
      const cur = state.entries[idx]!;
      if (cur.version !== input.version) throw new ApiError('conflict', 409, { error: 'conflict', current: cur });
      const next: TwoFaEntry = {
        ...cur,
        ...input,
        version: cur.version + 1,
        updatedAt: nowIso(),
      };
      state.entries[idx] = next;
      return { entry: structuredClone(next) };
    },
    deleteEntry: async (id, version) => {
      const cur = state.entries.find((e) => e.id === id);
      if (!cur) throw new ApiError('记录不存在', 404, {});
      if (cur.version !== version) throw new ApiError('conflict', 409, { error: 'conflict' });
      state.entries = state.entries.filter((e) => e.id !== id);
      return { ok: true };
    },
    createGroup: async (input) => {
      const group: TwoFaGroup = {
        id: uid('g'),
        parentId: input.parentId ?? null,
        name: input.name,
        sort: state.groups.length,
        updatedAt: nowIso(),
        version: 1,
      };
      state.groups.push(group);
      return { group: structuredClone(group) };
    },
    updateGroup: async (id, input) => {
      const idx = state.groups.findIndex((g) => g.id === id);
      if (idx < 0) throw new ApiError('分组不存在', 404, {});
      const cur = state.groups[idx]!;
      const next: TwoFaGroup = { ...cur, ...input, version: cur.version + 1, updatedAt: nowIso() };
      state.groups[idx] = next;
      return { group: structuredClone(next) };
    },
    deleteGroup: async (id, mode) => {
      const target = state.groups.find((g) => g.id === id);
      if (!target) return { ok: true };
      if (mode === 'lift') {
        state.groups = state.groups
          .filter((g) => g.id !== id)
          .map((g) => (g.parentId === id ? { ...g, parentId: target.parentId } : g));
        state.entries = state.entries.map((e) => (e.groupId === id ? { ...e, groupId: target.parentId } : e));
      } else {
        const drop = new Set<string>([id]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const g of state.groups) {
            if (g.parentId && drop.has(g.parentId) && !drop.has(g.id)) {
              drop.add(g.id);
              changed = true;
            }
          }
        }
        state.groups = state.groups.filter((g) => !drop.has(g.id));
        state.entries = state.entries.filter((e) => !e.groupId || !drop.has(e.groupId));
      }
      return { ok: true };
    },
    createTag: async (input) => {
      if (state.tags.some((t) => t.name.toLowerCase() === input.name.toLowerCase())) {
        throw new ApiError('同名标签已存在', 409, { error: '同名标签已存在' });
      }
      const tag: TwoFaTag = {
        id: uid('t'),
        name: input.name,
        color: input.color ?? 'blue',
        updatedAt: nowIso(),
        version: 1,
      };
      state.tags.push(tag);
      return { tag: structuredClone(tag) };
    },
    updateTag: async (id, input) => {
      const idx = state.tags.findIndex((t) => t.id === id);
      if (idx < 0) throw new ApiError('标签不存在', 404, {});
      const cur = state.tags[idx]!;
      const next: TwoFaTag = { ...cur, ...input, version: cur.version + 1, updatedAt: nowIso() };
      state.tags[idx] = next;
      return { tag: structuredClone(next) };
    },
    deleteTag: async (id) => {
      state.tags = state.tags.filter((t) => t.id !== id);
      state.entries = state.entries.map((e) => ({ ...e, tags: e.tags.filter((x) => x !== id) }));
      return { ok: true };
    },
    recordUsage: async (id) => {
      const prev = state.usage[id] ?? { count: 0, lastUsedAt: null };
      const next = { count: prev.count + 1, lastUsedAt: nowIso() };
      state.usage[id] = next;
      return { usage: next };
    },
    importText: async () => ({ added: 2, skipped: 1, unsupported: 0, errors: [] }),
    previewImport: async () => ({
      items: [
        { index: 0, issuer: 'GitHub', account: 'dev@example.com', algorithm: 'SHA1', digits: 6, period: 30, duplicate: false },
        { index: 1, issuer: 'Cloudflare', account: 'ops@example.com', algorithm: 'SHA1', digits: 6, period: 30, duplicate: false },
        { index: 2, issuer: 'AWS', account: 'root', algorithm: 'SHA1', digits: 6, period: 30, duplicate: true, duplicateOf: state.entries[0]?.id },
      ],
      unsupported: 0,
      errors: [],
    }),
    syncNow: async () => {
      state.sync = { ...state.sync, lastSyncAt: nowIso(), lastError: undefined, syncing: false };
      return { sync: structuredClone(state.sync) };
    },
  };
}

/** 标题栏按钮（与 client/src-tauri/src/titlebar.js 完全一致的 SVG 与样式）与 AppShell 顶栏按钮状态对比页 */
function IconStatesPreview({ theme }: { theme: string }) {
  const twofaSvg = (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3.2 5.2 6v5.2c0 4.5 2.9 7.8 6.8 9.3 3.9-1.5 6.8-4.8 6.8-9.3V6z" />
      <circle cx="12" cy="10" r="2" />
      <path d="M12 12v4.2M12 14.5h1.8" />
    </svg>
  );
  const globeSvg = (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.6 2.4 3.9 5.2 3.9 8.5s-1.3 6.1-3.9 8.5c-2.6-2.4-3.9-5.2-3.9-8.5S9.4 5.9 12 3.5z" />
    </svg>
  );
  const tbBtnBase: React.CSSProperties = {
    display: 'grid',
    placeItems: 'center',
    width: 30,
    height: 28,
    borderRadius: 8,
    border: 0,
    background: 'transparent',
    color: 'var(--text-3)',
  };
  const states: { label: string; tbStyle: React.CSSProperties; shellCls?: string; pressed?: boolean; shellStyle?: React.CSSProperties }[] = [
    { label: '默认（idle）', tbStyle: {} },
    {
      label: '悬停（hover）',
      tbStyle: { background: 'var(--bg-hover)', color: 'var(--text)' },
      shellStyle: { background: 'var(--bg-hover)', color: 'var(--text)', borderColor: 'var(--border-strong)' },
    },
    {
      label: '按下（active）',
      tbStyle: { background: 'var(--bg-hover)', color: 'var(--text)', transform: 'scale(.92)' },
      shellStyle: { background: 'var(--bg-hover)', color: 'var(--text)', borderColor: 'var(--border-strong)', transform: 'scale(.94)' },
    },
    {
      label: '打开（aria-pressed=true）',
      tbStyle: {
        background: 'color-mix(in srgb, var(--accent) 16%, transparent)',
        color: 'var(--accent)',
        boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--accent) 32%, transparent)',
      },
      pressed: true,
    },
  ];

  return (
    <div
      id="icons-preview"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 18,
        padding: 20,
        width: 480,
        background: 'var(--bg)',
        color: 'var(--text)',
        fontFamily: 'var(--font-sans)',
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600 }}>桌面标题栏按钮（titlebar.js：#t 两步验证 + #b 内置浏览器）· {theme}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {states.map((s) => (
          <div
            key={s.label}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              height: 38,
              padding: '0 12px',
              background: 'var(--bg-sidebar)',
              border: '1px solid var(--border)',
              borderRadius: 10,
            }}
          >
            <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{s.label}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <button type="button" style={{ ...tbBtnBase, ...s.tbStyle }} aria-label="两步验证" aria-pressed={s.pressed}>
                {twofaSvg}
              </button>
              <button type="button" style={tbBtnBase} aria-label="内置浏览器">
                {globeSvg}
              </button>
            </div>
          </div>
        ))}
      </div>

      <div style={{ fontSize: 13, fontWeight: 600, marginTop: 4 }}>无标题栏网页顶栏按钮（AppShell .cz-shell__expand）</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {states.map((s) => (
          <div
            key={s.label}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              height: 46,
              padding: '0 12px',
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              borderRadius: 10,
            }}
          >
            <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{s.label}</span>
            <div className="cz-shell__trail" style={{ marginRight: 0 }}>
              <button
                type="button"
                className="cz-shell__expand"
                aria-label="两步验证"
                aria-pressed={s.pressed}
                style={s.shellStyle}
              >
                <Icon name="twofa" size={18} />
              </button>
              <button type="button" className="cz-shell__expand" aria-label="展开上下文栏">
                <Icon name="panel-expand" size={18} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 模拟 MainApp 接线：供测试真实旧版/新版 titlebar.js 注入与无页面内兜底按钮 */
function TitlebarCompatPage() {
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  openRef.current = open;
  const toggle = useCallback(() => setOpen((o) => !o), []);
  const [hasTitlebar, setHasTitlebar] = useState(() => hasCosyeeTitlebar());

  useEffect(() => {
    (window as unknown as { __cosyeeBrowserReady?: boolean }).__cosyeeBrowserReady = true;
    window.dispatchEvent(new CustomEvent('cosyee:browser-ready'));
    window.addEventListener('cosyee:2fa', toggle);
    const stop = installTitlebarTwoFaCompat(setHasTitlebar, () => openRef.current);
    return () => {
      window.removeEventListener('cosyee:2fa', toggle);
      stop();
    };
  }, [toggle]);

  useEffect(() => {
    syncInjectedTitlebarState(open);
    window.dispatchEvent(new CustomEvent('cosyee:2fa-state', { detail: { open } }));
  }, [open]);

  const built = useMemo(() => buildScenarioData('default'), []);
  const client = useMemo(() => createMockClient(built.data), [built]);

  return (
    <div style={{ minHeight: 'calc(100vh - var(--cosyee-titlebar-h, 0px))', background: 'var(--ambient), var(--bg)', color: 'var(--text)', padding: 16 }}>
      {!hasTitlebar && (
        <button type="button" className="cz-shell__expand" data-twofa-trigger="" aria-label="两步验证" onClick={toggle}>
          <Icon name="twofa" size={18} />
        </button>
      )}
      <TwoFactorPanel open={open} onClose={() => setOpen(false)} client={client} subscribeSocket={false} />
    </div>
  );
}

export default function TwoFaDevPage() {
  const params = new URLSearchParams(location.search);
  const scenario = params.get('scenario') ?? 'default';
  const theme = params.get('theme') ?? 'dark';
  const forceNarrow = params.get('narrow') === '1';

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
  }, [theme]);

  if (scenario === 'icons') {
    return <IconStatesPreview theme={theme} />;
  }
  if (scenario === 'titlebar-compat') {
    return <TitlebarCompatPage />;
  }

  const [open, setOpen] = useState(true);
  const built = useMemo(() => buildScenarioData(scenario), [scenario]);
  const client = useMemo(() => createMockClient(built.data), [built]);

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--ambient), var(--bg)',
        color: 'var(--text)',
        padding: 16,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
        <button
          type="button"
          className="cz-shell__expand"
          data-twofa-trigger=""
          aria-pressed={open}
          aria-label="两步验证"
          onClick={() => setOpen((o) => !o)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 32,
            height: 32,
            borderRadius: 9,
            border: '1px solid var(--border-strong)',
            background: open ? 'color-mix(in srgb, var(--accent) 16%, transparent)' : 'var(--bg-elev)',
            color: open ? 'var(--accent)' : 'var(--text-2)',
            cursor: 'pointer',
          }}
        >
          <Icon name="twofa" size={18} />
        </button>
      </div>

      <TwoFactorPanel
        open={open}
        onClose={() => setOpen(false)}
        client={client}
        subscribeSocket={false}
        fixedNowMs={built.fixedNowMs}
        initialGroupId={built.initialGroupId ?? null}
        initialCopiedId={built.initialCopiedId ?? null}
        forceNarrow={forceNarrow}
        disableOutsideClose
      />
    </div>
  );
}
