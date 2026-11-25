import { describe, expect, it } from 'vitest';
import type { SkillMode } from '@cosyee/shared';
import { Manager } from './claude/manager.js';

// 官方 agent-browser skill 默认关掉，只留 cosyee:browser 作为浏览器入口；用户自己设过的以用户为准
describe('官方 agent-browser skill 默认关闭', () => {
  const make = (stored: Record<string, SkillMode> | null, disk: string[]) => {
    const m = new Manager((stored ? { skills: { get: () => stored } } : {}) as never) as any;
    m.scanDiskSkills = () => disk.map((name) => ({ name }));
    return (): Record<string, SkillMode> => m.skillModes('sid', '/w');
  };

  it('磁盘上有、用户没设过：关掉（含插件里的同名 skill）', () => {
    expect(make({ pdf: 'on' }, ['agent-browser', 'vercel:agent-browser', 'pdf'])()).toEqual({
      pdf: 'on',
      'agent-browser': 'off',
      'vercel:agent-browser': 'off',
    });
  });

  it('用户设过的不动', () => {
    expect(make({ 'agent-browser': 'on' }, ['agent-browser', 'x:agent-browser'])()).toEqual({ 'agent-browser': 'on' });
    expect(make({ 'x:agent-browser': 'on' }, ['agent-browser', 'x:agent-browser'])()).toEqual({ 'x:agent-browser': 'on', 'agent-browser': 'off' });
  });

  it('磁盘上没有不加；没有 skill 设置存储时不改', () => {
    expect(make({}, ['pdf'])()).toEqual({});
    expect(make(null, ['agent-browser'])()).toEqual({});
  });
});
