import { describe, expect, it } from 'vitest';
import { hostAllowed } from './http.js';
import { TOKEN_HEADER, allowedHostnames, allowedOrigins, cookieName, originAllowed, readCookie, requestAuthorized, tokenOk } from './security.js';

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
