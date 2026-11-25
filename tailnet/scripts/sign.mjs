#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 客户端写死的 Ed25519 公钥（32 字节原始公钥 base64，见 CONTRACT.md）
export const DEFAULT_PUBLIC_KEY_B64 = 'cRew2agsYGnnrphfIwIjmlvFFToCaaidYmpvylSKB64=';

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function privateKeyFromSeedBase64(seedB64) {
  const seed = Buffer.from(seedB64.trim(), 'base64');
  if (seed.length !== 32) {
    throw new Error(`TAILNET_SIGNING_KEY must decode to 32 bytes, got ${seed.length}`);
  }
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

export function publicKeyFromRawBase64(pubB64 = DEFAULT_PUBLIC_KEY_B64) {
  const raw = Buffer.from(pubB64.trim(), 'base64');
  if (raw.length !== 32) {
    throw new Error(`Ed25519 public key must decode to 32 bytes, got ${raw.length}`);
  }
  const der = Buffer.concat([SPKI_ED25519_PREFIX, raw]);
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

export function signBytes(data, seedB64) {
  const privKey = privateKeyFromSeedBase64(seedB64);
  return crypto.sign(null, data, privKey).toString('base64');
}

export function verifyBytes(data, sigB64, pubB64 = DEFAULT_PUBLIC_KEY_B64) {
  const pubKey = publicKeyFromRawBase64(pubB64);
  const sig = Buffer.from(sigB64.trim(), 'base64');
  if (sig.length !== 64) {
    return false;
  }
  return crypto.verify(null, data, pubKey, sig);
}

function parseArgs(argv) {
  const opts = { verify: false, pubkey: DEFAULT_PUBLIC_KEY_B64, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--verify' || arg === '-v') {
      opts.verify = true;
    } else if (arg === '--pubkey') {
      opts.pubkey = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else {
      opts.positional.push(arg);
    }
  }
  return opts;
}

function usage() {
  console.error(
    [
      'Usage:',
      '  TAILNET_SIGNING_KEY=<base64-32B-seed> node sign.mjs <manifest.json> [manifest.json.sig]',
      '  node sign.mjs --verify <manifest.json> [manifest.json.sig] [--pubkey <base64-32B-pub>]',
    ].join('\n'),
  );
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || opts.positional.length < 1) {
    usage();
    process.exit(opts.help ? 0 : 1);
  }

  const manifestPath = path.resolve(opts.positional[0]);
  const sigPath = path.resolve(opts.positional[1] || `${manifestPath}.sig`);
  const data = fs.readFileSync(manifestPath);

  if (opts.verify) {
    const sigB64 = fs.readFileSync(sigPath, 'utf8').trim();
    const ok = verifyBytes(data, sigB64, opts.pubkey);
    if (!ok) {
      console.error(`Signature verification FAILED for ${manifestPath}`);
      process.exit(1);
    }
    console.log(`Signature verified OK: ${manifestPath}`);
    return;
  }

  const seedB64 = process.env.TAILNET_SIGNING_KEY;
  if (!seedB64 || !seedB64.trim()) {
    console.error('Missing environment variable TAILNET_SIGNING_KEY');
    process.exit(1);
  }

  const sigB64 = signBytes(data, seedB64);
  if (!verifyBytes(data, sigB64, opts.pubkey)) {
    console.error('Self-check FAILED: signing key does not match expected public key');
    process.exit(1);
  }

  fs.writeFileSync(sigPath, `${sigB64}\n`, 'utf8');
  console.log(`Signed and verified: ${sigPath}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
