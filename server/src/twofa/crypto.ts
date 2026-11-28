// 2FA 快照 AES-256-GCM 加解密与 256-bit 密钥编解码
import crypto from 'node:crypto';
import type { TwoFaSnapshot, VaultEnvelopeV2 } from './types.js';

export const VAULT_FORMAT = 'cosyee-2fa-vault';
export const VAULT_VERSION = 2;
export const KEY_BYTES = 32;
export const IV_BYTES = 12;
export const GCM_TAG_BYTES = 16;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** 严格校验标准 Base64 并解码 */
export function decodeStrictBase64(v: unknown): Buffer | null {
  if (typeof v !== 'string' || v.length === 0 || v.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(v)) return null;
  const buf = Buffer.from(v, 'base64');
  if (buf.toString('base64') !== v) return null;
  return buf;
}

/** 生成 32 字节（256-bit）随机密钥 */
export function generateKey(): Buffer {
  return crypto.randomBytes(KEY_BYTES);
}

/** 密钥编码为单行 Base64 */
export function encodeKey(key: Buffer): string {
  if (key.length !== KEY_BYTES) throw new Error(`密钥长度必须为 ${KEY_BYTES} 字节`);
  return key.toString('base64');
}

/** 解码 Base64 密钥（允许前后空白/换行），校验长度必须为 32 字节 */
export function decodeKey(raw: string): Buffer {
  const cleaned = raw.trim();
  const buf = decodeStrictBase64(cleaned);
  if (!buf || buf.length !== KEY_BYTES) {
    throw new Error('2FA 密钥格式无效（必须是 32 字节的 Base64 字符串）');
  }
  return buf;
}

/** 用 AES-256-GCM 加密快照，生成 v2 保管库信封 */
export function encryptSnapshot(snapshot: TwoFaSnapshot, key: Buffer): VaultEnvelopeV2 {
  if (key.length !== KEY_BYTES) throw new Error(`密钥长度必须为 ${KEY_BYTES} 字节`);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(snapshot), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    format: VAULT_FORMAT,
    v: VAULT_VERSION,
    iv: iv.toString('base64'),
    ct: Buffer.concat([encrypted, tag]).toString('base64'),
  };
}

/** 校验并解密 v2 保管库信封，返回快照 */
export function decryptSnapshot(raw: unknown, key: Buffer): TwoFaSnapshot {
  if (key.length !== KEY_BYTES) throw new Error(`密钥长度必须为 ${KEY_BYTES} 字节`);
  if (!isPlainObject(raw)) throw new Error('远端保管库不是合法 JSON 对象');
  if (raw.format !== VAULT_FORMAT) throw new Error('远端保管库 format 不匹配');
  if (raw.v !== VAULT_VERSION) throw new Error(`不支持的保管库版本：${String(raw.v)}`);

  const iv = decodeStrictBase64(raw.iv);
  if (!iv || iv.length !== IV_BYTES) throw new Error('远端保管库 iv 格式无效');

  const ctAll = decodeStrictBase64(raw.ct);
  if (!ctAll || ctAll.length < GCM_TAG_BYTES) throw new Error('远端保管库密文无效');

  const ciphertext = ctAll.subarray(0, ctAll.length - GCM_TAG_BYTES);
  const authTag = ctAll.subarray(ctAll.length - GCM_TAG_BYTES);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  let plaintext: string;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('远端保管库解密失败（密钥不匹配或文件已损坏）');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new Error('远端保管库解密后不是合法 JSON');
  }

  if (!isPlainObject(parsed) || !Array.isArray(parsed.entries) || !Array.isArray(parsed.groups) || !Array.isArray(parsed.tags)) {
    throw new Error('远端保管库快照结构不合法');
  }

  return {
    schema: 2,
    entries: parsed.entries as TwoFaSnapshot['entries'],
    groups: parsed.groups as TwoFaSnapshot['groups'],
    tags: parsed.tags as TwoFaSnapshot['tags'],
  };
}
