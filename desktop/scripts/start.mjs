// 生产模式（不打安装包）：用已构建的 dist 启动 Electron。先运行 `npm run build:desktop`。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

if (!fs.existsSync(path.join(root, 'dist/main.cjs')) || !fs.existsSync(path.join(root, 'dist/server/server.mjs'))) {
  console.error('desktop/dist 不存在，请先运行 npm run build:desktop');
  process.exit(1);
}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.COSYEE_DESKTOP_DEV;
const child = spawn(require('electron'), [root, ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (c) => process.exit(c ?? 0));
