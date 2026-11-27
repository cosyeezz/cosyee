// 会话里代码块的「运行」：在会话工作目录里用对应的解释器执行一段代码，收集输出后一次返回；
// 给了 onOutput 时同时把输出逐块推出去（常驻服务一类不会自己退出的命令靠它看到输出）。
// 代码一律先写进临时文件，再把文件路径作为参数 / 环境变量交给解释器，不拼进任何命令行字符串；
// spawn 不经过 shell。超时或客户端中止时杀掉整个进程树。
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { type ExecResult, type SnippetShell, snippetShell } from '@cosyee/shared';
import { HttpError } from './workspaces.js';

export const EXEC_TIMEOUT_MS = 120_000;
export const EXEC_OUTPUT_LIMIT = 64 * 1024;

export interface RunSnippetOpts {
  lang: string;
  code: string;
  cwd: string;
  signal?: AbortSignal;
  /** 0 表示不限时（只靠 signal 结束） */
  timeoutMs?: number;
  /** 输出逐块回调（已按 UTF-8 解码，不会切断多字节字符）；不受单路输出上限影响 */
  onOutput?: (stream: 'stdout' | 'stderr', data: string) => void;
  /** 测试用：覆盖单路输出上限 */
  outputLimit?: number;
}

interface Launch {
  cmd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  /** 这个命令不存在时退而尝试的下一个 */
  fallback?: Launch;
}

/**
 * PowerShell 外壳：从环境变量指向的文件读出代码，作为脚本块在当前作用域执行。
 * 不用 -File（默认执行策略可能禁止 .ps1），也不把代码本身塞进 -EncodedCommand（命令行有 32K 上限）。
 * 退出码：脚本自己 exit 的照用；否则最后一个外部程序的非零退出码；再否则运行中出现过错误记 1
 *（dot-source 之后的 $? 只反映「脚本块本身执行成功」，看不出里面的 cmdlet 报错，所以比较 $Error 的条数）。
 */
const PS_BOOTSTRAP = [
  '$ErrorActionPreference = "Continue"',
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  '$OutputEncoding = [Text.Encoding]::UTF8',
  '$__cz = [ScriptBlock]::Create([IO.File]::ReadAllText($env:COSYEE_SNIPPET))',
  '$__czErr = $Error.Count',
  '. $__cz',
  'if ($LASTEXITCODE) { exit $LASTEXITCODE } elseif ($Error.Count -gt $__czErr) { exit 1 }',
].join('\n');

function psLaunch(cmd: string, file: string): Launch {
  return {
    cmd,
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(PS_BOOTSTRAP, 'utf16le').toString('base64')],
    env: { COSYEE_SNIPPET: file },
  };
}

let gitBashCache: Promise<string | null> | undefined;

/**
 * Windows 上的 Git Bash：CLAUDE_CODE_GIT_BASH_PATH → `where git` 推出的安装目录 → 常见安装位置。
 * 不直接用 PATH 里的 bash.exe：System32\bash.exe 是 WSL，不是 Git Bash。
 */
export function findGitBash(): Promise<string | null> {
  gitBashCache ??= (async () => {
    const isFile = (p: string) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    };
    const env = process.env.CLAUDE_CODE_GIT_BASH_PATH;
    if (env && isFile(env)) return env;
    const gits = await new Promise<string[]>((resolve) => {
      execFile('where', ['git'], { windowsHide: true, timeout: 3000, encoding: 'utf8' }, (err, out) =>
        resolve(err ? [] : out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)));
    });
    const candidates = gits.flatMap((g) => {
      const root = path.resolve(path.dirname(g), '..'); // <Git>\cmd\git.exe 或 <Git>\bin\git.exe
      return [path.join(root, 'bin', 'bash.exe'), path.join(root, 'usr', 'bin', 'bash.exe')];
    });
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]) {
      if (base) candidates.push(path.join(base, 'Git', 'bin', 'bash.exe'));
    }
    return candidates.find(isFile) ?? null;
  })();
  return gitBashCache;
}

/** 各解释器的临时脚本扩展名 + 文件内容 */
function scriptFile(shell: SnippetShell, code: string): { ext: string; content: string } {
  if (shell === 'cmd') return { ext: '.cmd', content: '@chcp 65001>nul\r\n' + code.replace(/\r?\n/g, '\r\n') + '\r\n' };
  if (shell === 'powershell') return { ext: '.ps1', content: code };
  return { ext: '.sh', content: code.replace(/\r\n/g, '\n') + '\n' };
}

async function launchFor(shell: SnippetShell, file: string, platform: NodeJS.Platform): Promise<Launch> {
  const win = platform === 'win32';
  if (shell === 'powershell') {
    return win ? { ...psLaunch('pwsh.exe', file), fallback: psLaunch('powershell.exe', file) } : psLaunch('pwsh', file);
  }
  if (shell === 'cmd') return { cmd: process.env.ComSpec || 'cmd.exe', args: ['/d', '/c', file] };
  if (win) {
    const bash = await findGitBash();
    if (!bash) throw new HttpError(400, '未找到 Git Bash，无法运行 bash 代码');
    return { cmd: bash, args: ['--noprofile', '--norc', file.replace(/\\/g, '/')] };
  }
  return shell === 'zsh' ? { cmd: 'zsh', args: ['-f', file] } : { cmd: 'bash', args: ['--noprofile', '--norc', file] };
}

function killTree(proc: ChildProcess): void {
  const pid = proc.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    } catch { /* ignore */ }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL'); // detached 启动，pid 即进程组
  } catch {
    try {
      proc.kill('SIGKILL');
    } catch { /* ignore */ }
  }
}

/** 还在运行的进程：服务退出时一并杀掉，免得不限时的命令（如本地 HTTP 服务）变成孤儿进程 */
const live = new Set<ChildProcess>();
let exitHookInstalled = false;
function track(proc: ChildProcess): void {
  live.add(proc);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => { for (const p of live) killTree(p); });
}

/** 收集一路输出，超过上限后丢弃（按字节截断，最后统一按 UTF-8 解码） */
class Sink {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;
  constructor(private limit: number) {}
  push(b: Buffer): void {
    const room = this.limit - this.size;
    if (room <= 0) {
      this.truncated = true;
      return;
    }
    if (b.length > room) {
      this.truncated = true;
      b = b.subarray(0, room);
    }
    this.chunks.push(b);
    this.size += b.length;
  }
  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

type Outcome = { notFound: true } | { notFound: false; result: ExecResult };

function runOnce(l: Launch, o: RunSnippetOpts, start: number): Promise<Outcome> {
  return new Promise((resolve) => {
    const limit = o.outputLimit ?? EXEC_OUTPUT_LIMIT;
    const out = new Sink(limit);
    const err = new Sink(limit);
    let timedOut = false;
    let settled = false;
    const proc = spawn(l.cmd, l.args, {
      cwd: o.cwd,
      // PYTHONUNBUFFERED：stdout 不是终端时 Python 默认整块缓冲，流式显示时会长时间看不到输出
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb', PYTHONUNBUFFERED: '1', ...l.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    track(proc);
    const timeoutMs = o.timeoutMs ?? EXEC_TIMEOUT_MS;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          killTree(proc);
        }, timeoutMs)
      : undefined;
    const onAbort = () => killTree(proc);
    o.signal?.addEventListener('abort', onAbort, { once: true });
    const done = (v: Outcome) => {
      if (settled) return;
      settled = true;
      live.delete(proc);
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      resolve(v);
    };
    const outDec = new StringDecoder('utf8');
    const errDec = new StringDecoder('utf8');
    const emit = (stream: 'stdout' | 'stderr', s: string) => { if (s) o.onOutput?.(stream, s); };
    proc.stdout!.on('data', (b: Buffer) => { out.push(b); if (o.onOutput) emit('stdout', outDec.write(b)); });
    proc.stderr!.on('data', (b: Buffer) => { err.push(b); if (o.onOutput) emit('stderr', errDec.write(b)); });
    proc.once('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return done({ notFound: true });
      const msg = `启动失败：${e.message}\n`;
      err.push(Buffer.from(msg));
      emit('stderr', msg);
      done({ notFound: false, result: { exitCode: null, stdout: out.text(), stderr: err.text(), timedOut, truncated: out.truncated || err.truncated, durationMs: Date.now() - start } });
    });
    proc.once('close', (code) => {
      if (o.onOutput) {
        emit('stdout', outDec.end());
        emit('stderr', errDec.end());
      }
      done({ notFound: false, result: { exitCode: code, stdout: out.text(), stderr: err.text(), timedOut, truncated: out.truncated || err.truncated, durationMs: Date.now() - start } });
    });
    if (o.signal?.aborted) onAbort();
  });
}

export async function runSnippet(o: RunSnippetOpts, platform: NodeJS.Platform = process.platform): Promise<ExecResult> {
  const shell = snippetShell(o.lang, platform);
  if (!shell) throw new HttpError(400, `不支持运行 ${o.lang || '该'} 语言的代码`);
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cosyee-run-'));
  try {
    const { ext, content } = scriptFile(shell, o.code);
    const file = path.join(dir, `snippet${ext}`);
    await fs.promises.writeFile(file, content, 'utf8');
    const start = Date.now();
    let l: Launch | undefined = await launchFor(shell, file, platform);
    while (l) {
      const r = await runOnce(l, o, start);
      if (!r.notFound) return r.result;
      l = l.fallback;
    }
    throw new HttpError(400, `找不到 ${shell} 解释器`);
  } finally {
    // 进程树刚被杀时文件可能还被占用：稍后重试一次，失败就留给系统清理临时目录
    fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
  }
}
