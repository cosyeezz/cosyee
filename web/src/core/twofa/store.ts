// 2FA 数据层 hook：拉取 /api/2fa/data、订阅 WS 2fa.changed、处理乐观锁 409 冲突刷新。
// 支持注入自定义 client（用于 ?dev=2fa 调试页和单测，不依赖真实服务端）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, socket } from '../api';
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
} from './types';

export interface TwoFaClient {
  getData: () => Promise<TwoFaData>;
  createEntry: (input: TwoFaCreateEntryInput) => Promise<{ entry: TwoFaEntry }>;
  updateEntry: (id: string, input: TwoFaPatchEntryInput) => Promise<{ entry: TwoFaEntry }>;
  deleteEntry: (id: string, version: number) => Promise<{ ok: true }>;
  createGroup: (input: TwoFaCreateGroupInput) => Promise<{ group: TwoFaGroup }>;
  updateGroup: (id: string, input: TwoFaPatchGroupInput) => Promise<{ group: TwoFaGroup }>;
  deleteGroup: (id: string, mode: TwoFaDeleteGroupMode, version: number) => Promise<{ ok: true }>;
  createTag: (input: TwoFaCreateTagInput) => Promise<{ tag: TwoFaTag }>;
  updateTag: (id: string, input: TwoFaPatchTagInput) => Promise<{ tag: TwoFaTag }>;
  deleteTag: (id: string, version: number) => Promise<{ ok: true }>;
  recordUsage: (id: string) => Promise<{ usage: TwoFaUsage }>;
  importText: (input: TwoFaImportInput) => Promise<TwoFaImportResult>;
  previewImport: (input: TwoFaImportPreviewInput) => Promise<TwoFaImportPreviewResult>;
  syncNow: () => Promise<{ sync: TwoFaSync }>;
}

export const defaultTwoFaClient: TwoFaClient = {
  getData: () => api.twoFaData(),
  createEntry: (input) => api.twoFaCreateEntry(input),
  updateEntry: (id, input) => api.twoFaUpdateEntry(id, input),
  deleteEntry: (id, version) => api.twoFaDeleteEntry(id, version),
  createGroup: (input) => api.twoFaCreateGroup(input),
  updateGroup: (id, input) => api.twoFaUpdateGroup(id, input),
  deleteGroup: (id, mode, version) => api.twoFaDeleteGroup(id, mode, version),
  createTag: (input) => api.twoFaCreateTag(input),
  updateTag: (id, input) => api.twoFaUpdateTag(id, input),
  deleteTag: (id, version) => api.twoFaDeleteTag(id, version),
  recordUsage: (id) => api.twoFaRecordUsage(id),
  importText: (input) => api.twoFaImport(input),
  previewImport: (input) => api.twoFaImportPreview(input),
  syncNow: () => api.twoFaSync(),
};

const EMPTY_DATA: TwoFaData = {
  entries: [],
  groups: [],
  tags: [],
  usage: {},
  sync: { configured: false, syncing: false },
};

export interface UseTwoFaStoreOptions {
  open: boolean;
  client?: TwoFaClient;
  /** 是否订阅全局 WebSocket 2fa.changed（默认 true；mock 调试页可关闭） */
  subscribeSocket?: boolean;
  onToast?: (msg: string) => void;
}

export function useTwoFaStore({
  open,
  client = defaultTwoFaClient,
  subscribeSocket = true,
  onToast,
}: UseTwoFaStoreOptions) {
  const [data, setData] = useState<TwoFaData>(EMPTY_DATA);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const clientRef = useRef(client);
  clientRef.current = client;
  const toastRef = useRef(onToast);
  toastRef.current = onToast;
  const seqRef = useRef(0);

  const refresh = useCallback(async (silent = false) => {
    const seq = ++seqRef.current;
    if (!silent) setLoading(true);
    setError(null);
    try {
      const next = await clientRef.current.getData();
      if (seq !== seqRef.current) return;
      setData(next);
      setLoaded(true);
      setSyncing(!!next.sync.syncing);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setError(e instanceof Error ? e.message : '加载两步验证数据失败');
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);

  // 打开面板时拉取最新数据（已有缓存时静默刷新，不闪骨架）
  useEffect(() => {
    if (!open) return;
    void refresh(loaded);
  }, [open, refresh, loaded]);

  // 订阅 WebSocket { t: '2fa.changed' } 与断线重连
  useEffect(() => {
    if (!subscribeSocket) return;
    const offMsg = socket.on((m) => {
      const msg = m as { t?: string };
      if (msg && msg.t === '2fa.changed') {
        void refresh(true);
      }
    });
    const offReconn = socket.onReconnect(() => {
      void refresh(true);
    });
    return () => {
      offMsg();
      offReconn();
    };
  }, [subscribeSocket, refresh]);

  const handleMutationError = useCallback(
    (err: unknown, conflictIsRefresh = true): never => {
      if (conflictIsRefresh && err instanceof ApiError && err.status === 409) {
        void refresh(true);
        toastRef.current?.('已被其他地方更新，已刷新');
      }
      throw err;
    },
    [refresh],
  );

  const createEntry = useCallback(
    async (input: TwoFaCreateEntryInput) => {
      try {
        const res = await clientRef.current.createEntry(input);
        setData((prev) => ({ ...prev, entries: [...prev.entries, res.entry] }));
        return res.entry;
      } catch (e) {
        return handleMutationError(e, false);
      }
    },
    [handleMutationError],
  );

  const updateEntry = useCallback(
    async (id: string, input: TwoFaPatchEntryInput) => {
      try {
        const res = await clientRef.current.updateEntry(id, input);
        setData((prev) => ({
          ...prev,
          entries: prev.entries.map((it) => (it.id === id ? res.entry : it)),
        }));
        return res.entry;
      } catch (e) {
        return handleMutationError(e, true);
      }
    },
    [handleMutationError],
  );

  const deleteEntry = useCallback(
    async (id: string, version: number) => {
      try {
        await clientRef.current.deleteEntry(id, version);
        setData((prev) => ({
          ...prev,
          entries: prev.entries.filter((it) => it.id !== id),
        }));
      } catch (e) {
        handleMutationError(e, true);
      }
    },
    [handleMutationError],
  );

  const createGroup = useCallback(
    async (input: TwoFaCreateGroupInput) => {
      try {
        const res = await clientRef.current.createGroup(input);
        setData((prev) => ({ ...prev, groups: [...prev.groups, res.group] }));
        return res.group;
      } catch (e) {
        return handleMutationError(e, false);
      }
    },
    [handleMutationError],
  );

  const updateGroup = useCallback(
    async (id: string, input: TwoFaPatchGroupInput) => {
      try {
        const res = await clientRef.current.updateGroup(id, input);
        setData((prev) => ({
          ...prev,
          groups: prev.groups.map((g) => (g.id === id ? res.group : g)),
        }));
        return res.group;
      } catch (e) {
        return handleMutationError(e, true);
      }
    },
    [handleMutationError],
  );

  const deleteGroup = useCallback(
    async (id: string, mode: TwoFaDeleteGroupMode, version: number) => {
      try {
        await clientRef.current.deleteGroup(id, mode, version);
        await refresh(true);
      } catch (e) {
        handleMutationError(e, true);
      }
    },
    [handleMutationError, refresh],
  );

  const createTag = useCallback(
    async (input: TwoFaCreateTagInput) => {
      try {
        const res = await clientRef.current.createTag(input);
        setData((prev) => ({ ...prev, tags: [...prev.tags, res.tag] }));
        return res.tag;
      } catch (e) {
        return handleMutationError(e, false);
      }
    },
    [handleMutationError],
  );

  const updateTag = useCallback(
    async (id: string, input: TwoFaPatchTagInput) => {
      try {
        const res = await clientRef.current.updateTag(id, input);
        setData((prev) => ({
          ...prev,
          tags: prev.tags.map((t) => (t.id === id ? res.tag : t)),
        }));
        return res.tag;
      } catch (e) {
        return handleMutationError(e, true);
      }
    },
    [handleMutationError],
  );

  const deleteTag = useCallback(
    async (id: string, version: number) => {
      try {
        await clientRef.current.deleteTag(id, version);
        await refresh(true);
      } catch (e) {
        handleMutationError(e, true);
      }
    },
    [handleMutationError, refresh],
  );

  const recordUsage = useCallback(async (id: string) => {
    try {
      const res = await clientRef.current.recordUsage(id);
      setData((prev) => ({
        ...prev,
        usage: { ...prev.usage, [id]: res.usage },
      }));
    } catch {
      // 统计失败不影响复制主流程
    }
  }, []);

  const importText = useCallback(
    async (input: TwoFaImportInput) => {
      const res = await clientRef.current.importText(input);
      await refresh(true);
      return res;
    },
    [refresh],
  );

  /** 解析待导入文本，不落库；失败直接抛给调用方展示 */
  const previewImport = useCallback(
    (input: TwoFaImportPreviewInput) => clientRef.current.previewImport(input),
    [],
  );

  const syncNow = useCallback(async () => {
    setSyncing(true);
    try {
      const res = await clientRef.current.syncNow();
      setData((prev) => ({ ...prev, sync: res.sync }));
      await refresh(true);
      return res.sync;
    } finally {
      setSyncing(false);
    }
  }, [refresh]);

  return {
    data,
    loaded,
    loading,
    error,
    syncing: syncing || data.sync.syncing,
    refresh,
    createEntry,
    updateEntry,
    deleteEntry,
    createGroup,
    updateGroup,
    deleteGroup,
    createTag,
    updateTag,
    deleteTag,
    recordUsage,
    importText,
    previewImport,
    syncNow,
  };
}
