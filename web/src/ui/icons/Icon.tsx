// 统一图标组件。所有 UI 只用 <Icon name="..." />，不要直接写 SVG 或引入别的图标库。
// 会话流图标由设计会话提供（F:\Cosyee\icons\icons.js，别名 @icons），其余名字先用占位方框。
// 设计会话补齐图标后，只需要改这一个文件。
import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
// @ts-ignore 设计会话产出的是 JS 模块
import { ICONS as DESIGN_ICONS, icon as designIcon } from '@icons/icons.js';
import '@icons/icons.css';

export type IconName =
  // 会话流（设计会话已提供，共 21 个）
  | 'understanding' | 'streaming' | 'done' | 'error' | 'stopped' | 'chevron' | 'agent-running' | 'open'
  | 'tool-bash' | 'tool-read' | 'tool-edit' | 'tool-search' | 'tool-web' | 'tool-agent' | 'tool-mcp'
  | 'tool-todo' | 'tool-generic' | 'tool-fail' | 'thought' | 'note' | 'close'
  // 其余（设计稿未提供，用下方 SIMPLE 线条图标）
  | 'new-chat' | 'sidebar-collapse' | 'sidebar-expand' | 'panel-collapse' | 'panel-expand' | 'folder' | 'folder-open' | 'chevron-down' | 'chevron-up'
  | 'chevron-right' | 'settings' | 'branch' | 'plus' | 'mic' | 'send' | 'stop' | 'check' | 'info'
  | 'file' | 'image' | 'compact'
  // 选中回复
  | 'reply' | 'copy'
  // 朗读
  | 'volume'
  // 通话模式
  | 'phone'
  // 会话流滚动导航（回到上一个 / 下一个交付点）
  | 'arrow-up' | 'arrow-down'
  // 侧栏
  | 'search' | 'pin' | 'pin-on' | 'trash' | 'restore' | 'folder-reveal' | 'pencil'
  // 会话流里的「思考」行（线条火花，替代设计稿的 'thought' 云朵；'thought' 保留不删）
  | 'thinking'
  // Skills 面板：三种状态（开 / 手动 / 关）、一键推荐配置、撤销
  | 'skill-on' | 'skill-manual' | 'skill-off' | 'wand' | 'undo'
  // 本地文件预览浮窗：终端、最大化 / 还原、刷新、自动换行
  | 'terminal' | 'maximize' | 'window-restore' | 'refresh' | 'wrap'
  // 权限模式：自动（闪电）/ 计划（清单）
  | 'mode-auto' | 'mode-plan'
  // 内置浏览器：地球、后退 / 前进、抓取元素（准星）
  | 'globe' | 'arrow-left' | 'arrow-right' | 'pick'
  // 账号弹层：管理账号
  | 'users';

export interface IconProps {
  name: IconName;
  size?: number;
  /** 工具图标的执行中动效 */
  running?: boolean;
  /** 展开 / 收起状态（仅 chevron 有效）：切换 svg 上的 is-open 类，由 icons.css 做 90° 旋转过渡 */
  open?: boolean;
  className?: string;
  title?: string;
}

const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

const hasDesign = (name: string): boolean =>
  !!DESIGN_ICONS && Object.prototype.hasOwnProperty.call(DESIGN_ICONS, name);

/** 输入框与菜单用的简单线条图标（设计稿未提供前的实现），16×16 画布 */
const SIMPLE: Record<string, JSX.Element> = {
  plus: <path d="M8 3v10M3 8h10" />,
  // 权限模式：自动 = 闪电；计划 = 带勾选行的清单
  'mode-auto': <path d="M9 2L3.8 9h3.7L7 14l5.2-7H8.5z" />,
  'mode-plan': (
    <>
      <rect x="2.6" y="2.6" width="10.8" height="10.8" rx="2.4" />
      <path d="M5.4 6l.9.9 1.6-1.8M5.4 10.4l.9.9 1.6-1.8M9.6 6.2h1.6M9.6 10.6h1.6" />
    </>
  ),
  // skill 状态：开=圆里打勾；手动=圆角方框里一道斜杠（/名字）；关=圆里斜线
  'skill-on': (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M5.4 8.2l1.8 1.8 3.4-3.7" />
    </>
  ),
  'skill-manual': (
    <>
      <rect x="2.2" y="2.2" width="11.6" height="11.6" rx="3.2" />
      <path d="M9.3 5.2L6.7 10.8" />
    </>
  ),
  'skill-off': (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M3.9 12.1l8.2-8.2" />
    </>
  ),
  // 魔法棒 + 两颗火花：一键推荐配置
  wand: (
    <>
      <path d="M2.8 13.2L9.6 6.4" />
      <path d="M8.4 5.2l2.4 2.4" />
      <path d="M12.4 1.8v3.2M10.8 3.4H14" />
      <path d="M4.2 2.6v2M3.2 3.6h2" />
    </>
  ),
  undo: (
    <>
      <path d="M3.6 6.4h5.8a3.3 3.3 0 010 6.6H6" />
      <path d="M6.1 3.7L3.4 6.4l2.7 2.7" />
    </>
  ),
  'chevron-right': <path d="M6 4l4 4-4 4" />,
  // 新建会话：缺一角的方框 + 铅笔
  'new-chat': (
    <>
      <path d="M7.5 2.5H4.5a2 2 0 00-2 2v7a2 2 0 002 2h7a2 2 0 002-2V8.5" />
      <path d="M12.3 2.2l1.5 1.5-5.6 5.6-2.1.6.6-2.1z" />
    </>
  ),
  // 收起 / 展开侧栏：带左栏分隔线的面板 + 方向箭头
  'sidebar-collapse': (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="2.5" />
      <path d="M6 2.5v11M11 6.2L9.2 8l1.8 1.8" />
    </>
  ),
  'sidebar-expand': (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="2.5" />
      <path d="M6 2.5v11M9.2 6.2L11 8 9.2 9.8" />
    </>
  ),
  // 收起 / 展开右侧上下文栏：与侧栏图标镜像（分隔线在右）
  'panel-collapse': (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="2.5" />
      <path d="M10 2.5v11M5 6.2L6.8 8 5 9.8" />
    </>
  ),
  'panel-expand': (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="2.5" />
      <path d="M10 2.5v11M6.8 6.2L5 8l1.8 1.8" />
    </>
  ),
  folder: <path d="M2 4.5A1.5 1.5 0 013.5 3H6l1.5 1.8h5A1.5 1.5 0 0114 6.3v5.7a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12z" />,
  'folder-open': (
    <>
      <path d="M2 12V4.5A1.5 1.5 0 013.5 3H6l1.5 1.8h5A1.5 1.5 0 0114 6.3v1.2" />
      <path d="M2 13l1.6-4.6a1 1 0 01.95-.7h9.1a.7.7 0 01.66.93l-1.5 4.2a1 1 0 01-.94.67H2z" />
    </>
  ),
  // 在文件管理器中显示：文件夹 + 右上箭头
  'folder-reveal': (
    <>
      <path d="M8 13.5H3.5A1.5 1.5 0 012 12V4.5A1.5 1.5 0 013.5 3H6l1.5 1.8h5A1.5 1.5 0 0114 6.3V8" />
      <path d="M9.5 13.5l4-4M10.2 9.5h3.3v3.3" />
    </>
  ),
  // 设置：齿轮（24 画布的路径缩放到 16，线宽同比放大以保持 1.4）
  settings: (
    <g transform="scale(.6667)" strokeWidth="2.1">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </g>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.4 10.4l3.1 3.1" />
    </>
  ),
  // 置顶（Lucide 图钉，24→16 缩放 ×.575）与删除（垃圾桶）：竖向都是 y 2.5–14，视觉等高
  pin: (
    <g transform="translate(1.1 1.35) scale(.575)" strokeWidth="2.43">
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </g>
  ),
  // 置顶（已开启）：实心填充的图钉
  'pin-on': (
    <g transform="translate(1.1 1.35) scale(.575)" strokeWidth="2.43">
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" fill="currentColor" />
    </g>
  ),
  trash: (
    <>
      <path d="M2.5 4.2h11M6 4.2V2.5h4v1.7" />
      <path d="M4 4.2l.6 8.4A1.4 1.4 0 006 14h4a1.4 1.4 0 001.4-1.4l.6-8.4M6.7 7v4M9.3 7v4" />
    </>
  ),
  // 编辑：斜放的铅笔（竖向 y 2.5–13.5，与置顶 / 删除视觉等高）
  pencil: <path d="M10.6 2.9l2.5 2.5-7.4 7.4-3.2.7.7-3.2zM9.3 4.2l2.5 2.5" />,
  users: (
    <>
      <circle cx="6" cy="5.5" r="2.3" />
      <path d="M1.8 13c.4-2.3 2.1-3.6 4.2-3.6s3.8 1.3 4.2 3.6M10.4 3.4a2.2 2.2 0 010 4.3M11.6 9.6c1.4.4 2.3 1.6 2.6 3.4" />
    </>
  ),
  // 恢复：逆时针回转的箭头
  restore: <path d="M3 3v3.2h3.2M3.4 6.2A5 5 0 118 13" />,
  check: <path d="M3.5 8.5l3 3 6-7" />,
  // git 分支：主干竖线 + 右上分支节点弯回主干
  branch: (
    <>
      <circle cx="4.5" cy="12" r="1.8" />
      <circle cx="11.5" cy="4" r="1.8" />
      <path d="M4.5 2.2v8M11.5 5.8a5.4 5.4 0 01-5.4 5.4" />
    </>
  ),
  // 说明：圆圈里的 i
  info: (
    <>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M8 7.3v3.6M8 5.1v.01" />
    </>
  ),
  // 文件：右上折角的纸
  file: (
    <>
      <path d="M9 2H4.8A1.5 1.5 0 003.3 3.5v9A1.5 1.5 0 004.8 14h6.4a1.5 1.5 0 001.5-1.5V5.7z" />
      <path d="M9 2v3.7h3.7" />
    </>
  ),
  // 图片：画框 + 太阳 + 两座山
  image: (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <circle cx="5.6" cy="6" r="1.1" />
      <path d="M2.3 11.6l3.3-3.3a1 1 0 011.4 0l4.6 4.9M9.4 10.9l1.4-1.4a1 1 0 011.4 0l1.7 1.7" />
    </>
  ),
  // 压缩会话：上下两个箭头向中线收拢
  compact: <path d="M3 8h10M5.5 2.5L8 5l2.5-2.5M5.5 13.5L8 11l2.5 2.5" />,
  'chevron-down': <path d="M4 6l4 4 4-4" />,
  'chevron-up': <path d="M4 10l4-4 4 4" />,
  'arrow-up': <path d="M8 13V3M3.8 7.2L8 3l4.2 4.2" />,
  'arrow-down': <path d="M8 3v10M3.8 8.8L8 13l4.2-4.2" />,
  'arrow-left': <path d="M13 8H3M7.2 3.8L3 8l4.2 4.2" />,
  'arrow-right': <path d="M3 8h10M8.8 3.8L13 8l-4.2 4.2" />,
  globe: (
    <>
      <circle cx="8" cy="8" r="5.7" />
      <path d="M2.3 8h11.4M8 2.3c1.7 1.6 2.6 3.5 2.6 5.7S9.7 12.1 8 13.7C6.3 12.1 5.4 10.2 5.4 8S6.3 3.9 8 2.3z" />
    </>
  ),
  // 抓取元素：准星
  pick: (
    <>
      <circle cx="8" cy="8" r="4.6" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <path d="M8 1.6v2.2M8 12.2v2.2M1.6 8h2.2M12.2 8h2.2" />
    </>
  ),
  mic: (
    <>
      <rect x="6" y="1.8" width="4" height="7.4" rx="2" />
      <path d="M3.6 7.6a4.4 4.4 0 008.8 0M8 12v2.2" />
    </>
  ),
  send: <path d="M12.5 4v4.5h-9M6.5 5.5l-3 3 3 3" />,
  stop: <rect x="3.5" y="3.5" width="9" height="9" rx="2" fill="currentColor" stroke="none" />,
  // 回复：向左弯的箭头
  reply: <path d="M6.5 3.5l-4 4 4 4M2.5 7.5H9a4.5 4.5 0 014.5 4.5v.5" />,
  // 朗读：喇叭 + 两道声波
  phone: <path d="M5.4 2.4l-2 .6c-.6.2-1 .8-.9 1.4.5 4.5 4.1 8.1 8.6 8.6.6.1 1.2-.3 1.4-.9l.6-2-2.7-1.5-1.3 1.3c-1.6-.7-2.9-2-3.6-3.6l1.3-1.3z" />,
  volume: (
    <>
      <path d="M2.5 6h2.3L8 3.3v9.4L4.8 10H2.5z" />
      <path d="M10.4 6a2.8 2.8 0 010 4M12.2 4.2a5.3 5.3 0 010 7.6" />
    </>
  ),
  // 复制：两张叠放的卡片
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="2" />
      <path d="M10.5 5.5V4.5a2 2 0 00-2-2h-4a2 2 0 00-2 2v4a2 2 0 002 2h1" />
    </>
  ),
  // 终端：圆角窗口 + 提示符 > 与光标线
  terminal: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="2.2" />
      <path d="M5 6.6l2 1.6-2 1.6M8.8 10.2h2.4" />
    </>
  ),
  // 最大化：单个方框；还原：两个错位叠放的方框
  maximize: <rect x="3" y="3" width="10" height="10" rx="2" />,
  'window-restore': (
    <>
      <rect x="2.6" y="5.6" width="7.8" height="7.8" rx="1.8" />
      <path d="M5.6 5.6V4.8a1.8 1.8 0 011.8-1.8h3.8A1.8 1.8 0 0113 4.8v3.8a1.8 1.8 0 01-1.8 1.8h-.8" />
    </>
  ),
  // 刷新：顺时针回转的箭头（与 restore 的逆时针相对）
  refresh: <path d="M13 3v3.2H9.8M12.6 6.2A5 5 0 108 13" />,
  // 自动换行：一行文字折回下一行
  wrap: (
    <>
      <path d="M2.5 4h11M2.5 12h4" />
      <path d="M2.5 8h8.2a2.1 2.1 0 010 4.2H8.6M9.8 10.9l-1.2 1.3 1.2 1.3" />
    </>
  ),
  // 思考：一大一小两颗四角火花
  thinking: (
    <>
      <path d="M7 3.2C7.4 6.2 8.8 7.6 11.8 8 8.8 8.4 7.4 9.8 7 12.8 6.6 9.8 5.2 8.4 2.2 8 5.2 7.6 6.6 6.2 7 3.2z" />
      <path d="M12.6 1.8v3M11.1 3.3h3" />
    </>
  ),
};

/** 设计图标：icons.js 每次调用都会生成新的 id（let uid），所以按 (name, size, running) 只生成一次 */
function DesignIcon({ name, size, running, open, className, title }: IconProps & { size: number }) {
  // useMemo 按实例缓存：同一个实例重渲染时 __html 字符串不变，React 不会重写 innerHTML，
  // done / error / stopped / tool-fail 的一次性动画就不会重播；各实例的渐变 id 也互不重复。
  const html = useMemo(() => designIcon(name, { size, running }), [name, size, running]);
  const ref = useRef<HTMLSpanElement>(null);
  // chevron 的展开状态不进 html（否则换 innerHTML 会丢掉旋转过渡），而是直接切 svg 上的 is-open
  useIsoLayoutEffect(() => {
    ref.current?.firstElementChild?.classList.toggle('is-open', !!open);
  }, [html, open]);
  return (
    <span
      ref={ref}
      className={`icon icon-${name}${className ? ' ' + className : ''}`}
      style={{ display: 'inline-flex', width: size, height: size, flex: 'none' }}
      title={title}
      aria-hidden={title ? undefined : true}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export const Icon = memo(function Icon({ name, size = 16, running, open, className, title }: IconProps) {
  if (hasDesign(name)) {
    return <DesignIcon name={name} size={size} running={running} open={open} className={className} title={title} />;
  }
  const simple = SIMPLE[name];
  if (simple) {
    return (
      <svg
        className={`icon icon-${name}${className ? ' ' + className : ''}`}
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden={title ? undefined : true}
        style={{ flex: 'none' }}
      >
        {title ? <title>{title}</title> : null}
        {simple}
      </svg>
    );
  }
  // 占位：带名字缩写的圆角方框
  return (
    <svg
      className={`icon icon-${name} icon-placeholder${className ? ' ' + className : ''}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden={title ? undefined : true}
      style={{ flex: 'none' }}
    >
      {title ? <title>{title}</title> : null}
      <rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="none" stroke="currentColor" strokeOpacity=".55" />
      <text x="8" y="10.5" textAnchor="middle" fontSize="6" fill="currentColor" fillOpacity=".8" fontFamily="sans-serif">
        {name.slice(0, 2)}
      </text>
    </svg>
  );
});
