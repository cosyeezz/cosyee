import { describe, expect, it, vi } from 'vitest';
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
      'cosyee:browser': 'on',
      'agent-browser': 'off',
      'vercel:agent-browser': 'off',
    });
  });

  it('用户设过的不动', () => {
    expect(make({ 'agent-browser': 'on' }, ['agent-browser', 'x:agent-browser'])()).toEqual({ 'agent-browser': 'on', 'cosyee:browser': 'on' });
    expect(make({ 'x:agent-browser': 'on' }, ['agent-browser', 'x:agent-browser'])()).toEqual({ 'x:agent-browser': 'on', 'cosyee:browser': 'on', 'agent-browser': 'off' });
  });

  it('磁盘上没有不加；没有 skill 设置存储时不改', () => {
    expect(make({}, ['pdf'])()).toEqual({ 'cosyee:browser': 'on' });
    expect(make(null, ['agent-browser'])()).toEqual({ 'cosyee:browser': 'on' });
  });

  it('内置的 cosyee:browser 始终开启：存下的「手动」不生效，也改不了', async () => {
    const stored: Record<string, SkillMode> = { 'cosyee:browser': 'user-invocable-only' };
    expect(make(stored, [])()).toEqual({ 'cosyee:browser': 'on' });
    const setMany = vi.fn();
    const m = new Manager({ skills: { get: () => ({}), setMany } } as never);
    await m.setSkillModes({ 'cosyee:browser': 'off' });
    expect(setMany).not.toHaveBeenCalled();
    await m.setSkillModes({ 'cosyee:browser': 'off', pdf: 'off' });
    expect(setMany).toHaveBeenCalledWith({ pdf: 'off' });
  });
});
