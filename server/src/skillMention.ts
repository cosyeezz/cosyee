// 句中引用「手动」的 skill（如「给按钮加动效 /interaction-motion」）：把 SKILL.md 正文附在发给 CLI 的消息末尾。
// 原因：CLI 只展开消息开头的 /名字；句中的要靠模型调 Skill 工具，而「手动」的 skill 不在模型的清单里，
// 且 CLI 判断「用户本轮是否输入过 /名字」时不看执行中的插话（queued_command 附件），会直接拒绝调用（2.1.326 / 2.1.332 实测）。
// 附加内容只给模型看：界面、排队列表用原文，读会话记录时由 stripSkillBlock 去掉。

const OPEN = '<cosyee-skill>';
const CLOSE = '</cosyee-skill>';
const NOTE =
  'The user invoked the skill(s) below by typing /name in the message above. The full instructions are included: follow them directly, and do not call the Skill tool for them.';
/** 正文超过这个字数就不附全文，只让模型去读文件 */
const BODY_MAX = 100_000;

export interface MentionedSkill {
  name: string;
  body: string;
  dir: string;
}

// 前面不能是路径 / 网址 / 单词的一部分，后面不能还是名字字符或 /（排除 /a/b）；中文与标点可以紧挨着
const MENTION_RE = /(?<![\w./\\:~@-])\/([A-Za-z0-9][A-Za-z0-9._:@+-]*)(?![A-Za-z0-9._:@+/-])/g;

/** 消息里引用的名字（去重，按出现顺序）。以 / 开头的消息由 CLI 自己展开，返回空 */
export function skillMentions(text: string): string[] {
  if (text.trimStart().startsWith('/')) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) out.add(m[1]!.replace(/[.:]+$/, '')); // 句末的英文句号 / 冒号
  return [...out];
}

/** 在消息末尾附上 skill 正文；resolve 返回 null 的名字不附。没有可附的返回原文 */
export function appendSkills(text: string, resolve: (name: string) => MentionedSkill | null): string {
  const parts: string[] = [];
  for (const name of skillMentions(text)) {
    const s = resolve(name);
    if (!s) continue;
    const dir = s.dir.replace(/\\/g, '/');
    const body =
      s.body.length > BODY_MAX
        ? `(Too long to include: read ${dir}/SKILL.md before continuing.)`
        : s.body
            .replaceAll('${CLAUDE_SKILL_DIR}', () => dir)
            .replaceAll(CLOSE, '<\\/cosyee-skill>') // 正文里不能出现结束标签，否则剥离不干净
            .trim();
    parts.push(`Skill: ${s.name}\nBase directory for this skill: ${dir}\n\n${body}`);
  }
  return parts.length ? `${text}\n\n${OPEN}\n${NOTE}\n\n${parts.join('\n\n---\n\n')}\n${CLOSE}` : text;
}

/** 去掉 appendSkills 附加的部分，还原用户的原文（CLI 可能把几条消息合并成一条，所以去掉每一处） */
export function stripSkillBlock(text: string): string {
  const head = `\n\n${OPEN}\n${NOTE}`;
  let out = text;
  for (let i = out.indexOf(head); i >= 0; i = out.indexOf(head, i)) {
    const end = out.indexOf(CLOSE, i);
    if (end < 0) break;
    out = out.slice(0, i) + out.slice(end + CLOSE.length);
  }
  return out;
}
