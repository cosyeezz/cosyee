// 状态行 / 子代理面板用的动效图标，取自《会话生命周期动效》：
// 星轨（还没有文字）、机器人 / 魔法书 / 插头（子代理 / 技能 / MCP 面板）、完成 / 出错 / 中止。
// 颜色用 icons.css 的 --tk-*，样式与动画在 status.css。同一页有多个实例，渐变 / 滤镜 id 用 useId 区分。
import { memo, useId } from 'react';
import './status.css';

interface IconProps {
  size?: number;
  className?: string;
}

const cls = (name: string, className?: string) => `cz-ss cz-ss-${name}${className ? ' ' + className : ''}`;
/** useId 形如「:r1:」，去掉冒号再拼进 url(#...) 更稳妥 */
const useUid = () => useId().replace(/[^a-zA-Z0-9_-]/g, '');

const ELLIPSE = { cx: 32, cy: 32, rx: 27, ry: 10, pathLength: 100 } as const;

/** 彗尾：n 层很淡的线段叠成，连续变细变淡（与参考实现一致） */
function tailLayers(n: number) {
  const alpha = (1 - Math.pow(0.09, 1 / n)).toFixed(3);
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    const len = 1.5 + 34.5 * Math.pow(1 - t, 1.5);
    const w = 0.3 + 2.6 * Math.pow(t, 1.25);
    return {
      strokeOpacity: alpha,
      strokeWidth: w.toFixed(2),
      strokeDasharray: `0 ${(100 - len).toFixed(2)} ${len.toFixed(2)} 0`,
    };
  });
}
const TAIL = tailLayers(8);
const ORBIT_ANGLES = [0, 60, 120] as const;

/** 星轨：三色彗星绕琥珀色核心。状态行「正在理解问题」 */
export const OrbitIcon = memo(function OrbitIcon({ size = 20, className }: IconProps) {
  const uid = useUid();
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={cls('thinking', className)} aria-hidden focusable="false">
      <defs>
        <radialGradient id={`${uid}-k`}>
          <stop offset="0" stopColor="#fff" />
          <stop offset=".45" style={{ stopColor: 'var(--tk-d)' }} />
          <stop offset="1" style={{ stopColor: 'var(--tk-c)' }} />
        </radialGradient>
        <filter id={`${uid}-b`} x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur stdDeviation="3" />
        </filter>
      </defs>
      <g className="cz-ss-sys">
        {ORBIT_ANGLES.map((a, i) => (
          <g key={a} className={`cz-ss-o${i + 1}`} transform={`rotate(${a} 32 32)`}>
            <ellipse className="cz-ss-ring" {...ELLIPSE} />
            {TAIL.map((s, j) => (
              <ellipse key={j} className="cz-ss-tail" {...ELLIPSE} style={s} />
            ))}
            <ellipse className="cz-ss-head" {...ELLIPSE} />
          </g>
        ))}
      </g>
      <circle className="cz-ss-glow" cx="32" cy="32" r="6" filter={`url(#${uid}-b)`} />
      <circle className="cz-ss-core" cx="32" cy="32" r="4" fill={`url(#${uid}-k)`} />
    </svg>
  );
});

/**
 * 小机器人：圆角脑袋加琥珀色天线。子代理面板头部。
 * 进行中：眨眼、天线灯一明一暗；全部结束（is-still）：天线常亮、眯眼笑。
 */
export const AgentIcon = memo(function AgentIcon({ size = 16, className }: IconProps) {
  const uid = useUid();
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={cls('agent', className)} aria-hidden focusable="false">
      <defs>
        <linearGradient id={`${uid}-l`} gradientUnits="userSpaceOnUse" x1="8" y1="8" x2="56" y2="56">
          <stop offset="0" style={{ stopColor: 'var(--tk-b)' }} />
          <stop offset=".5" style={{ stopColor: 'var(--tk-a)' }} />
          <stop offset="1" style={{ stopColor: 'var(--tk-c)' }} />
        </linearGradient>
      </defs>
      {/* 按整个画布画，再缩到与魔法书相近的视觉大小 */}
      <g transform="translate(5.12 4.4) scale(.84)">
        <path className="cz-ss-ant" d="M32 10V20" />
        <circle className="cz-ss-tip" cx="32" cy="8" r="5.5" />
        <g fill={`url(#${uid}-l)`}>
          <rect x="1" y="30" width="9" height="16" rx="4.5" />
          <rect x="54" y="30" width="9" height="16" rx="4.5" />
          <rect x="8" y="17" width="48" height="42" rx="14" />
        </g>
        <g className="cz-ss-eyes">
          <rect x="19" y="30" width="8" height="15" rx="4" />
          <rect x="37" y="30" width="8" height="15" rx="4" />
        </g>
        <path className="cz-ss-smile" d="M18 40L23 34L28 40M36 40L41 34L46 40" />
      </g>
    </svg>
  );
});

/** 四角星（闪光）：以 (x, y) 为中心、r 为半径的内凹四角星 */
const sparkle = (x: number, y: number, r: number) =>
  `M${x} ${y - r}Q${x} ${y} ${x + r} ${y}Q${x} ${y} ${x} ${y + r}Q${x} ${y} ${x - r} ${y}Q${x} ${y} ${x} ${y - r}Z`;
const PAGE_L = 'M30.5 17C24 13.2 15 13 7 16.5V48.5C15 45.5 24 45.8 30.5 49.5Z';
const PAGE_R = 'M33.5 17C40 13.2 49 13 57 16.5V48.5C49 45.5 40 45.8 33.5 49.5Z';
const SPARKS: [number, number, number][] = [
  [11, 7, 5],
  [32, 5.5, 3.6],
  [53, 7.5, 4.4],
];

/**
 * 魔法书：摊开的书，右页不停翻到左边，上方三颗四角星依次闪烁。技能面板头部。
 * 全部加载完（is-still）：翻页停下、星星定格，表示「已读入」。
 */
export const SkillIcon = memo(function SkillIcon({ size = 16, className }: IconProps) {
  const uid = useUid();
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={cls('skill', className)} aria-hidden focusable="false">
      <defs>
        <linearGradient id={`${uid}-l`} gradientUnits="userSpaceOnUse" x1="7" y1="14" x2="57" y2="50">
          <stop offset="0" style={{ stopColor: 'var(--tk-b)' }} />
          <stop offset=".5" style={{ stopColor: 'var(--tk-a)' }} />
          <stop offset="1" style={{ stopColor: 'var(--tk-c)' }} />
        </linearGradient>
        <linearGradient id={`${uid}-f`} gradientUnits="userSpaceOnUse" x1="33" y1="14" x2="57" y2="50">
          <stop offset="0" style={{ stopColor: 'var(--tk-d)' }} />
          <stop offset="1" style={{ stopColor: 'var(--tk-c)' }} />
        </linearGradient>
      </defs>
      <g fill={`url(#${uid}-l)`}>
        <path d={PAGE_L} />
        <path d={PAGE_R} />
      </g>
      <g className="cz-ss-ln">
        <path d="M12 25Q19 23 26 25.5M12 32.5Q19 30.5 26 33M12 40Q19 38 26 40.5" />
        <path d="M38 25.5Q45 23 52 25M38 33Q45 30.5 52 32.5M38 40.5Q45 38 52 40" />
      </g>
      {/* 正在翻的一页：暖色（琥珀 → 粉），和冷色的书页区分开 */}
      <g className="cz-ss-flip">
        <path d={PAGE_R} fill={`url(#${uid}-f)`} />
        <path className="cz-ss-ln" d="M38 25.5Q45 23 52 25M38 33Q45 30.5 52 32.5M38 40.5Q45 38 52 40" />
      </g>
      {SPARKS.map(([x, y, r], i) => (
        <path key={i} className={`cz-ss-sp cz-ss-sp${i + 1}`} d={sparkle(x, y, r)} />
      ))}
    </svg>
  );
});

/**
 * 插头：斜放的插头插进插座，接触瞬间迸出琥珀色电火花，光点顺着插座的线缆流走，随后拔出再插。MCP 面板头部。
 * 没有进行中的调用（is-still）：插头停在插好的位置，表示「已连接」。
 * 图形按水平方向画（插头在左、插座在右），整组旋转 -45° 摆成斜向。
 */
export const McpIcon = memo(function McpIcon({ size = 16, className }: IconProps) {
  const uid = useUid();
  const fill = `url(#${uid}-l)`;
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={cls('mcp', className)} aria-hidden focusable="false">
      <defs>
        <linearGradient id={`${uid}-l`} gradientUnits="userSpaceOnUse" x1="-2" y1="32" x2="66" y2="32">
          <stop offset="0" style={{ stopColor: 'var(--tk-b)' }} />
          <stop offset=".5" style={{ stopColor: 'var(--tk-a)' }} />
          <stop offset="1" style={{ stopColor: 'var(--tk-c)' }} />
        </linearGradient>
      </defs>
      <g transform="rotate(-45 32 32)">
        <path className="cz-ss-cable" d="M-3 32H16M48 32H67" stroke={fill} />
        <path className="cz-ss-flow" d="M44 32H67" pathLength={100} />
        <g className="cz-ss-plug" fill={fill}>
          <rect x="9" y="21" width="15" height="22" rx="5" />
          <rect x="22" y="25" width="10" height="4.4" rx="2.2" />
          <rect x="22" y="34.6" width="10" height="4.4" rx="2.2" />
        </g>
        <rect className="cz-ss-sock" x="33" y="19" width="16" height="26" rx="5.5" fill={fill} />
        <g className="cz-ss-spark">
          <circle cx="32.5" cy="32" r="7" />
          <path d="M32.5 19V14M32.5 45V50M26 22.5L23 19M39 22.5L42 19M26 41.5L23 45M39 41.5L42 45" />
        </g>
      </g>
    </svg>
  );
});

/** 雷达脉冲：外圈柔和扩散 + 旋转扫描弧 + 琥珀色核心。状态行「等待后台：…」 */
export const WaitingIcon = memo(function WaitingIcon({ size = 20, className }: IconProps) {
  const uid = useUid();
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={cls('waiting', className)} aria-hidden focusable="false">
      <defs>
        <linearGradient id={`${uid}-w`} gradientUnits="userSpaceOnUse" x1="10" y1="10" x2="54" y2="54">
          <stop offset="0" style={{ stopColor: 'var(--tk-d)' }} />
          <stop offset="0.55" style={{ stopColor: 'var(--tk-a)' }} />
          <stop offset="1" style={{ stopColor: 'var(--tk-b)' }} />
        </linearGradient>
      </defs>
      <circle className="cz-ss-track" cx="32" cy="32" r="21" />
      <circle className="cz-ss-ripple" cx="32" cy="32" r="14" />
      <circle className="cz-ss-arc" cx="32" cy="32" r="21" pathLength={100} stroke={`url(#${uid}-w)`} />
      <circle className="cz-ss-dot" cx="32" cy="32" r="5" />
    </svg>
  );
});

/** 完成：绿色圆环画一圈，对勾跟着画出，外圈淡淡散开一次，之后静止 */
export const DoneIcon = memo(function DoneIcon({ size = 20, className }: IconProps) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={cls('done', className)} aria-hidden focusable="false">
      <circle className="cz-ss-w" cx="32" cy="32" r="22" />
      <circle className="cz-ss-r" cx="32" cy="32" r="22" pathLength={1} transform="rotate(-90 32 32)" />
      <path className="cz-ss-c" pathLength={1} d="M21 33L29 41L43.5 24.5" />
    </svg>
  );
});

/** 出错：红色圆环加叉号，左右轻抖一次，之后静止 */
export const ErrorIcon = memo(function ErrorIcon({ size = 20, className }: IconProps) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={cls('error', className)} aria-hidden focusable="false">
      <g className="cz-ss-g">
        <circle className="cz-ss-r" cx="32" cy="32" r="22" />
        <path className="cz-ss-x" d="M24 24L40 40M40 24L24 40" />
      </g>
    </svg>
  );
});

/** 中止：灰色圆环加方块，出现时轻轻缩放一次，之后静止 */
export const StoppedIcon = memo(function StoppedIcon({ size = 20, className }: IconProps) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={cls('stopped', className)} aria-hidden focusable="false">
      <g className="cz-ss-g">
        <circle className="cz-ss-r" cx="32" cy="32" r="22" />
        <rect className="cz-ss-q" x="24.5" y="24.5" width="15" height="15" rx="3.5" />
      </g>
    </svg>
  );
});
