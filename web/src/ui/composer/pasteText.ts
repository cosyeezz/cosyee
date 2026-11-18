// 粘贴文本的清理：浏览器地址栏复制出的链接是百分号编码的（中文会变成 %E4%BC%9A…），
// 这里把其中的 URL 还原成可读文字；file:/// 链接直接转成本地路径，方便 claude 读取。

const URL_RE = /\b(?:file:\/\/\/?|https?:\/\/)[^\s<>"']+/gi;

function safeDecode(s: string, fn: (x: string) => string): string {
  try {
    return fn(s);
  } catch {
    return s;
  }
}

/** file:///C:/a/b → C:/a/b；file:///home/a → /home/a；file://host/share → //host/share */
function fileUrlToPath(url: string): string {
  const rest = url.replace(/^file:/i, '');
  const decoded = safeDecode(rest, decodeURIComponent);
  if (/^\/\/\/[a-zA-Z]:/.test(decoded)) return decoded.slice(3); // 盘符
  if (decoded.startsWith('///')) return decoded.slice(2);
  return decoded; // UNC：//host/share
}

function decodeUrl(url: string): string {
  if (/^file:/i.test(url)) return fileUrlToPath(url);
  if (!/%[0-9a-f]{2}/i.test(url)) return url;
  // decodeURI 保留 / ? # & 等保留字符的编码，只还原中文等普通字符
  return safeDecode(url, decodeURI);
}

/** 把粘贴文本中的百分号编码 URL 还原为可读形式 */
export function cleanPastedText(text: string): string {
  return text.replace(URL_RE, decodeUrl);
}
