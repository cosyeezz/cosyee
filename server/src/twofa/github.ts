// GitHub 认证（gh auth token / GH_TOKEN）与 Contents / Repos API 封装
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const GITHUB_API = 'https://api.github.com';
const GITHUB_TIMEOUT_MS = 20_000;
const GH_TIMEOUT_MS = 10_000;

export class ShaConflictError extends Error {
  constructor(message = '远端文件 SHA 发生并发冲突') {
    super(message);
    this.name = 'ShaConflictError';
  }
}

export class GitHubAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubAuthError';
  }
}

/** 对外错误脱敏：绝不泄露 GitHub Token 或 Authorization 头 */
export function sanitizeGitHubError(raw: unknown, token?: string): string {
  if (raw instanceof Error && (raw.name === 'TimeoutError' || raw.name === 'AbortError')) {
    return '连接 GitHub 超时，请检查网络或代理设置';
  }
  let s = (raw instanceof Error ? raw.message : String(raw ?? '')).replace(/[\r\n\t]+/g, ' ').trim();
  if (!s) return 'GitHub 请求失败';
  if (token) s = s.split(token).join('***');
  s = s
    .replace(/\b(Bearer|Basic|token)\s+[\x21-\x7e]+/gi, '$1 ***')
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]+/g, '***')
    .replace(/\bgithub_pat_[A-Za-z0-9_]+/g, '***');
  return s.length > 240 ? s.slice(0, 240) + '…' : s;
}

function encodeContentsPath(filePath: string): string {
  return filePath.split('/').map(encodeURIComponent).join('/');
}

function githubHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'cosyee',
  };
}

async function readGitHubDetail(res: Response): Promise<string | undefined> {
  try {
    const j = (await res.json()) as { message?: unknown };
    return typeof j?.message === 'string' ? j.message : undefined;
  } catch {
    return undefined;
  }
}

function githubStatusMessage(status: number, context: 'user' | 'repo' | 'contents', detail?: string): string {
  if (status === 401) return 'GitHub 登录凭据无效或已过期，请重新运行 gh auth login';
  if (status === 403) {
    if (detail && /rate limit/i.test(detail)) return 'GitHub API 请求频率受限，请稍后再试';
    return 'GitHub 权限不足，请确认 gh auth login 已授予 repo 权限';
  }
  if (status === 404) {
    if (context === 'repo') return '仓库不存在或无访问权限';
    return '远端仓库或文件不存在，或无访问权限';
  }
  if (status === 409) return '远端文件发生并发冲突，请重试';
  if (status === 422) return detail ? `GitHub 拒绝了本次请求（${detail}）` : 'GitHub 拒绝了本次请求';
  return `GitHub API 返回错误（HTTP ${status}）`;
}

/** 构造 gh 可执行文件候选列表：先 PATH 上的 gh，Windows 补充常见安装路径 */
function ghCandidates(): string[] {
  const list = ['gh'];
  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\GitHub CLI\\gh.exe',
      ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'Programs', 'GitHub CLI', 'gh.exe')] : []),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) list.push(c);
    }
  }
  return list;
}

/** 通过 GH_TOKEN / GITHUB_TOKEN 或 `gh auth token` 获取 GitHub Token */
export async function defaultGetGhToken(): Promise<string> {
  const envToken = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim();
  if (envToken) return envToken;

  const candidates = ghCandidates();
  let lastErr: NodeJS.ErrnoException | null = null;
  let foundBinary = false;

  for (const bin of candidates) {
    try {
      const { stdout } = await execFileAsync(bin, ['auth', 'token'], {
        timeout: GH_TIMEOUT_MS,
        windowsHide: true,
      });
      foundBinary = true;
      const tok = stdout.trim();
      if (tok) return tok;
      throw new GitHubAuthError('gh 未登录（请运行 gh auth login）');
    } catch (e) {
      if (e instanceof GitHubAuthError) throw e;
      const err = e as NodeJS.ErrnoException;
      if (err?.code === 'ENOENT') {
        lastErr = err;
        continue;
      }
      foundBinary = true;
      throw new GitHubAuthError('gh 未登录（请运行 gh auth login）');
    }
  }

  if (!foundBinary && lastErr?.code === 'ENOENT') {
    throw new GitHubAuthError('gh 未安装（请先安装 GitHub CLI：winget install GitHub.cli）');
  }
  throw new GitHubAuthError('gh 未登录（请运行 gh auth login）');
}

export interface RemoteFile {
  sha: string;
  content: Buffer;
}

export interface RepoInfo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
}

export interface GitHubClientOptions {
  fetch?: typeof globalThis.fetch;
  getToken?: () => Promise<string>;
}

/** GitHub API 客户端：内存缓存 token，遇到 401 自动重新获取一次 */
export class GitHubClient {
  private cachedToken: string | null = null;

  constructor(private readonly opts: GitHubClientOptions = {}) {}

  private fetchFn(): typeof globalThis.fetch {
    return this.opts.fetch ?? globalThis.fetch;
  }

  private async token(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.cachedToken) return this.cachedToken;
    const getter = this.opts.getToken ?? defaultGetGhToken;
    const tok = (await getter()).trim();
    if (!tok) throw new GitHubAuthError('gh 未登录（请运行 gh auth login）');
    this.cachedToken = tok;
    return tok;
  }

  clearTokenCache(): void {
    this.cachedToken = null;
  }

  /** 带 401 自动刷新重试一次的请求封装 */
  private async request(
    url: string,
    init: Omit<RequestInit, 'headers' | 'signal'> & { headers?: Record<string, string> },
  ): Promise<{ res: Response; token: string }> {
    let tok = await this.token(false);
    const send = (t: string) =>
      this.fetchFn()(url, {
        ...init,
        headers: { ...githubHeaders(t), ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });

    let res: Response;
    try {
      res = await send(tok);
    } catch (e) {
      throw new Error(sanitizeGitHubError(e, tok));
    }

    if (res.status === 401) {
      this.cachedToken = null;
      tok = await this.token(true);
      try {
        res = await send(tok);
      } catch (e) {
        throw new Error(sanitizeGitHubError(e, tok));
      }
    }
    return { res, token: tok };
  }

  async getUser(): Promise<{ login: string }> {
    const { res, token } = await this.request(`${GITHUB_API}/user`, { method: 'GET' });
    if (!res.ok) {
      const detail = await readGitHubDetail(res);
      throw new Error(sanitizeGitHubError(githubStatusMessage(res.status, 'user', detail), token));
    }
    const j = (await res.json()) as { login?: unknown };
    if (!j || typeof j.login !== 'string' || !j.login.trim()) {
      throw new Error('无法获取 GitHub 用户名');
    }
    return { login: j.login.trim() };
  }

  async getRepo(fullName: string): Promise<RepoInfo | null> {
    const { res, token } = await this.request(`${GITHUB_API}/repos/${fullName}`, { method: 'GET' });
    if (res.status === 404) return null;
    if (!res.ok) {
      const detail = await readGitHubDetail(res);
      throw new Error(sanitizeGitHubError(githubStatusMessage(res.status, 'repo', detail), token));
    }
    const j = (await res.json()) as { full_name?: unknown; private?: unknown; default_branch?: unknown };
    return {
      fullName: typeof j.full_name === 'string' ? j.full_name : fullName,
      private: j.private === true,
      defaultBranch: typeof j.default_branch === 'string' && j.default_branch ? j.default_branch : 'main',
    };
  }

  async createPrivateRepo(name: string, description: string): Promise<RepoInfo> {
    const { res, token } = await this.request(`${GITHUB_API}/user/repos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        description,
        private: true,
        auto_init: true,
      }),
    });
    if (!res.ok) {
      const detail = await readGitHubDetail(res);
      throw new Error(sanitizeGitHubError(githubStatusMessage(res.status, 'repo', detail), token));
    }
    const j = (await res.json()) as { full_name?: unknown; private?: unknown; default_branch?: unknown };
    return {
      fullName: typeof j.full_name === 'string' ? j.full_name : name,
      private: j.private === true,
      defaultBranch: typeof j.default_branch === 'string' && j.default_branch ? j.default_branch : 'main',
    };
  }

  async getContents(fullName: string, filePath: string): Promise<RemoteFile | null> {
    const url = `${GITHUB_API}/repos/${fullName}/contents/${encodeContentsPath(filePath)}`;
    const { res, token } = await this.request(url, { method: 'GET' });
    if (res.status === 404) return null;
    if (!res.ok) {
      const detail = await readGitHubDetail(res);
      throw new Error(sanitizeGitHubError(githubStatusMessage(res.status, 'contents', detail), token));
    }
    const j = (await res.json()) as { type?: unknown; sha?: unknown; content?: unknown; encoding?: unknown };
    if (!j || typeof j !== 'object' || j.type !== 'file' || typeof j.sha !== 'string') {
      throw new Error(`远端路径 ${filePath} 不是普通文件`);
    }
    if (j.encoding !== 'base64' || typeof j.content !== 'string') {
      throw new Error(`远端文件 ${filePath} 编码不受支持`);
    }
    const content = Buffer.from(j.content.replace(/\s+/g, ''), 'base64');
    return { sha: j.sha, content };
  }

  async putContents(
    fullName: string,
    filePath: string,
    content: Buffer,
    message: string,
    sha?: string,
  ): Promise<{ sha: string }> {
    const url = `${GITHUB_API}/repos/${fullName}/contents/${encodeContentsPath(filePath)}`;
    const payload: Record<string, string> = {
      message,
      content: content.toString('base64'),
    };
    if (sha) payload.sha = sha;

    const { res, token } = await this.request(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (res.status === 409 || res.status === 422) {
      throw new ShaConflictError();
    }
    if (!res.ok) {
      const detail = await readGitHubDetail(res);
      throw new Error(sanitizeGitHubError(githubStatusMessage(res.status, 'contents', detail), token));
    }
    let newSha = sha ?? '';
    try {
      const j = (await res.json()) as { content?: { sha?: unknown } };
      if (typeof j?.content?.sha === 'string') newSha = j.content.sha;
    } catch {
      // 响应体解析异常不影响已提交的写入
    }
    return { sha: newSha };
  }
}
