// 语音功能的运行库和模型：首次使用时下载到 ~/.cosyee/speech，之后离线可用。
//
// 运行库是 sherpa-onnx 的 Node 原生扩展（N-API，Node / Electron 通用）。它不放进 package.json：
// 服务端是 esbuild 打成的单文件、桌面版运行时没有 node_modules，原生扩展打不进去；
// 而且不用语音的人也不该多背几十 MB。所以和模型一样按需从 npm 仓库下载两个包，
// 摆成 node_modules 的结构，再用 createRequire 加载（addon.js 会在相邻目录找平台包）。
//
// 下载源：npm 包依次试 COSYEE_NPM_REGISTRY、npmjs、npmmirror；模型默认从 GitHub Releases 下，
// 网络不通时可以用 COSYEE_SPEECH_MIRROR 换成镜像（同样的 <tag>/<文件名> 结构）。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { SpeechKind } from '@cosyee/shared';
import { cosyeeHome } from '../paths.js';

export const SHERPA_VERSION = '2.0.3';

export interface ModelSpec {
  /** 解压后的顶层目录名 */
  name: string;
  /** Releases 下的相对路径 */
  file: string;
  /** 大约字节数：服务器没给 Content-Length 时用来估算进度 */
  size: number;
}

export const MODELS: Record<SpeechKind, ModelSpec> = {
  // MeloTTS 中英（女声）：CPU 上约 0.3 倍实时。试过 Kokoro v1.1-zh，同样 4 线程要 1.5 倍实时，
  // 而且把 http、ts 这类英文缩写当未登录词直接跳过，交付文字里很常见，所以没用它。
  tts: { name: 'vits-melo-tts-zh_en', file: 'tts-models/vits-melo-tts-zh_en.tar.bz2', size: 167_006_755 },
  // SenseVoice-Small（int8）：中英日韩粤，自带标点
  stt: {
    name: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09',
    file: 'asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2',
    size: 165_783_878,
  },
};

/** 运行库两个包的大约大小（压缩后），同样只用于估算进度 */
const RUNTIME_SIZE = 9_000_000;

export function speechRoot(): string {
  return path.join(cosyeeHome(), 'speech');
}

/** 平台包名；不支持的平台返回 null */
export function platformPackage(): string | null {
  const plat = process.platform === 'win32' ? 'win' : process.platform;
  const name = `sherpa-onnx-${plat}-${process.arch}`;
  const known = ['win-x64', 'win-ia32', 'win-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'];
  return known.includes(`${plat}-${process.arch}`) ? name : null;
}

export function runtimeDir(): string {
  return path.join(speechRoot(), `runtime-${SHERPA_VERSION}`);
}

export function modelDir(kind: SpeechKind): string {
  return path.join(speechRoot(), 'models', MODELS[kind].name);
}

const OK = '.ok';
const isReady = (dir: string) => fs.existsSync(path.join(dir, OK));
export const runtimeReady = () => isReady(runtimeDir());
export const modelReady = (kind: SpeechKind) => isReady(modelDir(kind));

/** 还需要下载的字节数（估算），用于进度条的分母 */
export function pendingBytes(kind: SpeechKind): number {
  return (runtimeReady() ? 0 : RUNTIME_SIZE) + (modelReady(kind) ? 0 : MODELS[kind].size);
}

function registries(): string[] {
  const list = [process.env.COSYEE_NPM_REGISTRY, 'https://registry.npmjs.org', 'https://registry.npmmirror.com'];
  return [...new Set(list.filter((s): s is string => !!s).map((s) => s.replace(/\/+$/, '')))];
}

function modelBases(): string[] {
  const list = [process.env.COSYEE_SPEECH_MIRROR, 'https://github.com/k2-fsa/sherpa-onnx/releases/download'];
  return [...new Set(list.filter((s): s is string => !!s).map((s) => s.replace(/\/+$/, '')))];
}

/** 系统自带的 tar：Windows 10+ 的 System32\tar.exe（bsdtar，能解 .tar.bz2 / .tgz）。
 *  不用 PATH 里的 tar：Git Bash 带的 GNU tar 会把 `F:\…` 里的冒号当成远程主机。 */
function tarBin(): string {
  if (process.platform !== 'win32') return 'tar';
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
}

function extract(archive: string, dest: string): Promise<void> {
  fs.mkdirSync(dest, { recursive: true });
  return new Promise((resolve, reject) => {
    execFile(tarBin(), ['-xf', archive], { cwd: dest, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, _o, stderr) => {
      if (err) reject(new Error(`解压失败：${String(stderr || err.message).trim().slice(0, 300)}`));
      else resolve();
    });
  });
}

/** 依次试每个地址，下载到 file；onBytes 收到每块的字节数 */
async function download(urls: string[], file: string, onBytes: (n: number) => void): Promise<void> {
  let last: unknown;
  for (const url of urls) {
    let got = 0;
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30 * 60_000) });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const count = new Transform({
        transform(chunk: Buffer, _e, cb) {
          got += chunk.length;
          onBytes(chunk.length);
          cb(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), count, fs.createWriteStream(file));
      return;
    } catch (e) {
      onBytes(-got); // 这个地址失败了，进度退回去
      last = new Error(`${new URL(url).host}：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw last ?? new Error('没有可用的下载地址');
}

function tmpPath(tag: string): string {
  return path.join(speechRoot(), 'tmp', `${tag}-${process.pid}-${Date.now()}`);
}

/** 把解压出来的目录挪到最终位置（先删掉上次没装完的残留） */
function place(from: string, to: string): void {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
}

let runtimeJob: Promise<void> | null = null;

/** 下载并摆好运行库（多个调用共用同一个任务） */
export function ensureRuntime(onBytes: (n: number) => void): Promise<void> {
  if (runtimeReady()) return Promise.resolve();
  const pkg = platformPackage();
  if (!pkg) return Promise.reject(new Error(`语音功能不支持当前平台（${process.platform}-${process.arch}）`));
  runtimeJob ??= (async () => {
    const tmp = tmpPath('runtime');
    try {
      const nm = path.join(tmp, 'node_modules');
      for (const name of ['sherpa-onnx-node', pkg]) {
        const tgz = path.join(tmp, `${name}.tgz`);
        await download(registries().map((r) => `${r}/${name}/-/${name}-${SHERPA_VERSION}.tgz`), tgz, onBytes);
        const out = path.join(tmp, name);
        await extract(tgz, out);
        place(path.join(out, 'package'), path.join(nm, name));
      }
      fs.writeFileSync(path.join(tmp, OK), SHERPA_VERSION);
      place(tmp, runtimeDir());
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      runtimeJob = null;
    }
  })();
  return runtimeJob;
}

const modelJobs: Partial<Record<SpeechKind, Promise<void>>> = {};

export function ensureModel(kind: SpeechKind, onBytes: (n: number) => void): Promise<void> {
  if (modelReady(kind)) return Promise.resolve();
  const spec = MODELS[kind];
  modelJobs[kind] ??= (async () => {
    const tmp = tmpPath(kind);
    try {
      const archive = path.join(tmp, path.basename(spec.file));
      await download(modelBases().map((b) => `${b}/${spec.file}`), archive, onBytes);
      const out = path.join(tmp, 'x');
      await extract(archive, out);
      const inner = path.join(out, spec.name);
      if (!fs.existsSync(inner)) throw new Error(`模型包结构不对：缺少 ${spec.name}/`);
      fs.writeFileSync(path.join(inner, OK), spec.file);
      place(inner, modelDir(kind));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      delete modelJobs[kind];
    }
  })();
  return modelJobs[kind]!;
}

/** 推理线程数：留一半核给服务端和其它会话 */
export function numThreads(): number {
  return Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2)));
}
