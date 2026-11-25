#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TAILNET_DIR = path.resolve(__dirname, '..');
const VERSION_PKG = 'github.com/cosyeezz/cosyee/tailnet/internal/version.Version';

function parseArgs(argv) {
  const opts = {
    target: '',
    outDir: path.join(TAILNET_DIR, 'dist'),
    version: '',
    androidApi: '24',
    goBin: process.env.GO_BIN || 'go',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--target' || arg === '-t') opts.target = argv[++i];
    else if (arg === '--out-dir' || arg === '-o') opts.outDir = path.resolve(argv[++i]);
    else if (arg === '--version') opts.version = argv[++i];
    else if (arg === '--android-api') opts.androidApi = argv[++i];
    else if (arg === '--go') opts.goBin = argv[++i];
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

function run(cmd, args, extraEnv = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, {
    cwd: TAILNET_DIR,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
}

function ldflags(version) {
  return `-s -w -X ${VERSION_PKG}=${version}`;
}

function findAndroidCC(apiLevel) {
  if (process.env.ANDROID_CC) return process.env.ANDROID_CC;
  const ndkRoot =
    process.env.ANDROID_NDK_HOME ||
    process.env.ANDROID_NDK_LATEST_HOME ||
    process.env.ANDROID_NDK_ROOT ||
    process.env.NDK_HOME;
  if (!ndkRoot) {
    throw new Error(
      'Android NDK not found. Set ANDROID_NDK_HOME (or ANDROID_NDK_LATEST_HOME / NDK_HOME / ANDROID_CC).',
    );
  }
  const prebuiltDir = path.join(ndkRoot, 'toolchains', 'llvm', 'prebuilt');
  if (!fs.existsSync(prebuiltDir)) {
    throw new Error(`NDK prebuilt toolchain dir not found: ${prebuiltDir}`);
  }
  const hosts = fs.readdirSync(prebuiltDir).filter((d) => !d.startsWith('.'));
  const ext = process.platform === 'win32' ? '.cmd' : '';
  for (const host of hosts) {
    const candidate = path.join(
      prebuiltDir,
      host,
      'bin',
      `aarch64-linux-android${apiLevel}-clang${ext}`,
    );
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `Could not locate aarch64-linux-android${apiLevel}-clang${ext} under ${prebuiltDir}`,
  );
}

function buildWindowsX64(opts, version) {
  const out = path.join(opts.outDir, `cosyee-tailnet_${version}_windows_x64.exe`);
  run(
    opts.goBin,
    ['build', '-trimpath', '-ldflags', ldflags(version), '-o', out, './cmd/cosyee-tailnet'],
    { GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0' },
  );
  return out;
}

function buildMacosArch(opts, version, arch, outPath) {
  run(
    opts.goBin,
    ['build', '-trimpath', '-ldflags', ldflags(version), '-o', outPath, './cmd/cosyee-tailnet'],
    { GOOS: 'darwin', GOARCH: arch, CGO_ENABLED: '0' },
  );
  return outPath;
}

function buildMacosUniversal(opts, version) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-tailnet-macos-'));
  try {
    const amd64Bin = path.join(tmpDir, 'cosyee-tailnet-amd64');
    const arm64Bin = path.join(tmpDir, 'cosyee-tailnet-arm64');
    buildMacosArch(opts, version, 'amd64', amd64Bin);
    buildMacosArch(opts, version, 'arm64', arm64Bin);

    const out = path.join(opts.outDir, `cosyee-tailnet_${version}_macos_universal`);
    run('lipo', ['-create', '-output', out, amd64Bin, arm64Bin]);
    run('codesign', ['-s', '-', '-f', out]);
    fs.chmodSync(out, 0o755);
    return out;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function buildAndroidArm64(opts, version) {
  const cc = findAndroidCC(opts.androidApi);
  const out = path.join(opts.outDir, `libcosyee_tailnet_${version}_android_arm64.so`);
  run(
    opts.goBin,
    [
      'build',
      '-buildmode=c-shared',
      '-trimpath',
      '-ldflags',
      ldflags(version),
      '-o',
      out,
      './cmd/cosyee-tailnet-android',
    ],
    {
      GOOS: 'android',
      GOARCH: 'arm64',
      CGO_ENABLED: '1',
      CC: cc,
    },
  );
  // Remove auto-generated .h header next to .so so outDir only contains release assets
  const headerPath = out.replace(/\.so$/, '.h');
  if (fs.existsSync(headerPath)) {
    fs.rmSync(headerPath);
  }
  return out;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.target) {
    console.error(
      [
        'Usage: node build.mjs --target <target> [--out-dir <dir>] [--version <ver>] [--android-api 24] [--go <go-bin>]',
        'Targets: windows-x64 | macos-amd64 | macos-arm64 | macos-universal | android-arm64',
      ].join('\n'),
    );
    process.exit(opts.help ? 0 : 1);
  }

  const version = opts.version || readVersion();
  fs.mkdirSync(opts.outDir, { recursive: true });

  switch (opts.target) {
    case 'windows-x64':
      buildWindowsX64(opts, version);
      break;
    case 'macos-amd64':
      buildMacosArch(
        opts,
        version,
        'amd64',
        path.join(opts.outDir, `cosyee-tailnet_${version}_macos_amd64`),
      );
      break;
    case 'macos-arm64':
      buildMacosArch(
        opts,
        version,
        'arm64',
        path.join(opts.outDir, `cosyee-tailnet_${version}_macos_arm64`),
      );
      break;
    case 'macos-universal':
      buildMacosUniversal(opts, version);
      break;
    case 'android-arm64':
      buildAndroidArm64(opts, version);
      break;
    default:
      console.error(`Unsupported target: ${opts.target}`);
      process.exit(1);
  }
}

main();
