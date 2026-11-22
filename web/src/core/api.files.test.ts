// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

afterEach(() => vi.unstubAllGlobals());

describe('api 文件预览', () => {
  it('fileRawUrl：session / path / cwd 进查询串，路径里的 % # ? 先转义，行号作为 #L 附加', () => {
    const url = new URL(api.fileRawUrl({ session: 's 1', cwd: 'F:\\proj', path: 'a#b%c?.png', line: 3 }), 'http://x');
    expect(url.pathname).toBe('/api/files/raw');
    expect(url.searchParams.get('session')).toBe('s 1');
    expect(url.searchParams.get('cwd')).toBe('F:\\proj');
    expect(url.searchParams.get('path')).toBe('a%23b%25c%3F.png#L3');
  });

  it('filePreview：GET /api/files/preview；服务端错误信息作为异常抛出', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: '路径不在工作目录内' }) });
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.filePreview({ session: 's', path: '/etc/passwd' })).rejects.toThrow('路径不在工作目录内');
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/^\/api\/files\/preview\?/);
    expect(fetchMock.mock.calls[0]![1].method).toBe('GET');
  });

  it('revealFile / openTerminalAt：POST，body 带 session、cwd 和转义后的 path', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetchMock);
    await api.revealFile({ session: 's', cwd: 'F:\\proj', path: 'F:\\proj\\a#1.md' });
    await api.openTerminalAt({ session: 's', cwd: 'F:\\proj', path: 'F:\\proj' });
    const [u1, o1] = fetchMock.mock.calls[0]!;
    const [u2, o2] = fetchMock.mock.calls[1]!;
    expect(u1).toBe('/api/files/reveal');
    expect(u2).toBe('/api/files/terminal');
    expect(o1.method).toBe('POST');
    expect(JSON.parse(o1.body)).toEqual({ session: 's', cwd: 'F:\\proj', path: 'F:\\proj\\a%231.md' });
    expect(JSON.parse(o2.body).path).toBe('F:\\proj');
  });
});

describe('api 技能正文', () => {
  it('getSkillContent：GET /api/skills/content，name / cwd 进查询串', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ name: 'a:b', body: 'x', dir: '/d' }) });
    vi.stubGlobal('fetch', fetchMock);
    expect(await api.getSkillContent('a:b', 'F:\proj')).toMatchObject({ body: 'x' });
    const url = new URL(String(fetchMock.mock.calls[0]![0]), 'http://x');
    expect(url.pathname).toBe('/api/skills/content');
    expect(url.searchParams.get('name')).toBe('a:b');
    expect(url.searchParams.get('cwd')).toBe('F:\proj');
    expect(fetchMock.mock.calls[0]![1].method).toBe('GET');
  });
});
