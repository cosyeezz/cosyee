// 头像：名字首字母 + 由名字哈希出的底色

/** 取名字第一个字符（按码点，兼容中文/emoji），英文转大写；空名返回 '?' */
export function avatarInitial(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toUpperCase() : '?';
}

/** 稳定哈希 → 色相，固定饱和度与明度，保证白字可读 */
export function avatarColor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return `hsl(${h % 360} 45% 38%)`;
}
