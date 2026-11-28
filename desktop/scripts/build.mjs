// 构建桌面版产物到 desktop/dist：
//   dist/server/server.mjs   后端单文件 bundle（ESM，入口 server/src/desktop-entry.ts）
//   dist/server/win.ps1      Windows 选择窗口脚本（运行时由 picker/win.ts 从 bundle 同目录读取）
//   dist/main.cjs            Electron 主进程
//   dist/preload.cjs         主窗口 preload（sandbox 下必须是 CJS）
//   dist/settings-preload.cjs + dist/settings.html   设置窗口（独立页面，不依赖 web/）
// 用法：node scripts/build.mjs [--main-only]   （--main-only 开发模式用，不重打后端）
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(root, '..');
const dist = path.join(root, 'dist');
const mainOnly = process.argv.includes('--main-only');

const serverPkg = JSON.parse(fs.readFileSync(path.join(repo, 'server', 'package.json'), 'utf8'));

if (!mainOnly) {
  fs.rmSync(path.join(dist, 'server'), { recursive: true, force: true });
  await build({
    entryPoints: [path.join(repo, 'server/src/desktop-entry.ts')],
    outfile: path.join(dist, 'server/server.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24', // Electron 45 内置 Node 24
    // ws 的 bufferutil / utf-8-validate 是可选原生加速，缺失时 ws 自动退回纯 JS，不打进 bundle
    external: ['bufferutil', 'utf-8-validate'],
    // ESM bundle 里 CJS 依赖（ws）需要 require
    banner: { js: "import { createRequire as __cosyeeCreateRequire } from 'node:module';\nconst require = __cosyeeCreateRequire(import.meta.url);" },
    // 版本号在构建时写死（bundle 里读不到 server/package.json）
    define: { __COSYEE_VERSION__: JSON.stringify(serverPkg.version ?? '0.0.0') },
    logLevel: 'info',
  });
  // picker/win.ts 会在 bundle 同目录找 win.ps1；twofa 会在同目录找 cosyee-2fa-decrypt.mjs
  fs.copyFileSync(path.join(repo, 'server/src/picker/win.ps1'), path.join(dist, 'server/win.ps1'));
  fs.copyFileSync(path.join(repo, 'scripts/cosyee-2fa-decrypt.mjs'), path.join(dist, 'server/cosyee-2fa-decrypt.mjs'));
}

for (const [entry, out] of [['src/main.ts', 'main.cjs'], ['src/preload.ts', 'preload.cjs'], ['src/settings-preload.ts', 'settings-preload.cjs']]) {
  await build({
    entryPoints: [path.join(root, entry)],
    outfile: path.join(dist, out),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron'],
    logLevel: 'info',
  });
}

// 设置窗口页面原样复制
fs.copyFileSync(path.join(root, 'src/settings.html'), path.join(dist, 'settings.html'));
