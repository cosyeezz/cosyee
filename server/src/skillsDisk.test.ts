import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listDiskSkills, readSkillContent, removeDiskSkill } from './skillsDisk.js';

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

describe('readSkillContent', () => {
  const write = (root: string, name: string, text: string): string => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), text);
    return dir;
  };

  it('去掉 frontmatter，取 description（单行带引号 / 多行块）；项目级优先于用户级', () => {
    const cfg = path.join(tmp, 'cfg');
    const proj = path.join(tmp, 'proj');
    write(path.join(cfg, 'skills'), 'one', '---\nname: one\ndescription: "单行描述"\n---\n\n# 标题\n正文 $ARGUMENTS\n');
    write(path.join(cfg, 'skills'), 'multi', '---\nname: multi\ndescription: >\n  第一行\n  第二行\nallowed-tools: Read\n---\n正文');
    write(path.join(cfg, 'skills'), 'plain', '没有 frontmatter');
    write(path.join(cfg, 'skills'), 'dup', '---\ndescription: user\n---\nU');
    const pdir = write(path.join(proj, '.claude', 'skills'), 'dup', '---\ndescription: project\n---\nP');
    expect(readSkillContent('one', cfg, null)).toMatchObject({ name: 'one', description: '单行描述', body: '# 标题\n正文 $ARGUMENTS\n', dir: path.join(cfg, 'skills', 'one') });
    expect(readSkillContent('multi', cfg, null)).toMatchObject({ description: '第一行 第二行', body: '正文' });
    const plain = readSkillContent('plain', cfg, null)!;
    expect(plain.body).toBe('没有 frontmatter');
    expect(plain.description).toBeUndefined();
    expect(readSkillContent('dup', cfg, proj)).toMatchObject({ description: 'project', body: 'P', dir: pdir });
  });

  it('插件 skill 按 plugin:name 找；不在扫描结果里的名字（含穿越写法）一律 null', () => {
    const cfg = path.join(tmp, 'cfg');
    const plug = path.join(tmp, 'plug');
    write(path.join(plug, 'skills'), 'pdf', '---\ndescription: pdf\n---\nPDF');
    fs.mkdirSync(path.join(cfg, 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(cfg, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'anthropic-skills@official': [{ installPath: plug }] } }));
    expect(readSkillContent('anthropic-skills:pdf', cfg, null)?.body).toBe('PDF');
    expect(readSkillContent('pdf', cfg, null)).toBeNull();
    expect(readSkillContent('../../etc/passwd', cfg, null)).toBeNull();
    expect(readSkillContent('nope', cfg, null)).toBeNull();
  });
});
