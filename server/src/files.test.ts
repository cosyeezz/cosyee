// 文件预览：路径授权（cwd 之内 / 之外 / .. / 符号链接 / junction / 设备名）、读取与解码、类型识别，
// 以及 /api/files/* 接口（含注入的 spawner：reveal / terminal 不会真的启动进程）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeFileText, hasReservedName, isInside, lexicalTarget, previewFile, resolveTarget, sniffMedia, TEXT_LIMIT } from './files.js';
import { encodeCwd } from './paths.js';
import { openTerminal, revealFileCommand, revealPath, terminalCommands } from './reveal.js';
import { type RunningServer, startServer } from './server.js';

const isWin = process.platform === 'win32';
// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>';

let tmp: string;
let cwd: string;
let outside: string;
let prevClaude: string | undefined;
let prevHome: string | undefined;
let linkSkipped = false;
let junctionSkipped = false;

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-files-')));
  prevClaude = process.env.CLAUDE_CONFIG_DIR;
  prevHome = process.env.COSYEE_HOME;
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
  process.env.COSYEE_HOME = path.join(tmp, 'home');
  cwd = path.join(tmp, 'my project'); // 带空格
  outside = path.join(tmp, 'outside');
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.mkdirSync(path.join(cwd, '文档 目录'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'a.ts'), 'export const a = 1;\nexport const b = 2;\n');
  fs.writeFileSync(path.join(cwd, 'README.md'), '# 标题\n\n正文\n');
  fs.writeFileSync(path.join(cwd, 'notes.txt'), 'plain\n');
  fs.writeFileSync(path.join(cwd, '文档 目录', '中文 文件.md'), '# 中文\n');
  fs.writeFileSync(path.join(cwd, 'gbk.txt'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a])); // GBK「中文」
  fs.writeFileSync(path.join(cwd, 'bom.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('bom 文本')]));
  fs.writeFileSync(path.join(cwd, 'pic.png'), PNG);
  fs.writeFileSync(path.join(cwd, 'fake.png'), 'not really a png'); // 扩展名骗人
  fs.writeFileSync(path.join(cwd, 'vec.svg'), SVG);
  fs.writeFileSync(path.join(cwd, 'doc.pdf'), '%PDF-1.4\n%%EOF\n');
  fs.writeFileSync(path.join(cwd, 'bin.dat'), Buffer.from([1, 2, 0, 3, 4]));
  fs.writeFileSync(path.join(cwd, 'a#b.md'), '# hash\n');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET');
  // 指向 cwd 之外的符号链接 / junction
  try {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(cwd, 'link.txt'), 'file');
  } catch {
    linkSkipped = true; // Windows 没有开发者模式 / 管理员权限时建不了文件符号链接
  }
  try {
    fs.symlinkSync(outside, path.join(cwd, 'jump'), 'junction');
  } catch {
    junctionSkipped = true;
  }
});

afterAll(() => {
  if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevClaude;
  if (prevHome === undefined) delete process.env.COSYEE_HOME;
  else process.env.COSYEE_HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const status = async (p: Promise<unknown>): Promise<number> => {
  try {
    await p;
    return 200;
  } catch (e) {
    return (e as { status?: number }).status ?? 500;
  }
};

describe('路径授权', () => {
  it('cwd 之内：相对路径 / 绝对路径 / file:// 都可以', async () => {
    const abs = path.join(cwd, 'src', 'a.ts');
    expect((await previewFile(cwd, 'src/a.ts')).path).toBe(abs);
    expect((await previewFile(cwd, abs)).path).toBe(abs);
    expect((await previewFile(cwd, `file:///${abs.replace(/\\/g, '/').replace(/^\//, '')}`)).path).toBe(abs);
  });

  it('行号后缀 / #L 锚点带出 line，路径不含后缀', async () => {
    expect(await previewFile(cwd, 'src/a.ts:2')).toMatchObject({ path: path.join(cwd, 'src', 'a.ts'), line: 2 });
    expect(await previewFile(cwd, 'src/a.ts#L1')).toMatchObject({ line: 1 });
  });

  it('%20 / 中文解码；%23 属于文件名', async () => {
    expect((await previewFile(cwd, '%E6%96%87%E6%A1%A3%20%E7%9B%AE%E5%BD%95/%E4%B8%AD%E6%96%87%20%E6%96%87%E4%BB%B6.md')).kind).toBe('markdown');
    expect((await previewFile(cwd, 'a%23b.md')).name).toBe('a#b.md');
  });

  it('cwd 之外的绝对路径 403', async () => {
    expect(await status(previewFile(cwd, path.join(outside, 'secret.txt')))).toBe(403);
    expect(await status(previewFile(cwd, path.parse(cwd).root))).toBe(403);
  });

  it('.. 逃逸 403（相对 / 绝对 / 混合分隔符）', async () => {
    expect(await status(previewFile(cwd, '../outside/secret.txt'))).toBe(403);
    expect(await status(previewFile(cwd, 'src/../../outside/secret.txt'))).toBe(403);
    expect(await status(previewFile(cwd, '..\\outside\\secret.txt'))).toBe(403);
    expect(await status(previewFile(cwd, '../'))).toBe(403);
  });

  it('前缀相同的兄弟目录不算在 cwd 内', async () => {
    const sibling = `${cwd}-evil`;
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, 'x.txt'), 'x');
    expect(await status(previewFile(cwd, path.join(sibling, 'x.txt')))).toBe(403);
    expect(isInside(path.join(sibling, 'x.txt'), cwd)).toBe(false);
    expect(isInside(path.join(cwd, 'x.txt'), cwd)).toBe(true);
    expect(isInside(cwd, cwd)).toBe(true);
  });

  it('符号链接逃逸 403（文件）', async (ctx) => {
    if (linkSkipped) return ctx.skip();
    expect(await status(previewFile(cwd, 'link.txt'))).toBe(403);
  });

  it('junction 逃逸 403（目录，及其下的文件）', async (ctx) => {
    if (junctionSkipped) return ctx.skip();
    expect(await status(previewFile(cwd, 'jump'))).toBe(403);
    expect(await status(previewFile(cwd, 'jump/secret.txt'))).toBe(403);
  });

  it('不存在的文件 404；非本地路径 400', async () => {
    expect(await status(previewFile(cwd, 'nope.txt'))).toBe(404);
    expect(await status(previewFile(cwd, 'http://example.com/a'))).toBe(400);
    expect(await status(previewFile(cwd, 'javascript:alert(1)'))).toBe(400);
    expect(await status(previewFile(cwd, ''))).toBe(400);
    expect(await status(previewFile(cwd, undefined))).toBe(400);
  });

  it('UNC / 设备路径 / 保留名 / 备用数据流被拒绝', () => {
    for (const p of ['\\\\host\\share\\a.txt', '//host/share/a.txt', '\\\\.\\C:\\x', '\\\\?\\C:\\x']) {
      expect([400, 403], p).toContain((() => { try { lexicalTarget(cwd, p); return 200; } catch (e) { return (e as { status: number }).status; } })());
    }
    if (isWin) {
      for (const p of ['con', 'NUL.txt', 'src/com1', 'lpt1.log', 'aux ', 'src\\nul.']) {
        expect(() => lexicalTarget(cwd, p), p).toThrow(/设备名/);
      }
      expect(() => lexicalTarget(cwd, 'notes.txt:stream')).toThrow();
    }
    expect(hasReservedName('C:\\a\\CON')).toBe(true);
    expect(hasReservedName('C:\\a\\console.txt')).toBe(false);
    expect(hasReservedName('C:\\a\\com10.txt')).toBe(false);
  });

  it('resolveTarget 返回 realpath 与 stat', async () => {
    const t = await resolveTarget(cwd, 'src/a.ts');
    expect(t.real).toBe(path.join(cwd, 'src', 'a.ts'));
    expect(t.stat.isFile()).toBe(true);
  });
});

describe('读取与类型识别', () => {
  it('Markdown / 代码 / 纯文本', async () => {
    expect(await previewFile(cwd, 'README.md')).toMatchObject({ kind: 'markdown', encoding: 'UTF-8', name: 'README.md' });
    expect((await previewFile(cwd, 'README.md')).text).toContain('# 标题');
    expect(await previewFile(cwd, 'src/a.ts')).toMatchObject({ kind: 'code', language: 'typescript', size: 40 });
    expect(await previewFile(cwd, 'notes.txt')).toMatchObject({ kind: 'text', text: 'plain\n' });
  });

  it('UTF-8（含 BOM）与 GB18030 解码', async () => {
    const bom = await previewFile(cwd, 'bom.txt');
    expect(bom.text).toBe('bom 文本');
    expect(bom.encoding).toBe('UTF-8');
    const gbk = await previewFile(cwd, 'gbk.txt');
    expect(gbk.text).toBe('中文\n');
    expect(gbk.encoding).toContain('GB18030');
    expect(decodeFileText(Buffer.from('héllo 你好'))).toMatchObject({ text: 'héllo 你好', encoding: 'UTF-8' });
    expect(decodeFileText(Buffer.from([0xff, 0xfe, 0x41, 0x00]))).toMatchObject({ text: 'A', encoding: 'UTF-16LE' });
  });

  it('含 NUL 的二进制 → unsupported + 原因', async () => {
    const r = await previewFile(cwd, 'bin.dat');
    expect(r.kind).toBe('unsupported');
    expect(r.reason).toBeTruthy();
    expect(r.text).toBeUndefined();
  });

  it('图片按魔数识别（不信扩展名）；SVG 单独识别；PDF', async () => {
    expect(await previewFile(cwd, 'pic.png')).toMatchObject({ kind: 'image', mimeType: 'image/png' });
    expect(await previewFile(cwd, 'vec.svg')).toMatchObject({ kind: 'image', mimeType: 'image/svg+xml' });
    expect(await previewFile(cwd, 'doc.pdf')).toMatchObject({ kind: 'pdf', mimeType: 'application/pdf' });
    const fake = await previewFile(cwd, 'fake.png');
    expect(fake.kind).toBe('unsupported');
    expect(sniffMedia(PNG)).toEqual({ type: 'image/png', kind: 'image' });
    expect(sniffMedia(Buffer.from('hello'))).toBeNull();
  });

  it('超过 2MB 的文本 → unsupported + 原因，不读内容', async () => {
    fs.writeFileSync(path.join(cwd, 'big.log'), Buffer.alloc(TEXT_LIMIT + 1, 0x61));
    const r = await previewFile(cwd, 'big.log');
    expect(r.kind).toBe('unsupported');
    expect(r.reason).toMatch(/2MB/);
    expect(r.size).toBe(TEXT_LIMIT + 1);
  });

  it('目录：kind = directory，带子项列表（目录在前）', async () => {
    const r = await previewFile(cwd, 'src');
    expect(r.kind).toBe('directory');
    expect(r.entries).toEqual([{ name: 'a.ts', isDir: false }]);
    const root = await previewFile(cwd, '.');
    expect(root.entries![0]).toMatchObject({ isDir: true });
    expect(root.entries!.some((e) => e.name === 'README.md')).toBe(true);
  });

  it('目录列表最多 500 项并标记 truncated', async () => {
    const d = path.join(cwd, 'many');
    fs.mkdirSync(d, { recursive: true });
    for (let i = 0; i < 510; i++) fs.writeFileSync(path.join(d, `f${i}.txt`), '');
    const r = await previewFile(cwd, 'many');
    expect(r.entries).toHaveLength(500);
    expect(r.truncated).toBe(true);
  });
});

describe('reveal / terminal 命令构造', () => {
  it('Windows reveal：explorer /select,"path"，verbatim 参数，路径用反斜杠，空格与中文原样', () => {
    const c = revealFileCommand('F:/我的 项目/中文 文件.md', 'win32');
    expect(c.cmd).toBe('explorer.exe');
    expect(c.args).toEqual(['/select,"F:\\我的 项目\\中文 文件.md"']);
    expect(c.opts?.windowsVerbatimArguments).toBe(true);
  });
  it('macOS reveal：open -R；Linux：xdg-open 父目录', () => {
    expect(revealFileCommand('/Users/a/b c/d.md', 'darwin')).toMatchObject({ cmd: 'open', args: ['-R', '/Users/a/b c/d.md'] });
    expect(revealFileCommand('/home/a/b c/d.md', 'linux')).toMatchObject({ cmd: 'xdg-open', args: ['/home/a/b c'] });
  });
  it('Windows 终端：wt.exe -d → cmd start → powershell；目录不进命令行', () => {
    const cs = terminalCommands('F:\\我的 项目', 'win32');
    expect(cs[0]).toMatchObject({ cmd: 'wt.exe', args: ['-d', 'F:\\我的 项目'] });
    expect(cs[1]).toMatchObject({ cmd: 'cmd.exe', args: ['/c', 'start', '', 'cmd.exe'], opts: { cwd: 'F:\\我的 项目' } });
    expect(cs[2]!.cmd).toBe('powershell.exe');
    expect(cs[2]!.args.join(' ')).not.toContain('我的');
    expect(cs[2]!.opts?.env?.COSYEE_TERMINAL_CWD).toBe('F:\\我的 项目');
  });
  it('Windows 目录含 ; 或以反斜杠结尾时跳过 wt', () => {
    expect(terminalCommands('F:\\a;b', 'win32')[0]!.cmd).toBe('cmd.exe');
    expect(terminalCommands('F:\\', 'win32')[0]!.cmd).toBe('cmd.exe');
  });
  it('macOS：open -a Terminal <dir>；Linux：按常见终端依次尝试', () => {
    expect(terminalCommands('/Users/a/b c', 'darwin')).toEqual([{ cmd: 'open', args: ['-a', 'Terminal', '/Users/a/b c'] }]);
    expect(terminalCommands('/home/a', 'linux').map((c) => c.cmd)).toEqual(['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm']);
  });
  it('revealPath / openTerminal 走注入的 spawner；不存在的路径不会 spawn', async () => {
    const calls: string[][] = [];
    const sp = (c: string, a: string[]) => calls.push([c, ...a]);
    expect(revealPath(path.join(cwd, 'nope'), sp)).toBe(false);
    expect(await openTerminal(path.join(cwd, 'nope'), sp)).toBe(false);
    expect(calls).toEqual([]);
    expect(revealPath(path.join(cwd, 'README.md'), sp, 'linux')).toBe(true);
    expect(calls).toEqual([['xdg-open', cwd.split(path.sep).join('/')]]);
  });
  it('终端：前一个候选启动失败（返回 false）就试下一个', async () => {
    const tried: string[] = [];
    const ok = await openTerminal(cwd, (c) => { tried.push(c); return c !== 'wt.exe' && c !== 'x-terminal-emulator'; });
    expect(ok).toBe(true);
    expect(tried).toHaveLength(2);
    const none = await openTerminal(cwd, () => Promise.resolve(false));
    expect(none).toBe(false);
  });
});

describe('/api/files/* 接口', () => {
  const SID = '4f3c2b1a-0000-4000-8000-000000000001';
  let srv: RunningServer;
  let base: string;
  let calls: { cmd: string; args: string[]; opts?: unknown }[];
  const prev = (rel: string, session = SID) => fetch(`${base}/api/files/preview?session=${session}&path=${encodeURIComponent(rel)}`);
  const raw = (rel: string) => fetch(`${base}/api/files/raw?session=${SID}&path=${encodeURIComponent(rel)}`);
  const post = (route: 'reveal' | 'terminal', body: unknown) =>
    fetch(`${base}/api/files/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  beforeAll(async () => {
    const dir = path.join(tmp, 'claude', 'projects', encodeCwd(cwd));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${SID}.jsonl`), JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hi' } }) + '\n');
    calls = [];
    srv = await startServer({
      port: 0,
      webDist: null,
      stateFile: path.join(tmp, 'state.json'),
      spawner: (cmd, args, opts) => calls.push({ cmd, args, opts }),
    });
    base = `http://127.0.0.1:${srv.port}`;
  });
  afterAll(async () => {
    await srv.stop();
  });

  it('preview：cwd 由会话记录解析；返回结构化结果', async () => {
    const r = await prev('src/a.ts:2');
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ name: 'a.ts', path: path.join(cwd, 'src', 'a.ts'), kind: 'code', language: 'typescript', line: 2 });
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('preview：cwd 之外 / .. 逃逸 403；会话 id 不合法 400；未知会话 404', async () => {
    expect((await prev(path.join(outside, 'secret.txt'))).status).toBe(403);
    expect((await prev('../outside/secret.txt')).status).toBe(403);
    expect((await prev('src/a.ts', '../x')).status).toBe(400);
    expect((await prev('src/a.ts', '4f3c2b1a-0000-4000-8000-0000000000ff')).status).toBe(404);
    expect((await fetch(`${base}/api/files/preview?path=a.ts`)).status).toBe(400);
  });

  it('preview：客户端 cwd 只在是已打开的工作空间时才兜底（未知会话）', async () => {
    const other = '4f3c2b1a-0000-4000-8000-0000000000aa';
    const u = (c: string) => `${base}/api/files/preview?session=${other}&cwd=${encodeURIComponent(c)}&path=README.md`;
    expect((await fetch(u(cwd))).status).toBe(404); // 还不是工作空间
    srv.workspaces.add(cwd);
    expect((await fetch(u(cwd))).status).toBe(200);
    expect((await fetch(u(outside))).status).toBe(404); // 不是工作空间：不能借此把 cwd 指到别处
  });

  it('cwd 之外：会话记录里原样提到过的路径放行，没提到过的仍 403', async () => {
    const shots = path.join(tmp, 'shots');
    fs.mkdirSync(shots, { recursive: true });
    const shot = path.join(shots, 'shot.png');
    fs.writeFileSync(shot, PNG);
    fs.writeFileSync(path.join(shots, 'shot.png.bak'), PNG);
    fs.writeFileSync(path.join(shots, 'other.png'), PNG);
    const file = path.join(tmp, 'claude', 'projects', encodeCwd(cwd), `${SID}.jsonl`);
    const text = `截图已保存到 ${shot}，另一张 [链接](${encodeURI(path.join(shots, 'other.png').replace(/\\/g, '/'))})`;
    fs.appendFileSync(file, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n');

    const r = await prev(shot);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ kind: 'image', mimeType: 'image/png', path: shot });
    const img = await raw(shot);
    expect(img.status).toBe(200);
    expect(Buffer.from(await img.arrayBuffer()).equals(PNG)).toBe(true);
    expect((await prev(path.join(shots, 'other.png'))).status).toBe(200); // Markdown 链接里的百分号编码
    calls.length = 0;
    expect((await post('reveal', { session: SID, path: shot })).status).toBe(200);
    expect(calls).toHaveLength(1);

    expect((await prev(path.join(shots, 'shot.png.bak'))).status).toBe(403); // 只是前缀相同
    expect((await prev(path.join(outside, 'secret.txt'))).status).toBe(403);
    expect((await prev(shots)).status).toBe(403); // 提到文件不等于提到它所在目录
    expect((await raw(path.join(outside, 'secret.txt'))).status).toBe(403);
  });

  it('raw：图片带正确 content-type 与 nosniff；SVG 带沙箱 CSP；文本 404；越界 403', async () => {
    const png = await raw('pic.png');
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(png.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await png.arrayBuffer()).equals(PNG)).toBe(true);
    const svg = await raw('vec.svg');
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');
    expect(svg.headers.get('content-security-policy')).toContain('sandbox');
    await svg.arrayBuffer();
    expect((await raw('doc.pdf')).headers.get('content-type')).toBe('application/pdf');
    expect((await raw('notes.txt')).status).toBe(404);
    expect((await raw('fake.png')).status).toBe(404);
    expect((await raw(path.join(outside, 'secret.txt'))).status).toBe(403);
  });

  it('reveal：文件 → 选中；经注入的 spawner，不启动真实进程', async () => {
    calls.length = 0;
    const abs = path.join(cwd, '文档 目录', '中文 文件.md');
    const r = await post('reveal', { session: SID, path: abs });
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(1);
    const want = revealFileCommand(abs);
    expect(calls[0]).toMatchObject({ cmd: want.cmd, args: want.args });
    if (isWin) {
      expect(calls[0]!.args).toEqual([`/select,"${abs}"`]);
      expect((calls[0]!.opts as { windowsVerbatimArguments: boolean }).windowsVerbatimArguments).toBe(true);
    }
  });

  it('terminal：文件用它所在目录，目录用自身；越界 403 且不 spawn', async () => {
    calls.length = 0;
    expect((await post('terminal', { session: SID, path: 'src/a.ts' })).status).toBe(200);
    const want = terminalCommands(path.join(cwd, 'src'))[0]!;
    expect(calls[0]).toMatchObject({ cmd: want.cmd, args: want.args });
    calls.length = 0;
    expect((await post('terminal', { session: SID, path: 'src' })).status).toBe(200);
    expect(calls[0]!.args).toEqual(want.args);
    calls.length = 0;
    expect((await post('terminal', { session: SID, path: outside })).status).toBe(403);
    expect((await post('reveal', { session: SID, path: '../outside/secret.txt' })).status).toBe(403);
    expect((await post('reveal', { session: SID, path: 'nope.txt' })).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('reveal / terminal：会话 id 不合法 400', async () => {
    expect((await post('reveal', { session: '../x', path: 'a' })).status).toBe(400);
    expect((await post('terminal', { path: 'a' })).status).toBe(400);
  });

  it('bootstrap：本机回环连接 remote=false', async () => {
    expect(await (await fetch(`${base}/api/bootstrap`)).json()).toMatchObject({ remote: false });
  });

  // 网页版选择窗口（远程连接时代替系统对话框）
  const browse = (p?: string) => fetch(`${base}/api/browse${p === undefined ? '' : `?path=${encodeURIComponent(p)}`}`);
  const postJson = (route: string, body: unknown) =>
    fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('workspaces/open：打开现存文件夹并设为当前；文件 / 不存在 / 相对路径被拒绝', async () => {
    const r = await postJson('/api/workspaces/open', { path: cwd });
    expect(r.status).toBe(200);
    expect((await r.json()).workspace.path).toBe(cwd);
    expect(srv.workspaces.list().current).toBe(cwd);
    expect((await postJson('/api/workspaces/open', { path: path.join(cwd, 'README.md') })).status).toBe(400);
    expect((await postJson('/api/workspaces/open', { path: path.join(cwd, 'nope') })).status).toBe(404);
    expect((await postJson('/api/workspaces/open', { path: 'src' })).status).toBe(400);
  });

  it('browse：默认从当前工作空间开始；目录在前；带上一级与根', async () => {
    const r = await browse();
    expect(r.status).toBe(200);
    const d = await r.json();
    expect(d.path).toBe(cwd);
    expect(d.parent).toBe(path.dirname(cwd));
    expect(d.roots.length).toBeGreaterThan(0);
    const firstFile = d.entries.findIndex((e: { isDir: boolean }) => !e.isDir);
    expect(d.entries.slice(0, firstFile).every((e: { isDir: boolean }) => e.isDir)).toBe(true);
    expect(d.entries.slice(firstFile).every((e: { isDir: boolean }) => !e.isDir)).toBe(true);
    expect(d.entries).toContainEqual({ name: '文档 目录', isDir: true });
    expect(d.entries).toContainEqual({ name: 'README.md', isDir: false });
    if (!junctionSkipped) expect(d.entries).toContainEqual({ name: 'jump', isDir: true }); // 跟随联接
  });

  it('browse：可浏览工作空间之外；根上 parent 为 null；文件 / 不存在 404，相对路径 400', async () => {
    const o = await (await browse(outside)).json();
    expect(o.entries).toEqual([{ name: 'secret.txt', isDir: false }]);
    const root = await (await browse(path.parse(cwd).root)).json();
    expect(root.parent).toBeNull();
    expect((await browse(path.join(cwd, 'README.md'))).status).toBe(404);
    expect((await browse(path.join(cwd, 'nope'))).status).toBe(404);
    expect((await browse('src')).status).toBe(400);
  });

  it('pick/paths：判断文件 / 文件夹、去重并发预览令牌；不存在 404，相对路径 400', async () => {
    const md = path.join(cwd, 'README.md');
    const r = await postJson('/api/pick/paths', { paths: [md, path.join(cwd, 'src'), md, path.join(cwd, 'pic.png')] });
    expect(r.status).toBe(200);
    const { items, supportsMixed } = await r.json();
    expect(supportsMixed).toBe(true);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ path: md, kind: 'file', isImage: false });
    expect(items[0].previewToken).toEqual(expect.any(String));
    expect(items[1]).toMatchObject({ path: path.join(cwd, 'src'), kind: 'folder' });
    expect(items[2]).toMatchObject({ kind: 'file', isImage: true });
    expect((await postJson('/api/pick/paths', { paths: [path.join(cwd, 'nope')] })).status).toBe(404);
    expect((await postJson('/api/pick/paths', { paths: ['a.txt'] })).status).toBe(400);
    expect((await postJson('/api/pick/paths', { paths: 'x' })).status).toBe(400);
  });
});
