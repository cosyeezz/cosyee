// 会话流调试用 mock 数据：覆盖各种状态。
import type { SkillLoad, Step, SubagentRun, Turn } from '@cosyee/shared';

const NOW = Date.now();
const min = (n: number) => n * 60_000;

const base = (over: Partial<Turn> & Pick<Turn, 'id' | 'userText'>): Turn => ({
  attachments: [],
  status: 'done',
  statusText: '',
  steps: [],
  answer: '',
  subagents: [],
  skills: [],
  startedAt: NOW - min(30),
  ...over,
});

const bashStep: Step = {
  kind: 'tool',
  id: 'tu_bash_1',
  name: 'Bash',
  input: { command: 'npm test -- --reporter=dot', description: '运行单元测试' },
  summary: 'Bash: npm test -- --reporter=dot',
  result: {
    content: [{ type: 'text', text: '> cosyee@0.1.0 test\n> vitest run --reporter=dot\n\n ......\n\n Test Files  1 passed (1)\n      Tests  12 passed (12)\n   Duration  988ms' }],
    isError: false,
  },
};

const longOutput = Array.from({ length: 120 }, (_, i) => `line ${String(i + 1).padStart(3, '0')}: some long log output to test truncation`).join('\n');

// 1. understanding
export const understandingTurn: Turn = base({
  id: 'turn-understanding',
  userText: '帮我看看这个项目为什么构建会变慢',
  status: 'understanding',
  statusText: '正在理解问题',
  startedAt: NOW - 3_000,
});

// 技能加载样例：模型加载（带正文）、同名加载 ×2、用户手动（实时无正文）、加载失败、加载中
const reviewBody = '# Code review\n\n按以下步骤审查当前 diff：\n\n1. 先看改动范围\n2. 逐个文件找**正确性问题**\n3. 输出带行号的结论\n\n参数：src/core\n';
const doneSkills: SkillLoad[] = [
  {
    id: 'tu_skill_review_1',
    name: 'code-review',
    args: 'src/core',
    source: 'model',
    status: 'loaded',
    body: reviewBody,
    dir: 'F:\\Cosyee\\.claude\\skills\\code-review',
    afterStep: 1,
  },
  {
    id: 'tu_skill_review_2',
    name: 'code-review',
    args: 'src/ui',
    source: 'model',
    status: 'loaded',
    body: reviewBody.replace('src/core', 'src/ui'),
    dir: 'F:\\Cosyee\\.claude\\skills\\code-review',
    afterStep: 2,
  },
  { id: 'user:turn-done', name: 'anthropic-skills:pdf', args: 'report.pdf', source: 'user', status: 'loaded', afterStep: 0 },
  { id: 'tu_skill_missing', name: 'no-such-skill', source: 'model', status: 'error', error: 'Unknown skill: no-such-skill', afterStep: 3 },
];
const runningSkills: SkillLoad[] = [{ id: 'tu_skill_loading', name: 'frontend-design', source: 'model', status: 'loading', afterStep: 1 }];

// 2. running：thinking + 两个工具 + 中间文字 + 流式 answer
export const runningTurn: Turn = base({
  id: 'turn-running',
  userText: '重构 file1 里的 reducer，并跑一下测试',
  attachments: [{ kind: 'file', label: 'file1', path: 'F:\\Cosyee\\web\\src\\core\\reducer.ts' }],
  status: 'running',
  statusText: '先读一下 reducer，再决定怎么拆分',
  startedAt: NOW - 25_000,
  skills: runningSkills,
  steps: [
    { kind: 'thinking', text: '用户想重构 reducer。我需要先读取文件，了解现有结构，再判断是否按事件类型拆分为多个纯函数。注意保持对外接口不变，避免影响 UI 层。' },
    {
      kind: 'tool',
      id: 'tu_read_1',
      name: 'Read',
      input: { file_path: 'F:\\Cosyee\\web\\src\\core\\reducer.ts' },
      summary: 'Read: web/src/core/reducer.ts',
      result: { content: 'export function reduce(state, event) {\n  // ...\n}\n', isError: false },
    },
    { kind: 'text', text: '`reduce` 目前是一个 300 行的 `switch`，我打算**按事件类型拆分**成独立的处理函数。' },
    {
      kind: 'tool',
      id: 'tu_edit_1',
      name: 'Edit',
      input: { file_path: 'F:\\Cosyee\\web\\src\\core\\reducer.ts', old_string: 'switch (e.type)', new_string: 'const h = handlers[e.type]' },
      summary: 'Edit: web/src/core/reducer.ts',
      streaming: true,
    },
  ],
  answer: '已经把 `reduce` 拆成了 `handlers` 表，接下来会逐个迁移事件类型：\n\n1. `system/init`\n2. `assistant`\n3. `user`',
});

// 3. done：Bash 工具、Markdown 答复带代码块和表格
export const doneTurn: Turn = base({
  id: 'turn-done',
  userText: '跑一下测试，并总结结果',
  skills: doneSkills,
  status: 'done',
  statusText: '',
  startedAt: NOW - min(12) - 185_000,
  endedAt: NOW - min(12),
  steps: [
    { kind: 'thinking', text: '先运行测试看看结果。' },
    bashStep,
    {
      kind: 'tool',
      id: 'tu_bash_long',
      name: 'Bash',
      input: { command: 'cat build.log' },
      summary: 'Bash: cat build.log',
      result: { content: longOutput, isError: false },
    },
    {
      kind: 'tool',
      id: 'tu_bash_err',
      name: 'Bash',
      input: { command: 'npm run lint' },
      summary: 'Bash: npm run lint',
      result: { content: [{ type: 'text', text: 'error  Unexpected any  @typescript-eslint/no-explicit-any' }], isError: true },
    },
  ],
  answer: `## 测试结果

全部 **12** 个用例通过，耗时不到 1 秒。

| 文件 | 用例数 | 状态 |
| --- | ---: | :---: |
| \`format.test.ts\` | 12 | 通过 |
| \`reducer.test.ts\` | 0 | 跳过 |

如果想只跑某一个文件：

\`\`\`bash
npx vitest run src/ui/flow
\`\`\`

核心逻辑大致如下：

\`\`\`ts
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  return total < 60 ? \`\${total} 秒\` : \`\${Math.floor(total / 60)} 分\`;
}
\`\`\`

> 提示：\`lint\` 报了一个 \`any\` 的问题，可以另行处理，详见 [文档](https://example.com)。

本地文件（点击打开预览浮窗）：[reducer.ts 第 42 行](web/src/core/reducer.ts#L42)、[README](F:\\Cosyee\\README.md)，行内路径 \`web/src/ui/flow/format.ts\` 悬停可看完整路径。`,
});

// 4. interrupted
export const interruptedTurn: Turn = base({
  id: 'turn-interrupted',
  userText: '把整个仓库的注释翻译成英文',
  status: 'interrupted',
  reason: '已被用户中断',
  startedAt: NOW - min(8),
  endedAt: NOW - min(8) + 40_000,
  steps: [{ kind: 'text', text: '先列出所有含中文注释的文件。' }],
});

// 5. error
export const errorTurn: Turn = base({
  id: 'turn-error',
  userText: '继续上面的任务',
  status: 'error',
  reason: 'API 请求失败：连接超时（529 overloaded）',
  startedAt: NOW - min(6),
  endedAt: NOW - min(6) + 5_000,
});

// 6. 带 3 个子代理（done / running / error）
const subTurn = (over: Partial<Turn> & Pick<Turn, 'id' | 'userText'>): Turn => base({ startedAt: NOW - min(3), ...over });

const subagents: SubagentRun[] = [
  {
    toolUseId: 'tu_agent_1',
    title: '调研 reducer 的现有实现',
    subagentType: 'Explore',
    status: 'done',
    turn: subTurn({
      id: 'sub-1',
      userText: '阅读 web/src/core 下的所有文件，总结 reducer 的职责与输入输出，不要修改任何文件。',
      status: 'done',
      endedAt: NOW - min(3) + 42_000,
      steps: [
        { kind: 'thinking', text: '先列目录再读关键文件。' },
        {
          kind: 'tool',
          id: 'tu_s1_glob',
          name: 'Glob',
          input: { pattern: 'web/src/core/**/*.ts' },
          summary: 'Glob: web/src/core/**/*.ts',
          result: { content: 'web/src/core/api.ts\nweb/src/core/reducer.ts', isError: false },
        },
      ],
      answer: 'reducer 负责把 CLI 事件归约为 `Turn[]`，输入是事件流，输出是不可变的视图模型。',
    }),
  },
  {
    toolUseId: 'tu_agent_2',
    title: '检查 icons 目录里的动画是否影响性能',
    subagentType: 'general-purpose',
    status: 'running',
    turn: subTurn({
      id: 'sub-2',
      userText: '检查 icons/icons.css 里的动画，判断同时渲染 50 个会话时是否会掉帧。',
      status: 'running',
      statusText: '正在统计动画元素数量',
      steps: [
        {
          kind: 'tool',
          id: 'tu_s2_grep',
          name: 'Grep',
          input: { pattern: 'animation', path: 'icons/icons.css' },
          summary: 'Grep: animation in icons/icons.css',
          streaming: true,
        },
      ],
      answer: '初步看，动画都是 transform / opacity，',
    }),
  },
  {
    toolUseId: 'tu_agent_3',
    title: '运行 e2e 测试',
    subagentType: 'general-purpose',
    status: 'error',
    turn: subTurn({
      id: 'sub-3',
      userText: '启动 dev server 并运行 e2e 测试，报告失败的用例。',
      status: 'error',
      reason: '端口 5173 被占用，无法启动 dev server',
      endedAt: NOW - min(3) + 9_000,
      steps: [
        {
          kind: 'tool',
          id: 'tu_s3_bash',
          name: 'Bash',
          input: { command: 'npm run dev' },
          summary: 'Bash: npm run dev',
          result: { content: 'Error: listen EADDRINUSE: address already in use 127.0.0.1:5173', isError: true },
        },
      ],
    }),
  },
];

export const subagentTurn: Turn = base({
  id: 'turn-subagents',
  userText: '并行调研三件事：reducer 实现、图标动画性能、e2e 测试状态',
  status: 'running',
  statusText: '已派出 3 个子代理，等待结果',
  startedAt: NOW - min(3),
  steps: [
    { kind: 'text', text: '我把这个任务拆成三个独立的调研，并行交给子代理。' },
    ...subagents.map<Step>((s) => ({
      kind: 'tool',
      id: s.toolUseId,
      name: 'Agent',
      input: { description: s.title, subagent_type: s.subagentType, prompt: s.turn.userText },
      summary: `Agent: ${s.title}`,
      result: s.status === 'running' ? undefined : { content: s.turn.answer || s.turn.reason || '', isError: s.status === 'error' },
    })),
  ],
  subagents,
});

// 7. 带标签的用户消息
export const attachmentTurn: Turn = base({
  id: 'turn-attachments',
  userText: '比较 file1 和 folder1 里的实现，参考 img1 的布局，给出差异',
  attachments: [
    { kind: 'file', label: 'file1', path: 'F:\\Cosyee\\web\\src\\App.tsx' },
    { kind: 'folder', label: 'folder1', path: 'F:\\Cosyee\\web\\src\\ui' },
    { kind: 'img', label: 'img1', path: 'C:\\Users\\dane\\Pictures\\layout.png' },
  ],
  status: 'done',
  startedAt: NOW - min(20),
  endedAt: NOW - min(20) + 65_000,
  answer: '主要差异有三点：\n\n- 入口不同\n- 样式组织方式不同\n- 数据来源不同',
});

export const mockTurns: Turn[] = [
  attachmentTurn,
  doneTurn,
  interruptedTurn,
  errorTurn,
  subagentTurn,
  understandingTurn,
  runningTurn,
];
