import { describe, expect, it, vi } from 'vitest';
import { RunningError } from './accounts/index.js';
import { createCodexAdapter } from './components/codex.js';
import { sanitizeLogLine } from './delegate/agyCli.js';
import {
  CODEX_INSTALL_PS1_URL,
  CODEX_INSTALL_SH_URL,
  CODEX_NPM_LATEST_URL,
  CodexCli,
  type CodexCliOptions,
  type CodexCliPool,
  type CodexCommandRunner,
} from './delegate/codexCli.js';
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
  const pool: CodexCliPool = {
    stats: () => ({ processes, sessions: 0, busy: running }),
    runningCount: () => running,
    retireAll,
    stopAll,
  };
  return { pool, retireAll, stopAll };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeCli(opts: CodexCliOptions = {}) {
  const fp = fakePool();
  const runCommand =
    opts.runCommand ??
    vi.fn<CodexCommandRunner>(async (_cmd, args) => {
      if (args[0] === '--version') return { code: 0, stdout: 'codex-cli 0.144.6\n', stderr: '' };
      return { code: 0, stdout: 'ok\n', stderr: '' };
    });
  const fetchFn = opts.fetch ?? vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ version: '0.145.0' }));
  const cli = new CodexCli({
    pool: fp.pool,
    resolveCodex: () => ({ execPath: 'C:\\npm\\codex.exe', rawPath: 'C:\\npm\\codex.cmd', installKind: 'npm' }),
    env: () => ({}),
    statFile: () => ({ mtimeMs: 1000, size: 500 }),
    findNpm: () => 'C:\\Program Files\\nodejs\\npm.cmd',
    platform: 'win32',
    now: () => 1_700_000_000_000,
    ...opts,
    runCommand,
    fetch: fetchFn,
  });
  return { cli, fp, runCommand, fetchFn };
}

describe('CodexCli 状态、版本缓存与日志脱敏', () => {
  it('sanitizeLogLine 遮盖 OpenAI API Key（sk- / sk-proj-）', () => {
    expect(sanitizeLogLine('key=sk-proj-1234567890abcdefABCDEF123456')).not.toContain('sk-proj-');
    expect(sanitizeLogLine('using sk-abcdefghijklmnop1234567890 here')).toBe('using [REDACTED] here');
  });

  it('status() 读取版本并按 stat 缓存；mtime 变化时重读；cachedVersion() 同步命中缓存', async () => {
    let mtime = 1000;
    let ver = 'codex-cli 0.144.6';
    const { cli, runCommand } = makeCli({
      statFile: () => ({ mtimeMs: mtime, size: 500 }),
      runCommand: vi.fn<CodexCommandRunner>(async () => ({ code: 0, stdout: ver, stderr: '' })),
    });
    const s1 = await cli.status();
    expect(s1).toMatchObject({ installed: true, custom: false, installKind: 'npm', version: '0.144.6', updateAvailable: false });
    expect(cli.cachedVersion()).toBe('0.144.6');
    await cli.status();
    expect(runCommand).toHaveBeenCalledTimes(1);

    mtime = 2000;
    ver = 'codex-cli 0.145.0';
    const s2 = await cli.status();
    expect(s2.version).toBe('0.145.0');
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it('check() 查询 npm latest 并校验严格 semver（拒绝 alpha 预发布）', async () => {
    const { cli, fetchFn } = makeCli();
    const s = await cli.check();
    expect(fetchFn).toHaveBeenCalledWith(CODEX_NPM_LATEST_URL, expect.any(Object));
    expect(s.latest).toBe('0.145.0');
    expect(s.updateAvailable).toBe(true);
    expect(s.checkError).toBeNull();

    const { cli: cliAlpha } = makeCli({
      fetch: vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ version: '0.146.0-alpha.1' })),
    });
    const s2 = await cliAlpha.check();
    expect(s2.latest).toBeNull();
    expect(s2.checkError).toContain('格式无效');
  });
});

describe('CodexCli 安装与升级渠道', () => {
  it('npm 渠道升级走 npm install -g @openai/codex@latest，成功后 retireAll 并触发 onUpdated', async () => {
    const onUpdated = vi.fn();
    const { cli, fp, runCommand } = makeCli({ onUpdated });
    await cli.update();
    await cli.waitForJob();
    // 必须用 npm 的绝对路径：裸名 "npm.cmd" 经 cmd.exe 启动时 %~dp0 会变成 cwd，npm 会找不到 npm-cli.js
    expect(runCommand).toHaveBeenCalledWith('C:\\Program Files\\nodejs\\npm.cmd', ['install', '-g', '@openai/codex@latest'], expect.any(Object));
    expect(fp.retireAll).toHaveBeenCalledTimes(1);
    expect(onUpdated).toHaveBeenCalledTimes(1);
    expect((await cli.status()).job).toBeNull();
  });

  it('npm 渠道但找不到 npm 时直接失败，不去跑裸名 npm', async () => {
    const { cli, runCommand } = makeCli({ findNpm: () => null });
    await cli.update();
    await cli.waitForJob();
    expect(runCommand).not.toHaveBeenCalledWith(expect.anything(), ['install', '-g', '@openai/codex@latest'], expect.anything());
    expect((await cli.status()).job).toMatchObject({ state: 'failed', error: expect.stringContaining('找不到 npm') });
  });

  it('standalone / 无 npm 时走官方安装脚本（Windows & Unix）', async () => {
    let installed = false;
    const { cli: winCli, runCommand: winRun } = makeCli({
      resolveCodex: () => (installed ? { execPath: 'C:\\codex.exe', rawPath: 'C:\\codex.exe', installKind: 'standalone' } : null),
      findNpm: () => null,
      platform: 'win32',
      runCommand: vi.fn<CodexCommandRunner>(async (cmd, args) => {
        if (args[0] === '--version') return { code: 0, stdout: 'codex-cli 0.145.0', stderr: '' };
        installed = true;
        return { code: 0, stdout: 'installed', stderr: '' };
      }),
    });
    await winCli.update();
    await winCli.waitForJob();
    expect(winRun).toHaveBeenCalledWith(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `irm ${CODEX_INSTALL_PS1_URL} | iex`],
      expect.any(Object),
    );

    const { cli: unixCli, runCommand: unixRun } = makeCli({
      resolveCodex: () => ({ execPath: '/usr/local/bin/codex', rawPath: '/usr/local/bin/codex', installKind: 'standalone' }),
      platform: 'darwin',
    });
    await unixCli.update();
    await unixCli.waitForJob();
    expect(unixRun).toHaveBeenCalledWith('sh', ['-c', `curl -fsSL ${CODEX_INSTALL_SH_URL} | sh`], expect.any(Object));
  });

  it('custom（COSYEE_CODEX）拒绝升级抛 409；restart 有任务抛 RunningError', async () => {
    const { cli } = makeCli({
      env: () => ({ COSYEE_CODEX: 'C:\\custom\\codex.exe' }),
      resolveCodex: () => ({ execPath: 'C:\\custom\\codex.exe', rawPath: 'C:\\custom\\codex.exe', installKind: 'custom' }),
    });
    await expect(cli.update()).rejects.toMatchObject({ status: 409 });

    const fp = fakePool({ processes: 1, running: 2 });
    const { cli: busyCli } = makeCli({ pool: fp.pool });
    await expect(busyCli.restart()).rejects.toBeInstanceOf(RunningError);
    await busyCli.restart({ force: true });
    expect(fp.stopAll).toHaveBeenCalledWith(true);
  });

  it('createCodexAdapter 正确映射 ComponentAdapter', async () => {
    const { cli } = makeCli();
    const adapter = createCodexAdapter(cli);
    expect(adapter.id).toBe('codex');
    expect(adapter.installable).toBe(true);
    await adapter.check();
    const info = await adapter.info();
    expect(info.version).toBe('0.144.6');
    expect(info.latest).toBe('0.145.0');
    expect(info.updateAvailable).toBe(true);
    await adapter.update();
    expect(adapter.log(0).lines.length).toBeGreaterThan(0);
    cli.dispose();
  });
});
