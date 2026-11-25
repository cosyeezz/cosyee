// 磁盘上的全部 skill：用户级（<配置目录>/skills）、项目级（<cwd>/.claude/skills）、已安装插件里的 skill。
// 用途：①「已关闭 / 还没加载」的 skill 也能列在 Skills 面板上；②移除用户级 / 项目级 skill（移到备份目录，不直接删除）。
import fs from 'node:fs';
import path from 'node:path';
import { isSessionUuid } from './paths.js';
import { SKILL_NAME_RE } from './workspaces.js';

export interface DiskSkill {
  /** CLI 里的名字：用户 / 项目级是目录名，插件 skill 带 `插件名:` 前缀 */
  name: string;
  source: 'userSettings' | 'projectSettings' | 'plugin';
  /** skill 目录（用户 / 项目级是 skills 下的条目本身，可能是指向别处的链接） */
  dir: string;
  /** 用户 / 项目级可移除；插件里的 skill 只能随插件卸载 */
  removable: boolean;
}

/** skills 目录下的子目录，且含 SKILL.md；隐藏目录（.trash 等）跳过 */
function scanSkillsDir(root: string): { name: string; dir: string }[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: { name: string; dir: string }[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.') || !SKILL_NAME_RE.test(e.name)) continue;
    const dir = path.join(root, e.name);
    try {
      // statSync 会跟随链接：链接指向有效目录才算
      if (fs.statSync(dir).isDirectory() && fs.statSync(path.join(dir, 'SKILL.md')).isFile()) out.push({ name: e.name, dir });
    } catch { /* 不是 skill */ }
  }
  return out;
}

function pluginSkills(configDir: string): DiskSkill[] {
  let json: { plugins?: Record<string, { installPath?: unknown }[]> };
  try {
    json = JSON.parse(fs.readFileSync(path.join(configDir, 'plugins', 'installed_plugins.json'), 'utf8'));
  } catch {
    return [];
  }
  const out: DiskSkill[] = [];
  const seen = new Set<string>();
  for (const [key, installs] of Object.entries(json.plugins ?? {})) {
    const plugin = key.split('@')[0] ?? '';
    if (!plugin || !Array.isArray(installs)) continue;
    for (const inst of installs) {
      if (typeof inst?.installPath !== 'string') continue;
      for (const s of scanSkillsDir(path.join(inst.installPath, 'skills'))) {
        const name = `${plugin}:${s.name}`;
        if (seen.has(name)) continue; // 同一插件在用户 / 项目两个范围各装一次，只列一个
        seen.add(name);
        out.push({ name, source: 'plugin', dir: s.dir, removable: false });
      }
    }
  }
  return out;
}

/** 列出某账号配置目录 + 某个项目下的全部 skill */
export function listDiskSkills(configDir: string, cwd: string | null): DiskSkill[] {
  const out: DiskSkill[] = [];
  const seen = new Set<string>();
  const add = (s: DiskSkill) => {
    if (seen.has(s.name)) return;
    seen.add(s.name);
    out.push(s);
  };
  // 项目级优先于用户级同名（与 CLI 的覆盖顺序一致）
  if (cwd) for (const s of scanSkillsDir(path.join(cwd, '.claude', 'skills'))) add({ ...s, source: 'projectSettings', removable: true });
  for (const s of scanSkillsDir(path.join(configDir, 'skills'))) add({ ...s, source: 'userSettings', removable: true });
  for (const s of pluginSkills(configDir)) add(s);
  return out;
}

/**
 * 列出当前账号在磁盘上的云端同步 skill（<configDir>/skills/synced/<orgUuid>_<accountUuid>/<名字>/SKILL.md）。
 * 只用于判断 onDisk 与「打开文件位置」，不并入 listDiskSkills。
 * 读不到 .claude.json、未登录、uuid 不是合法 UUID 或目录不存在时一律返回空 Map。
 */
export function listSyncedSkills(configDir: string, claudeJsonFile: string): Map<string, string> {
  const out = new Map<string, string>();
  let oauth: Record<string, unknown> | null = null;
  try {
    const j = JSON.parse(fs.readFileSync(claudeJsonFile, 'utf8')) as { oauthAccount?: unknown };
    if (j?.oauthAccount && typeof j.oauthAccount === 'object' && !Array.isArray(j.oauthAccount)) {
      oauth = j.oauthAccount as Record<string, unknown>;
    }
  } catch {
    return out;
  }
  const org = oauth?.organizationUuid;
  const acc = oauth?.accountUuid;
  if (!isSessionUuid(org) || !isSessionUuid(acc)) return out;
  const bucket = path.join(configDir, 'skills', 'synced', `${org}_${acc}`);
  for (const s of scanSkillsDir(bucket)) out.set(`anthropic-skills:${s.name}`, s.dir);
  return out;
}

/**
 * 移除一个用户级 / 项目级 skill：把它的目录移到 backupRoot 下（<时间>-<来源>-<名字>），可以手动放回去恢复。
 * 目录名只取自磁盘扫描结果，不会拼接外部输入的路径。返回备份位置。
 */
export function removeDiskSkill(name: string, configDir: string, cwd: string | null, backupRoot: string): string {
  const hit = listDiskSkills(configDir, cwd).find((s) => s.name === name);
  if (!hit) throw new Error('找不到这个 skill（可能已被移除，或它来自插件 / 内置）');
  if (!hit.removable) throw new Error('插件里的 skill 不能单独移除：请改用「关」，或卸载整个插件');
  fs.mkdirSync(backupRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(backupRoot, `${stamp}-${hit.source === 'projectSettings' ? 'project' : 'user'}-${name}`);
  try {
    fs.renameSync(hit.dir, dest);
  } catch (e) {
    // 跨磁盘（EXDEV）等：复制到备份再删原目录；链接只删链接本身，不碰它指向的内容
    const st = fs.lstatSync(hit.dir);
    if (st.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(hit.dir), dest, 'junction');
      fs.rmSync(hit.dir, { recursive: true });
    } else {
      void e;
      fs.cpSync(hit.dir, dest, { recursive: true });
      fs.rmSync(hit.dir, { recursive: true, force: true });
    }
  }
  return dest;
}

/** 拆出 SKILL.md 的 frontmatter（--- 包起来的头）与正文；没有 frontmatter 时 head 为空 */
export function splitFrontmatter(text: string): { head: string; body: string } {
  const src = text.replace(/^﻿/, '');
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { head: '', body: src };
  return { head: m[1] ?? '', body: src.slice(m[0].length).replace(/^\r?\n/, '') };
}

/** frontmatter 里的 description：支持单行（可带引号）与 `>` / `|` 多行块 */
export function frontmatterDescription(head: string): string | undefined {
  const lines = head.split(/\r?\n/);
  const i = lines.findIndex((l) => /^description\s*:/.test(l));
  if (i < 0) return undefined;
  const first = lines[i]!.replace(/^description\s*:\s*/, '').trim();
  if (/^[>|][+-]?$/.test(first)) {
    const parts: string[] = [];
    for (const l of lines.slice(i + 1)) {
      if (l.trim() && !/^\s/.test(l)) break; // 缩进结束 = 块结束
      parts.push(l.trim());
    }
    const joined = (first.startsWith('>') ? parts.join(' ') : parts.join('\n')).trim();
    return joined || undefined;
  }
  const unq = first.replace(/^(["'])([\s\S]*)\1$/, '$2').trim();
  return unq || undefined;
}

/**
 * 读磁盘上的 SKILL.md（技能面板兜底展示）：只服务 listDiskSkills 扫描到的 skill，名字不在其中返回 null，
 * 路径不由外部输入拼接，因此无法穿越。返回的正文已去掉 frontmatter。
 */
export function readSkillContent(
  name: string,
  configDir: string,
  cwd: string | null,
): { name: string; description?: string; body: string; dir: string } | null {
  const hit = listDiskSkills(configDir, cwd).find((s) => s.name === name);
  if (!hit) return null;
  let text: string;
  try {
    text = fs.readFileSync(path.join(hit.dir, 'SKILL.md'), 'utf8');
  } catch {
    return null;
  }
  const { head, body } = splitFrontmatter(text);
  const description = frontmatterDescription(head);
  return { name, ...(description ? { description } : {}), body, dir: hit.dir };
}

/** 读一个 .md 文件 frontmatter 里的 description（SKILL.md / 智能体定义通用）；读不到为 undefined */
export function fileDescription(file: string): string | undefined {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 512 * 1024) return undefined;
    return frontmatterDescription(splitFrontmatter(fs.readFileSync(file, 'utf8')).head);
  } catch {
    return undefined;
  }
}

/** 某个 skill 目录下 SKILL.md 的 description */
export const skillDescription = (dir: string): string | undefined => fileDescription(path.join(dir, 'SKILL.md'));

/** 智能体定义：frontmatter 的 name（没有就用文件名）与 description */
function scanAgentsDir(root: string, prefix: string, out: Map<string, string>): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.name.endsWith('.md') || e.name.startsWith('.')) continue;
    const file = path.join(root, e.name);
    let head: string;
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || st.size > 512 * 1024) continue;
      head = splitFrontmatter(fs.readFileSync(file, 'utf8')).head;
    } catch {
      continue;
    }
    const desc = frontmatterDescription(head);
    if (!desc) continue;
    const m = /^name\s*:\s*(.+)$/m.exec(head);
    const raw = (m?.[1] ?? e.name.slice(0, -3)).trim().replace(/^(["'])(.*)\1$/, '$2');
    const name = prefix + raw;
    if (raw && !out.has(name)) out.set(name, desc);
  }
}

/**
 * 磁盘上自定义智能体的描述（名字 → description）：项目级（<cwd>/.claude/agents）优先于用户级，再加已安装插件里的。
 * 已关闭的智能体不在 init 里，靠它也能显示说明。
 */
export function listDiskAgentDescriptions(configDir: string, cwd: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (cwd) scanAgentsDir(path.join(cwd, '.claude', 'agents'), '', out);
  scanAgentsDir(path.join(configDir, 'agents'), '', out);
  let json: { plugins?: Record<string, { installPath?: unknown }[]> } = {};
  try {
    json = JSON.parse(fs.readFileSync(path.join(configDir, 'plugins', 'installed_plugins.json'), 'utf8'));
  } catch { /* 没装插件 */ }
  for (const [key, installs] of Object.entries(json.plugins ?? {})) {
    const plugin = key.split('@')[0] ?? '';
    if (!plugin || !Array.isArray(installs)) continue;
    for (const inst of installs) if (typeof inst?.installPath === 'string') scanAgentsDir(path.join(inst.installPath, 'agents'), `${plugin}:`, out);
  }
  return out;
}
