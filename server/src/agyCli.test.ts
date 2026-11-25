import { describe, expect, it, vi } from 'vitest';
import { RunningError } from './accounts/index.js';
import {
  AgyCli,
  type AgyCliOptions,
  type AgyCliPool,
  type AgyCommandRunner,
  INSTALL_PS1_URL,
  INSTALL_SH_URL,
  MANIFEST_BASE_URL,
  agyCliRoutes,
  compareSemver,
  isStrictSemver,
  manifestPlatform,
  parseAgyVersion,
  sanitizeLogLine,
  stripAnsi,
} from './delegate/agyCli.js';
import { HttpError } from './workspaces.js';

function fakePool(initial: { processes?: number; running?: number } = {}) {
  let processes = initial.processes ?? 0;
  let running = initial.running ?? 0;
  const retireAll = vi.fn(() => {
    if (running === 0) processes = 0;
  });
  const stopAll = vi.fn((force = false) => {
    if (!force && running > 0) return { stopped: false, running };
    const prev = running;
    processes = 0;
    running = 0;
    return { stopped: true, running: prev };
  });
  const pool: AgyCliPool = {
    stats: () => ({ processes, sessions: 0, busy: running }),
    runningCount: () => running,
    retireAll,
    stopAll,
  };
  return {
    pool,
    retireAll,
    stopAll,
    setState(next: { processes?: number; running?: number }) {
      if (next.processes !== undefined) processes = next.processes;
      if (next.running !== undefined) running = next.running;
    },
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function makeCli(opts: AgyCliOptions = {}) {
  const fp = fakePool();
  const runCommand = vi.fn<AgyCommandRunner>(async (_cmd, args) => {
    if (args[0] === '--version') return { code: 0, stdout: '1.5.16\n', stderr: '' };
    return { code: 0, stdout: 'ok\n', stderr: '' };
  });
  const fetchFn = vi.fn<typeof globalThis.fetch>(async () =>
    jsonResponse({ version: '1.5.17', url: 'https://example.invalid/agy', sha512: 'abc' }),
  );
  const cli = new AgyCli({
    pool: fp.pool,
    resolveAgy: () => 'C:\\agy\\bin\\agy.exe',
    env: () => ({}),
    statFile: () => ({ mtimeMs: 1000, size: 500 }),
    runCommand,
    fetch: fetchFn,
    platform: 'win32',
    arch: 'x64',
    isMusl: () => false,
    now: () => 1_700_000_000_000,
    ...opts,
  });
  return { cli, fp, runCommand, fetchFn };
}

describe('版本解析、校验与比较', () => {
  it('parseAgyVersion / isStrictSemver', () => {
    expect(parseAgyVersion('1.5.16\n')).toBe('1.5.16');
    expect(parseAgyVersion('v1.5.16')).toBe('1.5.16');
    expect(parseAgyVersion('agy 1.10.2 (abc123)')).toBe('1.10.2');
    expect(parseAgyVersion('\x1b[32m1.5.16\x1b[0m')).toBe('1.5.16');
    expect(parseAgyVersion('not-a-version')).toBeNull();
    expect(parseAgyVersion('')).toBeNull();

    expect(isStrictSemver('1.5.16')).toBe(true);
    expect(isStrictSemver('0.0.1')).toBe(true);
    expect(isStrictSemver('v1.5.16')).toBe(false);
    expect(isStrictSemver('1.5')).toBe(false);
    expect(isStrictSemver('1.5.16-beta.1')).toBe(false);
  });

  it('compareSemver 按数值语义比较', () => {
    expect(compareSemver('1.5.16', '1.5.16')).toBe(0);
    expect(compareSemver('1.5.17', '1.5.16')).toBe(1);
    expect(compareSemver('1.10.0', '1.9.9')).toBe(1);
    expect(compareSemver('2.0.0', '1.99.99')).toBe(1);
    expect(compareSemver('1.5.15', '1.5.16')).toBe(-1);
    expect(compareSemver('bad', '1.5.16')).toBe(0);
  });

  it('manifestPlatform 映射各平台与架构', () => {
    expect(manifestPlatform('win32', 'x64')).toBe('windows_amd64');
    expect(manifestPlatform('win32', 'arm64')).toBe('windows_arm64');
    expect(manifestPlatform('darwin', 'arm64')).toBe('darwin_arm64');
    expect(manifestPlatform('darwin', 'x64')).toBe('darwin_amd64');
    expect(manifestPlatform('linux', 'x64', false)).toBe('linux_amd64');
    expect(manifestPlatform('linux', 'arm64', true)).toBe('linux_arm64_musl');
    expect(manifestPlatform('freebsd', 'x64')).toBeNull();
    expect(manifestPlatform('linux', 'ia32')).toBeNull();
  });
});

describe('status() 与版本缓存', () => {
  it('按路径 + mtime + size 缓存版本，变化时重新读取', async () => {
    let stat = { mtimeMs: 1000, size: 500 };
    let ver = '1.5.16';
    const runCmd = vi.fn<AgyCommandRunner>(async () => ({ code: 0, stdout: `${ver}\n`, stderr: '' }));
    const { cli, fp } = makeCli({
      statFile: () => stat,
      runCommand: runCmd,
    });
    fp.setState({ processes: 2, running: 1 });

    const s1 = await cli.status();
    expect(s1).toEqual({
      installed: true,
      custom: false,
      version: '1.5.16',
      latest: null,
      updateAvailable: false,
      checkedAt: null,
      checkError: null,
      processes: 2,
      busy: 1,
      job: null,
    });
    expect(runCmd).toHaveBeenCalledTimes(1);

    // 同一 mtime / size 命中缓存，不再起子进程
    const s2 = await cli.status();
    expect(s2.version).toBe('1.5.16');
    expect(runCmd).toHaveBeenCalledTimes(1);

    // 文件变化（后台自更新）-> 重新读取
    stat = { mtimeMs: 2000, size: 512 };
    ver = '1.5.17';
    const s3 = await cli.status();
    expect(s3.version).toBe('1.5.17');
    expect(runCmd).toHaveBeenCalledTimes(2);
  });

  it('未安装与 custom（COSYEE_AGY）状态正确', async () => {
    const a = makeCli({ resolveAgy: () => null });
    const sa = await a.cli.status();
    expect(sa.installed).toBe(false);
    expect(sa.version).toBeNull();
    expect(sa.custom).toBe(false);

    const b = makeCli({ env: () => ({ COSYEE_AGY: 'D:\\custom\\agy.exe' }) });
    const sb = await b.cli.status();
    expect(sb.installed).toBe(true);
    expect(sb.custom).toBe(true);
  });

  it('读取版本失败或超时不崩溃，返回 version=null', async () => {
    const { cli } = makeCli({
      versionTimeoutMs: 20,
      runCommand: async (_c, _a, opts) =>
        new Promise((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    });
    const st = await cli.status();
    expect(st.installed).toBe(true);
    expect(st.version).toBeNull();
  });
});

describe('check() 检查官方最新版本', () => {
  it('成功读取 manifest，使用通用 UA，正确计算 updateAvailable', async () => {
    const { cli, fetchFn } = makeCli({ platform: 'darwin', arch: 'arm64' });
    const st = await cli.check();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(`${MANIFEST_BASE_URL}/darwin_arm64.json`);
    const headers = init?.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe('antigravity-cli-check/1.0');
    expect(st.latest).toBe('1.5.17');
    expect(st.updateAvailable).toBe(true);
    expect(st.checkedAt).toBe(1_700_000_000_000);
    expect(st.checkError).toBeNull();
  });

  it('HTTP 错误 / 非法版本号 / 超大响应 / 网络异常都记入 checkError 且不崩，不影响 update()', async () => {
    const a = makeCli({ fetch: async () => jsonResponse('err', 503) });
    expect((await a.cli.check()).checkError).toContain('503');

    const b = makeCli({ fetch: async () => jsonResponse({ version: 'not-semver' }) });
    expect((await b.cli.check()).checkError).toContain('格式无效');

    const c = makeCli({ fetch: async () => jsonResponse({ version: '1.5.17' }, 200, { 'content-length': '999999' }) });
    expect((await c.cli.check()).checkError).toContain('超出限制');

    const d = makeCli({
      fetch: async () => {
        throw new Error('network down');
      },
    });
    const sd = await d.cli.check();
    expect(sd.checkError).toContain('network down');
    // check 失败不影响后续 update()
    const su = await d.cli.update();
    expect(su.job?.state).toBe('running');
    await d.cli.waitForJob();
    expect((await d.cli.status()).job).toBeNull();
  });

  it('不支持的平台给出 checkError 而不发起请求', async () => {
    const fetchFn = vi.fn();
    const { cli } = makeCli({ platform: 'freebsd', arch: 'x64', fetch: fetchFn });
    const st = await cli.check();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(st.checkError).toContain('不支持');
  });
});

describe('update() 升级与安装', () => {
  it('已安装运行 agy update，成功后重读版本、更新 updateAvailable 并回收空闲常驻进程', async () => {
    let ver = '1.5.16';
    let stat = { mtimeMs: 1000, size: 500 };
    const runCommand = vi.fn<AgyCommandRunner>(async (_cmd, args, opts) => {
      if (args[0] === '--version') return { code: 0, stdout: `${ver}\n`, stderr: '' };
      opts.onLine?.('\x1b[32mUpdating to 1.5.17...\x1b[0m');
      ver = '1.5.17';
      stat = { mtimeMs: 2000, size: 600 };
      return { code: 0, stdout: 'Updated\n', stderr: '' };
    });
    const fp = fakePool({ processes: 1, running: 0 });
    const { cli } = makeCli({ pool: fp.pool, statFile: () => stat, runCommand });

    const before = await cli.check();
    expect(before.version).toBe('1.5.16');
    expect(before.updateAvailable).toBe(true);

    const started = await cli.update();
    expect(started.job).toEqual({ kind: 'update', state: 'running', error: null });
    await cli.waitForJob();

    const after = await cli.status();
    expect(after.job).toBeNull();
    expect(after.version).toBe('1.5.17');
    expect(after.updateAvailable).toBe(false);
    expect(fp.retireAll).toHaveBeenCalledTimes(1);
    expect(runCommand.mock.calls.some(([c, a]) => c === 'C:\\agy\\bin\\agy.exe' && a[0] === 'update')).toBe(true);
  });

  it('未安装时走官方安装脚本（Windows / Unix 分别验证），安装后重新定位并读版本', async () => {
    let installedPath: string | null = null;
    const runWin = vi.fn<AgyCommandRunner>(async (_cmd, args) => {
      if (args[0] === '--version') return { code: 0, stdout: '1.5.17\n', stderr: '' };
      installedPath = 'C:\\Users\\x\\AppData\\Local\\agy\\bin\\agy.exe';
      return { code: 0, stdout: 'installed\n', stderr: '' };
    });
    const w = makeCli({ platform: 'win32', resolveAgy: () => installedPath, runCommand: runWin });
    const sw = await w.cli.update();
    expect(sw.job?.kind).toBe('install');
    await w.cli.waitForJob();
    const afterW = await w.cli.status();
    expect(afterW.installed).toBe(true);
    expect(afterW.version).toBe('1.5.17');
    expect(afterW.job).toBeNull();
    expect(runWin.mock.calls[0]![0]).toBe('powershell.exe');
    expect(runWin.mock.calls[0]![1]).toContain('-NoProfile');
    expect(runWin.mock.calls[0]![1].join(' ')).toContain(INSTALL_PS1_URL);

    let unixPath: string | null = null;
    const runUnix = vi.fn<AgyCommandRunner>(async (_cmd, args) => {
      if (args[0] === '--version') return { code: 0, stdout: '1.5.17\n', stderr: '' };
      unixPath = '/home/u/.local/bin/agy';
      return { code: 0, stdout: 'installed\n', stderr: '' };
    });
    const u = makeCli({ platform: 'darwin', resolveAgy: () => unixPath, runCommand: runUnix });
    await u.cli.update();
    await u.cli.waitForJob();
    expect((await u.cli.status()).version).toBe('1.5.17');
    expect(runUnix.mock.calls[0]![0]).toBe('bash');
    expect(runUnix.mock.calls[0]![1][1]).toContain(INSTALL_SH_URL);
  });

  it('custom 时 409；单飞进行中再次调用 409；非 0 退出码记为 failed 带可读错误', async () => {
    const customCli = makeCli({ env: () => ({ COSYEE_AGY: 'D:\\agy.exe' }) });
    await expect(customCli.cli.update()).rejects.toMatchObject({ status: 409 });

    let release!: () => void;
    const runCommand = vi.fn<AgyCommandRunner>(async (_cmd, args) => {
      if (args[0] === '--version') return { code: 0, stdout: '1.5.16\n', stderr: '' };
      await new Promise<void>((r) => {
        release = r;
      });
      return { code: 2, stdout: '', stderr: 'Permission denied\n' };
    });
    const { cli } = makeCli({ runCommand });
    await cli.update();
    await expect(cli.update()).rejects.toBeInstanceOf(HttpError);
    await expect(cli.update()).rejects.toMatchObject({ status: 409 });

    release();
    await cli.waitForJob();
    const st = await cli.status();
    expect(st.job).toEqual({
      kind: 'update',
      state: 'failed',
      error: '升级失败（退出码 2）: Permission denied',
    });
  });

  it('超时中止命令并标记 failed；dispose 不杀正在进行的更新任务', async () => {
    let aborted = false;
    const { cli } = makeCli({
      jobTimeoutMs: 30,
      runCommand: async (_cmd, args, opts) => {
        if (args[0] === '--version') return { code: 0, stdout: '1.5.16\n', stderr: '' };
        return new Promise((_resolve, reject) => {
          opts.signal?.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new Error('aborted'));
            },
            { once: true },
          );
        });
      },
    });
    await cli.update();
    await cli.waitForJob();
    expect(aborted).toBe(true);
    const st = await cli.status();
    expect(st.job?.state).toBe('failed');
    expect(st.job?.error).toContain('超时');

    // dispose 不中止正在进行的更新子进程
    let updateAborted = false;
    let finishUpdate!: () => void;
    const d = makeCli({
      jobTimeoutMs: 10_000,
      runCommand: async (_cmd, args, opts) => {
        if (args[0] === '--version') return { code: 0, stdout: '1.5.16\n', stderr: '' };
        opts.signal?.addEventListener('abort', () => {
          updateAborted = true;
        });
        await new Promise<void>((r) => {
          finishUpdate = r;
        });
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    await d.cli.update();
    d.cli.dispose();
    expect(updateAborted).toBe(false);
    finishUpdate();
    await d.cli.waitForJob();
  });
});

describe('log() 游标、截断、ANSI 与脱敏', () => {
  it('stripAnsi 与 sanitizeLogLine 遮盖令牌和邮箱', () => {
    expect(stripAnsi('\x1b[31mhello\x1b[0m\r')).toBe('hello');
    const line = sanitizeLogLine(
      '\x1b[33mAuthorization: Bearer abcdef1234567890 token=mysecret123 user@example.com https://x?access_token=zzz\x1b[0m',
    );
    expect(line).not.toContain('abcdef1234567890');
    expect(line).not.toContain('mysecret123');
    expect(line).not.toContain('user@example.com');
    expect(line).not.toContain('zzz');
    expect(line).toContain('[REDACTED]');
    expect(line).toContain('[REDACTED_EMAIL]');
  });

  it('日志超上限截断后 next 仍单调递增', async () => {
    const { cli } = makeCli({
      logMaxLines: 3,
      runCommand: async (_cmd, args, opts) => {
        if (args[0] === '--version') return { code: 0, stdout: '1.5.16\n', stderr: '' };
        for (let i = 1; i <= 5; i++) opts.onLine?.(`line-${i}`);
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    await cli.update();
    await cli.waitForJob();
    // 1 条开始 + 5 条输出 + 1 条完成 = 7 条，保留最近 3 条（base=4, next=7）
    const first = cli.log(0);
    expect(first.next).toBe(7);
    expect(first.lines).toHaveLength(3);
    expect(first.lines[0]).toBe('line-4');

    const incremental = cli.log(first.next);
    expect(incremental).toEqual({ lines: [], next: 7 });

    const mid = cli.log(5);
    expect(mid.next).toBe(7);
    expect(mid.lines).toHaveLength(2);
  });
});

describe('restart() 与路由处理器 agyCliRoutes', () => {
  it('restart 空闲回收、忙碌 409 RunningError、force 强制终止', async () => {
    const fp = fakePool({ processes: 2, running: 2 });
    const { cli } = makeCli({ pool: fp.pool });

    await expect(cli.restart()).rejects.toBeInstanceOf(RunningError);
    await expect(cli.restart()).rejects.toMatchObject({ status: 409, running: 2 });

    const forced = await cli.restart({ force: true });
    expect(forced.processes).toBe(0);
    expect(forced.busy).toBe(0);
    expect(fp.stopAll).toHaveBeenCalledWith(true);
  });

  it('agyCliRoutes 覆盖全部路由、fromLocal 403、from 参数校验、409 与未命中返回 null', async () => {
    const fp = fakePool({ processes: 1, running: 1 });
    const { cli } = makeCli({ pool: fp.pool });
    const q = (s = '') => new URLSearchParams(s);

    // 未命中
    expect(await agyCliRoutes(cli, { method: 'GET', pathname: '/api/other', query: q(), fromLocal: true })).toBeNull();
    expect(await agyCliRoutes(cli, { method: 'DELETE', pathname: '/api/agy/cli', query: q(), fromLocal: true })).toBeNull();

    // GET /api/agy/cli
    const rStatus = await agyCliRoutes(cli, { method: 'GET', pathname: '/api/agy/cli', query: q(), fromLocal: false });
    expect(rStatus?.status).toBe(200);

    // GET /api/agy/cli/log 参数校验
    expect((await agyCliRoutes(cli, { method: 'GET', pathname: '/api/agy/cli/log', query: q('from=0'), fromLocal: false }))?.status).toBe(200);
    expect((await agyCliRoutes(cli, { method: 'GET', pathname: '/api/agy/cli/log', query: q('from=-1'), fromLocal: true }))?.status).toBe(400);
    expect((await agyCliRoutes(cli, { method: 'GET', pathname: '/api/agy/cli/log', query: q('from=abc'), fromLocal: true }))?.status).toBe(400);
    expect((await agyCliRoutes(cli, { method: 'GET', pathname: '/api/agy/cli/log', query: q('from=1.5'), fromLocal: true }))?.status).toBe(400);

    // 所有 POST 要求 fromLocal
    for (const p of ['/api/agy/cli/check', '/api/agy/cli/update', '/api/agy/cli/restart']) {
      const r = await agyCliRoutes(cli, { method: 'POST', pathname: p, query: q(), fromLocal: false });
      expect(r?.status).toBe(403);
    }

    // POST /api/agy/cli/check
    const rCheck = await agyCliRoutes(cli, { method: 'POST', pathname: '/api/agy/cli/check', query: q(), fromLocal: true });
    expect(rCheck?.status).toBe(200);

    // POST /api/agy/cli/restart 无 force -> 409 { error, running }
    const rRestart409 = await agyCliRoutes(cli, { method: 'POST', pathname: '/api/agy/cli/restart', query: q(), fromLocal: true });
    expect(rRestart409?.status).toBe(409);
    expect(rRestart409?.body).toMatchObject({ running: 1 });

    // POST /api/agy/cli/restart?force=1 -> 200
    const rRestartOk = await agyCliRoutes(cli, { method: 'POST', pathname: '/api/agy/cli/restart', query: q('force=1'), fromLocal: true });
    expect(rRestartOk?.status).toBe(200);
    expect((rRestartOk?.body as any).processes).toBe(0);

    // POST /api/agy/cli/update
    const rUpd = await agyCliRoutes(cli, { method: 'POST', pathname: '/api/agy/cli/update', query: q(), fromLocal: true });
    expect(rUpd?.status).toBe(200);
    await cli.waitForJob();
  });
});
