// kiro.rs 引擎单测：release 查询、预编译包下载 / SHA256 校验 / 解压安装、旧版 sha 引擎迁移、
// 保留当前 + 上一版、自动检查。全部使用临时目录与注入的 fetch / runCommand，不联网、不碰真实 ~/.cosyee。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KiroEngine, type CommandRunner, type KiroEngineOptions } from './kiro/engine.js';

const SUFFIX = 'macOS-arm64';
const SHA_OLD = 'a'.repeat(40);

let home: string;
let root: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-kiro-engine-'));
  root = path.join(home, 'kiro-rs');
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

interface FakeRelease {
  tag: string;
  /** 压缩包内容（同时决定 SHA） */
  body?: string;
  /** SHA256SUMS 里写的摘要；默认按 body 计算 */
  sums?: string;
  /** 不提供压缩包资产 */
  noArchive?: boolean;
}

/** 模拟 GitHub API 与资产下载；calls 记录请求 URL 与 headers */
function makeFetch(rel: { current: FakeRelease }, calls: Array<{ url: string; headers: Headers }> = []): typeof globalThis.fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers) });
    const r = rel.current;
    const ver = r.tag.slice(1);
    const archiveName = `kiro-rs-${ver}-${SUFFIX}.tar.gz`;
    const base = `https://github.com/ZyphrZero/kiro.rs/releases/download/${r.tag}`;
    const body = r.body ?? `bin-${r.tag}`;
    if (url === 'https://api.github.com/repos/ZyphrZero/kiro.rs/releases/latest') {
      const assets = [
        ...(r.noArchive ? [] : [{ name: archiveName, browser_download_url: `${base}/${archiveName}`, size: body.length }]),
        { name: 'SHA256SUMS.txt', browser_download_url: `${base}/SHA256SUMS.txt`, size: 100 },
      ];
      return new Response(JSON.stringify({
        tag_name: r.tag,
        name: `Kiro.rs ${ver}`,
        published_at: '2026-11-13T01:26:12Z',
        assets,
      }), { status: 200 });
    }
    if (url === `${base}/SHA256SUMS.txt`) {
      return new Response(`${r.sums ?? sha256(body)}  ${archiveName}\n${'0'.repeat(64)}  other-file.zip\n`, { status: 200 });
    }
    if (url === `${base}/${archiveName}`) return new Response(body, { status: 200 });
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;
}

/** 模拟 tar：在 -C 目录下写出 kiro-rs-<ver>-<suffix>/kiro-rs，内容取自压缩包 */
function makeTar(commands: string[] = []): CommandRunner {
  return async (cmd, args) => {
    commands.push(`${path.basename(cmd)} ${args.join(' ')}`);
    const archive = args[1]!;
    const outDir = args[args.indexOf('-C') + 1]!;
    const m = /^(kiro-rs-[\d.]+-[\w-]+)\.(?:tar\.gz|zip)$/.exec(path.basename(archive))!;
    const inner = path.join(outDir, m[1]!);
    fs.mkdirSync(inner, { recursive: true });
    fs.writeFileSync(path.join(inner, 'kiro-rs'), fs.readFileSync(archive));
    fs.writeFileSync(path.join(inner, 'README.md'), 'readme');
    return { code: 0, stdout: '', stderr: '' };
  };
}

function makeEngine(rel: { current: FakeRelease }, extra: Partial<KiroEngineOptions> = {}): KiroEngine {
  return new KiroEngine({
    rootDir: () => root,
    env: () => ({}),
    platform: 'darwin',
    arch: 'arm64',
    fetch: makeFetch(rel),
    runCommand: makeTar(),
    ...extra,
  });
}

function leftoverTmp(): string[] {
  return fs.existsSync(root) ? fs.readdirSync(root).filter((n) => n.startsWith('tmp-')) : [];
}

describe('KiroEngine（预编译包）', () => {
  it('check 写入 latest 并带上正确的请求头，不带用户信息', async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const rel = { current: { tag: 'v0.9.9' } };
    const engine = makeEngine(rel, { fetch: makeFetch(rel, calls), now: () => 12345 });
    const st = await engine.check();
    expect(st.latest).toEqual({ commit: 'v0.9.9', date: Date.parse('2026-11-13T01:26:12Z'), title: 'Kiro.rs 0.9.9' });
    expect(st.checkedAt).toBe(12345);
    expect(st.source).toBe('none');
    expect(st.updateAvailable).toBe(false);
    expect(st.missingTools).toEqual([]);
    expect(st.adminUi).toBe(true);
    expect(st.adminUiError).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.get('user-agent')).toBe('cosyee');
    expect(calls[0]!.headers.get('accept')).toBe('application/vnd.github+json');
    // 持久化
    expect(new KiroEngine({ rootDir: () => root, env: () => ({}) }).status().latest?.commit).toBe('v0.9.9');
  });

  it('build 成功：安装到 bin/<tag>/kiro-rs，日志记录步骤，onUpgraded 被调用，临时目录被清掉', async () => {
    const rel = { current: { tag: 'v0.9.9' } };
    const commands: string[] = [];
    const onUpgraded = vi.fn();
    const engine = makeEngine(rel, { runCommand: makeTar(commands), onUpgraded });
    expect(engine.binaryPath()).toBeNull();
    expect(engine.status().source).toBe('none');

    expect(engine.startBuild().build.state).toBe('running');
    await engine.waitForBuild();

    const st = engine.status();
    expect(st.build).toEqual({ state: 'idle', step: null, error: null });
    expect(st.source).toBe('managed');
    expect(st.current?.commit).toBe('v0.9.9');
    expect(st.updateAvailable).toBe(false);
    const bin = path.join(root, 'bin', 'v0.9.9', 'kiro-rs');
    expect(engine.binaryPath()).toBe(bin);
    expect(fs.readFileSync(bin, 'utf8')).toBe('bin-v0.9.9');
    expect(fs.statSync(bin).mode & 0o111).toBeGreaterThan(0);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatch(/^tar -xzf .*kiro-rs-0\.9\.9-macOS-arm64\.tar\.gz -C /);
    expect(onUpgraded).toHaveBeenCalledTimes(1);
    expect(leftoverTmp()).toEqual([]);

    const log = engine.getLog(0).lines.join('\n');
    expect(log).toContain('查询最新版本');
    expect(log).toContain('下载 kiro-rs-0.9.9-macOS-arm64.tar.gz');
    expect(log).toContain('MB');
    expect(log).toContain('校验');
    expect(log).toContain('解压');
    expect(log).toContain('安装完成');
    // 增量读取
    const first = engine.getLog(0);
    expect(engine.getLog(first.next)).toEqual({ lines: [], next: first.next });

    // 再次 build：已是最新，不再下载也不再回调
    engine.startBuild();
    await engine.waitForBuild();
    expect(commands).toHaveLength(1);
    expect(onUpgraded).toHaveBeenCalledTimes(1);
    expect(engine.getLog(0).lines.join('\n')).toContain('已是最新版');
  });

  it('SHA256 不匹配：失败、不留临时目录、不改 current', async () => {
    const rel: { current: FakeRelease } = { current: { tag: 'v0.9.9' } };
    const onUpgraded = vi.fn();
    const engine = makeEngine(rel, { onUpgraded });
    engine.startBuild();
    await engine.waitForBuild();
    expect(engine.status().current?.commit).toBe('v0.9.9');

    rel.current = { tag: 'v0.9.10', body: 'tampered', sums: sha256('something-else') };
    engine.startBuild();
    await engine.waitForBuild();
    const st = engine.status();
    expect(st.build.state).toBe('failed');
    expect(st.build.error).toContain('SHA256');
    expect(st.current?.commit).toBe('v0.9.9');
    expect(st.latest?.commit).toBe('v0.9.10');
    expect(st.updateAvailable).toBe(true);
    expect(fs.existsSync(path.join(root, 'bin', 'v0.9.10'))).toBe(false);
    expect(leftoverTmp()).toEqual([]);
    expect(onUpgraded).toHaveBeenCalledTimes(1);
  });

  it('SHA256SUMS 里没有该文件或没有对应平台资产时失败', async () => {
    const rel: { current: FakeRelease } = { current: { tag: 'v0.9.9', noArchive: true } };
    const engine = makeEngine(rel);
    engine.startBuild();
    await engine.waitForBuild();
    expect(engine.status().build.state).toBe('failed');
    expect(engine.status().build.error).toContain('没有适用于当前平台的预编译包');
    expect(leftoverTmp()).toEqual([]);
  });

  it('不支持的平台：check 与 startBuild 报错，autoInstall 静默', async () => {
    const rel = { current: { tag: 'v0.9.9' } };
    const fetchSpy = vi.fn(makeFetch(rel));
    const engine = makeEngine(rel, { platform: 'freebsd', fetch: fetchSpy as typeof globalThis.fetch, hasKiroAccounts: () => true });
    await expect(engine.check()).rejects.toThrow('当前平台没有预编译包');
    expect(() => engine.startBuild()).toThrow('当前平台没有预编译包');
    expect(() => engine.maybeAutoInstall()).not.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();

    const win = makeEngine(rel, { platform: 'win32', arch: 'arm64' });
    expect(() => win.startBuild()).toThrow('当前平台没有预编译包');
  });

  it('Linux musl 与 Windows 选择对应资产名并用对应解压参数', async () => {
    const seen: string[] = [];
    // 只验证资产名选择：release 里给出目标资产，让 build 走到下载前一步失败
    const mk = (platform: NodeJS.Platform, arch: string, isMusl: boolean, name: string) => {
      const f = (async (input: unknown) => {
        const url = String(input);
        if (url.endsWith('/releases/latest')) {
          return new Response(JSON.stringify({
            tag_name: 'v0.9.9',
            assets: [
              { name, browser_download_url: `https://github.com/x/${name}`, size: 1 },
              { name: 'SHA256SUMS.txt', browser_download_url: 'https://github.com/x/SHA256SUMS.txt', size: 1 },
            ],
          }), { status: 200 });
        }
        seen.push(url);
        return new Response('bad', { status: 404 });
      }) as typeof globalThis.fetch;
      return new KiroEngine({ rootDir: () => root, env: () => ({}), platform, arch, isMusl: () => isMusl, fetch: f });
    };
    for (const [platform, arch, musl, name] of [
      ['linux', 'x64', true, 'kiro-rs-0.9.9-Linux-musl-x64.tar.gz'],
      ['linux', 'arm64', false, 'kiro-rs-0.9.9-Linux-arm64.tar.gz'],
      ['darwin', 'x64', false, 'kiro-rs-0.9.9-macOS-x64.tar.gz'],
      ['win32', 'x64', false, 'kiro-rs-0.9.9-Windows-x64.zip'],
    ] as const) {
      seen.length = 0;
      const e = mk(platform, arch, musl, name);
      e.startBuild();
      await e.waitForBuild();
      // 走到了下载 SHA256SUMS（说明已找到该平台的资产）
      expect(seen).toEqual(['https://github.com/x/SHA256SUMS.txt']);
    }
  });

  it('Windows：用 zip 的 -xf 参数解压并找到 kiro-rs.exe（不假定目录层级）', async () => {
    const body = 'win-bin';
    const archiveName = 'kiro-rs-0.9.9-Windows-x64.zip';
    const base = 'https://github.com/ZyphrZero/kiro.rs/releases/download/v0.9.9';
    const commands: string[] = [];
    const engine = new KiroEngine({
      rootDir: () => root,
      env: () => ({ SystemRoot: 'C:\\Windows' }),
      platform: 'win32',
      arch: 'x64',
      fetch: (async (input: unknown) => {
        const url = String(input);
        if (url.endsWith('/releases/latest')) {
          return new Response(JSON.stringify({
            tag_name: 'v0.9.9',
            assets: [
              { name: archiveName, browser_download_url: `${base}/${archiveName}`, size: 7 },
              { name: 'SHA256SUMS.txt', browser_download_url: `${base}/SHA256SUMS.txt`, size: 1 },
            ],
          }), { status: 200 });
        }
        if (url.endsWith('SHA256SUMS.txt')) return new Response(`${sha256(body)} *${archiveName}\n`, { status: 200 });
        return new Response(body, { status: 200 });
      }) as typeof globalThis.fetch,
      runCommand: async (cmd, args) => {
        commands.push(`${cmd} ${args[0]}`);
        // 更深一层的目录
        const deep = path.join(args[args.indexOf('-C') + 1]!, 'a', 'b');
        fs.mkdirSync(deep, { recursive: true });
        fs.writeFileSync(path.join(deep, 'kiro-rs.exe'), body);
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    engine.startBuild();
    await engine.waitForBuild();
    expect(engine.status().build.error).toBeNull();
    expect(commands[0]).toMatch(/System32.tar\.exe -xf$/);
    expect(engine.binaryPath()).toBe(path.join(root, 'bin', 'v0.9.9', 'kiro-rs.exe'));
  });

  it('COSYEE_KIRO_RS 优先于 managed', async () => {
    const rel = { current: { tag: 'v0.9.9' } };
    const custom = path.join(home, 'my-kiro-rs');
    fs.writeFileSync(custom, 'custom');
    let env: NodeJS.ProcessEnv = {};
    const engine = makeEngine(rel, { env: () => env });
    engine.startBuild();
    await engine.waitForBuild();
    expect(engine.binaryPath()).toBe(path.join(root, 'bin', 'v0.9.9', 'kiro-rs'));

    env = { COSYEE_KIRO_RS: custom };
    expect(engine.binaryPath()).toBe(custom);
    const st = engine.status();
    expect(st.source).toBe('env');
    expect(st.current).toBeNull();
    expect(st.adminUi).toBe(true);
    // 环境变量指向不存在的文件时回落到 managed
    env = { COSYEE_KIRO_RS: path.join(home, 'missing') };
    expect(engine.status().source).toBe('managed');
  });

  it('enabled 开关持久化，且不影响引擎信息', async () => {
    const rel = { current: { tag: 'v0.9.9' } };
    const engine = makeEngine(rel);
    expect(engine.isEnabled()).toBe(true);
    engine.startBuild();
    await engine.waitForBuild();
    engine.setEnabled(false);
    const again = new KiroEngine({ rootDir: () => root, env: () => ({}), platform: 'darwin', arch: 'arm64' });
    expect(again.isEnabled()).toBe(false);
    expect(again.status().current?.commit).toBe('v0.9.9');
    again.setEnabled(true);
    expect(engine.isEnabled()).toBe(true);
  });

  /** 写入旧版（hank9999 源码编译）留下的引擎：engine.json、bin/<sha>/kiro-rs、src/ */
  function seedLegacy(): void {
    fs.mkdirSync(path.join(root, 'bin', SHA_OLD), { recursive: true });
    fs.writeFileSync(path.join(root, 'bin', SHA_OLD, 'kiro-rs'), 'old-binary');
    fs.mkdirSync(path.join(root, 'bin', `${'b'.repeat(40)}-1700000000000`), { recursive: true });
    fs.mkdirSync(path.join(root, 'src', '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, 'engine.json'), JSON.stringify({
      current: { commit: SHA_OLD, date: 1, title: 'old' },
      currentBinDir: SHA_OLD,
      previousSha: 'b'.repeat(40),
      previousBinDir: `${'b'.repeat(40)}-1700000000000`,
      latest: { commit: SHA_OLD, date: 1, title: 'old' },
      checkedAt: 1,
      enabled: false,
      adminUi: false,
      adminUiError: 'x',
    }));
  }

  it('旧 sha 引擎视为没有可用引擎；安装新版后清理 src/ 与旧 sha 目录，enabled 保留', async () => {
    seedLegacy();
    const rel = { current: { tag: 'v0.9.9' } };
    const engine = makeEngine(rel);
    expect(engine.binaryPath()).toBeNull();
    const before = engine.status();
    expect(before.source).toBe('none');
    expect(before.current).toBeNull();
    expect(before.latest).toBeNull();
    expect(before.updateAvailable).toBe(false);
    expect(engine.isEnabled()).toBe(false);

    engine.startBuild();
    await engine.waitForBuild();
    expect(engine.status().source).toBe('managed');
    expect(engine.binaryPath()).toBe(path.join(root, 'bin', 'v0.9.9', 'kiro-rs'));
    expect(fs.readdirSync(path.join(root, 'bin'))).toEqual(['v0.9.9']);
    expect(fs.existsSync(path.join(root, 'src'))).toBe(false);
    expect(engine.isEnabled()).toBe(false);
    const meta = JSON.parse(fs.readFileSync(path.join(root, 'engine.json'), 'utf8'));
    expect(meta.previousSha ?? null).toBeNull();
    expect(meta.adminUi).toBeUndefined();
  });

  it('保留当前 + 上一版，清理更早的版本；updateAvailable 按版本号比较', async () => {
    const rel: { current: FakeRelease } = { current: { tag: 'v0.9.9' } };
    const onUpgraded = vi.fn();
    const engine = makeEngine(rel, { onUpgraded });
    for (const tag of ['v0.9.9', 'v0.9.10', 'v0.10.0']) {
      rel.current = { tag };
      engine.startBuild();
      await engine.waitForBuild();
      expect(engine.status().build.error).toBeNull();
    }
    expect(onUpgraded).toHaveBeenCalledTimes(3);
    expect(engine.status().current?.commit).toBe('v0.10.0');
    expect(fs.readdirSync(path.join(root, 'bin')).sort()).toEqual(['v0.10.0', 'v0.9.10']);
    const meta = JSON.parse(fs.readFileSync(path.join(root, 'engine.json'), 'utf8'));
    expect(meta.previousSha).toBe('v0.9.10');
    expect(meta.previousBinDir).toBe('v0.9.10');

    // 上游 latest 比当前旧时不算有更新（v0.9.10 < v0.10.0，字符串比较会搞反）
    rel.current = { tag: 'v0.9.10' };
    expect((await engine.check()).updateAvailable).toBe(false);
    rel.current = { tag: 'v0.10.1' };
    expect((await engine.check()).updateAvailable).toBe(true);
  });

  it('maybeAutoInstall：没有 Kiro 账号时什么都不做', async () => {
    const rel = { current: { tag: 'v0.9.9' } };
    const fetchSpy = vi.fn(makeFetch(rel));
    const engine = makeEngine(rel, { fetch: fetchSpy as typeof globalThis.fetch, hasKiroAccounts: () => false });
    engine.maybeAutoInstall();
    await engine.waitForBuild();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(engine.status().build.state).toBe('idle');
  });

  it('maybeAutoInstall：有账号但没有引擎（含旧 sha 引擎）时后台下载安装', async () => {
    for (const legacy of [false, true]) {
      fs.rmSync(root, { recursive: true, force: true });
      if (legacy) seedLegacy();
      const rel = { current: { tag: 'v0.9.9' } };
      const onUpgraded = vi.fn();
      const engine = makeEngine(rel, { hasKiroAccounts: () => true, onUpgraded });
      engine.maybeAutoInstall();
      expect(engine.status().build.state).toBe('running');
      await engine.waitForBuild();
      expect(engine.binaryPath()).toBe(path.join(root, 'bin', 'v0.9.9', 'kiro-rs'));
      expect(onUpgraded).toHaveBeenCalledTimes(1);
    }
  });

  it('maybeAutoInstall：已有引擎时什么都不做（检查与更新交给 components 调度）', async () => {
    const rel: { current: FakeRelease } = { current: { tag: 'v0.9.9' } };
    let now = 1_000_000;
    const calls: Array<{ url: string; headers: Headers }> = [];
    const engine = makeEngine(rel, { fetch: makeFetch(rel, calls), now: () => now, hasKiroAccounts: () => true });
    engine.startBuild();
    await engine.waitForBuild();
    calls.length = 0;

    now += 25 * 60 * 60_000;
    rel.current = { tag: 'v0.9.10' };
    engine.maybeAutoInstall();
    await engine.waitForBuild();
    expect(calls).toHaveLength(0);
    expect(engine.status().current?.commit).toBe('v0.9.9');
    expect(engine.status().build.state).toBe('idle');
  });

  it('解压失败时报中文错误并清理临时目录，旧版不动', async () => {
    const rel = { current: { tag: 'v0.9.9' } };
    let fail = false;
    const tar = makeTar();
    const engine = makeEngine(rel, { runCommand: (cmd, args, opts) => (fail ? Promise.resolve({ code: 1, stdout: '', stderr: 'bad' }) : tar(cmd, args, opts)) });
    engine.startBuild();
    await engine.waitForBuild();
    fail = true;
    rel.current = { tag: 'v0.9.10' };
    engine.startBuild();
    await engine.waitForBuild();
    const st = engine.status();
    expect(st.build).toEqual({ state: 'failed', step: null, error: '解压失败（tar 返回非零）' });
    expect(st.current?.commit).toBe('v0.9.9');
    expect(engine.binaryPath()).toBe(path.join(root, 'bin', 'v0.9.9', 'kiro-rs'));
    expect(leftoverTmp()).toEqual([]);
  });

  it('压缩包没有可执行文件、HTTP 错误、下载地址非 github.com 都会失败', async () => {
    const rel = { current: { tag: 'v0.9.9' } };
    const noBin = makeEngine(rel, { runCommand: async () => ({ code: 0, stdout: '', stderr: '' }) });
    noBin.startBuild();
    await noBin.waitForBuild();
    expect(noBin.status().build.error).toContain('没有找到 kiro-rs');

    const http500 = makeEngine(rel, { fetch: (async () => new Response('', { status: 503 })) as typeof globalThis.fetch });
    http500.startBuild();
    await http500.waitForBuild();
    expect(http500.status().build.error).toContain('503');

    const evil = makeEngine(rel, {
      fetch: (async (input: unknown) => {
        if (String(input).endsWith('/releases/latest')) {
          return new Response(JSON.stringify({
            tag_name: 'v0.9.9',
            assets: [
              { name: 'kiro-rs-0.9.9-macOS-arm64.tar.gz', browser_download_url: 'https://evil.example/a.tar.gz', size: 1 },
              { name: 'SHA256SUMS.txt', browser_download_url: 'https://evil.example/SHA256SUMS.txt', size: 1 },
            ],
          }), { status: 200 });
        }
        throw new Error('不应请求');
      }) as typeof globalThis.fetch,
    });
    evil.startBuild();
    await evil.waitForBuild();
    expect(evil.status().build.error).toContain('github.com');
    expect(leftoverTmp()).toEqual([]);
  });

  it('上游 tag 格式异常（含路径穿越）时拒绝', async () => {
    const rel = { current: { tag: 'v0.9.9' } };
    const engine = makeEngine(rel, {
      fetch: (async () => new Response(JSON.stringify({ tag_name: '../../etc', assets: [] }), { status: 200 })) as typeof globalThis.fetch,
    });
    await expect(engine.check()).rejects.toThrow('版本号格式异常');
    expect(engine.status().latest).toBeNull();
  });
});
