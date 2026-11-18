import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listDiskSkills, removeDiskSkill } from './skillsDisk.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cz-skills-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function mkSkill(root: string, name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---
name: ${name}
---
hi`);
  return dir;
}

describe('skillsDisk', () => {
  it('列出用户级、项目级、插件 skill；隐藏目录与没有 SKILL.md 的跳过；项目级优先于同名用户级', () => {
    const cfg = path.join(tmp, 'cfg');
    const proj = path.join(tmp, 'proj');
    mkSkill(path.join(cfg, 'skills'), 'alpha');
    mkSkill(path.join(cfg, 'skills'), 'dup');
    mkSkill(path.join(cfg, 'skills'), '.trash');
    fs.mkdirSync(path.join(cfg, 'skills', 'empty'), { recursive: true });
    mkSkill(path.join(proj, '.claude', 'skills'), 'dup');
    const plug = path.join(tmp, 'plug');
    mkSkill(path.join(plug, 'skills'), 'pdf');
    fs.mkdirSync(path.join(cfg, 'plugins'), { recursive: true });
    fs.writeFileSync(
      path.join(cfg, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { 'anthropic-skills@official': [{ installPath: plug }, { installPath: plug }] } }),
    );

    const list = listDiskSkills(cfg, proj);
    expect(list.map((s) => s.name).sort()).toEqual(['alpha', 'anthropic-skills:pdf', 'dup']);
    expect(list.find((s) => s.name === 'dup')).toMatchObject({ source: 'projectSettings', removable: true });
    expect(list.find((s) => s.name === 'alpha')).toMatchObject({ source: 'userSettings', removable: true });
    expect(list.find((s) => s.name === 'anthropic-skills:pdf')).toMatchObject({ source: 'plugin', removable: false });
  });

  it('移除：目录移到备份目录，原位置消失；插件 / 不存在 / 带路径的名字都拒绝', () => {
    const cfg = path.join(tmp, 'cfg');
    const backup = path.join(tmp, 'bak');
    const dir = mkSkill(path.join(cfg, 'skills'), 'alpha');
    fs.writeFileSync(path.join(dir, 'extra.txt'), 'x');

    const dest = removeDiskSkill('alpha', cfg, null, backup);
    expect(fs.existsSync(dir)).toBe(false);
    expect(path.dirname(dest)).toBe(backup);
    expect(path.basename(dest)).toMatch(/-user-alpha$/);
    expect(fs.readFileSync(path.join(dest, 'extra.txt'), 'utf8')).toBe('x');

    expect(() => removeDiskSkill('alpha', cfg, null, backup)).toThrow('找不到');
    expect(() => removeDiskSkill('../escape', cfg, null, backup)).toThrow('找不到');
  });

  it('移除插件里的 skill 被拒绝', () => {
    const cfg = path.join(tmp, 'cfg');
    const plug = path.join(tmp, 'plug');
    mkSkill(path.join(plug, 'skills'), 'pdf');
    fs.mkdirSync(path.join(cfg, 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(cfg, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'p@m': [{ installPath: plug }] } }));
    expect(() => removeDiskSkill('p:pdf', cfg, null, path.join(tmp, 'bak'))).toThrow('不能单独移除');
    expect(fs.existsSync(path.join(plug, 'skills', 'pdf'))).toBe(true);
  });
});
