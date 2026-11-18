import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { hostAllowed } from './http.js';
import {
  TAILSCALE_MODE,
  TOKEN_HEADER,
  allowedHostnames,
  allowedOrigins,
  connectionAllowed,
  cookieName,
  isTailscaleAddr,
  listenAddress,
  originAllowed,
  readCookie,
  requestAuthorized,
  tailscaleAddrs,
  tokenOk,
} from './security.js';

describe('Origin / Host', () => {
  it('白名单', () => {
    expect(allowedOrigins(7878)).toEqual([
      'http://127.0.0.1:5273',
      'http://localhost:5273',
      'http://127.0.0.1:7878',
      'http://localhost:7878',
    ]);
  });
  it('无 Origin 放行，白名单内放行，其余拒绝', () => {
    expect(originAllowed(undefined, 7878)).toBe(true);
    expect(originAllowed('http://127.0.0.1:5273', 7878)).toBe(true);
    expect(originAllowed('http://localhost:7878', 7878)).toBe(true);
    expect(originAllowed('http://evil.com', 7878)).toBe(false);
    expect(originAllowed('http://127.0.0.1:9999', 7878)).toBe(false);
    expect(originAllowed('https://127.0.0.1:7878', 7878)).toBe(false);
    expect(originAllowed('null', 7878)).toBe(false);
  });
  it('Host 头只允许回环地址（防 DNS rebinding）', () => {
    expect(hostAllowed('127.0.0.1:7878', 7878)).toBe(true);
    expect(hostAllowed('localhost:7878', 7878)).toBe(true);
    expect(hostAllowed('evil.com:7878', 7878)).toBe(false);
    expect(hostAllowed(undefined, 7878)).toBe(false);
  });
});

describe('桌面版 token', () => {
  it('头名固定', () => expect(TOKEN_HEADER).toBe('x-cosyee-token'));
  it('相同通过；缺失 / 为空 / 不同 / 长度不同 / 数组 一律拒绝', () => {
    expect(tokenOk('abc123', 'abc123')).toBe(true);
    expect(tokenOk(undefined, 'abc123')).toBe(false);
    expect(tokenOk('', 'abc123')).toBe(false);
    expect(tokenOk('abc124', 'abc123')).toBe(false);
    expect(tokenOk('abc1234', 'abc123')).toBe(false);
    expect(tokenOk(['abc123'], 'abc123')).toBe(false);
  });
});

const FAKE_IFACES = {
  lo: [{ address: '127.0.0.1', family: 'IPv4' }],
  eth0: [
    { address: '192.168.1.23', family: 'IPv4' },
    { address: 'fe80::1', family: 'IPv6' },
  ],
} as unknown as NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>;

describe('监听非本机地址时的 Host / Origin 白名单', () => {
  it('默认只认回环', () => {
    expect(allowedHostnames()).toEqual(['127.0.0.1', 'localhost']);
    expect(hostAllowed('192.168.1.23:7878', 7878)).toBe(false);
  });
  it('0.0.0.0：加上本机各网卡 IPv4（不含 IPv6）', () => {
    expect(allowedHostnames('0.0.0.0', FAKE_IFACES)).toEqual(['127.0.0.1', 'localhost', '192.168.1.23']);
  });
  it('具体 IP：加上这个 IP', () => {
    expect(allowedHostnames('192.168.1.23')).toEqual(['127.0.0.1', 'localhost', '192.168.1.23']);
  });
  it('0.0.0.0 时本机网卡 IP + 端口通过，其它 Host 拒绝', () => {
    const ip = allowedHostnames('0.0.0.0').find((h) => h !== 'localhost')!;
    expect(hostAllowed(`${ip}:7878`, 7878, '0.0.0.0')).toBe(true);
    expect(hostAllowed('127.0.0.1:7878', 7878, '0.0.0.0')).toBe(true);
    expect(hostAllowed(`${ip}:9999`, 7878, '0.0.0.0')).toBe(false);
    expect(hostAllowed('evil.com:7878', 7878, '0.0.0.0')).toBe(false);
    expect(hostAllowed('10.255.255.254:7878', 7878, '0.0.0.0')).toBe(false);
    expect(originAllowed(`http://${ip}:7878`, 7878, '0.0.0.0')).toBe(true);
    expect(originAllowed('http://evil.com:7878', 7878, '0.0.0.0')).toBe(false);
  });
  it('监听具体 IP：该 IP + 端口通过，别的网卡 IP 不通过', () => {
    expect(hostAllowed('192.168.1.23:7878', 7878, '192.168.1.23')).toBe(true);
    expect(hostAllowed('192.168.1.24:7878', 7878, '192.168.1.23')).toBe(false);
    expect(originAllowed('http://192.168.1.23:7878', 7878, '192.168.1.23')).toBe(true);
  });
});

const TS_IFACES = {
  lo: [{ address: '127.0.0.1', family: 'IPv4' }],
  eth0: [{ address: '192.168.1.23', family: 'IPv4' }],
  // 运营商 CGNAT 地址：地址段和 Tailscale 相同，但不是 Tailscale 网卡
  wan0: [{ address: '100.70.0.9', family: 'IPv4' }],
  Tailscale: [
    { address: '100.106.9.14', family: 'IPv4' },
    { address: 'fd7a:115c:a1e0::1234', family: 'IPv6' },
  ],
} as unknown as NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>;

describe('Tailscale 模式', () => {
  it('地址段判断', () => {
    expect(isTailscaleAddr('100.64.0.1')).toBe(true);
    expect(isTailscaleAddr('100.127.255.255')).toBe(true);
    expect(isTailscaleAddr('::ffff:100.106.9.14')).toBe(true);
    expect(isTailscaleAddr('fd7a:115c:a1e0::1')).toBe(true);
    expect(isTailscaleAddr('100.63.0.1')).toBe(false);
    expect(isTailscaleAddr('100.128.0.1')).toBe(false);
    expect(isTailscaleAddr('192.168.1.2')).toBe(false);
    expect(isTailscaleAddr(undefined)).toBe(false);
  });
  it('只认 Tailscale 网卡上的地址（排除运营商 CGNAT 网卡）', () => {
    expect(tailscaleAddrs(TS_IFACES)).toEqual(['100.106.9.14', 'fd7a:115c:a1e0::1234']);
  });
  it('连接过滤：本机回环、tailnet -> Tailscale 地址放行，其它断开', () => {
    const ok = (l: string, r: string) => connectionAllowed(l, r, TAILSCALE_MODE, TS_IFACES);
    expect(ok('127.0.0.1', '127.0.0.1')).toBe(true);
    expect(ok('::ffff:127.0.0.1', '::ffff:127.0.0.1')).toBe(true);
    expect(ok('::ffff:100.106.9.14', '::ffff:100.101.2.3')).toBe(true);
    expect(ok('100.106.9.14', '192.168.1.50')).toBe(false); // 来源不是 tailnet
    expect(ok('192.168.1.23', '192.168.1.50')).toBe(false); // 局域网
    expect(ok('192.168.1.23', '100.101.2.3')).toBe(false); // 打到局域网网卡
    expect(ok('100.70.0.9', '100.70.0.1')).toBe(false); // 运营商 CGNAT 网卡
    expect(ok('127.0.0.1', '100.101.2.3')).toBe(false);
    // 非 Tailscale 模式不在 TCP 层过滤
    expect(connectionAllowed('192.168.1.23', '192.168.1.50', '0.0.0.0', TS_IFACES)).toBe(true);
  });
  it('监听 0.0.0.0', () => {
    expect(listenAddress(TAILSCALE_MODE)).toBe('0.0.0.0');
    expect(listenAddress('127.0.0.1')).toBe('127.0.0.1');
  });
  it('Host：Tailscale 地址、本机名、*.ts.net 通过；局域网 IP 和其它域名拒绝', () => {
    const ip = tailscaleAddrs().find((a) => !a.includes(':'));
    if (ip) expect(hostAllowed(`${ip}:7878`, 7878, TAILSCALE_MODE)).toBe(true);
    expect(hostAllowed(`${os.hostname()}:7878`, 7878, TAILSCALE_MODE)).toBe(true);
    expect(hostAllowed('127.0.0.1:7878', 7878, TAILSCALE_MODE)).toBe(true);
    expect(hostAllowed('pc.tail1234.ts.net:7878', 7878, TAILSCALE_MODE)).toBe(true);
    expect(hostAllowed('pc.tail1234.ts.net', 7878, TAILSCALE_MODE)).toBe(true); // tailscale serve 反代
    expect(hostAllowed('pc.tail1234.ts.net:9999', 7878, TAILSCALE_MODE)).toBe(false);
    expect(hostAllowed('evil.com:7878', 7878, TAILSCALE_MODE)).toBe(false);
    expect(hostAllowed('ts.net.evil.com:7878', 7878, TAILSCALE_MODE)).toBe(false);
    expect(hostAllowed('192.168.1.23:7878', 7878, TAILSCALE_MODE)).toBe(false);
    // 非 Tailscale 模式不认 ts.net
    expect(hostAllowed('pc.tail1234.ts.net:7878', 7878, '0.0.0.0')).toBe(false);
    expect(hostAllowed('pc.tail1234.ts.net', 7878)).toBe(false);
  });
  it('Origin：http://*.ts.net:端口 与 https://*.ts.net（tailscale serve）', () => {
    expect(originAllowed('http://pc.tail1234.ts.net:7878', 7878, TAILSCALE_MODE)).toBe(true);
    expect(originAllowed('https://pc.tail1234.ts.net', 7878, TAILSCALE_MODE)).toBe(true);
    expect(originAllowed('https://pc.tail1234.ts.net:8443', 7878, TAILSCALE_MODE)).toBe(false);
    expect(originAllowed('http://pc.tail1234.ts.net:9999', 7878, TAILSCALE_MODE)).toBe(false);
    expect(originAllowed('http://evil.com:7878', 7878, TAILSCALE_MODE)).toBe(false);
    expect(originAllowed('https://pc.tail1234.ts.net', 7878, '0.0.0.0')).toBe(false);
  });
});

describe('cookie 令牌', () => {
  it('cookie 名带端口', () => expect(cookieName(7878)).toBe('cosyee_token_7878'));
  it('readCookie 取指定名字，找不到返回 undefined', () => {
    expect(readCookie('a=1; cosyee_token_7878=abc; b=2', 'cosyee_token_7878')).toBe('abc');
    expect(readCookie('a=1', 'cosyee_token_7878')).toBeUndefined();
    expect(readCookie(undefined, 'x')).toBeUndefined();
    expect(readCookie('cosyee_token_7878', 'cosyee_token_7878')).toBeUndefined();
  });
  it('requestAuthorized：头或 cookie 任一匹配即可；端口不同的 cookie 无效', () => {
    expect(requestAuthorized({ 'x-cosyee-token': 'T' }, 7878, 'T')).toBe(true);
    expect(requestAuthorized({ cookie: 'cosyee_token_7878=T' }, 7878, 'T')).toBe(true);
    expect(requestAuthorized({ cookie: 'cosyee_token_7878=X' }, 7878, 'T')).toBe(false);
    expect(requestAuthorized({ cookie: 'cosyee_token_9999=T' }, 7878, 'T')).toBe(false);
    expect(requestAuthorized({}, 7878, 'T')).toBe(false);
  });
});
