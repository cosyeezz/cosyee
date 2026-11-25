// 账号分组用的官方品牌图标。彩色的放 brand/*.svg 用 <img> 显示（Antigravity 带渐变滤镜和 id，内联会重复）；
// Anthropic 的标志是单色的，内联跟随文字颜色，深浅主题都看得清。
import antigravity from './brand/antigravity.svg';
import claude from './brand/claude.svg';
import kiro from './brand/kiro.svg';

/** claude = Claude；api = Anthropic；kiro = Kiro；agy = Google Antigravity */
export type BrandKind = 'claude' | 'api' | 'kiro' | 'agy';

const SRC: Record<Exclude<BrandKind, 'api'>, string> = { claude, kiro, agy: antigravity };

export function BrandIcon({ kind, size = 14 }: { kind: BrandKind; size?: number }) {
  if (kind === 'api') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="currentColor"
        fillRule="evenodd"
        style={{ flex: 'none', color: 'var(--text)' }}
        data-brand={kind}
        aria-hidden="true"
      >
        <path d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.46H0L6.57 3.522zm4.132 9.959L8.453 7.687 6.205 13.48H10.7z" />
      </svg>
    );
  }
  return <img src={SRC[kind]} width={size} height={size} alt="" draggable={false} style={{ flex: 'none' }} data-brand={kind} />;
}
