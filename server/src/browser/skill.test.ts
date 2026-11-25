import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserInstall } from './install.js';
import { ensureBrowserPlugin, skillMarkdown, wrapperScript } from './skill.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cz-skill-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 假的 agent-browser：把参数逐行写进 args.log；eval 时像 --json 输出一样回一个 UA */
function fakeBin(): string {
  const bin = path.join(dir, 'fake-agent-browser');
  fs.writeFileSync(
    bin,
    `#!/bin/sh
printf '%s\\n' "--- AGENT_BROWSER_SKILLS_DIR=\${AGENT_BROWSER_SKILLS_DIR:-}" "$@" >> ${JSON.stringify(path.join(dir, 'args.log'))}
case " $* " in *" eval "*) echo '{"success":true,"data":{"result":"Mozilla/5.0 HeadlessChrome/158.0.0.0 Safari/537.36"}}' ;; esac
`,
    { mode: 0o755 },
  );
  return bin;
}

const install = (bin: string | null, skillsDir = path.join(dir, 'skill-data')) =>
  ({ binPath: () => bin, skillsDir: () => skillsDir }) as unknown as BrowserInstall;

function gen(bin: string | null) {
  const pluginDir = path.join(dir, 'plugin');
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'profiles.json'), JSON.stringify({ profiles: [{ id: 'default', name: '默认' }, { id: 'deadbeef', name: '测试' }] }));
  ensureBrowserPlugin({ pluginDir, dataDir, install: install(bin), platform: 'darwin' });
  const wrapper = path.join(pluginDir, 'bin', 'cosyee-browser');
  const run = (...args: string[]) => spawnSync(wrapper, args, { encoding: 'utf8' });
  const calls = () =>
    fs
      .readFileSync(path.join(dir, 'args.log'), 'utf8')
      .split('--- ')
      .filter(Boolean)
      .map((c) => c.trim().split('\n'));
  return { pluginDir, dataDir, wrapper, run, calls };
}

describe('cosyee:browser 插件', () => {
  it('生成插件清单、SKILL.md 和可执行的包装脚本，sh 语法正确', () => {
    const { pluginDir, wrapper } = gen(fakeBin());
    expect(JSON.parse(fs.readFileSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('cosyee');
    const md = fs.readFileSync(path.join(pluginDir, 'skills', 'browser', 'SKILL.md'), 'utf8');
    expect(md).toMatch(/^---\nname: browser\ndescription: .*⟦内置浏览器元素｜/);
    expect(md).toContain(`'${wrapper}' snapshot -i`);
    expect(md).toContain('skills get core');
    expect(md).toContain('⇧⌘P');
    expect(fs.statSync(wrapper).mode & 0o777).toBe(0o755);
    execFileSync('sh', ['-n', wrapper]);
  });

  it('内容没变不重写', () => {
    const { wrapper, pluginDir, dataDir } = gen(fakeBin());
    fs.utimesSync(wrapper, new Date(0), new Date(0));
    ensureBrowserPlugin({ pluginDir, dataDir, install: install(path.join(dir, 'fake-agent-browser')), platform: 'darwin' });
    expect(fs.statSync(wrapper).mtimeMs).toBe(0);
  });

  it('Windows 路径换成正斜杠，快捷键写 Ctrl+Shift+P', () => {
    const s = wrapperScript({ bin: 'C:/Users/a/agent-browser.exe', dataDir: 'C:/Users/a/browser', skillsDir: 'C:/x' });
    expect(s).toContain("BIN='C:/Users/a/agent-browser.exe'");
    expect(skillMarkdown('C:/p/bin/cosyee-browser', 'win32')).toContain('Ctrl+Shift+P');
    const pluginDir = path.join(dir, 'p');
    ensureBrowserPlugin({ pluginDir, dataDir: 'C:\\Users\\a\\browser', install: install('C:\\a\\agent-browser.exe', 'C:\\a\\skill-data'), platform: 'win32' });
    const w = fs.readFileSync(path.join(pluginDir, 'bin', 'cosyee-browser'), 'utf8');
    expect(w).toContain("BIN='C:/a/agent-browser.exe'");
    expect(w).toContain("DATA='C:/Users/a/browser'");
    expect(w).not.toContain('\\a');
  });

  it('没装时提示去面板安装', () => {
    const r = gen(null).run('open', 'https://example.com');
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('还没有安装');
  });

  it('带上和面板一致的启动参数；首次自动写 UA；--profile 选身份', () => {
    const { run, calls, dataDir } = gen(fakeBin());
    expect(run('get', 'url').status).toBe(0);
    expect(fs.readFileSync(path.join(dataDir, 'ua.txt'), 'utf8')).toBe('Mozilla/5.0 Chrome/158.0.0.0 Safari/537.36\n');
    const [boot, first] = calls();
    expect(boot).toEqual(['AGENT_BROWSER_SKILLS_DIR=', '--json', '--namespace', 'cosyee', '--session', 'cosyee', '--profile', path.join(dataDir, 'profile'), '--idle-timeout', '1h', 'eval', 'navigator.userAgent']);
    expect(first).toEqual(['AGENT_BROWSER_SKILLS_DIR=', '--namespace', 'cosyee', '--session', 'cosyee', '--profile', path.join(dataDir, 'profile'), '--idle-timeout', '1h', '--user-agent', 'Mozilla/5.0 Chrome/158.0.0.0 Safari/537.36', 'get', 'url']);
    expect(run('--profile', 'deadbeef', 'click', '#a b').status).toBe(0);
    expect(run('--profile=deadbeef', 'get', 'url').status).toBe(0);
    const c = calls();
    expect(c[2]!.slice(1, 9)).toEqual(['--namespace', 'cosyee', '--session', 'cosyee-deadbeef', '--profile', path.join(dataDir, 'profiles', 'deadbeef'), '--idle-timeout', '1h']);
    expect(c[2]!.slice(-2)).toEqual(['click', '#a b']);
    expect(c[3]!.slice(-2)).toEqual(['get', 'url']);
    expect(fs.statSync(path.join(dataDir, 'profiles', 'deadbeef')).mode & 0o777).toBe(0o700);
  });

  it('有官方文档时设 AGENT_BROWSER_SKILLS_DIR；skills 直接转给程序', () => {
    fs.mkdirSync(path.join(dir, 'skill-data', 'core'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'skill-data', 'core', 'SKILL.md'), '# core');
    const { run, calls } = gen(fakeBin());
    expect(run('skills', 'get', 'core').status).toBe(0);
    expect(calls()[0]).toEqual([`AGENT_BROWSER_SKILLS_DIR=${path.join(dir, 'skill-data')}`, 'skills', 'get', 'core']);
  });

  it('拒绝：未知身份、关闭、安装、自带启动参数', () => {
    const { run } = gen(fakeBin());
    for (const [args, text] of [
      [['--profile', '12345678', 'get', 'url'], '没有这个身份：12345678（'],
      [['--profile', '../x', 'get', 'url'], '没有这个身份'],
      [['close'], '不要关闭'],
      [['quit'], '不要关闭'],
      [['install'], '由 Cosyee 管理'],
      [['open', 'x', '--session', 's'], '不要带 --session：'],
      [['open', 'x', '--cdp=9222'], '不要带 --cdp=9222：'],
      [['open', 'x', '--headed'], '不要带 --headed：'],
    ] as const) {
      const r = run(...args);
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.stderr).toContain(text);
    }
    expect(fs.existsSync(path.join(dir, 'args.log'))).toBe(false);
    const u = run();
    expect(u.stdout).toContain('cosyee-browser profiles');
    expect(u.stdout).not.toContain('BIN=');
    expect(JSON.parse(run('profiles').stdout).profiles).toHaveLength(2);
  });
});

describe('官方 skill 文档下载', () => {
  const tree = {
    tree: [
      { path: 'skill-data/core/SKILL.md', type: 'blob', size: 10 },
      { path: 'skill-data/core/references/commands.md', type: 'blob', size: 10 },
      { path: 'skill-data/core', type: 'tree' },
      { path: 'skill-data/../evil/x.md', type: 'blob', size: 1 },
      { path: 'skill-data/big/SKILL.md', type: 'blob', size: 10 * 1024 * 1024 },
      { path: 'src/main.rs', type: 'blob', size: 1 },
    ],
  };
  const make = (fetchFn: typeof fetch, version = '0.44.0') => {
    const root = path.join(dir, 'ab');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'agent-browser'), '', { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'meta.json'), JSON.stringify({ version }));
    return new BrowserInstall({ rootDir: () => root, env: () => ({}), platform: 'darwin', fetch: fetchFn });
  };
  const okFetch = () =>
    vi.fn<typeof fetch>(async (u) => {
      const url = String(u);
      if (url.startsWith('https://api.github.com/')) return new Response(JSON.stringify(tree));
      return new Response(`内容 ${url.split('/v0.44.0/')[1]}`);
    });

  it('只下载 skill-data 下安全的路径，记下版本；版本一致不再下载', async () => {
    const f = okFetch();
    const b = make(f);
    await b.ensureSkills();
    const sd = b.skillsDir();
    expect(f.mock.calls[0]![0]).toBe('https://api.github.com/repos/vercel-labs/agent-browser/git/trees/v0.44.0?recursive=1');
    expect(fs.readFileSync(path.join(sd, 'core', 'SKILL.md'), 'utf8')).toBe('内容 skill-data/core/SKILL.md');
    expect(fs.readFileSync(path.join(sd, 'core', 'references', 'commands.md'), 'utf8')).toBe('内容 skill-data/core/references/commands.md');
    expect(fs.readFileSync(path.join(sd, '.version'), 'utf8')).toBe('0.44.0\n');
    expect(fs.existsSync(path.join(sd, 'big'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'ab', 'evil'))).toBe(false);
    expect(f.mock.calls).toHaveLength(3);
    expect(fs.readdirSync(path.join(dir, 'ab')).filter((n) => n.startsWith('.skill-data-'))).toEqual([]);
    await b.ensureSkills();
    expect(f.mock.calls).toHaveLength(3);
  });

  it('失败只记日志、不抛错，旧文档保留；没装或自定义程序时不下载', async () => {
    const f = vi.fn<typeof fetch>(async () => new Response('x', { status: 500 }));
    const b = make(f);
    fs.mkdirSync(path.join(b.skillsDir(), 'core'), { recursive: true });
    fs.writeFileSync(path.join(b.skillsDir(), 'core', 'SKILL.md'), '旧');
    await expect(b.ensureSkills()).resolves.toBeUndefined();
    expect(b.logs.read().lines.join('\n')).toContain('官方 skill 文档下载失败');
    expect(fs.readFileSync(path.join(b.skillsDir(), 'core', 'SKILL.md'), 'utf8')).toBe('旧');

    const g = okFetch();
    await new BrowserInstall({ rootDir: () => path.join(dir, 'none'), env: () => ({}), fetch: g }).ensureSkills();
    await new BrowserInstall({ rootDir: () => path.join(dir, 'ab'), env: () => ({ COSYEE_AGENT_BROWSER: '/x' }), fetch: g }).ensureSkills();
    expect(g).not.toHaveBeenCalled();
  });
});
