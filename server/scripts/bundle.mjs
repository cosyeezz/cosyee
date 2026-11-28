// 打独立服务端包（不依赖 Electron，需要本机装 Node.js 24+ 和已登录的 claude CLI）：
//   server/dist/cosyee-server/
//     server.mjs    后端单文件 bundle（入口 src/index.ts，ws 等依赖都打进去）
//     win.ps1       Windows 选择窗口脚本（picker/win.ts 在 bundle 同目录找它）
//     web/          前端静态文件（需先 npm run build -w web）
//     start.cmd     Windows 启动脚本（默认 Tailscale 模式）
//     start.sh      macOS / Linux 启动脚本
//     README.txt
// 用法：node server/scripts/bundle.mjs
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(serverRoot, '..');
const out = path.join(serverRoot, 'dist', 'cosyee-server');
const webDist = path.join(repo, 'web', 'dist');

if (!fs.existsSync(path.join(webDist, 'index.html'))) {
  console.error('缺少 web/dist：先运行 npm run build -w web');
  process.exit(1);
}

const version = process.env.COSYEE_VERSION || JSON.parse(fs.readFileSync(path.join(serverRoot, 'package.json'), 'utf8')).version || '0.0.0';

fs.rmSync(out, { recursive: true, force: true });
await build({
  entryPoints: [path.join(serverRoot, 'src/index.ts')],
  outfile: path.join(out, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: true,
  // ws 的 bufferutil / utf-8-validate 是可选原生加速，缺失时 ws 自动退回纯 JS
  external: ['bufferutil', 'utf-8-validate'],
  // ESM bundle 里的 CJS 依赖（ws）需要 require
  banner: { js: "import { createRequire as __cosyeeCreateRequire } from 'node:module';\nconst require = __cosyeeCreateRequire(import.meta.url);" },
  define: { __COSYEE_VERSION__: JSON.stringify(version) },
  logLevel: 'info',
});
fs.copyFileSync(path.join(serverRoot, 'src/picker/win.ps1'), path.join(out, 'win.ps1'));
fs.copyFileSync(path.join(repo, 'scripts/cosyee-2fa-decrypt.mjs'), path.join(out, 'cosyee-2fa-decrypt.mjs'));
fs.cpSync(webDist, path.join(out, 'web'), { recursive: true });

// .cmd 用 CRLF；chcp 65001 让中文提示不乱码
const cmd = [
  '@echo off',
  'chcp 65001 >nul',
  'cd /d "%~dp0"',
  'where node >nul 2>nul || (echo 需要先安装 Node.js 24 或更高版本：winget install OpenJS.NodeJS & pause & exit /b 1)',
  'where claude >nul 2>nul || if "%COSYEE_CLAUDE%"=="" (echo 找不到 claude 命令：先安装并登录 Claude Code CLI & pause & exit /b 1)',
  'rem 默认 Tailscale 模式：本机和 tailnet 内的设备可访问，局域网 / 公网连不上。只给本机用可改成 127.0.0.1',
  'if "%COSYEE_HOST%"=="" set COSYEE_HOST=tailscale',
  'node server.mjs',
  'pause',
  '',
].join('\r\n');
fs.writeFileSync(path.join(out, 'start.cmd'), cmd);

const sh = `#!/bin/sh
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "需要先安装 Node.js 24 或更高版本"; exit 1; }
if [ -z "$COSYEE_CLAUDE" ] && ! command -v claude >/dev/null 2>&1; then echo "找不到 claude 命令：先安装并登录 Claude Code CLI"; exit 1; fi
# 默认 Tailscale 模式：本机和 tailnet 内的设备可访问，局域网 / 公网连不上。只给本机用可改成 127.0.0.1
export COSYEE_HOST="\${COSYEE_HOST:-tailscale}"
exec node server.mjs
`;
fs.writeFileSync(path.join(out, 'start.sh'), sh, { mode: 0o755 });

fs.writeFileSync(
  path.join(out, 'README.txt'),
  `Cosyee 服务端 ${version}

需要：Node.js 24+；已安装并登录的 Claude Code CLI（终端里 claude auth status 显示已登录）。

启动：Windows 双击 start.cmd；macOS / Linux 运行 ./start.sh
默认端口 7878，Tailscale 模式：
  - 本机：http://127.0.0.1:7878/
  - tailnet 里的其它设备：http://<本机 Tailscale IP 或机器名>:7878/
  - 局域网 / 公网的连接会被直接断开；不需要令牌。

环境变量：
  COSYEE_HOST    tailscale（默认）| 127.0.0.1（只给本机用）
  COSYEE_PORT    端口，默认 7878
  COSYEE_CLAUDE  claude 可执行文件路径，默认从 PATH 查找

注意：模型以 --dangerously-skip-permissions 运行，tailnet 里的任何设备都能让它在本机执行任意命令。
`.replace(/\n/g, '\r\n'),
);

// 作为 npm 包安装（CI 把本目录推到 server-dist 分支）：npm i -g github:cosyeezz/cosyee#server-dist
// 没有任何依赖和安装脚本，装完就是 cosyee-server 命令
const cli = `#!/usr/bin/env node
// cosyee-server [--tailscale | --local] [--host <IPv4>] [--port <n>]；其余配置见 README.txt 的环境变量
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const val = () => {
    const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[++i];
    if (!v) { console.error('缺少参数值: ' + a); process.exit(2); }
    return v;
  };
  if (a === '--tailscale') process.env.COSYEE_HOST = 'tailscale';
  else if (a === '--local') process.env.COSYEE_HOST = '127.0.0.1';
  else if (a === '--host' || a.startsWith('--host=')) process.env.COSYEE_HOST = val();
  else if (a === '--port' || a.startsWith('--port=')) process.env.COSYEE_PORT = val();
  else if (a === '-v' || a === '--version') { console.log(${JSON.stringify(version)}); process.exit(0); }
  else if (a === '-h' || a === '--help') {
    console.log('用法: cosyee-server [--tailscale | --local] [--host <IPv4>] [--port <端口>]\\n  --tailscale  本机 + tailnet 内设备可访问，不需要令牌（默认）\\n  --local      只监听 127.0.0.1\\n  默认端口 7878');
    process.exit(0);
  } else { console.error('未知参数: ' + a + '（--help 查看用法）'); process.exit(2); }
}
await import('./server.mjs');
`;
fs.writeFileSync(path.join(out, 'cli.mjs'), cli, { mode: 0o755 });
fs.writeFileSync(
  path.join(out, 'package.json'),
  JSON.stringify(
    {
      name: 'cosyee-server',
      version,
      description: 'Cosyee 服务端（Claude Code 的网页界面后端），单文件、无依赖',
      type: 'module',
      bin: { 'cosyee-server': 'cli.mjs' },
      main: 'server.mjs',
      // 桌面客户端据此判断能不能用 `node server.mjs components …` 在服务端没运行时管理组件
      cosyee: { componentsCli: 1 },
      engines: { node: '>=22' },
      license: 'UNLICENSED',
      repository: { type: 'git', url: 'https://github.com/cosyeezz/cosyee.git' },
      ...(process.env.GITHUB_SHA ? { gitHead: process.env.GITHUB_SHA } : {}),
    },
    null,
    2,
  ) + '\n',
);

const size = fs.statSync(path.join(out, 'server.mjs')).size;
console.log(`独立服务端包: ${out}（server.mjs ${(size / 1024).toFixed(0)} KB）`);
