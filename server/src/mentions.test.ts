// 会话记录里的路径提及：边界判断与流式扫描跨块不漏。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fileMentions, textMentions } from './mentions.js';

describe('textMentions', () => {
  const p = '/tmp/czshot/mk-sw.png';
  it('完整路径出现即命中：引号 / 空格 / 括号 / 中文标点 / 句号 / file:// / JSON 转义的换行', () => {
    for (const t of [`"${p}"`, `见 ${p} 。`, `[a](${p})`, `${p}，`, `存到 ${p}.`, `file://${p}`, `${p}\\n下一行`, p, `\`${p}:12\``]) {
      expect(textMentions(t, p), t).toBe(true);
    }
  });
  it('只是更长路径的一段不算', () => {
    for (const t of [`${p}.bak`, `/x${p}`, `${p}/child`, `${p}-2`, `a${p}`, `${p}\\\\child`]) {
      expect(textMentions(t, p), t).toBe(false);
    }
  });
  it('多处出现时，后面的完整出现也能命中', () => {
    expect(textMentions(`${p}.bak 和 ${p}`, p)).toBe(true);
  });
});

describe('fileMentions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-mentions-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('跨读取块边界的路径也能找到；不存在的路径不命中；忽略大小写可选', async () => {
    const needle = '/tmp/中文 目录/shot.png';
    const file = path.join(dir, 's.jsonl');
    // 让路径正好跨过 256KB 的块边界（中文按字符计，块按字节切）
    const pad = 'x'.repeat(256 * 1024 - 5);
    fs.writeFileSync(file, `${pad} ${needle} 结束\n`);
    expect(await fileMentions(file, [needle])).toBe(true);
    expect(await fileMentions(file, ['/tmp/中文 目录/other.png'])).toBe(false);
    expect(await fileMentions(file, ['/TMP/中文 目录/SHOT.png'])).toBe(false);
    expect(await fileMentions(file, ['/TMP/中文 目录/SHOT.png'], true)).toBe(true);
  });
});
