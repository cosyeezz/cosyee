// 音频格式转换：合成结果（Float32）→ WAV；语音输入上传的 16 位 PCM → Float32。
// 只做单声道 16 位 PCM，所有浏览器 / WebView 的 <audio> 都能直接播，不需要 ffmpeg。

export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt 块长度
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // 单声道
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // 每秒字节数
  buf.writeUInt16LE(2, 32); // 每帧字节数
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]!));
    buf.writeInt16LE(Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), 44 + i * 2);
  }
  return buf;
}

/** 小端 16 位 PCM → [-1, 1) 浮点；奇数长度时丢掉最后一个字节 */
export function pcm16ToFloat32(buf: Buffer): Float32Array {
  const n = buf.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 0x8000;
  return out;
}

/** 首尾静音裁剪默认参数 */
export const TRIM_THRESHOLD = 0.01; // 约 -40 dBFS
export const TRIM_FRAME_MS = 10;
export const TRIM_PAD_MS = 30;

/** 响度归一化默认参数 */
export const TARGET_RMS_DBFS = -20;
export const PEAK_LIMIT = 0.95;
export const MIN_GAIN = 0.25; // -12 dB
export const MAX_GAIN = 4.0; // +12 dB

/** 长音频切块默认参数（SenseVoice 适合 ≤30s） */
export const STT_CHUNK_THRESHOLD_SEC = 20;
export const STT_WINDOW_MIN_SEC = 15;
export const STT_WINDOW_MAX_SEC = 25;
export const STT_ENERGY_FRAME_MS = 30;

function frameRms(samples: Float32Array, start: number, end: number): number {
  const len = end - start;
  if (len <= 0) return 0;
  let sum = 0;
  for (let i = start; i < end; i++) {
    const v = samples[i]!;
    sum += v * v;
  }
  return Math.sqrt(sum / len);
}

/** 裁掉首尾静音（按帧 RMS 阈值），首尾各保留 padMs 毫秒缓冲；全静音时返回空数组 */
export function trimSilence(
  samples: Float32Array,
  sampleRate: number,
  opts?: { threshold?: number; frameMs?: number; padMs?: number },
): Float32Array {
  if (samples.length === 0) return new Float32Array(0);
  const threshold = opts?.threshold ?? TRIM_THRESHOLD;
  const frameLen = Math.max(1, Math.round((sampleRate * (opts?.frameMs ?? TRIM_FRAME_MS)) / 1000));
  const pad = Math.max(0, Math.round((sampleRate * (opts?.padMs ?? TRIM_PAD_MS)) / 1000));

  let firstStart = -1;
  for (let i = 0; i < samples.length; i += frameLen) {
    const end = Math.min(samples.length, i + frameLen);
    if (frameRms(samples, i, end) >= threshold) {
      firstStart = i;
      break;
    }
  }
  if (firstStart === -1) return new Float32Array(0);

  let lastEnd = samples.length;
  for (let end = samples.length; end > firstStart; end -= frameLen) {
    const start = Math.max(firstStart, end - frameLen);
    if (frameRms(samples, start, end) >= threshold) {
      lastEnd = end;
      break;
    }
  }

  const start = Math.max(0, firstStart - pad);
  const end = Math.min(samples.length, lastEnd + pad);
  return samples.slice(start, end);
}

/** 响度归一化：拉齐到目标 RMS（默认 -20 dBFS），限制峰值与增益上下限（防止把底噪放大） */
export function normalizeLoudness(
  samples: Float32Array,
  opts?: { targetDbfs?: number; peakLimit?: number; minGain?: number; maxGain?: number },
): Float32Array {
  if (samples.length === 0) return new Float32Array(0);
  const targetRms = 10 ** ((opts?.targetDbfs ?? TARGET_RMS_DBFS) / 20);
  const peakLimit = opts?.peakLimit ?? PEAK_LIMIT;
  const minGain = opts?.minGain ?? MIN_GAIN;
  const maxGain = opts?.maxGain ?? MAX_GAIN;

  let sum = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]!;
    sum += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  const rms = Math.sqrt(sum / samples.length);
  if (rms < 1e-6 || peak < 1e-6) return samples.slice();

  let gain = Math.max(minGain, Math.min(maxGain, targetRms / rms));
  if (peak * gain > peakLimit) gain = peakLimit / peak;

  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i]! * gain;
  return out;
}

/** 在音频末尾追加指定毫秒的静音 */
export function appendSilence(samples: Float32Array, sampleRate: number, ms: number): Float32Array {
  const pad = Math.max(0, Math.round((sampleRate * ms) / 1000));
  if (pad === 0) return samples;
  const out = new Float32Array(samples.length + pad);
  out.set(samples, 0);
  return out;
}

/** 长音频切块：超过 thresholdSec（默认 20s）时，在 [minSec, maxSec]（默认 [15s, 25s]）窗口内找 30ms 帧能量最低点切开 */
export function splitAudioChunks(
  samples: Float32Array,
  sampleRate: number,
  opts?: { thresholdSec?: number; minSec?: number; maxSec?: number; frameMs?: number },
): Float32Array[] {
  if (samples.length === 0) return [];
  const thresholdSamples = Math.round(sampleRate * (opts?.thresholdSec ?? STT_CHUNK_THRESHOLD_SEC));
  if (samples.length <= thresholdSamples) return [samples];

  const minSamples = Math.round(sampleRate * (opts?.minSec ?? STT_WINDOW_MIN_SEC));
  const maxSamples = Math.round(sampleRate * (opts?.maxSec ?? STT_WINDOW_MAX_SEC));
  const frameLen = Math.max(1, Math.round((sampleRate * (opts?.frameMs ?? STT_ENERGY_FRAME_MS)) / 1000));

  const chunks: Float32Array[] = [];
  let offset = 0;
  while (samples.length - offset > thresholdSamples) {
    const winStart = offset + minSamples;
    const winEnd = Math.min(samples.length, offset + maxSamples);
    if (winStart >= winEnd) break;

    let bestStart = winStart;
    let bestRms = Infinity;
    for (let pos = winStart; pos + frameLen <= winEnd; pos += frameLen) {
      const r = frameRms(samples, pos, pos + frameLen);
      if (r < bestRms) {
        bestRms = r;
        bestStart = pos;
      }
    }
    const cut = Math.min(winEnd, bestStart + (frameLen >> 1));
    if (cut <= offset || cut >= samples.length) break;
    chunks.push(samples.slice(offset, cut));
    offset = cut;
  }
  if (offset < samples.length) chunks.push(samples.slice(offset));
  return chunks;
}

/** 拼接多段识别文本：中文直接拼，两侧都是拉丁字母/数字时补空格 */
export function joinTranscripts(parts: string[]): string {
  let out = '';
  for (const raw of parts) {
    const p = raw.trim();
    if (!p) continue;
    if (!out) {
      out = p;
    } else {
      const needSpace = /[A-Za-z0-9]$/.test(out) && /^[A-Za-z0-9]/.test(p);
      out += needSpace ? ` ${p}` : p;
    }
  }
  return out;
}
