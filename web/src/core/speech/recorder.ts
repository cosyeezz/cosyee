// 麦克风录音：ScriptProcessorNode 虽已弃用，但所有 WebView 都支持（AudioWorklet 在部分 WebView 不可用）。

export const TARGET_RATE = 16000;

export type MicSupport = { ok: true } | { ok: false; reason: string };

export function micSupport(): MicSupport {
  if (!window.isSecureContext) {
    return { ok: false, reason: '远程语音输入需要 HTTPS 地址（如 https://机器名.xxx.ts.net，用 tailscale serve 反代）' };
  }
  if (!navigator.mediaDevices?.getUserMedia) return { ok: false, reason: '当前环境不支持录音' };
  return { ok: true };
}

/** 把若干 Float32 块重采样（区间平均）到 toRate 并转 16 位整数；超出 [-1,1] 的样本截断 */
export function downsampleToInt16(chunks: Float32Array[], fromRate: number, toRate: number): Int16Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  if (total === 0) return new Int16Array(0);
  const all = new Float32Array(total);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }

  const ratio = fromRate / toRate;
  const n = ratio <= 1 ? total : Math.floor(total / ratio);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    let v: number;
    if (ratio <= 1) {
      v = all[i]!;
    } else {
      const start = Math.floor(i * ratio);
      const end = Math.min(total, Math.max(start + 1, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let j = start; j < end; j++) sum += all[j]!;
      v = sum / (end - start);
    }
    out[i] = v >= 1 ? 32767 : v <= -1 ? -32768 : Math.round(v * 32768);
  }
  return out;
}

export interface Recorder {
  stop(): Promise<{ pcm: Int16Array; rate: 16000 }>;
  cancel(): void;
}

/** 打开麦克风，每块原始采样（AudioContext 的采样率）交给 onFrame，直到 close() */
export interface Mic {
  rate: number;
  close(): void;
}

export async function openMic(onFrame: (f: Float32Array) => void): Promise<Mic> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const Ctx: typeof AudioContext =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  const source = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  proc.onaudioprocess = (e) => onFrame(new Float32Array(e.inputBuffer.getChannelData(0)));
  source.connect(proc);
  proc.connect(ctx.destination); // 部分浏览器不接到输出就不触发回调（输出缓冲是静音的）

  let done = false;
  return {
    rate: ctx.sampleRate,
    close() {
      if (done) return;
      done = true;
      proc.onaudioprocess = null;
      try { source.disconnect(); proc.disconnect(); } catch { /* 已断开 */ }
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close().catch(() => {});
    },
  };
}

export async function startRecording(): Promise<Recorder> {
  const chunks: Float32Array[] = [];
  const mic = await openMic((f) => chunks.push(f));
  return {
    async stop() {
      mic.close();
      return { pcm: downsampleToInt16(chunks, mic.rate, TARGET_RATE), rate: TARGET_RATE };
    },
    cancel: () => mic.close(),
  };
}
