// 两步验证（2FA / TOTP）前后端接口 DTO 定义（与 2fa-api-contract.md 保持严格一致）。

export type Algorithm = 'SHA1' | 'SHA256' | 'SHA512';
export type TotpAlgorithm = Algorithm;

export type TwoFaTagColor =
  | 'slate'
  | 'red'
  | 'orange'
  | 'amber'
  | 'green'
  | 'teal'
  | 'blue'
  | 'indigo'
  | 'violet'
  | 'pink';

export const TWOFA_TAG_COLORS: readonly TwoFaTagColor[] = [
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

export interface TwoFaEntry {
  id: string;
  issuer: string;
  account: string;
  /** base32，大写，无空格无填充 */
  secret: string;
  algorithm: Algorithm;
  digits: 6 | 8;
  period: number;
  /** null 表示根目录（未分组） */
  groupId: string | null;
  pinned: boolean;
  /** 标签 ID 列表 */
  tags: string[];
  note?: string;
  /** 手动排序值（升序；新条目追加到末尾；拖动排序时取相邻两项的中间值） */
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
  color: string;
  updatedAt: string;
  version: number;
}

export interface TwoFaUsage {
  count: number;
  lastUsedAt: string | null;
}

export interface TwoFaSync {
  configured: boolean;
  repo?: string;
  keyRepo?: string;
  ghLogin?: string;
  syncing: boolean;
  lastSyncAt?: string;
  lastError?: string;
}

export interface TwoFaData {
  entries: TwoFaEntry[];
  groups: TwoFaGroup[];
  tags: TwoFaTag[];
  usage: Record<string, TwoFaUsage>;
  sync: TwoFaSync;
}

export interface TwoFaCreateEntryInput {
  issuer: string;
  account?: string;
  secret: string;
  algorithm?: Algorithm;
  digits?: 6 | 8;
  period?: number;
  groupId?: string | null;
  tags?: string[];
  pinned?: boolean;
  note?: string;
}

export interface TwoFaPatchEntryInput {
  version: number;
  issuer?: string;
  account?: string;
  secret?: string;
  algorithm?: Algorithm;
  digits?: 6 | 8;
  period?: number;
  groupId?: string | null;
  tags?: string[];
  pinned?: boolean;
  note?: string;
  /** 手动排序值；可与 groupId 一起改（拖进分组 / 拖动排序） */
  sort?: number;
}

export interface TwoFaCreateGroupInput {
  name: string;
  parentId?: string | null;
}

export interface TwoFaPatchGroupInput {
  version: number;
  name?: string;
  parentId?: string | null;
  sort?: number;
}

export type TwoFaDeleteGroupMode = 'all' | 'lift';

export interface TwoFaCreateTagInput {
  name: string;
  color?: string;
}

export interface TwoFaPatchTagInput {
  version: number;
  name?: string;
  color?: string;
}

export interface TwoFaImportInput {
  text: string;
  groupId?: string | null;
  tags?: string[];
  /** 预览中用户取消勾选的条目下标（对应 TwoFaImportPreviewItem.index） */
  exclude?: number[];
}

/** POST /api/2fa/import/preview 请求：与正式导入相同的文本（otpauth:// 多行、otpauth-migration://、Authenticator JSON） */
export interface TwoFaImportPreviewInput {
  text: string;
}

export interface TwoFaImportPreviewItem {
  /** 解析顺序下标，正式导入时用于 exclude */
  index: number;
  issuer: string;
  account: string;
  algorithm: Algorithm;
  digits: 6 | 8;
  period: number;
  /** 保管库里已存在同 secret（+ 同 issuer/account）的条目，正式导入会跳过 */
  duplicate: boolean;
  /** 重复时对应的已有条目 ID */
  duplicateOf?: string;
}

export interface TwoFaImportPreviewResult {
  items: TwoFaImportPreviewItem[];
  /** HOTP 等不支持的条目数 */
  unsupported: number;
  errors: string[];
}

export interface TwoFaImportResult {
  added: number;
  skipped: number;
  unsupported: number;
  errors: string[];
}
