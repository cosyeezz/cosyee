// 生成可直接双击打开的 icons/preview.html（把 icons.css 和 icons.js 内联进模板）。
// 用法：node icons/preview/build.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const p = rel => fileURLToPath(new URL(rel, import.meta.url));
const css = readFileSync(p('../icons.css'), 'utf8');
const js = readFileSync(p('../icons.js'), 'utf8').replace(/^export /gm, '');
const html = readFileSync(p('./template.html'), 'utf8')
  .replace('/*@ICONS_CSS*/', () => css)
  .replace('/*@ICONS_JS*/', () => js);
writeFileSync(p('../preview.html'), html);
console.log('written', p('../preview.html'));
