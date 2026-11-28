// Base32 校验与解码、RFC 6238 TOTP 计算、otpauth URI 与 Authenticator JSON 导入解析
import crypto from 'node:crypto';
import { HttpError } from '../workspaces.js';
import type { TwoFaAlgorithm } from './types.js';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** 规范化并校验 Base32 密钥（大写、去掉空白 / 连字符 / '=' 填充） */
export function normalizeBase32Secret(raw: unknown): string {
  if (typeof raw !== 'string') throw new HttpError(400, '缺少 secret');
  const cleaned = raw.toUpperCase().replace(/[\s=-]+/g, '');
  if (!cleaned) throw new HttpError(400, 'Base32 密钥不能为空');
  if (!/^[A-Z2-7]+$/.test(cleaned)) throw new HttpError(400, 'Base32 密钥包含非法字符');
  if (cleaned.length < 2) throw new HttpError(400, 'Base32 密钥过短');
  return cleaned;
}

/** 解码 RFC 4648 Base32 字符串 */
export function base32Decode(input: string): Buffer {
  const cleaned = normalizeBase32Secret(input);
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 校验并规范化 TOTP 算法（默认 SHA1） */
export function normalizeAlgorithm(raw: unknown): TwoFaAlgorithm {
  if (raw === undefined || raw === null || raw === '') return 'SHA1';
  if (typeof raw !== 'string') throw new HttpError(400, 'algorithm 不合法');
  const s = raw.trim().toUpperCase().replace(/-/g, '');
  if (s === 'SHA1' || s === 'SHA256' || s === 'SHA512') return s;
  throw new HttpError(400, `不支持的算法：${raw}（仅支持 SHA1 / SHA256 / SHA512）`);
}

/** 校验并规范化位数（默认 6，仅支持 6 或 8） */
export function normalizeDigits(raw: unknown): 6 | 8 {
  if (raw === undefined || raw === null || raw === '') return 6;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (n === 6 || n === 8) return n;
  throw new HttpError(400, 'digits 仅支持 6 或 8');
}

/** 校验并规范化周期（默认 30 秒，正整数） */
export function normalizePeriod(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return 30;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 3600) {
    throw new HttpError(400, 'period 必须是 1–3600 之间的整数');
  }
  return n;
}

/** 按 RFC 6238 计算 TOTP 验证码 */
export function generateTotp(
  entry: { secret: string; algorithm?: TwoFaAlgorithm; digits?: 6 | 8; period?: number },
  nowMs: number = Date.now(),
): { code: string; remaining: number; period: number } {
  const period = entry.period && entry.period > 0 ? Math.floor(entry.period) : 30;
  const digits = entry.digits === 8 ? 8 : 6;
  const alg = entry.algorithm ?? 'SHA1';
  const hashAlg = alg === 'SHA256' ? 'sha256' : alg === 'SHA512' ? 'sha512' : 'sha1';

  const key = base32Decode(entry.secret);
  const nowSec = Math.floor(nowMs / 1000);
  const counter = BigInt(Math.floor(nowSec / period));
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(counter, 0);

  const hmac = crypto.createHmac(hashAlg, key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binCode =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);

  const mod = 10 ** digits;
  const code = String(binCode % mod).padStart(digits, '0');
  const remaining = period - (nowSec % period);
  return { code, remaining, period };
}

export interface ParsedImportEntry {
  issuer: string;
  account: string;
  secret: string;
  algorithm: TwoFaAlgorithm;
  digits: 6 | 8;
  period: number;
}

export interface ParseImportResult {
  entries: ParsedImportEntry[];
  unsupported: number;
  errors: string[];
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 按 otpauth label 规则拆分 "issuer:account"，issuer 参数优先 */
function splitLabel(rawLabel: string, paramIssuerRaw: string): { issuer: string; account: string } {
  let labelIssuer = '';
  let account = '';
  const colonIdx = rawLabel.indexOf(':');
  if (colonIdx >= 0) {
    labelIssuer = rawLabel.slice(0, colonIdx).trim();
    account = rawLabel.slice(colonIdx + 1).trim();
  } else {
    account = rawLabel.trim();
  }
  const paramIssuer = paramIssuerRaw.trim();
  const issuer = paramIssuer || labelIssuer || account || '未命名';
  // 如果 label 没有冒号、但 issuer 参数和 account 相同，则保留 issuer 并清空重复 account
  if (!labelIssuer && paramIssuer && account === paramIssuer) account = '';
  return { issuer, account };
}

function parseOtpAuthLine(line: string, lineNo: number): { kind: 'ok'; entry: ParsedImportEntry } | { kind: 'unsupported' } | { kind: 'error'; message: string } {
  let url: URL;
  try {
    url = new URL(line);
  } catch {
    return { kind: 'error', message: `第 ${lineNo} 行不是合法的 otpauth URI` };
  }
  if (url.protocol !== 'otpauth:') {
    return { kind: 'error', message: `第 ${lineNo} 行不是 otpauth 链接` };
  }
  const type = url.host.toLowerCase();
  if (type !== 'totp') {
    return { kind: 'unsupported' };
  }

  const rawLabel = safeDecode(url.pathname.replace(/^\/+/, ''));
  const { issuer, account } = splitLabel(rawLabel, url.searchParams.get('issuer') ?? '');

  try {
    const secret = normalizeBase32Secret(url.searchParams.get('secret'));
    const algorithm = normalizeAlgorithm(url.searchParams.get('algorithm'));
    const digits = normalizeDigits(url.searchParams.get('digits'));
    const period = normalizePeriod(url.searchParams.get('period'));
    return { kind: 'ok', entry: { issuer, account, secret, algorithm, digits, period } };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { kind: 'error', message: `第 ${lineNo} 行（${issuer}）：${msg}` };
  }
}

// ───────────── Google Authenticator 迁移导出（otpauth-migration://） ─────────────

/** Base32 编码（RFC 4648，无填充，大写） */
export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** 极简 protobuf 读取器：只支持迁移载荷用到的 wire type（0 varint / 1 64 位 / 2 定长 / 5 32 位） */
class PbReader {
  private pos = 0;
  constructor(private readonly buf: Buffer) {}

  get done(): boolean {
    return this.pos >= this.buf.length;
  }

  /** 读 varint；用 BigInt 避免 int64 溢出，调用方按需转 number */
  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.buf.length) throw new Error('protobuf 数据被截断');
      const b = this.buf[this.pos++]!;
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
    }
    throw new Error('protobuf varint 过长');
  }

  bytes(): Buffer {
    const len = Number(this.varint());
    if (!Number.isSafeInteger(len) || len < 0 || this.pos + len > this.buf.length) throw new Error('protobuf 长度字段越界');
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  /** 按 wire type 跳过未知字段 */
  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.advance(8);
    else if (wire === 2) this.bytes();
    else if (wire === 5) this.advance(4);
    else throw new Error(`不支持的 protobuf wire type：${wire}`);
  }

  private advance(n: number): void {
    if (this.pos + n > this.buf.length) throw new Error('protobuf 数据被截断');
    this.pos += n;
  }
}

type MigrationItem = { kind: 'ok'; entry: ParsedImportEntry } | { kind: 'unsupported' } | { kind: 'error'; message: string };

/** 解析单个 OtpParameters 消息 */
function parseOtpParameters(buf: Buffer): MigrationItem {
  const r = new PbReader(buf);
  let secret: Buffer = Buffer.alloc(0);
  let name = '';
  let issuerField = '';
  let algorithm = 0;
  let digits = 0;
  let type = 0;
  while (!r.done) {
    const tag = Number(r.varint());
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 2) secret = Buffer.from(r.bytes());
    else if (field === 2 && wire === 2) name = r.bytes().toString('utf8');
    else if (field === 3 && wire === 2) issuerField = r.bytes().toString('utf8');
    else if (field === 4 && wire === 0) algorithm = Number(r.varint());
    else if (field === 5 && wire === 0) digits = Number(r.varint());
    else if (field === 6 && wire === 0) type = Number(r.varint());
    else r.skip(wire); // 含 counter(7) 与未知字段
  }

  // HOTP（1）与 MD5（4）不支持
  if (type === 1 || algorithm === 4) return { kind: 'unsupported' };
  if (type !== 0 && type !== 2) return { kind: 'unsupported' };

  const { issuer, account } = splitLabel(name.trim(), issuerField.trim());
  if (secret.length === 0) return { kind: 'error', message: `条目 ${issuer}：密钥为空` };
  if (algorithm < 0 || algorithm > 3) return { kind: 'error', message: `条目 ${issuer}：未知的算法编号 ${algorithm}` };
  if (digits > 2) return { kind: 'error', message: `条目 ${issuer}：未知的位数编号 ${digits}` };
  return {
    kind: 'ok',
    entry: {
      issuer,
      account,
      secret: base32Encode(secret),
      algorithm: algorithm === 2 ? 'SHA256' : algorithm === 3 ? 'SHA512' : 'SHA1',
      digits: digits === 2 ? 8 : 6,
      period: 30,
    },
  };
}

/** 解析一行 otpauth-migration:// 链接，返回其中所有条目 */
function parseMigrationLine(line: string, lineNo: number): MigrationItem[] {
  const m = /[?&]data=([^&#\s]*)/.exec(line);
  if (!m) return [{ kind: 'error', message: `第 ${lineNo} 行迁移链接缺少 data 参数` }];
  // URL 编码 → 还原被转成空格的 '+' → base64url 转标准 base64 → 去填充
  const b64 = safeDecode(m[1]!).replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (!b64 || !/^[A-Za-z0-9+/]+$/.test(b64) || b64.length % 4 === 1) {
    return [{ kind: 'error', message: `第 ${lineNo} 行迁移链接的 data 不是合法的 base64` }];
  }
  const payload = Buffer.from(b64, 'base64');
  const out: MigrationItem[] = [];
  try {
    const r = new PbReader(payload);
    while (!r.done) {
      const tag = Number(r.varint());
      const field = tag >>> 3;
      const wire = tag & 7;
      if (field === 1 && wire === 2) out.push(parseOtpParameters(r.bytes()));
      else r.skip(wire); // version / batch_size / batch_index / batch_id 及未知字段
    }
  } catch (e) {
    out.push({ kind: 'error', message: `第 ${lineNo} 行迁移链接解析失败：${e instanceof Error ? e.message : String(e)}` });
  }
  return out;
}

function parseAuthenticatorJson(raw: unknown): ParseImportResult {
  const entries: ParsedImportEntry[] = [];
  let unsupported = 0;
  const errors: string[] = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { entries, unsupported, errors: ['JSON 格式不受支持：应为 Authenticator 导出的对象'] };
  }

  const obj = raw as Record<string, unknown>;
  if (obj.encrypted === true || obj.enc !== undefined) {
    return {
      entries,
      unsupported,
      errors: ['该备份文件已加密，请在 Chrome Authenticator 插件导出时取消设置密码（不加密导出）后重试'],
    };
  }

  for (const [key, val] of Object.entries(obj)) {
    if (!val || typeof val !== 'object' || Array.isArray(val)) continue;
    const item = val as Record<string, unknown>;
    if (item.encrypted === true) {
      return {
        entries: [],
        unsupported: 0,
        errors: ['该备份文件已加密，请在 Chrome Authenticator 插件导出时取消设置密码（不加密导出）后重试'],
      };
    }
    const type = item.type !== undefined && item.type !== null ? String(item.type).toLowerCase() : 'totp';
    if (type !== 'totp') {
      unsupported++;
      continue;
    }
    const issuerRaw = typeof item.issuer === 'string' ? item.issuer.trim() : '';
    const accountRaw = typeof item.account === 'string' ? item.account.trim() : '';
    const issuer = issuerRaw || accountRaw || '未命名';
    const account = issuerRaw ? accountRaw : '';
    try {
      const secret = normalizeBase32Secret(item.secret);
      const algorithm = normalizeAlgorithm(item.algorithm);
      const digits = normalizeDigits(item.digits);
      const period = normalizePeriod(item.period);
      entries.push({ issuer, account, secret, algorithm, digits, period });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`条目 ${issuer || key}：${msg}`);
    }
  }

  return { entries, unsupported, errors };
}

/** 解析导入文本：支持逐行 otpauth://totp/... URI 或 Chrome Authenticator (authenticator.cc) JSON 备份 */
export function parseImportText(text: string): ParseImportResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return { entries: [], unsupported: 0, errors: ['导入内容为空'] };
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return parseAuthenticatorJson(parsed);
    } catch {
      return { entries: [], unsupported: 0, errors: ['JSON 解析失败，请检查导出文件是否完整'] };
    }
  }

  const entries: ParsedImportEntry[] = [];
  let unsupported = 0;
  const errors: string[] = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith('#')) continue;
    const results = line.toLowerCase().startsWith('otpauth-migration:')
      ? parseMigrationLine(line, i + 1)
      : [parseOtpAuthLine(line, i + 1)];
    for (const res of results) {
      if (res.kind === 'ok') entries.push(res.entry);
      else if (res.kind === 'unsupported') unsupported++;
      else errors.push(res.message);
    }
  }

  return { entries, unsupported, errors };
}
