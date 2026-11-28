import { describe, expect, it } from 'vitest';
import {
  buildOtpAuthUri,
  decodeBase32,
  formatTotpCode,
  generateHotp,
  generateTotp,
  normalizeSecret,
  parseOtpAuthUri,
  totpRemaining,
} from './totp';
import type { Algorithm } from './types';

// RFC 6238 Appendix B 测试向量（8 位，周期 30s）
const enc = new TextEncoder();
const SECRETS: Record<Algorithm, Uint8Array> = {
  SHA1: enc.encode('12345678901234567890'),
  SHA256: enc.encode('12345678901234567890123456789012'),
  SHA512: enc.encode('1234567890123456789012345678901234567890123456789012345678901234'),
};

const VECTORS: { time: number; SHA1: string; SHA256: string; SHA512: string }[] = [
  { time: 59, SHA1: '94287082', SHA256: '46119246', SHA512: '90693936' },
  { time: 1111111109, SHA1: '07081804', SHA256: '68084774', SHA512: '25091201' },
  { time: 1111111111, SHA1: '14050471', SHA256: '67062674', SHA512: '99943326' },
  { time: 1234567890, SHA1: '89005924', SHA256: '91819424', SHA512: '93441116' },
  { time: 2000000000, SHA1: '69279037', SHA256: '90698825', SHA512: '38618901' },
  { time: 20000000000, SHA1: '65353130', SHA256: '77737706', SHA512: '47863826' },
];

describe('TOTP (RFC 6238 Appendix B)', () => {
  for (const backend of ['webcrypto', 'js'] as const) {
    describe(`backend: ${backend}`, () => {
      for (const alg of ['SHA1', 'SHA256', 'SHA512'] as const) {
        it(`matches all RFC 6238 vectors for ${alg}`, async () => {
          for (const v of VECTORS) {
            const counter = BigInt(Math.floor(v.time / 30));
            const code = await generateHotp(SECRETS[alg], counter, 8, alg, backend);
            expect(code).toBe(v[alg]);
          }
        });
      }
    });
  }

  it('generateTotp computes 6-digit code identically on webcrypto and pure-JS backends', async () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const c1 = await generateTotp({ secret, algorithm: 'SHA1', digits: 6, period: 30 }, 59, 'webcrypto');
    const c2 = await generateTotp({ secret, algorithm: 'SHA1', digits: 6, period: 30 }, 59, 'js');
    expect(c1).toBe('287082');
    expect(c2).toBe('287082');
  });

  it('totpRemaining computes remaining seconds and smooth progress', () => {
    const r1 = totpRemaining(30, 27_500);
    expect(r1.remaining).toBe(3);
    expect(r1.progress).toBeCloseTo(2.5 / 30, 4);
  });
});

describe('Base32 decode', () => {
  it('decodes RFC 4648 test strings and tolerates lowercase, spaces, hyphens, padding', () => {
    const dec = new TextDecoder();
    expect(dec.decode(decodeBase32('MZXW6YTBOI======'))).toBe('foobar');
    expect(dec.decode(decodeBase32('mzxw 6ytb-oi'))).toBe('foobar');
    expect(normalizeSecret('jbsw y3dp-ehpk 3pxp====')).toBe('JBSWY3DPEHPK3PXP');
  });

  it('rejects empty or invalid base32 characters', () => {
    expect(() => decodeBase32('')).toThrow();
    expect(() => decodeBase32('INVALID0189')).toThrow();
  });
});

describe('otpauth URI parse & build', () => {
  it('roundtrips standard otpauth://totp URI', () => {
    const uri = 'otpauth://totp/GitHub:alice%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&algorithm=SHA256&digits=8&period=60';
    const parsed = parseOtpAuthUri(uri);
    expect(parsed).toEqual({
      issuer: 'GitHub',
      account: 'alice@example.com',
      secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA256',
      digits: 8,
      period: 60,
    });
    const rebuilt = buildOtpAuthUri(parsed);
    expect(parseOtpAuthUri(rebuilt)).toEqual(parsed);
  });

  it('extracts issuer from label when issuer query param is absent', () => {
    const parsed = parseOtpAuthUri('otpauth://totp/Google:bob@gmail.com?secret=jbswy3dpehpk3pxp');
    expect(parsed.issuer).toBe('Google');
    expect(parsed.account).toBe('bob@gmail.com');
    expect(parsed.algorithm).toBe('SHA1');
    expect(parsed.digits).toBe(6);
    expect(parsed.period).toBe(30);
  });

  it('rejects non-totp URI', () => {
    expect(() => parseOtpAuthUri('otpauth://hotp/Test:a?secret=JBSWY3DPEHPK3PXP&counter=1')).toThrow();
  });

  it('formats 6-digit and 8-digit codes with space', () => {
    expect(formatTotpCode('123456')).toBe('123 456');
    expect(formatTotpCode('12345678')).toBe('1234 5678');
  });
});
