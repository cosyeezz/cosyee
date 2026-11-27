import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UPLOAD_TTL, safeName, sweepUploads, uploadTarget, uploadsDir } from './uploads.js';

describe('safeName', () => {
  it('保留普通名字与中文', () => {
    expect(safeName('报错日志.txt')).toBe('报错日志.txt');
    expect(safeName('IMG_1234.HEIC')).toBe('IMG_1234.HEIC');
    expect(safeName('a b.tar.gz')).toBe('a b.tar.gz');
  });
  it('去掉路径、控制字符与 Windows 保留字符', () => {
    expect(safeName('../../etc/passwd')).toBe('passwd');
    expect(safeName('C:\\Users\\x\\a.txt')).toBe('a.txt');
    expect(safeName('a<b>:"c|?*.txt')).toBe('abc.txt');
    expect(safeName('a\u0000\u001fb.txt')).toBe('ab.txt');
  });
  it('首尾的点和空格、保留设备名', () => {
    expect(safeName('  .hidden  ')).toBe('hidden');
    expect(safeName('name.  ')).toBe('name');
    expect(safeName('CON.txt')).toBe('_CON.txt');
    expect(safeName('nul')).toBe('_nul');
    expect(safeName('console.txt')).toBe('console.txt');
  });
  it('清空了就叫 file', () => {
    expect(safeName('')).toBe('file');
    expect(safeName('...')).toBe('file');
    expect(safeName('<>|')).toBe('file');
  });
  it('超长名字按字节截断，保留扩展名，不拆开汉字', () => {
    const s = safeName(`${'长'.repeat(200)}.png`);
    expect(Buffer.byteLength(s)).toBeLessThanOrEqual(180);
    expect(s.endsWith('.png')).toBe(true);
    expect(s).not.toContain('\uFFFD');
  });
  it('结果是幂等的', () => {
    for (const raw of ['a<b>.txt', 'CON.txt', '  x  ', `${'a'.repeat(300)}.md`]) expect(safeName(safeName(raw))).toBe(safeName(raw));
  });
});

describe('sweepUploads / uploadTarget', () => {
  let tmp: string;
  let prev: string | undefined;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-uploads-'));
    prev = process.env.COSYEE_HOME;
    process.env.COSYEE_HOME = tmp;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.COSYEE_HOME;
    else process.env.COSYEE_HOME = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const mk = (name: string, file = 'a.txt') => {
    fs.mkdirSync(path.join(uploadsDir(), name), { recursive: true });
    fs.writeFileSync(path.join(uploadsDir(), name, file), 'x');
  };

  it('没有 uploads 目录时什么也不做', async () => {
    expect(await sweepUploads()).toBe(0);
  });
  it('只删过期且格式合规的子目录', async () => {
    const now = Date.now();
    const old = `${now - UPLOAD_TTL - 1000}-aaaaaaaaaaaa`;
    const fresh = `${now - 1000}-bbbbbbbbbbbb`;
    mk(old);
    mk(fresh);
    mk('1-notvalidname');
    fs.writeFileSync(path.join(uploadsDir(), `${now - UPLOAD_TTL - 1000}-cccccccccccc`), 'a file, not a dir');
    expect(await sweepUploads(now)).toBe(1);
    expect(fs.readdirSync(uploadsDir()).sort()).toEqual([`${now - UPLOAD_TTL - 1000}-cccccccccccc`, fresh, '1-notvalidname'].sort());
  });
  it('uploadTarget 找回文件，清理后 404', async () => {
    const dir = `${Date.now()}-dddddddddddd`;
    mk(dir, 'b.txt');
    const t = await uploadTarget(dir, 'b.txt');
    expect(t).toMatchObject({ file: path.join(uploadsDir(), dir, 'b.txt'), size: 1, image: null });
    await sweepUploads(Date.now() + UPLOAD_TTL + 1000);
    await expect(uploadTarget(dir, 'b.txt')).rejects.toMatchObject({ status: 404 });
  });
});
