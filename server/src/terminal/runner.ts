// 单条终端命令的执行：独立 shell 进程、流式 UTF-8 解码与合并、stdin 写入、进程树终止、最终 cwd 捕获。
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { TermBlockState, TermShell } from '@cosyee/shared';
import { killTree } from '../exec.js';
import { normalizeDir } from '../paths.js';

/** 输出分片合并间隔（毫秒） */
const FLUSH_MS = 30;

/**
 * PowerShell 引导脚本：不加 -NonInteractive（以便 stdin 可交互）；
 * 从环境变量 COSYEE_TERM_SCRIPT 读出命令文本在当前作用域执行；
 * 无论是否 exit / 报错，finally 里都将当前目录写入 COSYEE_TERM_CWD；
 * 退出码规则同 exec.ts：显式 exit 照用，否则外部程序 $LASTEXITCODE，否则 cmdlet 错误计数增量记 1。
 */
const PS_BOOTSTRAP = [
  '$ErrorActionPreference = "Continue"',
  '$ProgressPreference = "SilentlyContinue"',
  '[Console]::InputEncoding = [Text.Encoding]::UTF8',
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  '$OutputEncoding = [Text.Encoding]::UTF8',
  '$__czCode = [IO.File]::ReadAllText($env:COSYEE_TERM_SCRIPT, [Text.Encoding]::UTF8)',
  '$__czErr = $Error.Count',
  '$global:LASTEXITCODE = 0',
  'try {',
  '  $__cz = [ScriptBlock]::Create($__czCode)',
  '  . $__cz',
  '} finally {',
  '  try {',
  '    $__czLoc = (Get-Location)',
  '    if ($__czLoc.Provider.Name -eq "FileSystem") {',
  '      [IO.File]::WriteAllText($env:COSYEE_TERM_CWD, $__czLoc.ProviderPath, (New-Object Text.UTF8Encoding($false)))',
  '    }',
  '  } catch {}',
  '}',
  'if ($LASTEXITCODE) { exit $LASTEXITCODE } elseif ($Error.Count -gt $__czErr) { exit 1 }',
].join('\n');

const PS_ENCODED = Buffer.from(PS_BOOTSTRAP, 'utf16le').toString('base64');

const POSIX_WRAPPER = [
  '__cz_save_cwd() {',
  '  __cz_ec=$?',
  '  pwd > "$COSYEE_TERM_CWD" 2>/dev/null || true',
  '  exit $__cz_ec',
  '}',
  'trap __cz_save_cwd EXIT',
  '. "$COSYEE_TERM_SCRIPT"',
].join('\n');

const GITBASH_WRAPPER = [
  '__cz_save_cwd() {',
  '  __cz_ec=$?',
  '  (cygpath -w "$PWD" 2>/dev/null || pwd -W 2>/dev/null || pwd) > "$COSYEE_TERM_CWD" 2>/dev/null || true',
  '  exit $__cz_ec',
  '}',
  'trap __cz_save_cwd EXIT',
  '. "$COSYEE_TERM_SCRIPT"',
].join('\n');

interface PreparedLaunch {
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  scriptFile: string;
  scriptContent: string;
  cwdFile: string;
}

function prepareLaunch(
  shell: TermShell,
  bin: string,
  cmd: string,
  tmpDir: string,
): PreparedLaunch {
  const cwdFile = path.join(tmpDir, 'cwd.txt');
  const baseEnv: NodeJS.ProcessEnv = { ...process.env };
  delete baseEnv.NO_COLOR;
  baseEnv.FORCE_COLOR = '1';
  baseEnv.CLICOLOR_FORCE = '1';
  baseEnv.TERM = 'xterm-256color';
  baseEnv.COLORTERM = 'truecolor';
  // 不强制 git 彩色（color.ui=always 会让 `git diff > a.patch` 之类的重定向混进转义码）；需要时自己加 --color

  if (shell === 'pwsh' || shell === 'powershell') {
    const scriptFile = path.join(tmpDir, 'cmd.ps1');
    return {
      bin,
      args: ['-NoLogo', '-NoProfile', '-OutputFormat', 'Text', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', PS_ENCODED],
      env: { ...baseEnv, COSYEE_TERM_SCRIPT: scriptFile, COSYEE_TERM_CWD: cwdFile },
      scriptFile,
      scriptContent: cmd,
      cwdFile,
    };
  }

  if (shell === 'cmd') {
    const scriptFile = path.join(tmpDir, 'cmd.cmd');
    const body = cmd.replace(/\r?\n/g, '\r\n');
    const scriptContent = [
      '@echo off',
      'chcp 65001>nul',
      body,
      'set "__cz_ec=%ERRORLEVEL%"',
      'cd > "%COSYEE_TERM_CWD%"',
      'exit /b %__cz_ec%',
      '',
    ].join('\r\n');
    return {
      bin,
      args: ['/d', '/c', scriptFile],
      env: { ...baseEnv, COSYEE_TERM_CWD: cwdFile },
      scriptFile,
      scriptContent,
      cwdFile,
    };
  }

  const scriptFile = path.join(tmpDir, 'cmd.sh');
  const scriptContent = cmd.replace(/\r\n/g, '\n') + '\n';

  if (shell === 'gitbash') {
    return {
      bin,
      args: ['--noprofile', '--norc', '-c', GITBASH_WRAPPER],
      env: {
        ...baseEnv,
        COSYEE_TERM_SCRIPT: scriptFile.replace(/\\/g, '/'),
        COSYEE_TERM_CWD: cwdFile.replace(/\\/g, '/'),
      },
      scriptFile,
      scriptContent,
      cwdFile,
    };
  }

  const args =
    shell === 'zsh'
      ? ['-f', '-c', POSIX_WRAPPER]
      : shell === 'bash'
        ? ['--noprofile', '--norc', '-c', POSIX_WRAPPER]
        : ['-c', POSIX_WRAPPER];

  return {
    bin,
    args,
    env: { ...baseEnv, COSYEE_TERM_SCRIPT: scriptFile, COSYEE_TERM_CWD: cwdFile },
    scriptFile,
    scriptContent,
    cwdFile,
  };
}

export interface RunCommandOpts {
  shell: TermShell;
  /** shell 可执行文件路径 */
  bin: string;
  cmd: string;
  cwd: string;
  onData: (chunk: string) => void;
  onEnd: (res: { state: TermBlockState; exitCode: number | null; endedAt: number; nextCwd?: string }) => void;
}

export interface RunningCommand {
  writeStdin(data: string): void;
  stop(): void;
  /** 等待命令彻底结束（测试 / shutdown 用） */
  done: Promise<void>;
}

function readNextCwd(cwdFile: string): string | undefined {
  try {
    const raw = fs.readFileSync(cwdFile, 'utf8').replace(/^\uFEFF/, '').trim();
    if (!raw) return undefined;
    // 取最后一行非空文本，防止意外输出污染
    const line = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop();
    if (!line) return undefined;
    const norm = normalizeDir(line);
    if (fs.statSync(norm).isDirectory()) return norm;
  } catch { /* 文件不存在或目录无效 */ }
  return undefined;
}

export function startCommand(opts: RunCommandOpts): RunningCommand {
  let proc: ChildProcess | null = null;
  let stopped = false;
  let finished = false;
  let pending = '';
  let flushTimer: NodeJS.Timeout | null = null;
  let tmpDir: string | null = null;
  let cwdFile = '';
  const stdinQueue: string[] = [];

  let resolveDone!: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });

  const flush = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pending) {
      const data = pending;
      pending = '';
      opts.onData(data);
    }
  };

  const enqueue = (text: string) => {
    if (!text) return;
    pending += text;
    if (!flushTimer) {
      flushTimer = setTimeout(flush, FLUSH_MS);
    }
  };

  const cleanupTmp = () => {
    if (!tmpDir) return;
    const dir = tmpDir;
    tmpDir = null;
    fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
  };

  const finish = (state: TermBlockState, exitCode: number | null, checkCwd: boolean) => {
    if (finished) return;
    finished = true;
    flush();
    const nextCwd = checkCwd && cwdFile ? readNextCwd(cwdFile) : undefined;
    cleanupTmp();
    opts.onEnd({ state, exitCode, endedAt: Date.now(), ...(nextCwd ? { nextCwd } : {}) });
    resolveDone();
  };

  void (async () => {
    try {
      tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cosyee-term-'));
      if (stopped) {
        finish('stopped', null, false);
        return;
      }
      const launch = prepareLaunch(opts.shell, opts.bin, opts.cmd, tmpDir);
      cwdFile = launch.cwdFile;
      await fs.promises.writeFile(launch.scriptFile, launch.scriptContent, 'utf8');
      if (stopped) {
        finish('stopped', null, false);
        return;
      }

      const child = spawn(launch.bin, launch.args, {
        cwd: opts.cwd,
        env: launch.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      proc = child;

      // 把进程尚未启动前就收到的 stdin 补写进去
      if (stdinQueue.length > 0 && child.stdin && !child.stdin.destroyed) {
        for (const chunk of stdinQueue) {
          try {
            child.stdin.write(chunk);
          } catch { /* ignore */ }
        }
        stdinQueue.length = 0;
      }
      // 忽略 stdin EPIPE（进程已退出但还在写）
      child.stdin?.on('error', () => {});

      const outDec = new StringDecoder('utf8');
      const errDec = new StringDecoder('utf8');
      child.stdout?.on('data', (b: Buffer) => enqueue(outDec.write(b)));
      child.stderr?.on('data', (b: Buffer) => enqueue(errDec.write(b)));

      child.once('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') {
          enqueue(`找不到 ${opts.shell} 可执行文件（${opts.bin}），请检查是否已安装\n`);
        } else {
          enqueue(`启动命令失败：${e.message}\n`);
        }
        finish('error', null, false);
      });

      child.once('close', (code) => {
        const tail = outDec.end() + errDec.end();
        if (tail) enqueue(tail);
        if (stopped) {
          finish('stopped', code ?? null, false);
        } else {
          finish('done', code ?? null, true);
        }
      });

      if (stopped) killTree(child);
    } catch (e) {
      enqueue(`准备执行环境失败：${e instanceof Error ? e.message : String(e)}\n`);
      finish('error', null, false);
    }
  })();

  return {
    writeStdin(data: string): void {
      if (finished || stopped) return;
      if (!proc) {
        stdinQueue.push(data);
        return;
      }
      if (proc.stdin && !proc.stdin.destroyed) {
        try {
          proc.stdin.write(data);
        } catch { /* ignore */ }
      }
    },
    stop(): void {
      if (finished || stopped) return;
      stopped = true;
      if (proc) killTree(proc);
    },
    done,
  };
}
