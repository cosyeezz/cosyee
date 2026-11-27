// Cosyee 会话流图标 —— 生成内联 SVG 字符串，配合 icons.css 使用。
//   import { icon } from './icons/icons.js'
//   el.innerHTML = icon('understanding', { size: 20 })
//   el.innerHTML = icon('tool-bash', { size: 16, running: true })
// 所有图标 viewBox 都是 64×64；一次性动画（done / error / stopped）在元素插入时播放一次。

let uid = 0;

const wrap = (name, size, body, extra = '') =>
  `<svg class="ci ci-${name}${extra}" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true">${body}</svg>`;

// 星轨的彗尾：n 层很淡的线段叠成，尺寸越小层数越少
const E = 'cx="32" cy="32" rx="27" ry="10" pathLength="100"';
function tail(n) {
  const alpha = (1 - Math.pow(0.09, 1 / n)).toFixed(3);
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    const len = (1.5 + 34.5 * Math.pow(1 - t, 1.5)).toFixed(2);
    const w = (0.3 + 2.6 * Math.pow(t, 1.25)).toFixed(2);
    return `<ellipse class="tail" ${E} style="stroke-opacity:${alpha};stroke-width:${w};stroke-dasharray:0 ${(100 - len).toFixed(2)} ${len} 0"/>`;
  }).join('');
}

// 子代理转圈的弧：三层叠出渐隐的尾巴，头部在 12 点方向
const ARC = [[62, .22], [40, .45], [18, 1]]
  .map(([len, op]) => `<circle class="a" cx="32" cy="32" r="21" pathLength="100" transform="rotate(-90 32 32)" style="stroke-opacity:${op};stroke-dasharray:0 ${100 - len} ${len} 0"/>`)
  .join('');

export const ICONS = {
  understanding: {
    label: '正在理解问题', where: '状态行 · 已发送，还没有实质输出', live: true,
    render({ size }) {
      const id = 'ci' + (++uid), T = tail(size >= 60 ? 28 : size >= 40 ? 14 : 8);
      const O = (i, a) => `<g class="o${i}" transform="rotate(${a} 32 32)"><ellipse class="ring" ${E}/>${T}<ellipse class="head" ${E}/></g>`;
      return `<defs><radialGradient id="${id}-k"><stop offset="0" stop-color="#fff"/><stop offset=".45" style="stop-color:var(--tk-d)"/><stop offset="1" style="stop-color:var(--tk-c)"/></radialGradient>` +
        `<filter id="${id}-b" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="3"/></filter></defs>` +
        `<g class="sys">${O(1, 0)}${O(2, 60)}${O(3, 120)}</g>` +
        `<circle class="glow" cx="32" cy="32" r="6" filter="url(#${id}-b)"/><circle class="core" cx="32" cy="32" r="4" fill="url(#${id}-k)"/>`;
    },
  },
  streaming: {
    label: '模型输出文字', where: '状态行 · 文字流出时', live: true,
    render() {
      const id = 'ci' + (++uid);
      return `<defs><linearGradient id="${id}-w" gradientUnits="userSpaceOnUse" x1="8" y1="0" x2="56" y2="0"><stop offset="0" style="stop-color:var(--tk-c)"/><stop offset="1" style="stop-color:var(--tk-a)"/></linearGradient></defs>` +
        `<g fill="url(#${id}-w)"><rect x="8" y="16" width="7" height="32" rx="3.5"/><rect x="18.25" y="13" width="7" height="38" rx="3.5"/><rect x="28.5" y="10" width="7" height="44" rx="3.5"/><rect x="38.75" y="13" width="7" height="38" rx="3.5"/><rect x="49" y="16" width="7" height="32" rx="3.5"/></g>`;
    },
  },
  done: {
    label: '已完成', where: '状态行 · 结束；子代理行 · ✓',
    render() {
      const id = 'ci' + (++uid);
      return `<defs><linearGradient id="${id}-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" style="stop-color:var(--tk-ok)"/><stop offset="1" style="stop-color:var(--tk-b)"/></linearGradient></defs>` +
        `<path class="k" d="M57.9 42.7L62.5 44.6M42.7 57.9L44.6 62.5M21.3 57.9L19.4 62.5M6.1 42.7L1.5 44.6M6.1 21.3L1.5 19.4M21.3 6.1L19.4 1.5M42.7 6.1L44.6 1.5M57.9 21.3L62.5 19.4"/><circle class="b" cx="32" cy="32" r="24" fill="url(#${id}-g)"/><path class="c" pathLength="1" d="M21 33L29 41L44 25"/>`;
    },
  },
  error: {
    label: '出错', where: '状态行 · 出错',
    render() {
      const id = 'ci' + (++uid);
      return `<defs><linearGradient id="${id}-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" style="stop-color:var(--tk-d)"/><stop offset=".45" style="stop-color:var(--tk-err)"/><stop offset="1" style="stop-color:var(--tk-c)"/></linearGradient></defs>` +
        `<g class="g"><circle class="b" cx="32" cy="32" r="24" fill="url(#${id}-g)"/><path class="x" d="M32 19V35"/><circle class="d" cx="32" cy="44.5" r="3.6"/></g>`;
    },
  },
  stopped: {
    label: '中断', where: '状态行 · 中断',
    render: () => `<g class="g"><circle class="r" cx="32" cy="32" r="22"/><rect class="q" x="24.5" y="24.5" width="15" height="15" rx="3.5"/></g>`,
  },
  chevron: {
    label: '展开 / 收起', where: '状态行 · 点击展开执行过程（open 时转 90°）', openable: true,
    render: () => `<path d="M25 18L39 32L25 46"/>`,
  },
  'agent-running': {
    label: '子代理执行中', where: '子代理面板 · ⟳（标题行和每一行）', live: true,
    render: () => `<circle class="t" cx="32" cy="32" r="21"/><g class="s">${ARC}</g>`,
  },
  open: {
    label: '打开浮层', where: '子代理面板 · ↗',
    render: () => `<g class="arw"><path d="M21 43L43 21"/><path d="M25 21H43V39"/></g>`,
  },
  'tool-bash': {
    label: 'Bash 工具', where: '展开区 · 工具调用摘要行（running 时带动效）', runnable: true,
    render: () => `<rect class="f" x="8" y="12" width="48" height="40" rx="9"/><rect class="p" x="8" y="12" width="48" height="40" rx="9" pathLength="100"/><path class="c" d="M19 25L27 32L19 39"/><path class="u" d="M33 40H45"/>`,
  },

  // ── 以下为细线图标（line: true → .ci-ln）：.l 线条，.hi 运行时变色，.w 运行时反复描出，.p 运行时沿轮廓跑光 ──
  'tool-read': {
    label: 'Read 工具', where: '展开区 · 读文件', runnable: true, line: true,
    render: () => { const d = 'M18 8H38L50 20V52A4 4 0 0 1 46 56H18A4 4 0 0 1 14 52V12A4 4 0 0 1 18 8Z';
      return `<path class="l" d="${d}"/><path class="p" pathLength="100" d="${d}"/><path class="l" d="M38 8V20H50"/><path class="l hi w" pathLength="1" d="M22 33H42"/><path class="l hi w w2" pathLength="1" d="M22 44H35"/>`; },
  },
  'tool-edit': {
    label: 'Edit / Write 工具', where: '展开区 · 改文件、写文件', runnable: true, line: true,
    render: () => `<g class="pen"><path class="l" d="M40 10L52 22L24 50L10 54L14 40Z"/><path class="l" d="M33 17L45 29"/></g><path class="l hi w" pathLength="1" d="M32 55H55"/>`,
  },
  'tool-search': {
    label: 'Grep / Glob 工具', where: '展开区 · 搜索内容、查找文件', runnable: true, line: true,
    render: () => `<g class="lens"><circle class="l" cx="28" cy="28" r="17"/><circle class="p" cx="28" cy="28" r="17" pathLength="100"/><path class="l" d="M41 41L55 55"/></g>`,
  },
  'tool-web': {
    label: 'WebFetch / WebSearch 工具', where: '展开区 · 抓网页、联网搜索', runnable: true, line: true,
    render: () => `<circle class="l" cx="32" cy="32" r="23"/><circle class="p" cx="32" cy="32" r="23" pathLength="100"/><path class="l" d="M9 32H55"/><ellipse class="l hi mer" cx="32" cy="32" rx="10" ry="23"/>`,
  },
  'tool-agent': {
    label: 'Agent 工具', where: '展开区 · 启动子代理', runnable: true, line: true,
    render: () => `<circle class="l" cx="32" cy="13" r="6.5"/><path class="l" d="M32 20V31M15 42V36A5 5 0 0 1 20 31H44A5 5 0 0 1 49 36V42"/><circle class="l hi n1" cx="15" cy="49" r="6.5"/><circle class="l hi n2" cx="49" cy="49" r="6.5"/>`,
  },
  'tool-mcp': {
    label: 'MCP 工具', where: '展开区 · 外部连接器的工具', runnable: true, line: true,
    render: () => `<g class="pl"><path class="l" d="M5 32H14M14 19H22A5 5 0 0 1 27 24V40A5 5 0 0 1 22 45H14Z"/><path class="l hi" d="M27 26H34M27 38H34"/></g><g class="pr"><path class="l" d="M59 32H50M50 19H47A9 9 0 0 0 38 28V36A9 9 0 0 0 47 45H50Z"/></g>`,
  },
  'tool-todo': {
    label: '任务清单', where: '展开区 · TodoWrite', runnable: true, line: true,
    render: () => `<path class="l hi w" pathLength="1" d="M9 17L15 23L25 11"/><path class="l" d="M34 17H55"/><rect class="l" x="10" y="38" width="13" height="13" rx="3.5"/><path class="l" d="M34 45H55"/>`,
  },
  'tool-skill': {
    label: 'Skill 工具', where: '展开区 · 加载 skill（摊开的书 + 星光，与技能面板的魔法书同一意象）', runnable: true, line: true,
    render: () => `<path class="l" d="M27.5 29C21.9 24.5 14 24 6 26.5V52.5C14 50 21.9 50.5 27.5 55C33.1 50.5 41 50 49 52.5V26.5C41 24 33.1 24.5 27.5 29Z"/><path class="l" d="M27.5 29V55"/><path class="l dot hi spk" d="M51 2C51.8 7.9 54.6 10.7 60.5 11.5C54.6 12.3 51.8 15.1 51 21C50.2 15.1 47.4 12.3 41.5 11.5C47.4 10.7 50.2 7.9 51 2Z"/>`,
  },
  'tool-generic': {
    label: '其他工具', where: '展开区 · 兜底图标', runnable: true, line: true,
    render: () => `<g class="nut"><polygon class="l hi" points="55,32 43.5,51.9 20.5,51.9 9,32 20.5,12.1 43.5,12.1"/><circle class="l" cx="32" cy="32" r="8.5"/></g>`,
  },
  'tool-fail': {
    label: '工具失败', where: '展开区 · 工具调用失败时替换工具图标', line: true,
    render: () => `<g class="g"><path class="l" d="M32 10L56 52H8Z"/><path class="l" d="M32 26V38"/><circle class="dot" cx="32" cy="45" r="2.4"/></g>`,
  },
  thought: {
    label: '思考', where: '展开区 · 思考内容', line: true,
    render: () => `<path class="l" d="M22 41A12.5 12.5 0 0 1 19 17A14 14 0 0 1 45 15A13 13 0 0 1 45 41Z"/><circle class="dot" cx="17" cy="51" r="3.4"/><circle class="dot" cx="9" cy="58" r="2.2"/>`,
  },
  note: {
    label: '中间说明文字', where: '展开区 · 模型在步骤之间说的话', line: true,
    render: () => `<path class="l" d="M11 18H53M11 32H53M11 46H36"/>`,
  },
  close: {
    label: '关闭浮层', where: '子代理浮层 · ×（悬停时转 90°）', line: true,
    render: () => `<g class="x"><path class="l" d="M19 19L45 45M45 19L19 45"/></g>`,
  },
};

/** 生成图标 SVG 字符串。opts: size（像素，默认 20）、running（仅 tool-* 有效）、open（仅 chevron 有效） */
export function icon(name, opts = {}) {
  const def = ICONS[name];
  if (!def) throw new Error(`unknown icon: ${name}`);
  const size = opts.size ?? 20;
  const running = def.runnable && opts.running;
  const extra = (def.line ? ' ci-ln' : '') + (def.live || running ? ' ci-live' : '') + (running ? ' is-running' : '') + (def.openable && opts.open ? ' is-open' : '');
  return wrap(name, size, def.render({ size }), extra);
}
