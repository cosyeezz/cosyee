// 开发模式：主进程不拉起后端，直接加载 Vite（http://127.0.0.1:5273/）。
// 后端（7878）和 Vite（5273）由根目录 `npm run dev:desktop` 并行启动。
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const build = spawn(process.execPath, [path.join(root, 'scripts/build.mjs'), '--main-only'], { stdio: 'inherit' });
build.on('exit', (code) => {
  if (code !== 0) process.exit(code ?? 1);
  const electron = require('electron'); // 返回 electron 可执行文件路径
  const env = { ...process.env, COSYEE_DESKTOP_DEV: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [root, ...process.argv.slice(2)], { stdio: 'inherit', env });
  child.on('exit', (c) => process.exit(c ?? 0));
});
