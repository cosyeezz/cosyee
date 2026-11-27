// 账号弹层（AccountMenu）和管理面板（AccountManager）共用的小工具与小组件。
import { useState, type CSSProperties } from 'react';
import type { AccountApiInfo, AccountDedupeResult, AccountEntry, AccountLogin, AgyAccountEntry } from '@cosyee/shared';
import { Icon } from '../icons/Icon';
import { avatarColor, avatarInitial } from './avatar';

export const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const loginPending = (l: AccountLogin | null | undefined): l is AccountLogin =>
  !!l && (l.status === 'starting' || l.status === 'waiting');

/** API 账号显示的主机名（Base URL 为空 = 官方） */
export function apiHost(baseUrl: string): string {
  if (!baseUrl) return 'api.anthropic.com';
  try {
    return new URL(baseUrl).host || baseUrl;
  } catch {
    return baseUrl;
  }
}

/** API 账号的说明：按量计费 + 模型映射了几项（别名 + 自定义条目） */
export function apiMapNote(info: AccountApiInfo): string {
  const m = info.models;
  const n = Object.keys(m?.alias ?? {}).length + (m?.extra?.length ?? 0);
  return n ? `按量计费 · 已映射 ${n} 个模型` : '按量计费 · 未配置模型映射';
}

/** 标题：显示名，读不到时用备注名；都没有就叫「Claude 账号」（没登录的叫「未登录账号」） */
export function entryTitle(a: AccountEntry): string {
  return a.name ?? (a.label || (a.loggedIn ? 'Claude 账号' : '未登录账号'));
}

/** 副标题：备注名 · 需要登录；API 账号：主机名；Kiro 账号：邮箱（套餐另做成名字后面的小标签，见 planChip） */
export function entrySubtitle(a: AccountEntry): string {
  const parts: string[] = [];
  if (a.label && a.label !== entryTitle(a)) parts.push(a.label);
  if (a.api) {
    const host = apiHost(a.api.baseUrl);
    if (host !== entryTitle(a)) parts.push(host);
  }
  if (a.kiro?.email && a.kiro.email !== entryTitle(a)) parts.push(a.kiro.email);
  if (!a.loggedIn) parts.push('需要登录');
  return parts.join(' · ');
}

/** Claude 账号不能移除的原因（和服务端一致）；能移除返回 null */
export function claudeRemoveBlock(a: AccountEntry): string | null {
  if (a.isDefault) return '默认账号不能移除';
  if (a.active) return '不能移除当前账号，请先切换到其它账号';
  return null;
}

/** Antigravity 账号不能移除的原因（和服务端一致）；能移除返回 null */
export function agyRemoveBlock(a: AgyAccountEntry): string | null {
  if (a.isDefault) return '默认账号不能移除';
  if (a.active) return '不能移除当前账号，请先切换到其它账号';
  if (a.running > 0) return `有 ${a.running} 个委派任务正在执行，结束后才能移除`;
  return null;
}

/** 名字后面的套餐小标签：「Google AI Pro」→「Pro」；没有套餐返回 null */
export function planChip(plan: string | null | undefined): string | null {
  const s = (plan ?? '').replace(/^google\s+ai\s+/i, '').trim();
  return s || null;
}

/** Antigravity 标题：备注名 → 登录邮箱 → 默认账号「本机登录」 */
export function agyTitle(a: AgyAccountEntry): string {
  return a.label || a.email || (a.isDefault ? '本机登录' : 'Antigravity 账号');
}

/** Antigravity 副标题：N 个执行中 · 邮箱（标题是备注名时）· 检测中 / 需要登录 */
export function agySubtitle(a: AgyAccountEntry): string {
  const parts: string[] = [];
  if (a.running > 0) parts.push(`${a.running} 个执行中`);
  if (a.email && a.email !== agyTitle(a)) parts.push(a.email);
  if (a.loggedIn === null) parts.push('检测中…');
  else if (!a.loggedIn) parts.push('需要登录');
  return parts.join(' · ');
}

/** 账号分类：claude.ai 订阅 / API Key / Kiro */
export type ClaudeKind = 'claude' | 'api' | 'kiro';
export const claudeKind = (a: AccountEntry): ClaudeKind => (a.api ? 'api' : a.kiro ? 'kiro' : 'claude');

/** 登录可用：已登录，且 claude.ai 订阅账号的登录没有过期 */
export function claudeUsable(a: AccountEntry, now: number): boolean {
  if (!a.loggedIn) return false;
  return !(claudeKind(a) === 'claude' && a.loginExpiresAt != null && a.loginExpiresAt <= now);
}

/** 头像：名字首字母 + 由名字算出的渐变底色；没登录是虚线空圈 */
export function Avatar({ title, loggedIn, size = 'md' }: { title: string; loggedIn: boolean; size?: 'xs' | 'sm' | 'md' }) {
  return (
    <span
      className={`cz-sidebar__avatar cz-sidebar__avatar--${size}${loggedIn ? '' : ' cz-sidebar__avatar--empty'}`}
      style={loggedIn ? ({ '--av': avatarColor(title) } as CSSProperties) : undefined}
      aria-hidden="true"
    >
      {loggedIn ? avatarInitial(title) : '?'}
    </span>
  );
}

/** 名字后面的套餐小标签 */
export function PlanChip({ plan, tip = true }: { plan: string | null | undefined; tip?: boolean }) {
  const chip = planChip(plan);
  if (!chip) return null;
  return <span className="cz-acct-chip" title={tip ? plan ?? undefined : undefined}>{chip}</span>;
}

/** Kiro 账号凭据被 kiro.rs 停用时的红色问题标签文字；正常返回 null */
export function kiroIssue(a: AccountEntry): string | null {
  const c = a.kiro?.credential;
  return c === 'quota' ? '额度用完' : c === 'disabled' ? '已停用' : null;
}

/** 弹层账号行右端的红色问题标签（额度用完 / 已停用）；管理面板里改用右上角的状态徽标 */
export function IssueChip({ text }: { text: string | null | undefined }) {
  if (!text) return null;
  return <span className="cz-acct-chip is-danger">{text}</span>;
}

/** 选中账号的标记：实心小圆里一个勾 */
export function ActiveMark() {
  return (
    <span className="cz-sidebar__acct-check" aria-hidden="true">
      <Icon name="check" size={10} />
    </span>
  );
}

/** 有被隐藏的重复账号时的提示行：「有 N 个重复的账号已隐藏 · 清理」，清理后报告跳过了几个 */
export function DuplicateNote({ count, onClean }: { count: number; onClean: () => Promise<AccountDedupeResult> }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  /** 上次清理跳过的个数：剩下的都是暂时删不掉的，就不再给「清理」按钮 */
  const [skipped, setSkipped] = useState(0);
  if (count <= 0 && !note) return null;
  const clean = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await onClean();
      setSkipped(r.skipped);
      setNote(
        r.skipped > 0
          ? `已清理 ${r.removed} 个；${r.skipped} 个正在使用（当前 / 默认账号或有任务在执行），暂时保留`
          : `已清理 ${r.removed} 个重复账号`,
      );
    } catch (e) {
      setNote(`清理失败：${msg(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="cz-acct-mgr__note cz-acct-dup" role="status">
      {count > 0 && (
        <span className="cz-acct-dup__line">
          <span>有 {count} 个重复的账号已隐藏</span>
          {count > skipped && (
            <button
              type="button"
              className="cz-acct-mgr__btn"
              disabled={busy}
              title="删除重复添加的同一账号（保留列表里显示的那一个）"
              onClick={() => void clean()}
            >
              {busy ? '清理中…' : '清理'}
            </button>
          )}
        </span>
      )}
      {note && <span className="cz-acct-dup__result">{note}</span>}
    </div>
  );
}
