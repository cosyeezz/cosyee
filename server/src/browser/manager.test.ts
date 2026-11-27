import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrowserManager, DEFAULT_PROFILE, normalizeProfileName } from './manager.js';
import type { BrowserInstall } from './install.js';

describe('内置浏览器身份', () => {
  let dir: string;
  const make = () => new BrowserManager({ install: { binPath: () => null } as unknown as BrowserInstall, dataDir: () => dir });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cz-browser-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('没有身份文件时只有默认身份', () => {
    const s = make().status();
    expect(s.installed).toBe(false);
    expect(s.profiles).toEqual([{ id: DEFAULT_PROFILE, name: '默认', running: false, window: false, url: null, title: null, viewers: 0 }]);
  });

  it('启动时清掉上次没收尾的登录窗口标记', () => {
    const m0 = make();
    const p = m0.createProfile('小号');
    for (const d of [path.join(dir, 'profile'), path.join(dir, 'profiles', p.id)]) {
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'CosyeeWindow'), '1\n');
    }
    make();
    expect(fs.existsSync(path.join(dir, 'profile', 'CosyeeWindow'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'profiles', p.id, 'CosyeeWindow'))).toBe(false);
  });

  it('新建 / 改名会存盘，重新加载后还在', () => {
    const m = make();
    const p = m.createProfile('  淘宝-小号 ');
    expect(p.name).toBe('淘宝-小号');
    expect(p.id).toMatch(/^[0-9a-f]{8}$/);
    m.renameProfile(p.id, '淘宝-大号');
    m.renameProfile(DEFAULT_PROFILE, '主号');
    expect(make().status().profiles.map((x) => [x.id, x.name])).toEqual([[DEFAULT_PROFILE, '主号'], [p.id, '淘宝-大号']]);
  });

  it('名称校验：空、过长、控制字符、重名', () => {
    const m = make();
    expect(() => normalizeProfileName('  ')).toThrow('不能为空');
    expect(() => normalizeProfileName('x'.repeat(33))).toThrow('32');
    expect(() => normalizeProfileName('a\nb')).toThrow('不可见');
    expect(() => normalizeProfileName(1)).toThrow('缺少名称');
    m.createProfile('A');
    expect(() => m.createProfile('a')).toThrow('同名');
    expect(() => m.renameProfile(DEFAULT_PROFILE, 'A')).toThrow('同名');
    m.renameProfile(DEFAULT_PROFILE, '默认'); // 改成自己现在的名字不算重名
  });

  it('删除身份连 profile 目录一起删；默认身份不能删', async () => {
    const m = make();
    const p = m.createProfile('临时');
    const pdir = path.join(dir, 'profiles', p.id);
    fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(path.join(pdir, 'Cookies'), 'x');
    await m.deleteProfile(p.id);
    expect(fs.existsSync(pdir)).toBe(false);
    expect(m.status().profiles.map((x) => x.id)).toEqual([DEFAULT_PROFILE]);
    await expect(m.deleteProfile(DEFAULT_PROFILE)).rejects.toThrow('默认身份不能删除');
    await expect(m.deleteProfile('deadbeef')).rejects.toThrow('没有这个浏览器身份');
  });

  it('不认识的身份 id：取会话时报 404；文件里不合法的条目被忽略', () => {
    fs.writeFileSync(path.join(dir, 'profiles.json'), JSON.stringify({ profiles: [{ id: '../x', name: 'bad' }, { id: 'abcdef01', name: 'ok' }] }));
    const m = make();
    expect(m.status().profiles.map((x) => x.id)).toEqual([DEFAULT_PROFILE, 'abcdef01']);
    expect(() => m.session('../x')).toThrow('没有这个浏览器身份');
    expect(m.session('abcdef01')).toBe(m.session('abcdef01'));
  });

  it('历史联想：不认识的身份报 404，还没用过的身份返回空', () => {
    const m = make();
    expect(() => m.history('git', '../x')).toThrow('没有这个浏览器身份');
    expect(m.history('git')).toEqual([]);
    expect(m.history('git', m.createProfile('小号').id)).toEqual([]);
  });
});
