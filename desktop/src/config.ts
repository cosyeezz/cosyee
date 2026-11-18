// 桌面版配置：userData/config.json  { host, port, token }
// 读写都要容错：文件不存在 -> 默认值并写出；坏 JSON / 字段非法 -> 用默认值并返回 warning（主进程弹窗提示），坏文件改名留底。
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export interface Config {
  /** 监听地址（IPv4）：127.0.0.1 仅本机，0.0.0.0 局域网，或某个具体 IP */
  host: string;
  /** 监听端口；0 = 每次启动随机 */
  port: number;
  /** 访问令牌；持久化，否则每次重启浏览器链接都会失效 */
  token: string;
}

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 7878;

export function newToken(): string {
  return randomBytes(32).toString('hex');
}

/** 校验地址与端口，通过返回 null，否则返回中文错误信息。 */
export function validate(host: unknown, port: unknown): string | null {
  if (typeof host !== 'string' || !net.isIPv4(host)) return '监听地址必须是 IPv4 地址，例如 127.0.0.1 或 0.0.0.0';
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) return '端口必须是 0-65535 的整数（0 表示自动选择）';
  return null;
}

export function isLoopback(host: string): boolean {
  return host === '127.0.0.1';
}

export function loadConfig(file: string): { config: Config; warning?: string } {
  const fresh = (): Config => ({ host: DEFAULT_HOST, port: DEFAULT_PORT, token: newToken() });
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    const config = fresh();
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { config, warning: `无法读取配置文件 ${file}（${String(e)}），已使用默认设置。` };
    }
    trySave(file, config);
    return { config };
  }
  let j: unknown;
  try {
    j = JSON.parse(raw);
    if (typeof j !== 'object' || j === null || Array.isArray(j)) throw new Error('不是对象');
  } catch {
    const config = fresh();
    let kept = '';
    try {
      fs.renameSync(file, `${file}.bad`);
      kept = `，原文件已保留为 ${file}.bad`;
    } catch { /* 留底失败也不影响启动 */ }
    trySave(file, config);
    return { config, warning: `配置文件不是合法 JSON${kept}。已恢复默认设置（${DEFAULT_HOST}:${DEFAULT_PORT}）。` };
  }
  const o = j as Record<string, unknown>;
  const warnings: string[] = [];
  const config = fresh();
  let dirty = false;
  if (validate(o.host, 0) === null) config.host = o.host as string;
  else {
    warnings.push(`host 无效，已改用 ${DEFAULT_HOST}`);
    dirty = true;
  }
  if (validate(DEFAULT_HOST, o.port) === null) config.port = o.port as number;
  else {
    warnings.push(`port 无效，已改用 ${DEFAULT_PORT}`);
    dirty = true;
  }
  if (typeof o.token === 'string' && /^[0-9a-f]{32,}$/i.test(o.token)) config.token = o.token;
  else dirty = true; // 缺令牌（比如手写的最小配置）：生成并写回，不算错误
  if (dirty) trySave(file, config);
  return warnings.length ? { config, warning: `配置文件有无效字段：${warnings.join('；')}。` } : { config };
}

function trySave(file: string, c: Config): void {
  try {
    saveConfig(file, c);
  } catch { /* 写不了（只读目录等）：本次运行仍可用，只是不持久 */ }
}

/** 先写临时文件再改名，避免写一半断电留下坏文件。 */
export function saveConfig(file: string, c: Config): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ host: c.host, port: c.port, token: c.token }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
