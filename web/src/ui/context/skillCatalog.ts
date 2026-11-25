// 已知 skill 的中文用途与推荐状态（按去掉插件前缀后的名字查）。
// 推荐依据：模型自动调用价值 vs 常驻上下文的 token 成本——
//   on  = 日常高频、让模型自己判断何时用；
//   manual = 偶尔用，需要时输入 /名字（不占上下文）；
//   off = 与当前工作流基本无关，连 / 菜单都不留。
import type { SkillMode } from '@cosyee/shared';

export interface SkillInfo {
  /** 一句话用途（中文） */
  purpose: string;
  /** 推荐状态 */
  mode: SkillMode;
  /** 推荐理由（中文） */
  reason: string;
}

const ON: SkillMode = 'on';
const MANUAL: SkillMode = 'user-invocable-only';
const OFF: SkillMode = 'off';

export const SKILL_CATALOG: Record<string, SkillInfo> = {
  // —— 前端 / 开发流程（建议常开）——
  impeccable: { purpose: '设计、重做、评审、打磨前端界面与设计系统（DESIGN.md）。', mode: ON, reason: '本项目经常改界面，让模型自动判断何时调用。' },
  verify: { purpose: '改完代码后实际运行程序，验证改动是否真的生效。', mode: ON, reason: '内置且几乎不占上下文，对质量有帮助。' },
  debug: { purpose: '开启调试日志，排查本次会话中 Claude Code 自身的问题。', mode: ON, reason: '内置且几乎不占上下文，出问题时模型可自行使用。' },

  // —— 协作 / 计划 ——
  'ax-supervise': { purpose: 'Axiom 项目的协调者 / 监工流程：派发执行者、盯进度、交接。', mode: MANUAL, reason: '只在 Axiom 项目里用，描述较长，需要时 /ax-supervise。' },
  schedule: { purpose: '创建、更新、运行定时的云端智能体（cron 例行任务）。', mode: MANUAL, reason: '偶尔用，需要时手动调用即可。' },
  loop: { purpose: '按间隔反复执行某个任务或命令（轮询、定时检查）。', mode: MANUAL, reason: '明确要循环时才用，/loop。' },
  batch: { purpose: '把大改动拆成多个并行子任务批量完成。', mode: MANUAL, reason: '内置，需要大规模改动时手动调用。' },
  run: { purpose: '运行当前项目 / 脚本并查看输出。', mode: MANUAL, reason: '模型本来就会用终端运行，手动调用足够。' },

  // —— 代码质量 ——
  'code-review': { purpose: '审查当前分支或 PR 的改动，找出缺陷。', mode: MANUAL, reason: '要审查时再 /code-review，不必常驻。' },
  simplify: { purpose: '复查刚改的代码，清理重复、提升可读性与效率。', mode: MANUAL, reason: '改完想收尾时手动调用。' },
  'security-review': { purpose: '对当前改动做安全审查。', mode: MANUAL, reason: '偶尔用，手动调用。' },
  init: { purpose: '分析项目并生成 CLAUDE.md 项目说明。', mode: MANUAL, reason: '一个项目通常只用一次。' },

  // —— 配置 / 扩展 ——
  'update-config': { purpose: '修改 Claude Code 的 settings.json（权限、钩子、环境变量等）。', mode: MANUAL, reason: '改配置时才需要，手动调用。' },
  'fewer-permission-prompts': { purpose: '扫描历史会话，生成权限白名单以减少确认弹窗。', mode: MANUAL, reason: '偶尔整理一次即可。' },
  'keybindings-help': { purpose: '自定义键盘快捷键（keybindings.json）。', mode: MANUAL, reason: '极少用到。' },
  'claude-api': { purpose: '用 Claude API / Anthropic SDK 构建、调试、优化应用。', mode: MANUAL, reason: '只在开发 AI 应用时用，描述较长。' },
  'plugin-authoring': { purpose: '编写与调试 Claude Code 插件。', mode: MANUAL, reason: '只在写插件时用。' },
  'workflow-authoring': { purpose: '编写工作流脚本（workflow）。', mode: MANUAL, reason: '只在写工作流时用。' },
  'skill-creator': { purpose: '创建、修改、评测并优化 skill（官方维护）。', mode: MANUAL, reason: '描述和正文都很大，需要做 skill 时 /skill-creator。' },
  'run-skill-generator': { purpose: '为项目生成「如何运行 / 构建」类 skill。', mode: MANUAL, reason: '内置，偶尔用。' },
  doctor: { purpose: '诊断 Claude Code 安装与配置问题。', mode: MANUAL, reason: '内置，出问题时手动调用。' },
  design: { purpose: '内置的设计辅助（界面方案与评审）。', mode: MANUAL, reason: '已有 impeccable，需要时再调用。' },
  'design-sync': { purpose: '把设计稿与代码同步。', mode: MANUAL, reason: '内置，偶尔用。' },
  dataviz: { purpose: '生成数据可视化图表。', mode: MANUAL, reason: '需要画图时手动调用。' },

  // —— 文档 / 文件格式 ——
  pdf: { purpose: '读取、合并、拆分、填写、创建 PDF，含 OCR。', mode: MANUAL, reason: '碰到 PDF 才用，手动调用。' },
  xlsx: { purpose: '读取、编辑、创建 Excel / CSV 表格。', mode: MANUAL, reason: '偶尔处理表格，手动调用。' },
  docx: { purpose: '读取、编辑、创建 Word 文档。', mode: OFF, reason: '开发场景基本用不到。' },
  pptx: { purpose: '读取、编辑、创建 PowerPoint 演示文稿。', mode: OFF, reason: '开发场景基本用不到。' },
  docs: { purpose: '在 Claude 内创建可分享、可评论的在线文档。', mode: OFF, reason: '依赖桌面端文档连接器，这里用不到。' },
  'google-workspace': { purpose: '创建或修改 Google 文档 / 表格 / 幻灯片。', mode: MANUAL, reason: '只在改 Google 文件时用。' },

  // —— 浏览器 / 桌面控制 ——
  'built-in-browser': { purpose: '使用 Claude 桌面端内置浏览器窗格的操作说明。', mode: MANUAL, reason: '用到内置浏览器时模型会提示，手动调用。' },
  'chrome-browser': { purpose: '使用 Claude in Chrome 扩展操作真实 Chrome 的说明。', mode: MANUAL, reason: '用到 Chrome 扩展时手动调用。' },
  'computer-use': { purpose: '截图并控制本机桌面应用（点击、输入、滚动）。', mode: OFF, reason: '风险较高且这里不用桌面控制。' },

  // —— 其他 ——
  'deep-research': { purpose: '多来源深度调研并生成综合报告（需要子智能体）。', mode: MANUAL, reason: '需要时手动调用，调研较耗 token。' },
  morning: { purpose: '生成「晨报」HTML 摘要，或设为每个工作日的定时任务。', mode: MANUAL, reason: '只在明确要晨报时用。' },
  'import-memory': { purpose: '把其他 AI 助手导出的记忆导入 Claude。', mode: MANUAL, reason: '一次性操作。' },
  'setup-writing-style': { purpose: '从你写过的内容学习文风，生成个人写作风格 skill。', mode: MANUAL, reason: '一次性操作。' },
};

/** 去掉插件前缀：anthropic-skills:pdf -> pdf */
export const skillBaseName = (name: string): string => name.slice(name.lastIndexOf(':') + 1);

export const skillInfo = (name: string): SkillInfo | undefined => SKILL_CATALOG[skillBaseName(name)];
