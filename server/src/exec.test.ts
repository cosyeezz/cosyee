import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isRunnableLang, snippetShell } from '@cosyee/shared';
import { findGitBash, runSnippet } from './exec.js';

const isWin = process.platform === 'win32';
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-exec-'));
afterAll(() => fs.rmSync(cwd, { recursive: true, force: true }));

describe('可运行语言', () => {
  it('语言映射（大小写不敏感），cmd 只在 Windows 上', () => {
    expect(snippetShell('PowerShell', 'win32')).toBe('powershell');
    expect(snippetShell('ps1', 'linux')).toBe('powershell');
    expect(snippetShell('sh', 'darwin')).toBe('bash');
    expect(snippetShell('zsh', 'darwin')).toBe('zsh');
    expect(snippetShell('bat', 'win32')).toBe('cmd');
    expect(snippetShell('cmd', 'linux')).toBeNull();
    expect(isRunnableLang('python', 'win32')).toBe(false);
    expect(isRunnableLang(undefined, 'win32')).toBe(false);
  });
  it('不支持的语言 400', async () => {
    await expect(runSnippet({ lang: 'python', code: 'print(1)', cwd })).rejects.toMatchObject({ status: 400 });
  });
});

describe.runIf(isWin)('Windows 上运行', () => {
  it('powershell：输出、工作目录、中文、退出码', async () => {
    const r = await runSnippet({ lang: 'powershell', code: 'Write-Output "hi 你好"\n(Get-Location).Path\nexit 3', cwd });
    expect(r.stdout).toContain('hi 你好');
    expect(r.stdout.toLowerCase()).toContain(path.basename(cwd).toLowerCase());
    expect(r.exitCode).toBe(3);
    expect(r.timedOut).toBe(false);
  }, 30_000);
  it('powershell：外部程序的非零退出码透传', async () => {
    const r = await runSnippet({ lang: 'pwsh', code: 'cmd /c exit 5', cwd });
    expect(r.exitCode).toBe(5);
  }, 30_000);
  it('cmd：多行脚本', async () => {
    const r = await runSnippet({ lang: 'cmd', code: 'echo hi\necho 中文', cwd });
    expect(r.stdout).toContain('hi');
    expect(r.stdout).toContain('中文');
    expect(r.exitCode).toBe(0);
  }, 30_000);
  it('输出超过上限时截断', async () => {
    const r = await runSnippet({ lang: 'powershell', code: '"x" * 5000', cwd, outputLimit: 100 });
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(100);
  }, 30_000);
  it('powershell：错误进 stderr，退出码非零', async () => {
    const r = await runSnippet({ lang: 'powershell', code: 'Get-Item C:\\cosyee-nope-xyz', cwd });
    expect(r.stderr).toMatch(/cosyee-nope-xyz/);
    expect(r.exitCode).not.toBe(0);
  }, 30_000);
  it('bash：走 Git Bash（没装就报 400）', async () => {
    if (!(await findGitBash())) {
      await expect(runSnippet({ lang: 'bash', code: 'echo hi', cwd })).rejects.toMatchObject({ status: 400 });
      return;
    }
    const r = await runSnippet({ lang: 'bash', code: 'echo "hi $(basename "$PWD")"\nls /cosyee-nope >&2; exit 4', cwd });
    expect(r.stdout).toContain(`hi ${path.basename(cwd)}`);
    expect(r.stderr).toMatch(/cosyee-nope/);
    expect(r.exitCode).toBe(4);
  }, 30_000);
  it('超时杀掉进程', async () => {
    const r = await runSnippet({ lang: 'cmd', code: 'ping -n 30 127.0.0.1 >nul', cwd, timeoutMs: 500 });
    expect(r.timedOut).toBe(true);
    expect(r.durationMs).toBeLessThan(15_000);
  }, 30_000);
  it('中止信号杀掉进程', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const r = await runSnippet({ lang: 'cmd', code: 'ping -n 30 127.0.0.1 >nul', cwd, signal: ac.signal });
    expect(r.timedOut).toBe(false);
    expect(r.durationMs).toBeLessThan(15_000);
  }, 30_000);
});

describe.runIf(!isWin)('类 Unix 上运行', () => {
  it('bash：输出与退出码', async () => {
    const r = await runSnippet({ lang: 'bash', code: 'echo hi; pwd; exit 3', cwd });
    expect(r.stdout).toContain('hi');
    expect(r.exitCode).toBe(3);
  });
  it('超时杀掉进程', async () => {
    const r = await runSnippet({ lang: 'sh', code: 'sleep 30', cwd, timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
  }, 15_000);
});
