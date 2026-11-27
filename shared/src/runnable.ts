// 会话里「可一键运行」的代码块语言：前端据此显示「运行」按钮，服务端据此选解释器。

export type SnippetShell = 'powershell' | 'bash' | 'zsh' | 'cmd';

const SHELL_OF_LANG: Record<string, SnippetShell> = {
  powershell: 'powershell',
  pwsh: 'powershell',
  ps: 'powershell',
  ps1: 'powershell',
  bash: 'bash',
  sh: 'bash',
  shell: 'bash',
  console: 'bash',
  zsh: 'zsh',
  cmd: 'cmd',
  bat: 'cmd',
  batch: 'cmd',
};

/** 代码块语言 → 解释器；该平台上跑不了的（非 Windows 的 cmd）返回 null */
export function snippetShell(lang: string | undefined, platform: string): SnippetShell | null {
  const shell = lang ? SHELL_OF_LANG[lang.toLowerCase()] : undefined;
  if (!shell) return null;
  if (shell === 'cmd' && platform !== 'win32') return null;
  return shell;
}

export const isRunnableLang = (lang: string | undefined, platform: string): boolean => snippetShell(lang, platform) !== null;

/** 没标语言的代码块里，这些开头的行当命令看 */
const COMMAND_HEADS = new Set([
  'python', 'python3', 'pip', 'pip3', 'uv', 'uvx', 'node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno',
  'git', 'gh', 'brew', 'curl', 'wget', 'docker', 'kubectl', 'make', 'cargo', 'go', 'java', 'mvn', 'gradle',
  'cd', 'ls', 'cat', 'echo', 'mkdir', 'cp', 'mv', 'touch', 'chmod', 'open', 'lsof', 'ps', 'kill', 'ssh', 'scp',
  'export', 'source', 'sudo',
]);
const MAX_GUESS_LINES = 3;

/**
 * 没标语言（或标成 text）的代码块：最多三行、每行的第一个词都是常见命令（或 ./ ~/ 开头的脚本路径）时，
 * 当成该平台默认的 shell 代码（Windows 上是 PowerShell，其余 bash）；否则返回 undefined。
 * 只用来决定要不要显示「运行」按钮，执行仍要用户点。
 */
export function guessSnippetLang(lang: string | undefined, code: string, platform: string): string | undefined {
  if (lang && lang.toLowerCase() !== 'text' && lang.toLowerCase() !== 'plaintext') return undefined;
  const lines = code.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0 || lines.length > MAX_GUESS_LINES) return undefined;
  const isCommand = (line: string) => {
    if (/^(?:\.\/|~\/)\S/.test(line)) return true;
    const head = /^[A-Za-z][\w.-]*/.exec(line)?.[0];
    return !!head && COMMAND_HEADS.has(head) && (line.length === head.length || /\s/.test(line[head.length]!));
  };
  if (!lines.every(isCommand)) return undefined;
  return platform === 'win32' ? 'powershell' : 'bash';
}

/** 展示用的解释器名 */
export const SHELL_LABEL: Record<SnippetShell, string> = { powershell: 'PowerShell', bash: 'Bash', zsh: 'Zsh', cmd: 'cmd' };

/** POST /api/exec 的结果 */
export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

/**
 * POST /api/exec 带 stream: true 时的响应：每行一个 JSON（application/x-ndjson）。
 * 先是若干 out，最后一条 end（stdout / stderr 为空，输出已经随 out 发过）或 error。
 */
export type ExecStreamMsg =
  | { t: 'out'; stream: 'stdout' | 'stderr'; data: string }
  | { t: 'end'; result: ExecResult }
  | { t: 'error'; message: string };

/** 服务端接受的代码长度上限（字符） */
export const EXEC_CODE_LIMIT = 100 * 1024;
