// 语音服务：朗读（MeloTTS）和语音输入（SenseVoice），都用 sherpa-onnx 在本机 CPU 上跑。
// 运行库、模型首次使用时下载（见 assets.ts），加载后常驻内存；合成、识别都走原生扩展的异步接口，不阻塞事件循环。
import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { SpeechAssetStatus, SpeechKind, SpeechStatus, TtsPrepared } from '@cosyee/shared';
import { MODELS, ensureModel, ensureRuntime, modelDir, modelReady, numThreads, pendingBytes, runtimeDir, runtimeReady } from './assets.js';
import { speechText, splitSentences } from './text.js';
import { encodeWav, pcm16ToFloat32 } from './wav.js';

/** 未下载好模型时调用合成 / 识别（HTTP 层转成 409） */
export class SpeechNotReady extends Error {}

/** 朗读文字上限：再长的交付也只念前面这些 */
const MAX_TEXT = 20_000;
/** 语音输入上限：16kHz 下约 2 分钟 */
export const MAX_STT_SECONDS = 120;
/** 合成结果缓存：最多这么多段（每段几百 KB） */
const AUDIO_CACHE = 80;
const PREPARED_CACHE = 50;

/* sherpa-onnx-node 没有类型声明，只描述用到的部分 */
interface Generated {
  samples: Float32Array;
  sampleRate: number;
}
interface Tts {
  generateAsync(o: { text: string; sid: number; speed: number }): Promise<Generated>;
}
interface Stream {
  acceptWaveform(o: { samples: Float32Array; sampleRate: number }): void;
}
interface Recognizer {
  createStream(): Stream;
  decodeAsync(s: Stream): Promise<{ text?: string }>;
}
interface Sherpa {
  OfflineTts: { createAsync(c: unknown): Promise<Tts> };
  OfflineRecognizer: { createAsync(c: unknown): Promise<Recognizer> };
}

/** 44.1kHz → 22.05kHz（两两取平均）：人声足够清楚，传给手机的数据少一半 */
function halve(a: Generated): Generated {
  if (a.sampleRate < 32000) return a;
  const n = a.samples.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (a.samples[2 * i]! + a.samples[2 * i + 1]!) / 2;
  return { samples: out, sampleRate: a.sampleRate / 2 };
}

/** 简单的 LRU：Map 保持插入顺序，命中时挪到末尾 */
function lruGet<K, V>(m: Map<K, V>, k: K): V | undefined {
  const v = m.get(k);
  if (v !== undefined) {
    m.delete(k);
    m.set(k, v);
  }
  return v;
}
function lruSet<K, V>(m: Map<K, V>, k: K, v: V, max: number): void {
  m.delete(k);
  m.set(k, v);
  while (m.size > max) m.delete(m.keys().next().value as K);
}

export class Speech {
  private jobs: Partial<Record<SpeechKind, Promise<void>>> = {};
  private progress: Record<SpeechKind, { received: number; total: number }> = {
    tts: { received: 0, total: 0 },
    stt: { received: 0, total: 0 },
  };
  private errors: Partial<Record<SpeechKind, string>> = {};
  private sherpa: Sherpa | null = null;
  private tts: Promise<Tts> | null = null;
  private stt: Promise<Recognizer> | null = null;
  /** 合成串行执行：同一个模型句柄并发调用不安全，而且排队也让前面的段先出来 */
  private ttsQueue: Promise<unknown> = Promise.resolve();
  private prepared = new Map<string, string[]>();
  private audio = new Map<string, Promise<Buffer>>();

  private ready(kind: SpeechKind): boolean {
    return runtimeReady() && modelReady(kind);
  }

  status(): SpeechStatus {
    const one = (kind: SpeechKind): SpeechAssetStatus => {
      if (this.jobs[kind]) return { phase: 'downloading', ...this.progress[kind] };
      if (this.ready(kind)) return { phase: 'ready' };
      const error = this.errors[kind];
      return error ? { phase: 'error', error } : { phase: 'missing' };
    };
    return { tts: one('tts'), stt: one('stt') };
  }

  /** 开始下载（已就绪或已在下载时什么都不做），立刻返回当前状态 */
  prepare(kind: SpeechKind): SpeechStatus {
    if (!this.ready(kind) && !this.jobs[kind]) {
      delete this.errors[kind];
      const p = this.progress[kind];
      p.received = 0;
      p.total = pendingBytes(kind);
      // 实际下载量超过估算时把分母跟着抬高，进度不会超过 100%
      const onBytes = (n: number) => {
        p.received = Math.max(0, p.received + n);
        if (p.received > p.total) p.total = p.received;
      };
      this.jobs[kind] = (async () => {
        try {
          await ensureRuntime(onBytes);
          await ensureModel(kind, onBytes);
        } catch (e) {
          this.errors[kind] = `语音模型下载失败：${e instanceof Error ? e.message : String(e)}`;
          console.error(`[speech] ${kind} 准备失败`, e);
        } finally {
          delete this.jobs[kind];
        }
      })();
    }
    return this.status();
  }

  private lib(): Sherpa {
    this.sherpa ??= createRequire(path.join(runtimeDir(), 'index.js'))('sherpa-onnx-node') as Sherpa;
    return this.sherpa;
  }

  private loadTts(): Promise<Tts> {
    if (!this.ready('tts')) throw new SpeechNotReady('朗读模型还没有下载');
    this.tts ??= (async () => {
      const d = modelDir('tts');
      const f = (n: string) => path.join(d, n);
      return this.lib().OfflineTts.createAsync({
        model: {
          vits: { model: f('model.onnx'), lexicon: f('lexicon.txt'), tokens: f('tokens.txt'), dictDir: f('dict') },
          numThreads: numThreads(),
          provider: 'cpu',
          debug: false,
        },
        // 日期、电话、数字读法和多音字规则
        ruleFsts: ['date.fst', 'phone.fst', 'number.fst', 'new_heteronym.fst'].map(f).join(','),
        maxNumSentences: 1,
      });
    })().catch((e) => {
      this.tts = null; // 下次再试
      throw e;
    });
    return this.tts;
  }

  private loadStt(): Promise<Recognizer> {
    if (!this.ready('stt')) throw new SpeechNotReady('识别模型还没有下载');
    this.stt ??= (async () => {
      const d = modelDir('stt');
      return this.lib().OfflineRecognizer.createAsync({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          senseVoice: { model: path.join(d, 'model.int8.onnx'), useInverseTextNormalization: 1 },
          tokens: path.join(d, 'tokens.txt'),
          numThreads: numThreads(),
          provider: 'cpu',
          debug: 0,
        },
      });
    })().catch((e) => {
      this.stt = null;
      throw e;
    });
    return this.stt;
  }

  /** 清洗、分句，返回段数；同样的文字得到同样的 id，重复点朗读直接用缓存 */
  ttsPrepare(markdown: string): TtsPrepared {
    if (!this.ready('tts')) throw new SpeechNotReady('朗读模型还没有下载');
    const segs = splitSentences(speechText(markdown.slice(0, MAX_TEXT)));
    if (!segs.length) return { id: '', count: 0 };
    const id = crypto.createHash('sha1').update(MODELS.tts.name).update('\0').update(segs.join('\n')).digest('hex').slice(0, 16);
    lruSet(this.prepared, id, segs, PREPARED_CACHE);
    void this.loadTts().catch(() => {}); // 提前加载模型（首次约 3 秒）
    return { id, count: segs.length };
  }

  /** 第 i 段的 WAV；id 过期或越界返回 null。顺带开始合成下一段，播完这段时下一段已经好了。 */
  ttsAudio(id: string, i: number): Promise<Buffer> | null {
    const segs = lruGet(this.prepared, id);
    if (!segs || !Number.isInteger(i) || i < 0 || i >= segs.length) return null;
    const cur = this.segment(id, segs, i);
    if (i + 1 < segs.length) void this.segment(id, segs, i + 1).catch(() => {});
    return cur;
  }

  private segment(id: string, segs: string[], i: number): Promise<Buffer> {
    const key = `${id}:${i}`;
    const hit = lruGet(this.audio, key);
    if (hit) return hit;
    const job = this.ttsQueue.then(async () => {
      const tts = await this.loadTts();
      const a = halve(await tts.generateAsync({ text: segs[i]!, sid: 0, speed: 1.0 }));
      return encodeWav(a.samples, a.sampleRate);
    });
    this.ttsQueue = job.catch(() => {});
    job.catch(() => this.audio.delete(key)); // 失败的不缓存
    lruSet(this.audio, key, job, AUDIO_CACHE);
    return job;
  }

  /** 识别一段单声道 16 位 PCM */
  async transcribe(pcm: Buffer, rate: number): Promise<string> {
    const rec = await this.loadStt();
    const samples = pcm16ToFloat32(pcm);
    if (samples.length < rate * 0.2) return '';
    const s = rec.createStream();
    s.acceptWaveform({ samples, sampleRate: rate });
    const r = await rec.decodeAsync(s);
    return (r.text ?? '').trim();
  }
}
