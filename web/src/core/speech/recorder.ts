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

/** downsampleToInt16 实际输出采样率：输入 ≤ toRate 时原样输出，保留原采样率 */
export function effectiveRate(fromRate: number, toRate = TARGET_RATE): number {
  return fromRate <= toRate ? fromRate : toRate;
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
  stop(): Promise<{ pcm: Int16Array; rate: number }>;
  cancel(): void;
}

/** 打开麦克风，每块原始采样（AudioContext 的采样率）交给 onFrame，直到 close() */
export interface Mic {
  rate: number;
  /** 麦克风音频轨道是否仍处于 live 状态 */
  alive(): boolean;
  /** AudioContext 若为 suspended，尝试恢复 */
  resume(): void;
  close(): void;
}

export async function openMic(onFrame: (f: Float32Array) => void, onEnded?: () => void): Promise<Mic> {
  // 必须在用户点击的同步调用栈里先创建并 resume AudioContext，再 await getUserMedia（iOS Safari / WebView 手势要求）
  const Ctx: typeof AudioContext =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {});

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    void ctx.close().catch(() => {});
    throw e;
  }

  if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  const source = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  proc.onaudioprocess = (e) => onFrame(new Float32Array(e.inputBuffer.getChannelData(0)));
  source.connect(proc);
  proc.connect(ctx.destination); // 部分浏览器不接到输出就不触发回调（输出缓冲是静音的）

  let done = false;
  const tracks = stream.getAudioTracks();
  const handleEnded = () => {
    if (!done) onEnded?.();
  };
  tracks.forEach((t) => t.addEventListener('ended', handleEnded));

  return {
    rate: ctx.sampleRate,
    alive() {
      return !done && tracks.length > 0 && tracks.every((t) => t.readyState === 'live');
    },
    resume() {
      if (!done && ctx.state === 'suspended') void ctx.resume().catch(() => {});
    },
    close() {
      if (done) return;
      done = true;
      proc.onaudioprocess = null;
      tracks.forEach((t) => t.removeEventListener('ended', handleEnded));
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
      return {
        pcm: downsampleToInt16(chunks, mic.rate, TARGET_RATE),
        rate: effectiveRate(mic.rate, TARGET_RATE),
      };
    },
    cancel: () => mic.close(),
  };
}
