const pty = require('@lydell/node-pty');
const p = pty.spawn('claude.exe', ['--dangerously-skip-permissions','--model','haiku'], { name:'xterm-256color', cols:120, rows:30, cwd:process.cwd(), env:process.env });
let out='';
p.onData(d=>{ out+=d; });
setTimeout(()=>{ p.write('/mcp'); setTimeout(()=>p.write('\r'),500); }, 6000);
setTimeout(()=>{
  const plain = out.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g,'').replace(/\x1b\][^\x07]*\x07/g,'');
  console.log('bytes', out.length); console.log(plain.slice(-1500));
  p.kill(); process.exit(0);
}, 12000);
