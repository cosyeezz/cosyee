---
name: interaction-motion
description: "交互动效提示词库：液态玻璃选中、聚光卡片、边缘流光、点击展开放大、玻璃停靠栏、数据唤醒、模块自由拖动、信息流骨架加载、3D 透视轮播、粘性融合导航指示器。Use when the user asks to add any of these micro-interactions / motion effects (liquid glass, spotlight, border beam, shared-element expand, dock magnification, count-up & line draw, drag-and-drop grid reorder, skeleton shimmer, cover flow, gooey indicator) to a frontend."
user-invocable: true
argument-hint: "[编号或名称，如 1 / 液态玻璃 / border-beam] [目标组件]"
---

# 交互动效提示词库

下面是 10 条**原始提示词**。它们只描述了「想要什么感觉」，没有交代技术栈、设计规范、性能与无障碍约束，**不能原样照做**。

## ⚠️ 使用前必须先优化

每次调用本 skill 时，先把选中的原始提示词**优化成一份针对当前项目的实现规格**，再动手写代码。步骤：

1. **读项目上下文**
   - 技术栈与已有依赖（React / Vue / 原生；是否已有 framer-motion、GSAP 等）。优先用项目已有的东西，**没经用户同意不要新增动画库**；纯 CSS + 少量 JS 能做的就不引库。
   - 设计令牌与现有动效规范（如 `tokens.css`、`motion.css` 里的时长、缓动、圆角、颜色变量）。复用变量，不要硬编码新数值。
   - 深浅主题：玻璃、高光、光斑在两套主题下都要好看。
   - 目标组件的真实结构和尺寸。

2. **把模糊描述量化**：写清时长、缓动曲线（或弹簧参数）、位移/缩放/角度、错开间隔、触发条件、结束状态。原文已给的数值保持不变，没给的按项目规范补齐。

3. **补齐工程约束**（原始提示词都没写，但必须做）：
   - `prefers-reduced-motion: reduce` 时降级为无动画或简单淡入。
   - 只动 `transform` / `opacity` / `filter`，避免触发布局；高频指针事件用 `requestAnimationFrame` 节流；`backdrop-filter` 注意面积和层数。
   - 键盘可达与焦点状态；动画中文字保持清晰、不模糊、不抖动。
   - 动画打断：快速连续切换/悬停时要能从当前状态平滑接续，不跳变。
   - 卸载/离开时清理监听与计时器。
   - 触屏设备：悬停类效果（聚光、停靠栏）要有合理的触摸替代或直接关闭。

4. **把优化后的规格简要告诉用户**（几行即可），然后实现，并在浏览器里实际看一遍效果。
   - `.shots/` 脚本只在 Windows 那台机器上（未入库）；macOS 上没有时，自己写个一次性 CDP 脚本放 `/tmp`，用 `/Applications/Google Chrome.app` 的 `--headless=new` + 独立 `--user-data-dir`，Node 22 自带 `WebSocket` / `fetch`，不用装依赖。
   - 桌面客户端页 `client/ui/index.html` 直接用 `file://` 打开截图：`Page.addScriptToEvaluateOnNewDocument` 注入假的 `window.__TAURI__.core.invoke`（按命令名返回 local_status / components_status / kiro_status / tailnet_status 等），主题写 `localStorage['cosyee.theme']`。服务端没运行的场景让组件相关命令抛 `{kind:'offline'}`。要截 760 和 480（≤520px 断点）两种宽度。
   - 这个页面的样式坑：`.local-head .t small` 的颜色优先级比 `.ver.ok` 这类状态类高，状态色要写成 `.local-head .t small.ver.ok`，否则截图里版本行全是灰的。按钮全隐藏时外层用 `:not(:has(> .btn:not([hidden])))` 收掉，窄屏换行后才不会留一行空白。不可用的按钮（例如服务端没运行时的「检查更新」）直接隐藏，别置灰占位。
   - Cosyee 截图：`.shots/cdp-shot.mjs <url> <out.png> '<步骤JSON>' '<clip表达式>'`；切主题用步骤 `localStorage.setItem("cz-theme","dark")` + `!{"method":"Page.reload",...}`；clip 要写成 `({x:..,y:..,width:..,height:..})`（不加括号会被当成代码块）。
   - 主界面连的是用户真实后端：点按钮要用精确的类名选择器，**别按文字匹配**（「自动」「Opus 5.5」会先命中侧栏会话标题，点成切换会话）。只为看效果时优先用 `?dev=shell|flow|composer|motion` 调试页。
   - 上下文栏多宽度截图 + 溢出检测：先 `npx vite --port 5199`，再 `.shots/ctx.mjs <前缀> [theme]`（`WIDTHS`、`H`、`PRE`=页面内 JS，返回字符串会打印）。检测通过不等于好看，**截图必须逐张看**（吸顶文字重叠就没被检测出来）；交互场景要让 `PRE` 返回证据，确认真的触发了。
   - 无头 Edge 用 CDP `Browser.close` 退出：Windows 上 `child.kill()` 只杀启动器，残留实例占住调试端口，下一次会连到旧页面。清理残留只按自己的 `--user-data-dir` 前缀匹配，别动用户的浏览器。

5. **回写改进**：如果这次发现某条提示词有反复出现的坑或更好的参数，把经验补到对应条目的「优化要点」里，让本 skill 越用越准。

---

## 原始提示词

### 1. 液态玻璃选中效果
> 菜单当前项用半透明玻璃胶囊做底；切换时胶囊滑向新位置，移动中沿移动方向拉长，到位弹性回弹；胶囊边缘带一圈细高光。

优化要点：胶囊是独立绝对定位层，用 transform 移动而非改 left/width；拉长量与移动距离挂钩并设上限；回弹用弹簧或 overshoot 缓动。
- 新的列表要用胶囊时直接复用 `web/src/ui/motion/LiquidCapsule.tsx`：放在**滚动容器**的第一个子元素（它按父元素 + scrollTop 量位置），行要 `position: relative; z-index: 1` 盖住胶囊，并用 `:has(> .cz-capsule.is-on)` 去掉选中行自己的底色。点击后先挪高亮再 `startTransition` 换主区，用 `web/src/ui/sidebar/usePendingSelect.ts`（侧栏和收起后的置顶浮层 `PinnedRail` 共用）。
- 用于「横向分段单选 + 下方内容区切换」时（Cosyee 上下文栏「子代理」实战，`web/src/ui/context/Subagents.tsx`）：
  - `LiquidCapsule` 传 `axis="x"`：横向移动距离短，时长收紧到 `320–440ms`、拉伸上限降到 `1.45×`（竖向列表是 `1.6×`），避免跨两格时拉得过细。
  - 窄上下文栏（240px，三等分每格仅约 67px）里图标和长英文名（如 Antigravity）并排必溢出，改为「图标在上、名称在下」堆叠，配合下方下拉区在 `@container cz-ctx (max-width: 259.9px)` 切单列。
  - 选中项本身被禁用时（如后端不可用退回原生）：`.is-active:disabled` 保持较高不透明度（约 `.78`，别和普通禁用项一起压到 `.44`），不可用原因直接显式展示在控件下方而不只塞进 `title`；键盘 roving tabindex 落到实际生效项或首个可用项，保证 Tab 可达、方向键跳过禁用项。
  - 下方说明卡片的高度平滑过渡用外层 `height` transition + `overflow: hidden`，在 effect 清理时读取 `getBoundingClientRect().height` 存为下次起点，快速连点打断时与胶囊同步从当前视觉状态无缝接续。
  - 「选中值」和「实际生效值」可能不同（退回原生）：选中态胶囊跟选中值走，但工具开关小标签、折叠标题的摘要要按**实际生效值**显示，否则会和退回提示条自相矛盾；截图要专门看退回态。
  - 带 `overflow: hidden` + `ellipsis` 的短标签会按行盒裁掉下伸部（g、y）：给 `padding-block: 1px 2px` 和明确的 `line-height`。
- 用于「弹层顶部两段 `role=tablist` 切换 + 异步内容区」（Cosyee 账号菜单「主代理 / 子代理」实战，`web/src/ui/sidebar/AccountMenu.tsx`）：
  - 高度基准 `lastHeight` 在异步数据到达后要同步更新，但只在 `pane.style.height === ''`（非过渡期间）写入，避免覆盖正在进行的高度过渡；切换分段时主动关闭悬浮详情卡（`card.closeNow()`），防止旧分段的 portal 卡片残留。
  - 列表项变体（如子代理行在 `.cz-acct-pick` 上加头像列改为三列网格）若和基础类同优先级且写在前面，会被基础类的 `grid-template-columns` 静默覆盖导致错行，且不会触发宽度溢出检测；变体类要写复合选择器（`.cz-acct-sub-pick.cz-acct-pick`）或放在基础规则之后，并坚持逐张看截图。

### 2. 聚光
> 卡片为磨砂玻璃材质；悬停时在卡片内部跟随光标显示一团柔和径向光斑，靠近光标的边框局部提亮；卡片随光标位置轻微3D倾斜，不超过4度；移出后平滑复原。

优化要点：光标坐标写入 CSS 变量（`--x`/`--y`），光斑和边框提亮都用 radial-gradient 读变量；边框提亮可用 mask 只露出边框环；倾斜加 perspective，rAF 节流。

### 3. 边缘流光
> 这张卡片加一个Border Beam 边缘流光。

优化要点：需补充——流光颜色（取主题强调色）、长度、单圈时长、是否常驻；推荐 conic-gradient + `@property` 角度动画 + mask 只保留边框，不支持 `@property` 时降级为静态边框。

### 4. 点击展开放大
> 点击按钮原位放大为详情视图，关闭时原路收回。

优化要点：用 FLIP（记录首尾 rect，用 transform 反推）或 View Transitions API；内容在展开后期再淡入，避免被拉伸；关闭时焦点回到原按钮，Esc 可关闭。
- 用于「弹窗卡片」时的坑（Cosyee 实战）：
  - 来源元素经常已经不在了（菜单项随菜单关掉、按钮被滚走）：必须有 CSS 兜底入场（scale .96 + translateY 6px + 淡入，约 220ms），关闭时原地淡出。
  - 遮罩要在**每一条**关闭分支里和面板一起淡出（底色 + `backdrop-filter` blur 到 0），否则「找不到来源」那条分支里遮罩会突然消失。
  - 同一个弹窗只是换了内容、组件重新挂载时（例如在对话框里切换「登录方式 / API Key」），要能关掉入场（`enter: false`），否则会再从头长出来一遍。
  - 组件里所有会关闭弹窗的出口（取消、完成、确认后跳转）都要走「先播收回、再回调」，不能直接调 onClose。
- 锚定的小气泡、贴在输入框上方的面板不适合 FLIP：用 CSS transition + `@starting-style` 入场，配合延迟卸载（`is-leaving` 状态，等 transitionend 或超时）。比 keyframes 好打断：退场途中重新打开，会从当前状态接回去。transform-origin 对准触发按钮那一角。
- 面板退场期间要屏蔽交互（`inert` + 回调置空），尤其是全局快捷键，避免对已经回应过的项重复提交。
- 用于「折叠小节 / 窄侧栏」时（Cosyee 上下文栏实战，现成组件 `web/src/ui/context/Fold.tsx`）：
  - 展开收起用 `grid-template-rows 0fr↔1fr` + opacity 220ms + `@starting-style` + 延迟卸载，中途反向高度连续；这是少数允许动布局的地方，内容要短。展开完 `scrollIntoView({block:'nearest'})`，否则靠底的小节像没反应。
  - 布局断点用容器查询而不是屏幕宽度（桌面 1000px 时侧栏只有 240px，比手机抽屉还窄）。
  - 滚动的 flex 列里子项要 `flex: none`，否则内容超高时 `overflow: hidden` 的子项会被压成 0 高。
  - 吸顶标题：sticky 从滚动容器的**内边距**算起，`top` 要减掉 padding，不然内容从标题上方露出来；实底只在真正吸住时铺（IntersectionObserver + 多 1px），常驻实底会像一条黑块。
  - 气泡 / 行提示按量到的实际宽度夹在容器或可视区内；确认条、编辑条允许整组换行，按钮组 `margin-left: auto`。
  - 触屏放大控件后检查旧规则有没有用固定 `min-height` / `padding-left: 0` 盖回去。
- 用于「长表单对话框 / 多行列表项」时（Cosyee 账号菜单 + 模型映射对话框实战，调试页 `?dev=account`、脚本 `.shots/acct.mjs`）：
  - 玻璃对话框里再弹的下拉 / 气泡要用实底（`--bg-menu`）：嵌套的 `backdrop-filter` 取不到对话框后面的内容，半透明底会直接透出下面的表格。
  - 长表单拆成「标题 / 内容滚动 / 按钮栏」，按钮栏只在下面还有内容时画分隔线（scroll + ResizeObserver，rAF 合并）。morph 动画逐个淡入面板的直接子元素，包一层内容区不影响。
  - 纵向 flex 的字段里，输入框不能带 `flex: 1 1 0`，否则高度会被压到约 20px。截图先量一下输入框高度。
  - 多行的列表项（名字 + 额度条）：悬停按钮只盖住名字行，也只让名字行让位；整行竖直居中会压到额度条，还会让额度条在悬停时重新排版。触屏下按钮常驻、加大到 32px。
  - 表格式表单在窄容器里用容器查询变成小块，输入框的小标题用 `data-label` + `::before` 显示。没内容的 grid-area 行也会算一次 row-gap，按行的类型（`:has()`）分开写 areas。
  - 玻璃菜单（`backdrop-filter`）里的 `position: fixed` 气泡会以菜单为参照而错位：portal 到 body；`useDismiss` 按层叠放，Esc 一次只关一层。portal 后父级的 `:has(气泡)` 要换成按钮外壳上的 `is-open`（用 `:where()` 保持优先级）。
  - 候选项选中后把焦点还给触发按钮时，Enter 要 `preventDefault`，否则同一次回车会再点开它。
  - 截图 + 溢出检测抓不到「点了没反应」：用 `.shots/acct-e2e.mjs` 那样的真实鼠标键盘脚本逐项点一遍。
  - 锚定在可滚动容器里的下拉：打开前量到滚动容器底边的距离，放不下就往上弹出（`is-up`，origin 改成 bottom）。
  - 「高级感」账号菜单的做法（Cosyee 账号菜单重做）：
    - 头像用 `--av` 底色做 145° 提亮渐变 + 顶部内高光。选中行用主题色渐变底加 1px 主题色内描边，画在 `::before` 上交叉淡化；头像外加一圈「菜单底色 2px + 主题色 1.5px」的环；勾选做成实心小圆。
    - 套餐做成名字后面的小标签，副标题只放状态。分隔线两端渐隐，面板左上角叠一团约 8% 的主题色径向光。
  - 窄菜单里的额度：
    - 用两列小卡片，单数时最后一张占满一行：`:last-child:nth-child(odd)`。额度块从头像那一列开始横跨整行。
    - 用户要求所有额度一律一行「名称 | 条 | 百分比」（不要「名称 百分比」+ 下一行进度条的两行式）。窄的时候不要退回两行，而是让卡片网格变成单列：`@container (max-width: 299px)` 下 `.cz-acctq` 改成一列，`container-type` 加在额度外壳 `.cz-acct-row__extra` 上（里面没有 fixed 元素）。重置时间要直接可见（放进 `title` 用户会问「怎么没了」），作为条下方的小字；账号到期时间同理。查不到的日期不显示，推算的日期要写「约」并在 `title` 里说明。
    - 多个账号叠放时，每个账号的全部内容（名字、状态、额度）用一个外框框起来，里面的额度小卡片弱化边框，避免框套框；浅色主题下尤其要看相邻账号是否分得清。
    - 行内操作按钮（删除等）每行都显示；不能操作的（默认 / 当前 / 有任务在跑）置灰，用 `disabledTitle` 说明原因，原因文案和服务端的拒绝条件保持一致。不要直接不渲染，用户会以为「这行少了删除能力」。
    - `container-type` 只加在卡片自己身上，别加在菜单或弹层上：它会带上布局约束，`position: fixed` 的子元素会改以它为参照。
  - 进度条填充用 `transform: scaleX(var(--p))` + `transform-origin: left`，配合 `@starting-style { scaleX(0) }`：第一次出现时长出来，约 600ms ease-out；数据刷新时从当前值过渡，不重播；减少动效时去掉 transition。
  - 「标签 + 分段控件」挤在一行时：容器用 `flex-wrap: wrap`，控件 `flex: 1 1 160px`，窄了自动换到第二行。左侧缩进放在标签上，别放在容器上，否则换行后控件被缩进挤溢出。
  - 系统开了「减少动画」（Windows 动画效果关闭）时，无头 Edge 也会命中 `prefers-reduced-motion`，动画检查会全部失败：e2e 脚本开头要用 `Emulation.setEmulatedMedia` 强制 `no-preference`。只截静态图的脚本则反过来强制 `reduce`，让画面稳定。
  - CDP 悬停前会先把元素滚进视野：检查「悬停不重排」要比较相对于行的坐标，不能比绝对坐标。改了调试页假数据（名字、条数），要同步改 e2e 里按名字找行的选择器。
- 用于「列表行内展开详情 + 开关列」时（Cosyee 上下文栏工具 / skill / MCP / 智能体行实战）：
  - 一整列开关全是实心强调色会很吵：开 = 强调色浅底槽（约 15%）+ 强调色圆点，关 = 描边空槽 + 缩小（scale .66）的灰圆点。颜色变化用叠加层（槽的 `::before`、圆点的 `::before`）做 opacity 交叉淡化，不过渡 background。
  - subgrid 行里展开的详情放 `grid-column: 1 / -1; grid-row: 2`；flex 行要 `flex-wrap: wrap`，详情 `flex: 1 1 100%`。名字按钮要自带 `min-height` 一行高，否则行变高后第一行会被重新分配高度而跳动。
  - 「悬浮必须有说明」：每类行都要有兜底文案（没收录的工具按名字生成一句），用脚本对每一行派发 `mouseover`（`relatedTarget: document.body`，React 的 onMouseEnter 才会触发），逐行确认 `.cz-ctx__tip` 出现。
  - 无头 Edge 的 `document.hasFocus()` 为 false，`el.focus()` 不派发 focus 事件：键盘聚焦显示提示没法这样截图验证，改用模拟 mouseover，聚焦路径靠代码审查和单测。
  - 不能拿到的数据（如 CLI 不提供单个内置工具的定义原文）在展开里直接说明，并给出能拿到的合计，不编造。
- 用于「悬停详情卡片」时（Cosyee 会话标题卡片实战，`web/src/ui/sidebar/SessionCard.tsx`）：
  - 一列触发元素共用一张 portal 到 body 的卡片，状态放在独立控制器里（订阅式），指针事件不让整列重渲染。首次 400ms 才出，已开着或刚关 300ms 内换行只等 70ms。
  - 定位层和入场层分开：外层只管 `translate3d` 行间滑动，内层管 `@starting-style` 入场退场，两个 transform 不打架；首次打开隔两帧再开位移过渡，免得从旧位置滑过来。
  - 卡片要能移进去：路上的行内操作按钮不能一进入就关（按下才关），离开宽限约 220ms。用真实鼠标快、慢两种速度各走一遍，光看截图发现不了移不进去。
  - 任何一行的 leave 都要重新计关闭时间：经过下一行时 enter 取消了计时，没等到切换就离开，卡片会一直留着。
  - 「滚动就关」只认包含触发元素的容器：捕获阶段监听全局 scroll 的话，会话流输出时自己滚也会把卡片关掉。
  - 卡片开着时数据刷新：同一对象先留旧内容，不退回骨架，刷新失败也不清掉。
  - 别的弹层（确认气泡、菜单）开着时不弹卡片，否则它会压住气泡、抢走 Esc（`hasOpenLayer()`）。

### 5. 玻璃停靠栏
> 菜单做成底部居中的浮动玻璃停靠栏，只放图标；悬停时当前图标放大，相邻图标跟随放大；上方显示名称。

优化要点：放大倍数按光标到图标中心的距离连续计算（而非仅当前±1），设最大倍数；图标需 aria-label；名称提示用 tooltip 并支持键盘聚焦显示。
- 用于「竖排文字列表的波浪放大」时（现成 hook `web/src/ui/motion/useWaveMagnify.ts`，在置顶浮层 `PinnedRail` 上做过；用户后来改成「只放大悬停的那一行、其他行不变」，所以浮层现在用 CSS `:hover` 放大并单行展开，没再用这个 hook。给紧凑的导航列表加之前先确认要不要连带放大相邻行）：
  - 只放大行里的内容（包一层 `__mag`），不放大行本身：行高、悬停底色、液态胶囊都不动，也不会互相盖住。参数：半径 84px（约 2.7 行）、衰减 `(1-(d/R)²)²`、最大 1.2 倍 + 右移 4px、origin 左中、transform 过渡 160ms ease-out。
  - JS 只写每行的 `--m`（0~1），rAF 合并；滚轮滚动时按上次的光标位置重算，波浪会跟着行滚过去。非鼠标指针和减少动效时不写。
  - 放大后标题会超出行右边：按钮 `overflow: hidden` + 右侧渐隐遮罩，渐隐宽度写成 `var(--m) * 18px`，平时不裁。
  - 验证要用 CDP `Input.dispatchMouseEvent`（mouseMoved / mouseWheel）真实移动，再读各行的 `--m` 看波峰位置，别只看截图。

### 6. 数据唤醒
> 为Dashboard添加数据加载动效。页面进入时，核心指标从0平滑递增至目标数值，使用Ease Out缓动；趋势线从左向右逐步绘制，图表和指标依次出现，动画结束后保持稳定。

优化要点：数字递增用 rAF + easeOutCubic，按数值格式化（千分位、小数位、货币）且用等宽数字防抖动；趋势线用 `stroke-dasharray/dashoffset`；只在首次进入时播放，数据刷新时不重播。

### 7. 模块自由拖动
> 为Dashboard添加模块自由拖拽交互。按住卡片时悬浮放大，拖动时跟随鼠标，其他模块自动让位并平滑重排。松开后弹性吸附到网格，支持跨行跨列拖动，保持布局连续自然。

优化要点：用 Pointer Events 统一鼠标/触摸；长按或拖拽阈值防误触；重排动画用 FLIP；明确布局是否持久化；提供键盘重排方式。复杂度高，先与用户确认网格规则。

### 8. 信息流加载
> 做一个信息流加载：先显示和真实内容形状一样的骨架屏（圆头像、标题条、图片块，尺寸和位置跟真实卡片一致），所有骨架共用一道柔和的斜向光带，每1.5秒从左往右扫过；数据到了以后，按头像、标题、图片这些块从上到下每块错开60ms 依次浮現（淡入＋上移8px），骨架同步淡出，整页不跳动、不闪白。

优化要点：「共用一道光带」= 渐变背景用 `background-attachment: fixed` 或统一的视口坐标，而不是每块各扫各的；骨架与真实内容叠放在同一容器中交叉淡化以保证零位移；图片要预留宽高比。

### 9. 3D透视轮播
> 横向3D透视轮播（Cover Flow），当前项居中放大，切换时背景与标题同步过渡。

优化要点：补充——两侧项的旋转角、间距、可见数量；支持键盘方向键、拖拽/滑动、点击侧项切换；背景过渡用交叉淡化两层，避免闪烁。

### 10. 粘性融合
> 导航指示器切换时，从旧位置拉伸至新位置，中间形成短暂的液态连接，再收拢成圆角胶囊；动画约 0.6 秒，文字保持清晰。

优化要点：液态效果用 SVG goo 滤镜（blur + color matrix）只作用在指示器层，文字放在滤镜层之外以保持清晰；也可用「前沿先走、后沿后跟」两段时序模拟拉伸，无需滤镜。
