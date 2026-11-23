import { createHash, timingSafeEqual } from 'node:crypto';
import os from 'node:os';

// Origin 校验（纯函数，便于测试）。
// 网页版不使用访问 token：后端默认只监听 127.0.0.1，靠 Host + Origin 白名单挡住网页跨站请求和 DNS rebinding；
// Tailscale 模式（见 TAILSCALE_MODE）在此之上再按连接的本地 / 远端地址过滤，只放行本机和 tailnet。
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
 * Tailscale 模式（COSYEE_HOST=tailscale）：监听 0.0.0.0，但只接受两类连接——
 *   1. 本机回环（127.0.0.0/8、::1）；
 *   2. 打到本机 Tailscale 网卡地址、且来源也是 Tailscale 地址的连接。
 * 普通局域网 / 公网来的连接在 TCP 层直接断开。不使用令牌：能进 tailnet 的设备即视为可信。
 */
export const TAILSCALE_MODE = 'tailscale';

/** 去掉 IPv4 映射前缀（::ffff:100.1.2.3 -> 100.1.2.3）。 */
function plainAddr(a: string): string {
  return a.startsWith('::ffff:') ? a.slice(7) : a;
}

/** Tailscale 地址段：IPv4 100.64.0.0/10，IPv6 fd7a:115c:a1e0::/48。 */
export function isTailscaleAddr(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = plainAddr(addr).toLowerCase();
  const m = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(a);
  if (m) {
    const second = Number(m[1]);
    return second >= 64 && second <= 127;
  }
  return a.startsWith('fd7a:115c:a1e0:');
}

export function isLoopbackAddr(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = plainAddr(addr);
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

/**
 * 本机 Tailscale 网卡上的地址。网卡名：Windows「Tailscale」、Linux「tailscale0」、macOS「utunN」。
 * 只按地址段判断会误把运营商 CGNAT（同为 100.64/10）的网卡当成 Tailscale，所以同时看网卡名。
 */
export function tailscaleAddrs(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const out: string[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    if (!/tailscale/i.test(name) && !/^utun\d+$/.test(name)) continue;
    for (const i of list ?? []) if (isTailscaleAddr(i.address)) out.push(i.address);
  }
  return out;
}

/** TCP 连接是否放行（只在 Tailscale 模式下限制；其它模式由监听地址本身限制）。每次现查网卡，Tailscale 晚于本服务启动也没问题。 */
export function connectionAllowed(
  local: string | undefined,
  remote: string | undefined,
  bindHost: string,
  ifaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
): boolean {
  if (bindHost !== TAILSCALE_MODE) return true;
  if (isLoopbackAddr(local)) return isLoopbackAddr(remote);
  if (!local || !isTailscaleAddr(remote)) return false;
  return tailscaleAddrs(ifaces).includes(plainAddr(local));
}

/** 实际传给 server.listen 的地址。 */
export function listenAddress(bindHost: string): string {
  return bindHost === TAILSCALE_MODE ? '0.0.0.0' : bindHost;
}

/**
 * 允许出现在 Host / Origin 里的主机名（不含端口）。
 * 监听 127.0.0.1（默认）：只认回环；监听 0.0.0.0：再加本机任一网卡的 IPv4；监听具体 IP：再加这个 IP；
 * Tailscale 模式：再加本机 Tailscale 地址和本机名（MagicDNS 短名）；*.ts.net 全名见 hostnameAllowed。
 * 仍然拒绝其它任何 Host（包括解析到本机的域名），防 DNS rebinding。
 */
export function allowedHostnames(bindHost: string = '127.0.0.1', ifaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string[] {
  const names = ['127.0.0.1', 'localhost'];
  if (bindHost === TAILSCALE_MODE) {
    const hn = os.hostname().toLowerCase();
    // macOS 的 os.hostname() 带 .local 后缀，但 Tailscale MagicDNS 用不带后缀的短名；两个都要认
    names.push(...tailscaleAddrs(ifaces).map((a) => (a.includes(':') ? `[${a}]` : a)), hn, hn.replace(/\.local$/, ''));
  } else if (bindHost === '0.0.0.0') names.push(...localIPv4s(ifaces));
  else if (bindHost !== '127.0.0.1' && bindHost !== 'localhost') names.push(bindHost);
  return [...new Set(names)];
}

/** MagicDNS 全名（机器名.tailnet 名.ts.net）。攻击者控制不了 ts.net 下的域名，DNS rebinding 无从下手。 */
function isTsNetName(h: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(h);
}

function hostnameAllowed(h: string, bindHost: string): boolean {
  const name = h.toLowerCase();
  if (bindHost === TAILSCALE_MODE && isTsNetName(name)) return true;
  return allowedHostnames(bindHost).includes(name);
}

/** 拆分「主机:端口」（支持 [IPv6]:端口）。 */
function splitHostPort(s: string): { name: string; port: string } {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(s);
  return m ? { name: m[1]!, port: m[2] ?? '' } : { name: '', port: '' };
}

/** 允许的 Origin：开发端口与后端自身端口，主机名见 allowedHostnames。 */
export function allowedOrigins(port: number, bindHost: string = '127.0.0.1'): string[] {
  const dev = devPort();
  const names = allowedHostnames(bindHost);
  return [dev, port].flatMap((p) => names.map((h) => `http://${h}:${p}`));
}

/**
 * 没有 Origin（非浏览器请求，如 curl）放行；有则必须在白名单内。
 * Tailscale 模式另外认 http://*.ts.net:端口，以及 `tailscale serve` 提供的 https://*.ts.net（默认端口）。
 */
export function originAllowed(origin: string | undefined, port: number, bindHost: string = '127.0.0.1'): boolean {
  if (origin === undefined || origin === '') return true;
  if (allowedOrigins(port, bindHost).includes(origin)) return true;
  if (bindHost !== TAILSCALE_MODE) return false;
  const m = /^(https?):\/\/(.+)$/.exec(origin);
  if (!m) return false;
  const { name, port: p } = splitHostPort(m[2]!);
  if (!isTsNetName(name.toLowerCase())) return false;
  return m[1] === 'https' ? p === '' : p === String(port) || p === String(devPort());
}

/** Host 头必须是允许的主机名 + 本端口（或开发端口，Vite 代理可能保留前端端口的 Host）。 */
export function hostAllowedFor(host: string | undefined, port: number, bindHost: string = '127.0.0.1'): boolean {
  if (!host) return false;
  const { name, port: p } = splitHostPort(host);
  if (!name) return false;
  // tailscale serve 反代过来时 Host 是 xxx.ts.net（无端口）
  if (p === '') return bindHost === TAILSCALE_MODE && isTsNetName(name.toLowerCase());
  if (p !== String(port) && p !== String(devPort())) return false;
  return hostnameAllowed(name, bindHost);
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
