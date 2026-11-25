import { describe, expect, it } from 'vitest';
import { fromLocal } from './http.js';
import { magicDnsShortName, servesPort } from './tailscaleHttps.js';

describe('magicDnsShortName', () => {
  it('取 MagicDNS 全名的第一段', () => {
    expect(magicDnsShortName('my-server.tail1234.ts.net.')).toBe('my-server');
    expect(magicDnsShortName('PC.tail1.ts.net')).toBe('pc');
    expect(magicDnsShortName('')).toBe('');
  });
});

describe('servesPort', () => {
  const dns = 'pc.tail1.ts.net';
  const cfg = (proxy: string) => ({ TCP: { '443': { HTTPS: true } }, Web: { [`${dns}:443`]: { Handlers: { '/': { Proxy: proxy } } } } });
  it('认得 tailscale serve 写入的几种反代写法', () => {
    expect(servesPort(cfg('http://127.0.0.1:7878'), dns, 7878)).toBe(true);
    expect(servesPort(cfg('http://localhost:7878'), dns, 7878)).toBe(true);
    expect(servesPort(cfg('127.0.0.1:7878'), dns, 7878)).toBe(true);
  });
  it('别的端口、别的路径、没有配置都不算', () => {
    expect(servesPort(cfg('http://127.0.0.1:17878'), dns, 7878)).toBe(false);
    expect(servesPort(cfg('http://127.0.0.1:8080'), dns, 7878)).toBe(false);
    expect(servesPort({}, dns, 7878)).toBe(false);
  });
});

describe('fromLocal：tailscale serve 反代来的请求按远程处理', () => {
  const req = (remoteAddress: string, headers: Record<string, string> = {}) =>
    ({ socket: { remoteAddress }, headers }) as unknown as import('node:http').IncomingMessage;
  it('本机直连算本机，tailnet 直连算远程', () => {
    expect(fromLocal(req('127.0.0.1'))).toBe(true);
    expect(fromLocal(req('::ffff:127.0.0.1'))).toBe(true);
    expect(fromLocal(req('100.106.9.14'))).toBe(false);
  });
  it('带 Tailscale-User-Login 或非回环 X-Forwarded-For 的回环连接算远程', () => {
    expect(fromLocal(req('127.0.0.1', { 'tailscale-user-login': 'a@b.c', 'x-forwarded-for': '100.1.2.3' }))).toBe(false);
    expect(fromLocal(req('127.0.0.1', { 'x-forwarded-for': '100.1.2.3' }))).toBe(false);
    expect(fromLocal(req('127.0.0.1', { 'x-forwarded-for': '127.0.0.1' }))).toBe(true);
  });
});
