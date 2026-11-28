#!/usr/bin/env node
/**
 * Cosyee 2FA Vault 独立解密与 TOTP 恢复脚本（零依赖，Node 18+）
 *
 * 用法：
 *   node cosyee-2fa-decrypt.mjs <vault.json> <key.txt|base64-key>
 *
 * ---------------------------------------------------------------------------
 * 保管库加密信封格式规范（v2，无需 Cosyee 即可按此规范独立恢复）：
 *
 *   {
 *     "format": "cosyee-2fa-vault",
 *     "v": 2,
 *     "iv": "<base64, 12 bytes>",
 *     "ct": "<base64 of ciphertext || 16-byte GCM auth tag, no AAD>"
 *   }
 *
 * 密钥文件（key.txt / ~/.cosyee/2fa/key）：
 *   单行标准 Base64，解码后为 32 字节（256-bit）随机 AES 密钥。
 *
 * 解密步骤：
 *   1. 将密钥 Base64 解码得到 32 字节 key。
 *   2. 将 base64_decode(ct) 拆分为密文 body = ct[0..-16] 与认证标签 tag = ct[-16..]。
 *   3. 使用 AES-256-GCM（iv = base64_decode(iv)，无 AAD）解密并校验 tag。
 *   4. 得到 UTF-8 JSON 明文快照：
 *      {
 *        "schema": 2,
 *        "entries": [{ id, issuer, account, secret, algorithm, digits, period, groupId, pinned, tags, note?, createdAt, updatedAt, deletedAt, version }],
 *        "groups":  [{ id, parentId, name, sort, updatedAt, deletedAt, version }],
 *        "tags":    [{ id, name, color, updatedAt, deletedAt, version }]
 *      }
 *      注：deletedAt 非空的行是软删除标记（tombstone），恢复时应忽略。
 * ---------------------------------------------------------------------------
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * 解码 RFC 4648 Base32（忽略大小写、空格、连字符与 '=' 填充）。
 * @param {string} input
 * @returns {Buffer}
 */
export function base32Decode(input) {
  const cleaned = String(input).toUpperCase().replace(/[\s=-]+/g, '');
  if (!cleaned) throw new Error('Base32 密钥为空');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`Base32 密钥包含非法字符: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * 按 RFC 6238 计算 TOTP 验证码。
 * @param {{ secret: string, algorithm?: string, digits?: number, period?: number }} entry
 * @param {number} [nowMs=Date.now()]
 * @returns {{ code: string, remaining: number, period: number }}
 */
export function generateTotp(entry, nowMs = Date.now()) {
  const period = Number.isFinite(entry.period) && entry.period > 0 ? Math.floor(entry.period) : 30;
  const digits = entry.digits === 8 ? 8 : 6;
  const algRaw = String(entry.algorithm || 'SHA1').toUpperCase().replace('-', '');
  const algMap = { SHA1: 'sha1', SHA256: 'sha256', SHA512: 'sha512' };
  const hashAlg = algMap[algRaw];
  if (!hashAlg) throw new Error(`不支持的 TOTP 算法: ${entry.algorithm}`);

  const key = base32Decode(entry.secret);
  const nowSec = Math.floor(nowMs / 1000);
  const counter = BigInt(Math.floor(nowSec / period));
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(counter, 0);

  const hmac = crypto.createHmac(hashAlg, key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binCode =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const mod = 10 ** digits;
  const code = String(binCode % mod).padStart(digits, '0');
  const remaining = period - (nowSec % period);
  return { code, remaining, period };
}

/**
 * 生成标准 otpauth://totp/... URI。
 * @param {{ issuer?: string, account?: string, secret: string, algorithm?: string, digits?: number, period?: number }} entry
 * @returns {string}
 */
export function formatOtpAuthUri(entry) {
  const issuer = typeof entry.issuer === 'string' ? entry.issuer.trim() : '';
  const account = typeof entry.account === 'string' ? entry.account.trim() : '';
  const secret = String(entry.secret || '').toUpperCase().replace(/[\s=-]+/g, '');
  const algorithm = String(entry.algorithm || 'SHA1').toUpperCase().replace('-', '');
  const digits = entry.digits === 8 ? 8 : 6;
  const period = Number.isFinite(entry.period) && entry.period > 0 ? Math.floor(entry.period) : 30;

  let label;
  if (issuer && account) label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  else if (account) label = encodeURIComponent(account);
  else if (issuer) label = encodeURIComponent(issuer);
  else label = 'account';

  const params = [`secret=${encodeURIComponent(secret)}`];
  if (issuer) params.push(`issuer=${encodeURIComponent(issuer)}`);
  params.push(`algorithm=${encodeURIComponent(algorithm)}`);
  params.push(`digits=${digits}`);
  params.push(`period=${period}`);
  return `otpauth://totp/${label}?${params.join('&')}`;
}

/**
 * 解析密钥参数：支持 Buffer、密钥文件路径或原始 Base64 密钥字符串。
 * @param {string | Buffer} keyInput
 * @returns {Buffer}
 */
export function loadKey(keyInput) {
  if (Buffer.isBuffer(keyInput)) {
    if (keyInput.length !== 32) throw new Error('密钥长度必须为 32 字节');
    return keyInput;
  }
  const s = String(keyInput || '').trim();
  if (!s) throw new Error('缺少密钥');
  const raw = fs.existsSync(s) && fs.statSync(s).isFile() ? fs.readFileSync(s, 'utf8').trim() : s;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32 || key.toString('base64') !== raw) {
    throw new Error('密钥格式无效（必须是 32 字节的标准 Base64 字符串或包含该密钥的文件）');
  }
  return key;
}

/**
 * 解密 Cosyee 2FA v2 保管库信封并返回明文快照对象。
 * @param {object} envelope
 * @param {string | Buffer} keyInput
 * @returns {{ schema: number, entries: Array<object>, groups: Array<object>, tags: Array<object> }}
 */
export function decryptVault(envelope, keyInput) {
  if (!envelope || typeof envelope !== 'object') throw new Error('保管库文件不是合法 JSON 对象');
  if (envelope.format !== 'cosyee-2fa-vault' || envelope.v !== 2) {
    throw new Error(`不支持的保管库格式或版本（期望 v2，实际 ${String(envelope.v)}）`);
  }

  const key = loadKey(keyInput);
  const iv = Buffer.from(String(envelope.iv || ''), 'base64');
  const ctAll = Buffer.from(String(envelope.ct || ''), 'base64');
  if (iv.length !== 12) throw new Error('iv 长度必须为 12 字节');
  if (ctAll.length < 16) throw new Error('密文长度不合法');

  const ciphertext = ctAll.subarray(0, ctAll.length - 16);
  const authTag = ctAll.subarray(ctAll.length - 16);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('解密失败：密钥不匹配或文件已损坏');
  }

  const data = JSON.parse(plaintext);
  if (!data || typeof data !== 'object' || !Array.isArray(data.entries)) {
    throw new Error('解密后的保管库结构不合法');
  }
  return {
    schema: data.schema ?? 2,
    entries: data.entries,
    groups: Array.isArray(data.groups) ? data.groups : [],
    tags: Array.isArray(data.tags) ? data.tags : [],
  };
}

/**
 * 解析条目的完整分组路径（如 "工作 / 云服务"；未分组返回 ""）。
 * @param {string | null | undefined} groupId
 * @param {Array<{ id: string, parentId?: string | null, name: string, deletedAt?: string | null }>} groups
 * @returns {string}
 */
export function resolveGroupPath(groupId, groups) {
  if (!groupId) return '';
  const map = new Map();
  for (const g of groups || []) {
    if (!g.deletedAt) map.set(g.id, g);
  }
  const parts = [];
  const seen = new Set();
  let cur = groupId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const g = map.get(cur);
    if (!g) break;
    parts.unshift(g.name);
    cur = g.parentId;
  }
  return parts.join(' / ');
}

async function main() {
  const vaultFile = process.argv[2];
  const keyArg = process.argv[3];
  if (!vaultFile || !keyArg || vaultFile === '-h' || vaultFile === '--help') {
    process.stderr.write('用法: node cosyee-2fa-decrypt.mjs <vault.json> <key.txt|base64-key>\n');
    process.exit(vaultFile === '-h' || vaultFile === '--help' ? 0 : 1);
  }

  const raw = fs.readFileSync(vaultFile, 'utf8');
  const envelope = JSON.parse(raw);
  const data = decryptVault(envelope, keyArg);
  const liveEntries = data.entries.filter((e) => !e.deletedAt);

  if (liveEntries.length === 0) {
    console.log('保管库为空（0 条有效记录）。');
    return;
  }

  const now = Date.now();
  for (const entry of liveEntries) {
    const groupPath = resolveGroupPath(entry.groupId, data.groups);
    const title = [entry.issuer, entry.account].filter(Boolean).join(' / ') || entry.id || '(unnamed)';
    const { code, remaining } = generateTotp(entry, now);
    const uri = formatOtpAuthUri(entry);
    console.log(`=== ${groupPath ? `[${groupPath}] ` : ''}${title} ===`);
    console.log(`TOTP: ${code} (${remaining}s left)`);
    if (entry.note) console.log(`Note: ${entry.note}`);
    console.log(`URI:  ${uri}`);
    console.log('');
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`错误: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
