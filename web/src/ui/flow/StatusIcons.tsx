// 状态行 / 子代理面板用的动效图标，取自《会话生命周期动效》：
// 星轨（还没有文字）、液滴（整理上下文）、完成 / 出错 / 中止。
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

/** 液滴：几滴液体绕核心融合又分开。子代理面板头部 */
export const CompactingIcon = memo(function CompactingIcon({ size = 16, className }: IconProps) {
  const uid = useUid();
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={cls('compacting', className)} aria-hidden focusable="false">
      <defs>
        <filter id={`${uid}-g`} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="2.6" />
          <feColorMatrix values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -8" />
        </filter>
        <linearGradient id={`${uid}-l`} gradientUnits="userSpaceOnUse" x1="8" y1="8" x2="56" y2="56">
          <stop offset="0" style={{ stopColor: 'var(--tk-b)' }} />
          <stop offset=".5" style={{ stopColor: 'var(--tk-a)' }} />
          <stop offset="1" style={{ stopColor: 'var(--tk-c)' }} />
        </linearGradient>
      </defs>
      <g filter={`url(#${uid}-g)`} fill={`url(#${uid}-l)`}>
        <circle className="cz-ss-core" cx="32" cy="32" r="9.5" />
        <g className="cz-ss-o">
          <circle cx="32" cy="32" r="5.5" />
        </g>
        <g className="cz-ss-o cz-ss-o2">
          <circle cx="32" cy="32" r="4.5" />
        </g>
        <g className="cz-ss-o cz-ss-o3">
          <circle cx="32" cy="32" r="6" />
        </g>
        <g className="cz-ss-o cz-ss-o4">
          <circle cx="32" cy="32" r="3.5" />
        </g>
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
