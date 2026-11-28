// RFC 4226 (HOTP) / RFC 6238 (TOTP)、RFC 4648 Base32 解码与 otpauth:// URI 解析构建。
// 零第三方依赖：安全上下文优先用 WebCrypto，非安全上下文（如 Tailscale HTTP）自动回退到内置纯 JS HMAC-SHA1/256/512。
import type { Algorithm, TwoFaEntry } from './types';

export type CryptoBackend = 'auto' | 'webcrypto' | 'js';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BASE32_MAP = new Map<string, number>();
for (let i = 0; i < BASE32_ALPHABET.length; i++) {
  BASE32_MAP.set(BASE32_ALPHABET[i]!, i);
}

export function hasWebCrypto(): boolean {
  return typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.subtle !== 'undefined';
}

/** 规范化 Base32 密钥：去空白、连字符与尾随 =，转大写，并校验合法性。 */
export function normalizeSecret(input: string): string {
  const cleaned = input.replace(/[\s-]+/g, '').replace(/=+$/g, '').toUpperCase();
  if (!cleaned) throw new Error('密钥不能为空');
  for (let i = 0; i < cleaned.length; i++) {
    if (!BASE32_MAP.has(cleaned[i]!)) {
      throw new Error(`密钥包含无效的 Base32 字符: ${cleaned[i]}`);
    }
  }
  return cleaned;
}

/** RFC 4648 Base32 解码（容忍小写、空格、连字符和填充 =）。 */
export function decodeBase32(input: string): Uint8Array {
  const cleaned = normalizeSecret(input);
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (let i = 0; i < cleaned.length; i++) {
    value = (value << 5) | BASE32_MAP.get(cleaned[i]!)!;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  if (out.length === 0) throw new Error('密钥长度不足');
  return new Uint8Array(out);
}

// ───────────── 纯 JS SHA-1 / SHA-256 / SHA-512 & HMAC 兜底 ─────────────

const rotl32 = (x: number, n: number) => (x << n) | (x >>> (32 - n));
const rotr32 = (x: number, n: number) => (x >>> n) | (x << (32 - n));

function sha1Js(data: Uint8Array): Uint8Array {
  const len = data.length;
  const total = (((len + 9 + 63) >> 6) << 6);
  const buf = new Uint8Array(total);
  buf.set(data);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  const bitLen = BigInt(len) * 8n;
  dv.setBigUint64(total - 8, bitLen, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Int32Array(80);

  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getInt32(off + i * 4, false);
    for (let i = 16; i < 80; i++) w[i] = rotl32(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1);
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number, k: number;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const temp = (rotl32(a, 5) + f + e + k + w[i]!) | 0;
      e = d; d = c; c = rotl32(b, 30); b = a; a = temp;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  const out = new Uint8Array(20);
  const odv = new DataView(out.buffer);
  odv.setInt32(0, h0, false); odv.setInt32(4, h1, false); odv.setInt32(8, h2, false);
  odv.setInt32(12, h3, false); odv.setInt32(16, h4, false);
  return out;
}

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256Js(data: Uint8Array): Uint8Array {
  const len = data.length;
  const total = (((len + 9 + 63) >> 6) << 6);
  const buf = new Uint8Array(total);
  buf.set(data);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setBigUint64(total - 8, BigInt(len) * 8n, false);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr32(w[i - 15]!, 7) ^ rotr32(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr32(w[i - 2]!, 17) ^ rotr32(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K256[i]! + w[i]!) >>> 0;
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, h0, false); odv.setUint32(4, h1, false); odv.setUint32(8, h2, false); odv.setUint32(12, h3, false);
  odv.setUint32(16, h4, false); odv.setUint32(20, h5, false); odv.setUint32(24, h6, false); odv.setUint32(28, h7, false);
  return out;
}

const MASK64 = 0xffffffffffffffffn;
const rotr64 = (x: bigint, n: bigint) => ((x >> n) | (x << (64n - n))) & MASK64;

const K512: readonly bigint[] = [
  0x428a2f98d728ae22n, 0x7137449123ef65cdn, 0xb5c0fbcfec4d3b2fn, 0xe9b5dba58189dbbcn,
  0x3956c25bf348b538n, 0x59f111f1b605d019n, 0x923f82a4af194f9bn, 0xab1c5ed5da6d8118n,
  0xd807aa98a3030242n, 0x12835b0145706fben, 0x243185be4ee4b28cn, 0x550c7dc3d5ffb4e2n,
  0x72be5d74f27b896fn, 0x80deb1fe3b1696b1n, 0x9bdc06a725c71235n, 0xc19bf174cf692694n,
  0xe49b69c19ef14ad2n, 0xefbe4786384f25e3n, 0x0fc19dc68b8cd5b5n, 0x240ca1cc77ac9c65n,
  0x2de92c6f592b0275n, 0x4a7484aa6ea6e483n, 0x5cb0a9dcbd41fbd4n, 0x76f988da831153b5n,
  0x983e5152ee66dfabn, 0xa831c66d2db43210n, 0xb00327c898fb213fn, 0xbf597fc7beef0ee4n,
  0xc6e00bf33da88fc2n, 0xd5a79147930aa725n, 0x06ca6351e003826fn, 0x142929670a0e6e70n,
  0x27b70a8546d22ffcn, 0x2e1b21385c26c926n, 0x4d2c6dfc5ac42aedn, 0x53380d139d95b3dfn,
  0x650a73548baf63den, 0x766a0abb3c77b2a8n, 0x81c2c92e47edaee6n, 0x92722c851482353bn,
  0xa2bfe8a14cf10364n, 0xa81a664bbc423001n, 0xc24b8b70d0f89791n, 0xc76c51a30654be30n,
  0xd192e819d6ef5218n, 0xd69906245565a910n, 0xf40e35855771202an, 0x106aa07032bbd1b8n,
  0x19a4c116b8d2d0c8n, 0x1e376c085141ab53n, 0x2748774cdf8eeb99n, 0x34b0bcb5e19b48a8n,
  0x391c0cb3c5c95a63n, 0x4ed8aa4ae3418acbn, 0x5b9cca4f7763e373n, 0x682e6ff3d6b2b8a3n,
  0x748f82ee5defb2fcn, 0x78a5636f43172f60n, 0x84c87814a1f0ab72n, 0x8cc702081a6439ecn,
  0x90befffa23631e28n, 0xa4506cebde82bde9n, 0xbef9a3f7b2c67915n, 0xc67178f2e372532bn,
  0xca273eceea26619cn, 0xd186b8c721c0c207n, 0xeada7dd6cde0eb1en, 0xf57d4f7fee6ed178n,
  0x06f067aa72176fban, 0x0a637dc5a2c898a6n, 0x113f9804bef90daen, 0x1b710b35131c471bn,
  0x28db77f523047d84n, 0x32caab7b40c72493n, 0x3c9ebe0a15c9bebcn, 0x431d67c49c100d4cn,
  0x4cc5d4becb3e42b6n, 0x597f299cfc657e2an, 0x5fcb6fab3ad6faecn, 0x6c44198c4a475817n,
];

function sha512Js(data: Uint8Array): Uint8Array {
  const len = data.length;
  const total = (((len + 17 + 127) >> 7) << 7);
  const buf = new Uint8Array(total);
  buf.set(data);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setBigUint64(total - 8, BigInt(len) * 8n, false);

  let h0 = 0x6a09e667f3bcc908n, h1 = 0xbb67ae8584caa73bn, h2 = 0x3c6ef372fe94f82bn, h3 = 0xa54ff53a5f1d36f1n;
  let h4 = 0x510e527fade682d1n, h5 = 0x9b05688c2b3e6c1fn, h6 = 0x1f83d9abfb41bd6bn, h7 = 0x5be0cd19137e2179n;
  const w = new Array<bigint>(80);

  for (let off = 0; off < total; off += 128) {
    for (let i = 0; i < 16; i++) w[i] = dv.getBigUint64(off + i * 8, false);
    for (let i = 16; i < 80; i++) {
      const s0 = rotr64(w[i - 15]!, 1n) ^ rotr64(w[i - 15]!, 8n) ^ (w[i - 15]! >> 7n);
      const s1 = rotr64(w[i - 2]!, 19n) ^ rotr64(w[i - 2]!, 61n) ^ (w[i - 2]! >> 6n);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) & MASK64;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 80; i++) {
      const S1 = rotr64(e, 14n) ^ rotr64(e, 18n) ^ rotr64(e, 41n);
      const ch = (e & f) ^ ((~e & MASK64) & g);
      const t1 = (h + S1 + ch + K512[i]! + w[i]!) & MASK64;
      const S0 = rotr64(a, 28n) ^ rotr64(a, 34n) ^ rotr64(a, 39n);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) & MASK64;
      h = g; g = f; f = e; e = (d + t1) & MASK64;
      d = c; c = b; b = a; a = (t1 + t2) & MASK64;
    }
    h0 = (h0 + a) & MASK64; h1 = (h1 + b) & MASK64; h2 = (h2 + c) & MASK64; h3 = (h3 + d) & MASK64;
    h4 = (h4 + e) & MASK64; h5 = (h5 + f) & MASK64; h6 = (h6 + g) & MASK64; h7 = (h7 + h) & MASK64;
  }
  const out = new Uint8Array(64);
  const odv = new DataView(out.buffer);
  odv.setBigUint64(0, h0, false); odv.setBigUint64(8, h1, false); odv.setBigUint64(16, h2, false); odv.setBigUint64(24, h3, false);
  odv.setBigUint64(32, h4, false); odv.setBigUint64(40, h5, false); odv.setBigUint64(48, h6, false); odv.setBigUint64(56, h7, false);
  return out;
}

function hmacJs(algorithm: Algorithm, key: Uint8Array, data: Uint8Array): Uint8Array {
  const hashFn = algorithm === 'SHA512' ? sha512Js : algorithm === 'SHA256' ? sha256Js : sha1Js;
  const blockSize = algorithm === 'SHA512' ? 128 : 64;
  let k = key;
  if (k.length > blockSize) k = hashFn(k);
  const ipad = new Uint8Array(blockSize + data.length);
  const opad = new Uint8Array(blockSize + (algorithm === 'SHA512' ? 64 : algorithm === 'SHA256' ? 32 : 20));
  for (let i = 0; i < blockSize; i++) {
    const b = i < k.length ? k[i]! : 0;
    ipad[i] = b ^ 0x36;
    opad[i] = b ^ 0x5c;
  }
  ipad.set(data, blockSize);
  opad.set(hashFn(ipad), blockSize);
  return hashFn(opad);
}

function webHashName(alg: Algorithm): 'SHA-1' | 'SHA-256' | 'SHA-512' {
  if (alg === 'SHA256') return 'SHA-256';
  if (alg === 'SHA512') return 'SHA-512';
  return 'SHA-1';
}

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

export async function hmacDigest(
  algorithm: Algorithm,
  key: Uint8Array,
  data: Uint8Array,
  backend: CryptoBackend = 'auto',
): Promise<Uint8Array> {
  const useWeb = backend === 'webcrypto' || (backend === 'auto' && hasWebCrypto());
  if (useWeb) {
    const subtle = globalThis.crypto.subtle;
    const cryptoKey = await subtle.importKey(
      'raw',
      toArrayBuffer(key),
      { name: 'HMAC', hash: webHashName(algorithm) },
      false,
      ['sign'],
    );
    const sig = await subtle.sign('HMAC', cryptoKey, toArrayBuffer(data));
    return new Uint8Array(sig);
  }
  return hmacJs(algorithm, key, data);
}

/** RFC 4226 HOTP：8 字节大端计数器 + 动态截断。 */
export async function generateHotp(
  secretBytes: Uint8Array,
  counter: bigint | number,
  digits: 6 | 8 = 6,
  algorithm: Algorithm = 'SHA1',
  backend: CryptoBackend = 'auto',
): Promise<string> {
  const c = typeof counter === 'bigint' ? counter : BigInt(Math.floor(counter));
  const msg = new Uint8Array(8);
  let tmp = c;
  for (let i = 7; i >= 0; i--) {
    msg[i] = Number(tmp & 0xffn);
    tmp >>= 8n;
  }
  const mac = await hmacDigest(algorithm, secretBytes, msg, backend);
  const offset = mac[mac.length - 1]! & 0x0f;
  const binCode =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff);
  const mod = digits === 8 ? 100_000_000 : 1_000_000;
  return String(binCode % mod).padStart(digits, '0');
}

/** RFC 6238 TOTP（支持 SHA1 / SHA256 / SHA512、6 / 8 位、自定义周期）。 */
export async function generateTotp(
  entry: Pick<TwoFaEntry, 'secret' | 'algorithm' | 'digits' | 'period'>,
  timeSec = Math.floor(Date.now() / 1000),
  backend: CryptoBackend = 'auto',
): Promise<string> {
  const period = entry.period > 0 ? entry.period : 30;
  const counter = BigInt(Math.floor(timeSec / period));
  return generateHotp(decodeBase32(entry.secret), counter, entry.digits, entry.algorithm, backend);
}

/** 周期倒计时：返回剩余秒数（1..period）与剩余比例（0..1）。 */
export function totpRemaining(period: number, nowMs = Date.now()): { remaining: number; progress: number } {
  const p = period > 0 ? period : 30;
  const elapsed = (nowMs / 1000) % p;
  const left = p - elapsed;
  const remaining = Math.max(1, Math.min(p, Math.ceil(left)));
  return { remaining, progress: Math.max(0, Math.min(1, left / p)) };
}

/** 格式化显示验证码：6 位 "123 456"，8 位 "1234 5678"。 */
export function formatTotpCode(code: string): string {
  if (code.length === 6) return `${code.slice(0, 3)} ${code.slice(3)}`;
  if (code.length === 8) return `${code.slice(0, 4)} ${code.slice(4)}`;
  return code;
}

export function normalizeAlgorithm(raw?: string | null): Algorithm {
  const u = (raw ?? 'SHA1').trim().toUpperCase().replace(/-/g, '');
  if (u === 'SHA256') return 'SHA256';
  if (u === 'SHA512') return 'SHA512';
  return 'SHA1';
}

export function normalizeDigits(raw?: number | string | null): 6 | 8 {
  return Number(raw) === 8 ? 8 : 6;
}

export function normalizePeriod(raw?: number | string | null): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : 30;
}

export interface ParsedTotpInput {
  issuer: string;
  account: string;
  secret: string;
  algorithm: Algorithm;
  digits: 6 | 8;
  period: number;
}

/** 解析 otpauth://totp/... URI（用于粘贴 URI 快速填表）。 */
export function parseOtpAuthUri(uri: string): ParsedTotpInput {
  let url: URL;
  try {
    url = new URL(uri.trim());
  } catch {
    throw new Error('无效的 otpauth URI');
  }
  if (url.protocol.toLowerCase() !== 'otpauth:') {
    throw new Error('URI 协议必须为 otpauth://');
  }
  const type = url.hostname.toLowerCase();
  if (type !== 'totp') {
    throw new Error(`不支持的类型: ${type || '未知'}（仅支持 totp）`);
  }

  const rawLabel = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  let labelIssuer = '';
  let account = rawLabel;
  const colonIdx = rawLabel.indexOf(':');
  if (colonIdx >= 0) {
    labelIssuer = rawLabel.slice(0, colonIdx).trim();
    account = rawLabel.slice(colonIdx + 1).trim();
  }

  const secretParam = url.searchParams.get('secret');
  if (!secretParam) throw new Error('URI 缺少 secret 参数');
  const secret = normalizeSecret(secretParam);
  decodeBase32(secret);

  const issuer = (url.searchParams.get('issuer') ?? labelIssuer).trim();
  const algorithm = normalizeAlgorithm(url.searchParams.get('algorithm'));
  const digits = normalizeDigits(url.searchParams.get('digits'));
  const period = normalizePeriod(url.searchParams.get('period'));

  return { issuer, account: account.trim(), secret, algorithm, digits, period };
}

/** 构建标准 otpauth://totp/... URI。 */
export function buildOtpAuthUri(
  entry: Pick<TwoFaEntry, 'issuer' | 'account' | 'secret' | 'algorithm' | 'digits' | 'period'>,
): string {
  const issuer = entry.issuer.trim();
  const account = entry.account.trim();
  const label = issuer
    ? `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`
    : encodeURIComponent(account || 'account');
  const params = new URLSearchParams();
  params.set('secret', normalizeSecret(entry.secret));
  if (issuer) params.set('issuer', issuer);
  params.set('algorithm', entry.algorithm);
  params.set('digits', String(entry.digits));
  params.set('period', String(entry.period));
  return `otpauth://totp/${label}?${params.toString()}`;
}
