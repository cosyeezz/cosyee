// 内置浏览器的程序本体：agent-browser（vercel-labs/agent-browser 的预编译单文件）。
// 装在 <cosyee 目录>/agent-browser/ 下：bin 是程序，meta.json 记版本。
// 安装 / 更新 = 查 GitHub 最新 release → 下载当前平台的单文件 → 用 API 给的 sha256 摘要校验 → 原子替换。
// COSYEE_AGENT_BROWSER 指定了程序时只显示，不安装 / 更新。
// 预编译单文件不带官方 skill 文档：另外按程序版本把仓库里同一 tag 的 skill-data/ 下载到 <安装目录>/skill-data，
// 包装脚本经 AGENT_BROWSER_SKILLS_DIR 指给 `agent-browser skills`（见 skill.ts）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { writeFileAtomic } from '../kiro/sanitize.js';
import { cosyeeHome } from '../paths.js';
import { fetchJsonLimited, LogBuffer } from '../components/common.js';
import { readTextLimited } from '../delegate/agyCli.js';

export const RELEASE_API = 'https://api.github.com/repos/vercel-labs/agent-browser/releases/latest';
const BIN_MAX_BYTES = 200 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const TAG_RE = /^v?\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const REPO = 'vercel-labs/agent-browser';
/** skill-data 下的文件：最多 4 层、只含安全字符（不会写到目录外面） */
const SKILL_PATH_RE = /^skill-data(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}){2,4}$/;
const SKILL_FILE_MAX = 512 * 1024;
const SKILL_TOTAL_MAX = 8 * 1024 * 1024;
const SKILL_FILES_MAX = 300;
const SKILL_VERSION_FILE = '.version';

export interface BrowserInstallOptions {
  /** 安装目录，默认 <cosyee 目录>/agent-browser */
  rootDir?: () => string;
  env?: () => NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  isMusl?: () => boolean;
  now?: () => number;
}

interface Meta {
  version: string | null;
  latest: string | null;
  checkedAt: number | null;
}

interface ReleaseAsset {
  name: string;
  url: string;
  size: number | null;
  sha256: string | null;
}

function defaultIsMusl(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    return fs.existsSync('/lib/libc.musl-x86_64.so.1') || fs.existsSync('/lib/libc.musl-aarch64.so.1');
  } catch {
    return false;
  }
}

/** 上游资产名：agent-browser-darwin-arm64 / agent-browser-linux-musl-x64 / agent-browser-win32-x64.exe；不支持的平台返回 null */
export function assetName(platform: NodeJS.Platform, arch: string, musl: boolean): string | null {
  if (arch !== 'x64' && arch !== 'arm64') return null;
  if (platform === 'darwin') return `agent-browser-darwin-${arch}`;
  if (platform === 'linux') return `agent-browser-linux-${musl ? 'musl-' : ''}${arch}`;
  if (platform === 'win32' && arch === 'x64') return 'agent-browser-win32-x64.exe';
  return null;
}

/** 去掉前缀 v，比较 x.y.z；返回正数表示 a 更新 */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 解析 GitHub release JSON：tag + 资产（只认 github.com 的 https 下载地址、sha256:<hex> 摘要） */
export function parseRelease(data: unknown): { tag: string; assets: ReleaseAsset[] } {
  const o = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const tag = typeof o.tag_name === 'string' ? o.tag_name.trim() : '';
  if (!TAG_RE.test(tag)) throw new Error('检查最新版本失败：版本号格式不对');
  const assets: ReleaseAsset[] = [];
  for (const a of Array.isArray(o.assets) ? o.assets : []) {
    if (!a || typeof a !== 'object') continue;
    const r = a as Record<string, unknown>;
    if (typeof r.name !== 'string' || typeof r.browser_download_url !== 'string') continue;
    const digest = typeof r.digest === 'string' ? /^sha256:([0-9a-fA-F]{64})$/.exec(r.digest)?.[1]?.toLowerCase() ?? null : null;
    assets.push({
      name: r.name,
      url: r.browser_download_url,
      size: typeof r.size === 'number' && r.size > 0 ? r.size : null,
      sha256: digest,
    });
  }
  return { tag: tag.replace(/^v/, ''), assets };
}

export class BrowserInstall {
  private meta: Meta | null = null;
  private job: { state: 'running' | 'failed'; error: string | null } | null = null;
  private running: Promise<void> | null = null;
  private checking: Promise<void> | null = null;
  readonly logs = new LogBuffer();

  constructor(private readonly opts: BrowserInstallOptions = {}) {}

  private root(): string {
    return this.opts.rootDir ? this.opts.rootDir() : path.join(cosyeeHome(), 'agent-browser');
  }

  private env(): NodeJS.ProcessEnv {
    return this.opts.env ? this.opts.env() : process.env;
  }

  private platform(): NodeJS.Platform {
    return this.opts.platform ?? process.platform;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private exeName(): string {
    return this.platform() === 'win32' ? 'agent-browser.exe' : 'agent-browser';
  }

  /** 环境变量指定的程序（只用，不管理） */
  customPath(): string | null {
    const v = this.env().COSYEE_AGENT_BROWSER?.trim();
    return v ? v : null;
  }

  managedPath(): string {
    return path.join(this.root(), this.exeName());
  }

  /** 实际要运行的程序；没装返回 null */
  binPath(): string | null {
    const custom = this.customPath();
    if (custom) return custom;
    const p = this.managedPath();
    try {
      return fs.statSync(p).isFile() ? p : null;
    } catch {
      return null;
    }
  }

  /** 官方 skill 文档目录（含 core/SKILL.md 时包装脚本才指给 agent-browser） */
  skillsDir(): string {
    return path.join(this.root(), 'skill-data');
  }

  private skillsVersion(): string | null {
    try {
      return fs.readFileSync(path.join(this.skillsDir(), SKILL_VERSION_FILE), 'utf8').trim() || null;
    } catch {
      return null;
    }
  }

  private skillsJob: Promise<void> | null = null;

  /**
   * 官方 skill 文档和程序版本对不上（没下载过 / 程序更新了）时补下载；不阻塞调用方，失败下次再试。
   * 自定义程序（COSYEE_AGENT_BROWSER，多半是 npm 装的、自带文档）和没装时不管。
   */
  ensureSkills(): Promise<void> {
    if (this.skillsJob) return this.skillsJob;
    const version = this.customPath() ? null : this.status().installed ? this.readMeta().version : null;
    if (!version || this.skillsVersion() === version) return Promise.resolve();
    this.skillsJob = this.downloadSkills(version)
      .catch((e: unknown) => this.logs.append(`[cosyee] 官方 skill 文档下载失败：${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        this.skillsJob = null;
      });
    return this.skillsJob;
  }

  /** 从 GitHub 取 tag 下 skill-data/ 的文件清单和内容，写进临时目录再整体换上 */
  private async downloadSkills(version: string): Promise<void> {
    const tag = `v${version.replace(/^v/, '')}`;
    if (!TAG_RE.test(tag)) throw new Error('版本号无效');
    const fetchFn = this.opts.fetch ?? globalThis.fetch;
    const tree = await fetchJsonLimited(fetchFn, `https://api.github.com/repos/${REPO}/git/trees/${encodeURIComponent(tag)}?recursive=1`, {
      maxBytes: 16 * 1024 * 1024,
    });
    const items = (tree as { tree?: unknown } | null)?.tree;
    if (!Array.isArray(items)) throw new Error('文件清单格式不对');
    const files = items
      .filter((t): t is { path: string; type: string; size?: unknown } => !!t && typeof t.path === 'string' && t.type === 'blob')
      .filter((t) => t.path.startsWith('skill-data/'));
    if (!files.some((f) => f.path === 'skill-data/core/SKILL.md')) throw new Error(`${tag} 里没有 skill-data/core/SKILL.md`);
    if (files.length > SKILL_FILES_MAX) throw new Error('文件太多');
    const root = this.root();
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const tmp = path.join(root, `.skill-data-${crypto.randomBytes(6).toString('hex')}`);
    try {
      let total = 0;
      for (const f of files) {
        if (!SKILL_PATH_RE.test(f.path)) continue; // 不认识的路径跳过，不写
        if (typeof f.size === 'number' && f.size > SKILL_FILE_MAX) continue;
        const text = await this.fetchText(fetchFn, `https://raw.githubusercontent.com/${REPO}/${encodeURIComponent(tag)}/${f.path}`);
        total += Buffer.byteLength(text);
        if (total > SKILL_TOTAL_MAX) throw new Error('文件总量过大');
        const dest = path.join(tmp, f.path.slice('skill-data/'.length));
        fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
        fs.writeFileSync(dest, text, { mode: 0o600 });
      }
      fs.writeFileSync(path.join(tmp, SKILL_VERSION_FILE), version + '\n', { mode: 0o600 });
      fs.rmSync(this.skillsDir(), { recursive: true, force: true });
      fs.renameSync(tmp, this.skillsDir());
      this.logs.append(`[cosyee] 已下载官方 skill 文档 ${tag}（${files.length} 个文件）`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  private async fetchText(fetchFn: typeof globalThis.fetch, url: string): Promise<string> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30_000);
    timer.unref?.();
    try {
      const res = await fetchFn(url, { headers: { 'user-agent': 'cosyee' }, signal: ac.signal });
      if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`);
      return await readTextLimited(res, SKILL_FILE_MAX);
    } catch (e) {
      if (ac.signal.aborted) throw new Error('下载超时');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  private metaFile(): string {
    return path.join(this.root(), 'meta.json');
  }

  private readMeta(): Meta {
    if (this.meta) return this.meta;
    const m: Meta = { version: null, latest: null, checkedAt: null };
    try {
      const j = JSON.parse(fs.readFileSync(this.metaFile(), 'utf8')) as Record<string, unknown>;
      if (typeof j.version === 'string' && TAG_RE.test(j.version)) m.version = j.version;
      if (typeof j.latest === 'string' && TAG_RE.test(j.latest)) m.latest = j.latest;
      if (typeof j.checkedAt === 'number' && Number.isFinite(j.checkedAt)) m.checkedAt = j.checkedAt;
    } catch { /* 没有文件：全空 */ }
    return (this.meta = m);
  }

  private writeMeta(patch: Partial<Meta>): void {
    const m = { ...this.readMeta(), ...patch };
    fs.mkdirSync(this.root(), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.metaFile(), JSON.stringify(m, null, 2) + '\n', 0o600);
    this.meta = m;
  }

  status(): {
    installed: boolean;
    custom: boolean;
    version: string | null;
    latest: string | null;
    updateAvailable: boolean;
    checkedAt: number | null;
    job: { state: 'running' | 'failed'; error: string | null } | null;
  } {
    const custom = this.customPath() !== null;
    const installed = this.binPath() !== null;
    const m = this.readMeta();
    const version = custom ? null : installed ? m.version : null;
    const updateAvailable = !custom && installed && !!m.latest && !!version && compareVersions(m.latest, version) > 0;
    return { installed, custom, version, latest: m.latest, updateAvailable, checkedAt: m.checkedAt, job: this.job };
  }

  /** 查最新版并记下来；失败抛错 */
  check(): Promise<void> {
    this.checking ??= (async () => {
      try {
        const { tag } = parseRelease(await fetchJsonLimited(this.opts.fetch ?? globalThis.fetch, RELEASE_API));
        this.writeMeta({ latest: tag, checkedAt: this.now() });
      } finally {
        this.checking = null;
      }
    })();
    return this.checking;
  }

  /** 安装或更新到最新版；结束才返回，失败抛错。beforeReplace 在替换程序前调用（关掉正在运行的浏览器） */
  install(beforeReplace?: () => Promise<void>): Promise<void> {
    if (this.running) return this.running;
    if (this.customPath()) return Promise.reject(new Error('已用 COSYEE_AGENT_BROWSER 指定程序，不支持安装 / 更新'));
    this.logs.reset();
    this.job = { state: 'running', error: null };
    const p = this.runInstall(beforeReplace).then(
      () => {
        this.job = null;
      },
      (e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        this.logs.append(`[cosyee] 失败：${msg}`);
        this.job = { state: 'failed', error: msg };
        throw e;
      },
    );
    this.running = p.finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runInstall(beforeReplace?: () => Promise<void>): Promise<void> {
    const name = assetName(this.platform(), this.opts.arch ?? process.arch, (this.opts.isMusl ?? defaultIsMusl)());
    if (!name) throw new Error('当前平台没有 agent-browser 的预编译程序');
    this.logs.append('[cosyee] 查询最新版本');
    const { tag, assets } = parseRelease(await fetchJsonLimited(this.opts.fetch ?? globalThis.fetch, RELEASE_API));
    this.writeMeta({ latest: tag, checkedAt: this.now() });
    const cur = this.status();
    if (cur.installed && cur.version === tag) {
      this.logs.append(`[cosyee] 已是最新版 ${tag}`);
      await this.ensureSkills();
      return;
    }
    const asset = assets.find((a) => a.name === name);
    if (!asset) throw new Error(`${tag} 没有适用于当前平台的程序（${name}）`);
    if (!asset.sha256 || !SHA256_RE.test(asset.sha256)) throw new Error('release 没有提供 sha256 摘要，无法校验');

    const root = this.root();
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const tmp = path.join(root, `.download-${crypto.randomBytes(6).toString('hex')}`);
    try {
      this.logs.append(`[cosyee] 下载 ${name} ${tag}${asset.size ? `（${(asset.size / 1024 / 1024).toFixed(1)} MB）` : ''}`);
      const sha = await this.download(asset.url, tmp);
      if (sha !== asset.sha256) throw new Error('SHA256 校验失败，文件可能损坏或被篡改');
      this.logs.append('[cosyee] SHA256 校验通过');
      if (this.platform() !== 'win32') fs.chmodSync(tmp, 0o755);
      const ver = await this.readVersion(tmp);
      if (ver) this.logs.append(`[cosyee] 程序版本 ${ver}`);
      await beforeReplace?.().catch(() => { /* 关不掉也继续：Unix 上替换运行中的程序没问题 */ });
      fs.renameSync(tmp, this.managedPath());
      this.writeMeta({ version: ver ?? tag });
      this.logs.append(`[cosyee] 已安装 ${ver ?? tag}`);
      await this.ensureSkills();
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  /** 下载到 dest，边写边算 sha256；只接受 github.com 的 https 地址（之后的跳转由 fetch 处理） */
  private async download(url: string, dest: string): Promise<string> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new Error('下载地址无效');
    }
    if (u.protocol !== 'https:' || u.hostname !== 'github.com') throw new Error('下载地址不是 github.com 的 https 链接');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), DOWNLOAD_TIMEOUT_MS);
    timer.unref?.();
    try {
      const res = await (this.opts.fetch ?? globalThis.fetch)(url, { headers: { 'user-agent': 'cosyee' }, signal: ac.signal });
      if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`);
      const len = Number(res.headers.get('content-length'));
      if (Number.isFinite(len) && len > BIN_MAX_BYTES) throw new Error('文件过大，已放弃下载');
      if (!res.body) throw new Error('下载失败（响应没有内容）');
      const hash = crypto.createHash('sha256');
      const fd = fs.openSync(dest, 'w', 0o600);
      let bytes = 0;
      try {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > BIN_MAX_BYTES) {
            await reader.cancel().catch(() => { /* ignore */ });
            throw new Error('文件过大，已放弃下载');
          }
          hash.update(value);
          let off = 0;
          while (off < value.length) off += fs.writeSync(fd, value, off, value.length - off);
        }
      } finally {
        fs.closeSync(fd);
      }
      this.logs.append(`[cosyee] 下载完成 ${(bytes / 1024 / 1024).toFixed(1)} MB`);
      return hash.digest('hex');
    } catch (e) {
      if (ac.signal.aborted) throw new Error('下载超时，已终止');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /** `agent-browser --version` → 0.44.0；读不到返回 null */
  private readVersion(bin: string): Promise<string | null> {
    return new Promise((resolve) => {
      execFile(bin, ['--version'], { timeout: 10_000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve(null);
        const m = /(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?)/.exec(String(stdout));
        resolve(m ? m[1]! : null);
      });
    });
  }
}
