// 把版本号写进 tauri.conf.json 和 Cargo.toml（CI 发布时用标签版本）。
// 用法：node client/scripts/set-version.mjs 0.2.0
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const v = process.argv[2];
if (!v || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v)) {
  console.error(`版本号不合法：${v ?? '（空）'}，应为 x.y.z 或 x.y.z-xxx`);
  process.exit(1);
}
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri');

const confPath = path.join(dir, 'tauri.conf.json');
const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
conf.version = v;
fs.writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n');

const cargoPath = path.join(dir, 'Cargo.toml');
const cargo = fs.readFileSync(cargoPath, 'utf8');
const next = cargo.replace(/^version\s*=\s*"[^"]*"/m, `version = "${v}"`);
if (next === cargo && !cargo.includes(`version = "${v}"`)) {
  console.error('Cargo.toml 里没找到 version 行');
  process.exit(1);
}
fs.writeFileSync(cargoPath, next);
console.log(`版本号 -> ${v}`);
