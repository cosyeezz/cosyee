// 通话模式的说话检测（VAD）：按每帧能量判断「开始说话」「说完了」。
// 支持滞回（继续说话阈值低于开始阈值）与严格模式（扬声器朗读期间提高开始门槛抗回声）。
// 纯计算，不碰浏览器接口，方便测试。

export interface VadOptions {
  /** 输入采样率 */
  rate: number;
  /** 连续这么久高于阈值才算开始说话（滤掉咳嗽、敲键盘） */
  startMs?: number;
  /** 严格模式（扬声器朗读期间）下的开始持续时长 */
  strictStartMs?: number;
  /** 严格模式下的开始阈值倍率 */
  strictMultiplier?: number;
  /** 滞回系数：进入说话态后，维持说话的阈值 = 开始阈值 × hysteresis */
  hysteresis?: number;
  /** 说话后连续这么久低于维持阈值算说完 */
  endMs?: number;
  /** 说话总时长不到这么多的丢掉 */
  minSpeechMs?: number;
  /** 开始前保留这么长的音频，免得吞掉第一个字 */
  preRollMs?: number;
  /** 一句话最长，到了直接交出识别（后续继续收音） */
  maxMs?: number;
}

export interface VadPushOptions {
  /** 扬声器正在朗读：使用更高的开始阈值与更长的开始时长，且不更新底噪 */
  strict?: boolean;
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
  /** 底噪估计（RMS）：安静时慢慢跟上，说话或严格模式时不更新 */
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
    this.o = {
      startMs: 160,
      strictStartMs: 250,
      strictMultiplier: 2,
      hysteresis: 0.6,
      endMs: 1300,
      minSpeechMs: 350,
      preRollMs: 400,
      maxMs: 180_000,
      ...opts,
    };
  }

  get rate(): number {
    return this.o.rate;
  }

  /** 正在说话（已越过开始判定） */
  get active(): boolean {
    return this.speaking;
  }

  private threshold(): number {
    return Math.max(0.012, this.floor * 3);
  }

  /** 喂一帧；一句话说完（或达到 maxMs 上限）时返回这句话的音频，否则返回 null */
  push(frame: Float32Array, pushOpts?: VadPushOptions): Utterance | null {
    const ms = (frame.length / this.o.rate) * 1000;
    const e = rms(frame);
    const base = this.threshold();

    if (!this.speaking) {
      const strict = pushOpts?.strict === true;
      const startThresh = strict ? base * this.o.strictMultiplier : base;
      const needStartMs = strict ? this.o.strictStartMs : this.o.startMs;
      const loud = e > startThresh;

      // 严格模式（扬声器在响）不更新底噪，免得把回声当成环境底噪导致之后变聋
      if (!loud && !strict) this.floor = this.floor * 0.95 + Math.min(e, 0.05) * 0.05;

      this.pre.push(frame);
      this.preMs += ms;
      // 预留的音频保留最近 preRollMs + 开始判定窗口（取普通/严格中较大的，避免模式切换丢开头）
      const keepPre = this.o.preRollMs + Math.max(this.o.startMs, this.o.strictStartMs);
      while (this.pre.length > 1 && this.preMs - (this.pre[0]!.length / this.o.rate) * 1000 >= keepPre) {
        this.preMs -= (this.pre.shift()!.length / this.o.rate) * 1000;
      }

      this.loudMs = loud ? this.loudMs + ms : 0;
      if (this.loudMs >= needStartMs) {
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

    // 说话态用滞回阈值（低于开始阈值），避免轻声字尾被提前切断
    const keepLoud = e > base * this.o.hysteresis;
    this.buf.push(frame);
    this.bufMs += ms;
    if (keepLoud) {
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
