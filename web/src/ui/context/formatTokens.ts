// token 数量格式化：45200 → "45.2k"，200000 → "200k"，1_500_000 → "1.5m"

function trim(n: number, digits: number): string {
  return n.toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

export function formatTokens(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${trim(n / 1_000_000, 1)}m`;
  if (abs >= 1_000) return `${trim(n / 1_000, 1)}k`;
  return String(Math.round(n));
}

/** 百分比：<0.1 显示 "<0.1%"，其余保留 1 位小数并去掉多余的 0 */
export function formatPercent(p: number): string {
  if (p > 0 && p < 0.1) return '<0.1%';
  return `${trim(p, 1)}%`;
}
