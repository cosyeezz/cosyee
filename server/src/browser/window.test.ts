import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHROME_ARGS } from './skill.js';
import { findChrome, freePort, restorableUrl, windowArgs } from './window.js';

describe('登录窗口', () => {
  it('按平台找 Chrome：先系统目录，再用户目录；都没有返回 null', () => {
    const has = (want: string) => (p: string) => p === want;
    const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    expect(findChrome('darwin', { HOME: '/Users/a' }, has(mac))).toBe(mac);
    expect(findChrome('darwin', { HOME: '/Users/a' }, has('/Users/a/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'))).toBe('/Users/a/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    const win = path.win32.join('C:\\Users\\a\\AppData\\Local', 'Google', 'Chrome', 'Application', 'chrome.exe');
    expect(findChrome('win32', { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, has(win))).toBe(win);
    expect(findChrome('linux', {}, has('/usr/bin/chromium'))).toBe('/usr/bin/chromium');
    expect(findChrome('darwin', {}, () => false)).toBeNull();
  });

  it('启动参数：同一个 profile、和 agent-browser 一致的钥匙串设置、不带自动化和无界面参数；只打开 http(s) 地址', () => {
    const a = windowArgs('/d/profile', 'https://accounts.google.com/', 9555);
    expect(a).toContain('--user-data-dir=/d/profile');
    // 端口 0 会让 navigator.webdriver 变成 true
    expect(a).toContain('--remote-debugging-port=9555');
    expect(a).toContain('--use-mock-keychain');
    expect(a).toContain('--password-store=basic');
    expect(a).toContain(CHROME_ARGS);
    expect(a.at(-1)).toBe('https://accounts.google.com/');
    expect(a.some((x) => /headless|enable-automation/.test(x))).toBe(false);
    expect(windowArgs('/d', null, 9555).at(-1)).toBe('about:blank');
    expect(windowArgs('/d', 'file:///etc/passwd', 9555).at(-1)).toBe('about:blank');
    expect(windowArgs('/d', 'https://accounts.google.com/v3/signin/identifier?continue=https://accounts.google.com/signin/chrome/sync/finish', 9555).at(-1)).toBe('about:blank');
  });

  it('切回内置时跳过「登录 Chrome」同步页和拒绝页，普通页面照常', () => {
    expect(restorableUrl('https://mail.google.com/mail/u/0/#inbox')).toBe(true);
    expect(restorableUrl('https://accounts.google.com/v3/signin/identifier?continue=https://myaccount.google.com/&flowName=GlifWebSignIn')).toBe(true);
    expect(restorableUrl('https://accounts.google.com/v3/signin/identifier?continue=https://accounts.google.com/signin/chrome/sync/finish?est%3DX&flow=history_opt_in&flowName=GlifDesktopChromeSync')).toBe(false);
    expect(restorableUrl('https://accounts.google.com/v3/signin/rejected?continue=https%3A%2F%2Faccounts.google.com%2Fsignin%2Fchrome%2Fsync%2Ffinish')).toBe(false);
    expect(restorableUrl('https://accounts.google.com/v3/signin/rejected?continue=https%3A%2F%2Fmyaccount.google.com%2F')).toBe(false);
    expect(restorableUrl('chrome://newtab/')).toBe(false);
    expect(restorableUrl('about:blank')).toBe(false);
  });

  it('freePort 给出一个可用的非 0 端口', async () => {
    const p = await freePort();
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(65536);
  });
});
