// 通话模式的说话检测（VAD）：按每帧能量判断「开始说话」「说完了」。
// 不用模型：麦克风已开回声消除和降噪，能量阈值配合自适应底噪在安静 / 一般环境下足够，延迟也最低。
// 纯计算，不碰浏览器接口，方便测试。

export interface VadOptions {
  /** 输入采样率 */
  rate: number;
  /** 连续这么久高于阈值才算开始说话（滤掉咳嗽、敲键盘） */
  startMs?: number;
  /** 说话后连续这么久低于阈值算说完 */
  endMs?: number;
  /** 说话总时长不到这么多的丢掉 */
  minSpeechMs?: number;
  /** 开始前保留这么长的音频，免得吞掉第一个字 */
  preRollMs?: number;
  /** 一句话最长，到了直接结束 */
  maxMs?: number;
}

/** 一句话说完时交出的音频（原始采样率） */
export type Utterance = Float32Array[];

const rms = (f: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < f.length; i++) s += f[i]! * f[i]!;
  return Math.sqrt(s / Math.max(1, f.length));
};

export class Vad {
  private readonly o: Required<VadOptions>;
  /** 底噪估计（RMS）：安静时慢慢跟上，说话时不更新 */
  private floor = 0.004;
  private speaking = false;
  private loudMs = 0;
  private quietMs = 0;
  private speechMs = 0;
  private pre: Float32Array[] = [];
  private preMs = 0;
  private buf: Float32Array[] = [];
  private bufMs = 0;

  constructor(opts: VadOptions) {
    this.o = { startMs: 160, endMs: 1100, minSpeechMs: 350, preRollMs: 400, maxMs: 60_000, ...opts };
  }

  /** 正在说话（已越过开始判定） */
  get active(): boolean {
    return this.speaking;
  }

  private threshold(): number {
    return Math.max(0.012, this.floor * 3);
  }

  /** 喂一帧；一句话说完时返回这句话的音频，否则返回 null */
  push(frame: Float32Array): Utterance | null {
    const ms = (frame.length / this.o.rate) * 1000;
    const e = rms(frame);
    const loud = e > this.threshold();

    if (!this.speaking) {
      if (!loud) this.floor = this.floor * 0.95 + Math.min(e, 0.05) * 0.05;
      this.pre.push(frame);
      this.preMs += ms;
      // 预留的音频只保留最近 preRollMs（加上开始判定那段）
      while (this.pre.length > 1 && this.preMs - (this.pre[0]!.length / this.o.rate) * 1000 >= this.o.preRollMs + this.o.startMs) {
        this.preMs -= (this.pre.shift()!.length / this.o.rate) * 1000;
      }
      this.loudMs = loud ? this.loudMs + ms : 0;
      if (this.loudMs >= this.o.startMs) {
        this.speaking = true;
        this.buf = this.pre;
        this.bufMs = this.preMs;
        this.pre = [];
        this.preMs = 0;
        this.speechMs = this.loudMs;
        this.quietMs = 0;
      }
      return null;
    }

    this.buf.push(frame);
    this.bufMs += ms;
    if (loud) {
      this.speechMs += ms;
      this.quietMs = 0;
    } else {
      this.quietMs += ms;
    }
    if (this.quietMs >= this.o.endMs || this.bufMs >= this.o.maxMs) {
      const out = this.buf;
      const enough = this.speechMs >= this.o.minSpeechMs;
      this.reset();
      return enough ? out : null;
    }
    return null;
  }

  /** 丢掉当前状态（暂停收音、换场景时用）；底噪估计保留 */
  reset(): void {
    this.speaking = false;
    this.loudMs = this.quietMs = this.speechMs = 0;
    this.pre = [];
    this.preMs = 0;
    this.buf = [];
    this.bufMs = 0;
  }
}
