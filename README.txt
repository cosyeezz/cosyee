Cosyee 服务端 0.1.23-main.1

需要：Node.js 24+；已安装并登录的 Claude Code CLI（终端里 claude auth status 显示已登录）。

启动：Windows 双击 start.cmd；macOS / Linux 运行 ./start.sh
默认端口 7878，Tailscale 模式：
  - 本机：http://127.0.0.1:7878/
  - tailnet 里的其它设备：http://<本机 Tailscale IP 或机器名>:7878/
  - 局域网 / 公网的连接会被直接断开；不需要令牌。

环境变量：
  COSYEE_HOST    tailscale（默认）| 127.0.0.1（只给本机用）
  COSYEE_PORT    端口，默认 7878
  COSYEE_CLAUDE  claude 可执行文件路径，默认从 PATH 查找

注意：模型以 --dangerously-skip-permissions 运行，tailnet 里的任何设备都能让它在本机执行任意命令。
