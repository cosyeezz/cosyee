// Manual test:  npx -y tsx server/src/picker/try.ts [mixed|files|folders] [startDir]
import { pick, supportsMixed, type PickMode } from './index.js';

const mode = (process.argv[2] ?? 'mixed') as PickMode;
if (!['mixed', 'files', 'folders'].includes(mode)) {
  console.error('usage: try.ts [mixed|files|folders] [startDir]');
  process.exit(2);
}
const startDir = process.argv[3];

console.log(`platform=${process.platform} supportsMixed=${supportsMixed} mode=${mode}`);
const t0 = Date.now();
try {
  const items = await pick({ mode, title: `Cosyee picker test (${mode})`, startDir });
  console.log(`done in ${Date.now() - t0} ms, ${items.length} item(s):`);
  console.log(JSON.stringify(items, null, 2));
} catch (e) {
  console.error('pick failed:', e);
  process.exit(1);
}
