import { createHash, timingSafeEqual } from 'node:crypto';
import os from 'node:os';

// Origin 校验（纯函数，便于测试）。
// 网页版不使用访问 token：后端只监听 127.0.0.1，靠 Host + Origin 白名单挡住网页跨站请求和 DNS rebinding。
// 桌面版额外启用可选的 x-cosyee-token（StartOptions.authToken），防止本机其它程序直接调用接口。

/** 开发时前端（Vite）的端口：环境变量 COSYEE_WEB_PORT，默认 5273（避开 Vite 默认的 5173，免得与其它项目冲突）。 */
export function devPort(): number {
  const n = Number(process.env.COSYEE_WEB_PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 5273;
}

/** 本机所有网卡的 IPv4 地址（含 127.0.0.1）。 */
export function localIPv4s(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const out: string[] = [];
  for (const list of Object.values(ifaces)) {
    for (const i of list ?? []) if (i.family === 'IPv4') out.push(i.address);
  }
  return out;
}

/**
 * 允许出现在 Host / Origin 里的主机名（不含端口）。
 * 监听 127.0.0.1（默认）：只认回环；监听 0.0.0.0：再加本机任一网卡的 IPv4；监听具体 IP：再加这个 IP。
 * 仍然拒绝其它任何 Host（包括解析到本机的域名），防 DNS rebinding。
 */
export function allowedHostnames(bindHost: string = '127.0.0.1', ifaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string[] {
  const names = ['127.0.0.1', 'localhost'];
  if (bindHost === '0.0.0.0') names.push(...localIPv4s(ifaces));
  else if (bindHost !== '127.0.0.1' && bindHost !== 'localhost') names.push(bindHost);
  return [...new Set(names)];
}

/** 允许的 Origin：开发端口与后端自身端口，主机名见 allowedHostnames。 */
export function allowedOrigins(port: number, bindHost: string = '127.0.0.1'): string[] {
  const dev = devPort();
  const names = allowedHostnames(bindHost);
  return [dev, port].flatMap((p) => names.map((h) => `http://${h}:${p}`));
}

/** 没有 Origin（非浏览器请求，如 curl）放行；有则必须在白名单内。 */
export function originAllowed(origin: string | undefined, port: number, bindHost: string = '127.0.0.1'): boolean {
  if (origin === undefined || origin === '') return true;
  return allowedOrigins(port, bindHost).includes(origin);
}

/** Host 头必须是允许的主机名 + 本端口（或开发端口，Vite 代理可能保留前端端口的 Host）。 */
export function hostAllowedFor(host: string | undefined, port: number, bindHost: string = '127.0.0.1'): boolean {
  if (!host) return false;
  const dev = devPort();
  return allowedHostnames(bindHost).some((h) => host === `${h}:${port}` || host === `${h}:${dev}`);
}

/** 桌面版鉴权请求头名。 */
export const TOKEN_HEADER = 'x-cosyee-token';

/** 常量时间比较 token：先各自取 SHA-256 再 timingSafeEqual，长度不同也不会泄露长度信息。 */
export function tokenOk(provided: string | string[] | undefined, expected: string): boolean {
  if (typeof provided !== 'string' || provided === '') return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** 浏览器登录用的 cookie 名带上端口：不同端口的 Cosyee 实例（cookie 不区分端口）互不覆盖。 */
export function cookieName(port: number): string {
  return `cosyee_token_${port}`;
}

/** 从 Cookie 头里取指定名字的值。 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** 请求头 x-cosyee-token 或 cookie 任一匹配即通过（都是常量时间比较）。 */
export function requestAuthorized(
  headers: { [TOKEN_HEADER]?: string | string[]; cookie?: string },
  port: number,
  expected: string,
): boolean {
  if (tokenOk(headers[TOKEN_HEADER], expected)) return true;
  return tokenOk(readCookie(headers.cookie, cookieName(port)), expected);
}
