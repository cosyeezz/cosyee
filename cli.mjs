#!/usr/bin/env node
// cosyee-server [--tailscale | --local] [--host <IPv4>] [--port <n>]；其余配置见 README.txt 的环境变量
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const val = () => {
    const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[++i];
    if (!v) { console.error('缺少参数值: ' + a); process.exit(2); }
    return v;
  };
  if (a === '--tailscale') process.env.COSYEE_HOST = 'tailscale';
  else if (a === '--local') process.env.COSYEE_HOST = '127.0.0.1';
  else if (a === '--host' || a.startsWith('--host=')) process.env.COSYEE_HOST = val();
  else if (a === '--port' || a.startsWith('--port=')) process.env.COSYEE_PORT = val();
  else if (a === '-v' || a === '--version') { console.log("0.1.23-main.1"); process.exit(0); }
  else if (a === '-h' || a === '--help') {
    console.log('用法: cosyee-server [--tailscale | --local] [--host <IPv4>] [--port <端口>]\n  --tailscale  本机 + tailnet 内设备可访问，不需要令牌（默认）\n  --local      只监听 127.0.0.1\n  默认端口 7878');
    process.exit(0);
  } else { console.error('未知参数: ' + a + '（--help 查看用法）'); process.exit(2); }
}
await import('./server.mjs');
