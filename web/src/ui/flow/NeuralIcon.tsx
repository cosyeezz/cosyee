// 状态行「进行中」图标：神经脉冲（取自《会话生命周期动效》的「调用工具」）。
// 节点依次点亮，光脉冲沿连线流动；颜色用 icons.css 的 --tk-*，样式在 status.css。
import { memo } from 'react';
import './status.css';

const EDGES: [string, number][] = [
  ['M11 22L30 10', 0],
  ['M11 22L21 47', 0.15],
  ['M30 10L38 33', 0.7],
  ['M30 10L53 20', 0.8],
  ['M21 47L38 33', 0.9],
  ['M21 47L52 53', 1],
  ['M53 20L38 33', 1.5],
  ['M38 33L52 53', 1.5],
];
const NODES: [number, number, number, number][] = [
  [11, 22, 3, 0],
  [30, 10, 3, 0.6],
  [53, 20, 3, 1.4],
  [38, 33, 3.6, 1.4],
  [21, 47, 3, 0.8],
  [52, 53, 3, 2.1],
];
/** 负延迟：一挂载就处在周期中段，不会先空白一下 */
const delay = (v: number) => (v - 2.4).toFixed(2) + 's';

export const NeuralIcon = memo(function NeuralIcon({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={`cz-ss cz-ss-tool${className ? ' ' + className : ''}`}
      aria-hidden
      focusable="false"
    >
      {EDGES.map(([d], i) => (
        <path key={`e${i}`} className="cz-ss-e" d={d} />
      ))}
      {NODES.map(([cx, cy, r, t], i) => (
        <circle key={`n${i}`} className="cz-ss-n" cx={cx} cy={cy} r={r} style={{ animationDelay: delay(t) }} />
      ))}
      {EDGES.map(([d, t], i) => (
        <path
          key={`p${i}`}
          className={i % 3 === 2 ? 'cz-ss-p cz-ss-p2' : 'cz-ss-p'}
          pathLength={100}
          d={d}
          style={{ animationDelay: delay(t) }}
        />
      ))}
    </svg>
  );
});
