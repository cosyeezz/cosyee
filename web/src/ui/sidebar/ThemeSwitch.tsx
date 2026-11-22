// 账号菜单底部的外观切换：跟随系统 / 浅色 / 深色。与模式切换同一套分段样式（粘性融合指示器）。
// 选择保存在本机浏览器（core/theme.ts），立即生效，不刷新页面。
import { useEffect, useState } from 'react';
import { getThemePref, onThemePref, setThemePref, type ThemePref } from '../../core/theme';
import { GooeyIndicator } from '../motion/GooeyIndicator';

const OPTIONS: { value: ThemePref; label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];

export function ThemeSwitch() {
  const [pref, setPref] = useState<ThemePref>(getThemePref);
  useEffect(() => onThemePref(setPref), []);
  return (
    <div className="cz-sidebar__mode cz-sidebar__theme">
      <div className="cz-sidebar__theme-label">外观</div>
      <div className="cz-sidebar__seg" role="radiogroup" aria-label="外观">
        <GooeyIndicator activeKey={pref} selector=".cz-sidebar__seg-btn.is-on" />
        {OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={pref === o.value}
            className={`cz-sidebar__seg-btn${pref === o.value ? ' is-on' : ''}`}
            onClick={() => setThemePref(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
