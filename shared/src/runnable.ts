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

/** 服务端接受的代码长度上限（字符） */
export const EXEC_CODE_LIMIT = 100 * 1024;
