// 只读扫描 claude.exe 里的字符串：node scanbin.mjs <needle> [before] [after] [maxHits]
import fs from 'node:fs';
const f = 'C:/Users/dane/.local/bin/claude.exe';
const needle = Buffer.from(process.argv[2]);
const before = +process.argv[3] || 3000, after = +process.argv[4] || 500;
const maxHits = +process.argv[5] || 3;
const fd = fs.openSync(f, 'r');
const size = fs.fstatSync(fd).size;
const CH = 64 * 1024 * 1024;
let pos = 0, found = 0;
while (pos < size && found < maxHits) {
  const len = Math.min(CH + 4096, size - pos);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, pos);
  let i = 0;
  while ((i = buf.indexOf(needle, i)) >= 0) {
    const s = buf.slice(Math.max(0, i - before), Math.min(len, i + after)).toString('latin1').replace(/[^\x20-\x7e\n]/g, '');
    console.log('=== @', pos + i, '\n' + s);
    found++; i += needle.length;
    if (found >= maxHits) break;
  }
  pos += CH;
}
