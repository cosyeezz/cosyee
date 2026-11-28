// 2FA 服务端共享类型定义（严格对齐 2fa-api-contract.md）

export type TwoFaAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';
export const TWOFA_ALGORITHMS: readonly TwoFaAlgorithm[] = ['SHA1', 'SHA256', 'SHA512'];

export const TWOFA_TAG_COLORS = [
  'slate',
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'blue',
  'indigo',
  'violet',
  'pink',
] as const;
export type TwoFaTagColor = (typeof TWOFA_TAG_COLORS)[number];

export interface TwoFaEntry {
  id: string;
  issuer: string;
  account: string;
  /** Base32，大写、无空格与填充 */
  secret: string;
  algorithm: TwoFaAlgorithm;
  digits: 6 | 8;
  period: number;
  /** null = 根目录（未分组） */
  groupId: string | null;
  pinned: boolean;
  /** 标签 id 列表 */
  tags: string[];
  note?: string;
  /** 手动排序值（升序；新条目追加到末尾，拖动排序取相邻两项中间值） */
  sort: number;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface TwoFaGroup {
  id: string;
  parentId: string | null;
  name: string;
  sort: number;
  updatedAt: string;
  version: number;
}

export interface TwoFaTag {
  id: string;
  name: string;
  color: TwoFaTagColor;
  updatedAt: string;
  version: number;
}

export interface TwoFaUsage {
  count: number;
  lastUsedAt: string | null;
}

export interface TwoFaSync {
  /** 保管库仓库与密钥均已配置 */
  configured: boolean;
  repo?: string;
  keyRepo?: string;
  ghLogin?: string;
  syncing: boolean;
  lastSyncAt?: string;
  lastError?: string;
}

export interface TwoFaDataResponse {
  entries: TwoFaEntry[];
  groups: TwoFaGroup[];
  tags: TwoFaTag[];
  usage: Record<string, TwoFaUsage>;
  sync: TwoFaSync;
}

/** POST /api/2fa/import/preview 的单条结果（不含 secret） */
export interface TwoFaImportPreviewItem {
  /** 解析顺序下标，正式导入的 exclude 用它 */
  index: number;
  issuer: string;
  account: string;
  algorithm: TwoFaAlgorithm;
  digits: 6 | 8;
  period: number;
  duplicate: boolean;
  duplicateOf?: string;
}

export interface TwoFaImportPreviewResult {
  items: TwoFaImportPreviewItem[];
  unsupported: number;
  errors: string[];
}

/** 同步快照中的行（包含软删除 tombstone） */
export interface SnapshotEntry extends TwoFaEntry {
  deletedAt: string | null;
}

export interface SnapshotGroup extends TwoFaGroup {
  deletedAt: string | null;
}

export interface SnapshotTag extends TwoFaTag {
  deletedAt: string | null;
}

export interface TwoFaSnapshot {
  schema: 2;
  entries: SnapshotEntry[];
  groups: SnapshotGroup[];
  tags: SnapshotTag[];
}

export interface VaultEnvelopeV2 {
  format: 'cosyee-2fa-vault';
  v: 2;
  iv: string;
  ct: string;
}

/** 乐观锁冲突错误：路由层据此返回 409 { error: 'conflict', current } */
export class TwoFaConflictError extends Error {
  constructor(public readonly current: TwoFaEntry | TwoFaGroup | TwoFaTag) {
    super('conflict');
    this.name = 'TwoFaConflictError';
  }
}

export interface TwoFaSyncStateRow {
  repo: string | null;
  keyRepo: string | null;
  ghLogin: string | null;
  remoteSha: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
}
