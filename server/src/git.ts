// 读取 cwd 的 git 分支。失败或非仓库返回 null；detached HEAD 返回短 sha。
import { execFile } from 'node:child_process';

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 3000, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      if (err) return resolve(null);
      const s = String(stdout).trim();
      resolve(s || null);
    });
  });
}

export async function gitBranch(cwd: string): Promise<string | null> {
  const name = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (name && name !== 'HEAD') return name;
  if (name === 'HEAD') {
    // detached：返回短 sha
    return git(cwd, ['rev-parse', '--short', 'HEAD']);
  }
  // 还没有任何提交的新仓库：rev-parse 会失败，但 symbolic-ref 能读到分支名
  return git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
}
