#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TAILNET_DIR = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const opts = {
    repo: process.env.GITHUB_REPOSITORY || 'cosyeezz/cosyee',
    version: '',
    tailscale: '',
    released: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    assetsDir: '',
    out: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo') opts.repo = argv[++i];
    else if (arg === '--version') opts.version = argv[++i];
    else if (arg === '--tailscale') opts.tailscale = argv[++i];
    else if (arg === '--released') opts.released = argv[++i];
    else if (arg === '--assets-dir') opts.assetsDir = argv[++i];
    else if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return opts;
}

function readVersion() {
  return fs.readFileSync(path.join(TAILNET_DIR, 'VERSION'), 'utf8').trim();
}

function readTailscaleVersion() {
  const goMod = fs.readFileSync(path.join(TAILNET_DIR, 'go.mod'), 'utf8');
  const m = goMod.match(/^(?:\s*require\s+|\s+)tailscale\.com\s+v([^\s]+)/m);
  if (!m) {
    throw new Error('Could not find tailscale.com version in tailnet/go.mod');
  }
  return m[1];
}

function sha256AndSize(filePath) {
  const data = fs.readFileSync(filePath);
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  return { sha256, size: data.length };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.assetsDir) {
    console.error(
      'Usage: node manifest.mjs --assets-dir <dir> [--out <manifest.json>] [--version <ver>] [--tailscale <ver>] [--repo <owner/repo>] [--released <iso>]',
    );
    process.exit(opts.help ? 0 : 1);
  }

  const version = opts.version || readVersion();
  const tailscale = opts.tailscale || readTailscaleVersion();
  const assetsDir = path.resolve(opts.assetsDir);
  const outPath = path.resolve(opts.out || path.join(assetsDir, 'manifest.json'));
  const tag = `tailnet-v${version}`;

  const expected = {
    'windows-x64': `cosyee-tailnet_${version}_windows_x64.exe`,
    'macos-universal': `cosyee-tailnet_${version}_macos_universal`,
    'android-arm64': `libcosyee_tailnet_${version}_android_arm64.so`,
  };

  const assets = {};
  for (const [platform, filename] of Object.entries(expected)) {
    const filePath = path.join(assetsDir, filename);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Missing required asset for ${platform}: ${filePath}`);
    }
    const { sha256, size } = sha256AndSize(filePath);
    assets[platform] = {
      url: `https://github.com/${opts.repo}/releases/download/${tag}/${filename}`,
      sha256,
      size,
    };
  }

  const manifest = {
    version,
    tailscale,
    released: opts.released,
    assets,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`Wrote manifest to ${outPath}`);
}

main();
