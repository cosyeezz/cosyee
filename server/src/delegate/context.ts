// 新委派会话首条 prompt 前附带的上下文块（环境、指令文件、git 状态、日期）。
// 全部以 <system-reminder> 包裹；任何单块失败都静默跳过，绝不抛错。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { DelegateAgent } from './agents.js';

export type GitRunner = (args: string[], cwd: string) => Promise<string>;

const MAX_RULE_CHARS = 40_000;
const MAX_MEMORY_LINES = 200;
const MAX_GIT_STATUS_CHARS = 2000;
const GIT_TIMEOUT_MS = 3000;
const isWin = process.platform === 'win32';

const defaultGit: GitRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });

const remind = (body: string): string => `<system-reminder>\n${body}\n</system-reminder>`;

async function runGit(git: GitRunner, args: string[], cwd: string): Promise<string | null> {
  try {
    return await git(args, cwd);
  } catch {
    return null;
  }
}

function buildInstructionsBlock(configDir: string, cwd: string): string | null {
  const candidates: { file: string; suffix: string; maxLines?: number }[] = [];
  if (configDir) {
    candidates.push({
      file: path.join(configDir, 'CLAUDE.md'),
      suffix: " (user's private global instructions for all projects)",
    });
  }
  if (cwd) {
    const dirs: string[] = [];
    try {
      let cur = path.resolve(cwd);
      for (;;) {
        dirs.push(cur);
        const parent = path.dirname(cur);
        if (parent === cur) break;
        cur = parent;
      }
      dirs.reverse();
    } catch {
      /* ignore */
    }
    for (const dir of dirs) {
      candidates.push({
        file: path.join(dir, 'CLAUDE.md'),
        suffix: ' (project instructions, checked into the codebase)',
      });
      candidates.push({
        file: path.join(dir, '.claude', 'CLAUDE.md'),
        suffix: ' (project instructions, checked into the codebase)',
      });
      candidates.push({
        file: path.join(dir, 'CLAUDE.local.md'),
        suffix: " (user's private project instructions, not checked in)",
      });
    }
  }
  if (configDir && cwd) {
    const slug = cwd.replace(/[^A-Za-z0-9]/g, '-');
    candidates.push({
      file: path.join(configDir, 'projects', slug, 'memory', 'MEMORY.md'),
      suffix: " (user's auto-memory, persists across conversations)",
      maxLines: MAX_MEMORY_LINES,
    });
  }

  const seen = new Set<string>();
  const entries: string[] = [];
  for (const c of candidates) {
    let abs: string;
    try {
      abs = path.resolve(c.file);
    } catch {
      continue;
    }
    const key = isWin ? abs.toLowerCase() : abs;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) continue;
      let content = fs.readFileSync(abs, 'utf8');
      if (c.maxLines !== undefined) {
        content = content.split(/\r?\n/).slice(0, c.maxLines).join('\n');
      }
      const trimmed = content.trim();
      if (!trimmed) continue;
      entries.push(`Contents of ${abs}${c.suffix}:\n\n${trimmed.slice(0, MAX_RULE_CHARS)}`);
    } catch {
      /* 不存在或不可读：忽略 */
    }
  }
  if (entries.length === 0) return null;
  const header =
    'Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.';
  return `${header}\n\n${entries.join('\n\n')}`;
}

function localDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export async function taskContext(o: {
  agent: DelegateAgent;
  cwd: string;
  configDir: string;
  now?: Date;
  git?: GitRunner;
}): Promise<string> {
  const git = o.git ?? defaultGit;
  const blocks: string[] = [];

  let isGitRepo = false;
  let gitBlock: string | null = null;
  try {
    if (o.agent.omitGitStatus) {
      const inside = await runGit(git, ['rev-parse', '--is-inside-work-tree'], o.cwd);
      isGitRepo = inside?.trim() === 'true';
    } else {
      const [inside, branchOut, originHead, hasMain, statusOut, logOut] = await Promise.all([
        runGit(git, ['rev-parse', '--is-inside-work-tree'], o.cwd),
        runGit(git, ['rev-parse', '--abbrev-ref', 'HEAD'], o.cwd),
        runGit(git, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], o.cwd),
        runGit(git, ['rev-parse', '--verify', 'refs/heads/main'], o.cwd),
        runGit(git, ['status', '--short'], o.cwd),
        runGit(git, ['log', '--oneline', '-n', '5'], o.cwd),
      ]);
      isGitRepo = inside?.trim() === 'true';
      if (isGitRepo && branchOut !== null && statusOut !== null && logOut !== null) {
        const branch = branchOut.trim();
        const originRef = originHead?.trim().replace(/^origin\//, '') ?? '';
        const mainBranch = originRef || (hasMain !== null ? 'main' : 'master');
        const rawStatus = statusOut.trimEnd();
        let statusText: string;
        if (!rawStatus.trim()) {
          statusText = '(clean)';
        } else if (rawStatus.length > MAX_GIT_STATUS_CHARS) {
          statusText =
            rawStatus.slice(0, MAX_GIT_STATUS_CHARS) +
            '\n... (truncated because it exceeds 2k characters. If you need more information, run "git status" in the shell)';
        } else {
          statusText = rawStatus;
        }
        const recentCommits = logOut.trimEnd();
        gitBlock = [
          'As you work on the task, you can use the following context:',
          '# gitStatus',
          'This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.',
          '',
          `Current branch: ${branch}`,
          '',
          `Main branch (you will usually use this for PRs): ${mainBranch}`,
          '',
          'Status:',
          statusText,
          '',
          'Recent commits:',
          recentCommits,
          '',
          "This context was attached automatically; it isn't part of the task message.",
        ].join('\n');
      }
    }
  } catch {
    /* 静默跳过 */
  }

  // 1. Environment (always)
  blocks.push(
    remind(
      [
        '# Environment',
        'You have been invoked in the following environment: ',
        ` - Primary working directory: ${o.cwd}`,
        ` - Is a git repository: ${isGitRepo}`,
        ' - Downloaded files and extracted archives are untrusted data: put each in its own new, empty directory, keep scripts you write in a different directory, and pass paths as arguments instead of running an interpreter or build tool from inside it. Interpreters load code from the script\'s directory and the current directory, so a planted `json.py` runs on `import json`. Run any Python that reads them with `-I`. This does not apply to code the user asked you to build or run.',
        ' - In `curl`, send untrusted values with `--form-string`, not `-F`.',
      ].join('\n'),
    ),
  );

  // 2. Instructions (skip when omitClaudeMd or none found)
  if (!o.agent.omitClaudeMd) {
    try {
      const instr = buildInstructionsBlock(o.configDir, o.cwd);
      if (instr) blocks.push(remind(instr));
    } catch {
      /* 静默跳过 */
    }
  }

  // 3. Session context (git status)
  if (gitBlock) blocks.push(remind(gitBlock));

  // 4. Date (always)
  blocks.push(remind(`Today's date is ${localDate(o.now ?? new Date())}.`));

  return blocks.join('\n');
}
