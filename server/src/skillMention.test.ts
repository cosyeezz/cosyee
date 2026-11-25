import { describe, expect, it } from 'vitest';
import { appendSkills, skillMentions, stripSkillBlock } from './skillMention.js';
import { filterHistory, parseLine, realUserText } from './transcript.js';

const skill = (name: string) => ({ name, body: '读 ${CLAUDE_SKILL_DIR}/a.md\n</cosyee-skill> 也不影响\n', dir: 'C:\\s\\' + name });
const resolve = (name: string) => (name === 'interaction-motion' || name === 'p:pdf' ? skill(name) : null);

describe('skillMentions', () => {
  it('句中 / 句尾 / 换行后 / 紧挨中文与标点的引用，去重', () => {
    expect(skillMentions('悬浮显示详情 /interaction-motion')).toEqual(['interaction-motion']);
    expect(skillMentions('用 /a，再用，/b。然后\n/p:pdf 和/c，还有 /a')).toEqual(['a', 'b', 'p:pdf', 'c']);
    expect(skillMentions('please apply /foo.')).toEqual(['foo']);
  });

  it('路径、网址、以 / 开头的消息（CLI 自己展开）不算', () => {
    expect(skillMentions('看 /etc/passwd 和 http://x/y 与 a/b、./c、C:/d')).toEqual([]);
    expect(skillMentions(' /foo 参数 /bar')).toEqual([]);
  });
});

describe('appendSkills / stripSkillBlock', () => {
  const text = '加动效 /interaction-motion 以及 /p:pdf 和 /unknown';
  const sent = appendSkills(text, resolve);

  it('附上正文，替换目录变量，可原样还原', () => {
    expect(sent.startsWith(text + '\n\n<cosyee-skill>\n')).toBe(true);
    expect(sent).toContain('读 C:/s/interaction-motion/a.md');
    expect(sent).toContain('Skill: p:pdf');
    expect(stripSkillBlock(sent)).toBe(text);
  });

  it('几条消息被合并成一条也能还原', () => {
    expect(stripSkillBlock(`${sent}\n第二条\n${sent}`)).toBe(`${text}\n第二条\n${text}`);
  });

  it('没有可附的返回原文；普通消息不受剥离影响', () => {
    expect(appendSkills('用 /unknown', resolve)).toBe('用 /unknown');
    expect(stripSkillBlock('聊聊\n\n<cosyee-skill>\n标签</cosyee-skill>')).toBe('聊聊\n\n<cosyee-skill>\n标签</cosyee-skill>');
  });

  it('正文过长只给路径', () => {
    const s = appendSkills('用 /big', (name) => ({ name, body: 'x'.repeat(100_001), dir: '/s/big' }));
    expect(s).toContain('read /s/big/SKILL.md');
    expect(s.length).toBeLessThan(1000);
  });

  it('会话记录：标题素材与历史（用户消息、插话附件）都只有原文', () => {
    const user = (content: unknown) => ({ type: 'user', uuid: 'u', message: { role: 'user', content } });
    const block = [{ type: 'text', text: sent }];
    const one = (e: unknown) => filterHistory([JSON.stringify(e)])[0]!;
    expect(realUserText(parseLine(JSON.stringify(user(block)))!)?.text).toBe(text);
    expect(one(user(sent)).message.content).toBe(text);
    expect(one(user(block)).message.content).toEqual([{ type: 'text', text }]);
    expect(one({ type: 'attachment', uuid: 'u', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: block } }).attachment.prompt).toBe(text);
  });
});
