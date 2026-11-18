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
