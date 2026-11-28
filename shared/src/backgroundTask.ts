// CLI 后台任务分类：区分「等结果（awaited）」与「常驻（persistent）」。
// - awaited：会自己结束、模型会回来汇报的任务（后台子代理、Monitor、构建/测试、gh run watch 等），整轮保持进行中；
// - persistent：开发服务器之类不会自己结束的任务，或无法识别的任务，本轮说完即收尾，避免卡在进行中。

export type BackgroundTaskKind = 'awaited' | 'persistent';

export interface BackgroundTaskClassifyInput {
  /** task_started / background_tasks_changed 中的 task_type */
  taskType?: string;
  /** 对应 tool_use 的工具名（如 Bash / Monitor / Agent） */
  toolName?: string;
  /** 对应 tool_use 的 input（Bash 的 { command, description } 等） */
  toolInput?: unknown;
}

/**
 * 判断一条 shell 命令是否为常驻任务（dev server / watcher / tail -f 等）。
 * 优先级高于「有终点」规则；gh pr checks --watch 特判排除在通用 --watch 之外。
 */
const PERSISTENT_PATTERNS: readonly RegExp[] = [
  // npm / pnpm / yarn / bun 的 dev / start / serve / preview（含简写与常见子脚本如 dev:watch）
  /(?:^|[\s;&|(])(?:npm|pnpm|yarn|bun)(?:\s+(?:--filter|--prefix|-C|--cwd)\s+\S+)*\s+(?:run\s+)?(?:dev|start|serve|preview)(?:[:\w-]*)?(?=$|[\s;&|)])/i,
  // vite（排除 vite build）
  /(?:^|[\s;&|(])(?:npx\s+|pnpm\s+(?:exec\s+|dlx\s+)?|yarn\s+|bunx?\s+)?vite(?!\s+build\b)(?=$|[\s;&|)])/i,
  // next / nuxt dev / start / preview
  /(?:^|[\s;&|(])(?:npx\s+|pnpm\s+(?:exec\s+)?|yarn\s+|bunx?\s+)?(?:next\s+(?:dev|start)|nuxt\s+(?:dev|preview))(?=$|[\s;&|)])/i,
  // webpack serve / webpack-dev-server
  /(?:^|[\s;&|(])(?:webpack\s+serve|webpack-dev-server)(?=$|[\s;&|)])/i,
  // nodemon / tsx watch / ts-node-dev
  /(?:^|[\s;&|(])(?:nodemon|ts-node-dev|tsx\s+watch)(?=$|[\s;&|)])/i,
  // tsc -w
  /\btsc\b[^;&|\n]*\s-w(?=$|[\s;&|)])/,
  // tail -f / -F / --follow
  /\btail\b[^;&|\n]*(?:\s-[a-zA-Z]*[fF]\b|\s--follow\b)/,
  // python -m http.server / uvicorn / flask run / django runserver
  /\bpython3?\b[^;&|\n]*\s-m\s+http\.server(?=$|[\s;&|)])/i,
  /(?:^|[\s;&|(])(?:uvicorn|flask\s+run)(?=$|[\s;&|)])/i,
  /\bmanage\.py\s+runserver(?=$|[\s;&|)])/i,
  // serve / http-server / live-server（命令位，避免误伤路径里的 server 目录名）
  /(?:^|[;&|(]|\bnpx\s+|\bpnpm\s+dlx\s+|\bbunx\s+)\s*(?:serve|http-server|live-server)(?=$|[\s;&|)])/i,
];

/** 通用 --watch（排除 gh pr checks --watch 这种有终点的 CI 等待命令） */
const GENERIC_WATCH_RE = /(?:^|\s)--watch(?=$|[\s=;&|)])/;
const GH_PR_CHECKS_RE = /\bgh\s+pr\s+checks\b/;

/** docker compose up / docker-compose up（带 -d / --detach 时不是常驻前台） */
const DOCKER_COMPOSE_UP_RE = /\bdocker(?:\s+|-)compose\b[^;&|\n]*\bup\b/i;
const DETACH_FLAG_RE = /(?:^|\s)(?:-d|--detach)(?=$|[\s;&|)])/;

const INFINITE_LOOP_RE = /(?:^|[\s;&|(])while\s+(?:true|:|\[\s*1\s*\]|\(\(\s*1\s*\)\))\s*;/;

/** 有明确终点的命令：命中则归为 awaited */
const AWAITED_PATTERNS: readonly RegExp[] = [
  // GitHub CLI 等待 CI
  /\bgh\s+run\s+watch\b/,
  /\bgh\s+pr\s+checks\b[^;&|\n]*--watch\b/,
  // JS 包管理器的 build / test / lint / typecheck / check / install / ci
  /(?:^|[\s;&|(])(?:npm|pnpm|yarn|bun)(?:\s+(?:--filter|--prefix|-C|--cwd)\s+\S+)*\s+(?:run\s+)?(?:build|test|lint|typecheck|type-check|check|verify|bundle)(?:[:\w-]*)?(?=$|[\s;&|)])/i,
  /(?:^|[\s;&|(])(?:npm|pnpm|yarn|bun)\s+(?:ci|install|i)(?=$|[\s;&|)])/i,
  // 构建 / 测试工具
  /\bvite\s+build\b/i,
  /\b(?:next|nuxt)\s+build\b/i,
  /\bcargo\s+(?:build|test|check|clippy)\b/i,
  /\bgo\s+(?:build|test|vet)\b/i,
  /(?:^|[\s;&|(])(?:\.\/)?(?:mvn|mvnw|gradle|gradlew|pytest|jest)(?=$|[\s;&|)])/i,
  /\bvitest\s+run\b/i,
  /\btsc\b/,
  // 定时 / 轮询等待
  /(?:^|[\s;&|(])sleep\s+\d/,
  /(?:^|[\s;&|(])(?:until|while)\s+/,
  /(?:^|[\s;&|(])timeout\s+\d/,
  // Git / Docker 一次性操作
  /\bgit\s+(?:push|clone|fetch|pull)\b/,
  /\bdocker\s+(?:build|pull|push)\b/i,
  // 下载
  /(?:^|[\s;&|(])(?:curl|wget)\s+/,
];

/** 按命令文本分类 Bash 后台任务 */
export function classifyBashCommand(command: string): BackgroundTaskKind {
  const cmd = command.trim();
  if (!cmd) return 'persistent';

  // 1. 常驻标记优先
  for (const re of PERSISTENT_PATTERNS) {
    if (re.test(cmd)) return 'persistent';
  }
  if (DOCKER_COMPOSE_UP_RE.test(cmd) && !DETACH_FLAG_RE.test(cmd)) return 'persistent';
  if (GENERIC_WATCH_RE.test(cmd) && !GH_PR_CHECKS_RE.test(cmd)) return 'persistent';
  // 无条件死循环（while true / while :）：轮询脚本不会自己结束
  if (INFINITE_LOOP_RE.test(cmd)) return 'persistent';

  // 2. 有终点标记
  for (const re of AWAITED_PATTERNS) {
    if (re.test(cmd)) return 'awaited';
  }

  // 3. 认不出来默认常驻，宁可早交付也不卡在进行中
  return 'persistent';
}

/** 分类一个 CLI 后台任务 */
export function classifyBackgroundTask(input: BackgroundTaskClassifyInput): BackgroundTaskKind {
  const taskType = input.taskType?.trim() ?? '';
  const toolName = input.toolName?.trim() ?? '';

  if (taskType === 'local_agent') return 'awaited';
  if (toolName === 'Monitor' || /monitor/i.test(taskType)) return 'awaited';

  if (taskType === 'local_bash') {
    const cmd =
      input.toolInput && typeof input.toolInput === 'object' && typeof (input.toolInput as { command?: unknown }).command === 'string'
        ? (input.toolInput as { command: string }).command
        : '';
    return classifyBashCommand(cmd);
  }

  return 'persistent';
}
