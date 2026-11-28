import { describe, expect, it } from 'vitest';
import { classifyBackgroundTask, classifyBashCommand } from '@cosyee/shared';

describe('classifyBashCommand', () => {
  it('常驻命令（开发服务器 / watcher / tail）归为 persistent', () => {
    const persistent = [
      'npm run dev',
      'npm start',
      'pnpm dev',
      'pnpm run preview',
      'pnpm --filter web dev',
      'yarn start',
      'yarn run serve',
      'bun dev',
      'bun run dev:watch',
      'vite',
      'npx vite --port 5173',
      'vite preview',
      'next dev',
      'nuxt dev',
      'webpack serve --open',
      'webpack-dev-server',
      'nodemon src/index.ts',
      'tsx watch src/index.ts',
      'tsc -w',
      'tsc --watch',
      'vitest --watch',
      'jest --watch',
      'tail -f app.log',
      'tail -n 100 -F /var/log/app.log',
      'tail --follow app.log',
      'python -m http.server 8000',
      'python3 -m http.server',
      'docker compose up',
      'docker-compose up',
      'serve -s dist',
      'npx serve dist',
      'http-server ./public',
      'live-server',
    ];
    for (const cmd of persistent) {
      expect(classifyBashCommand(cmd), cmd).toBe('persistent');
    }
  });

  it('有明确终点的命令归为 awaited', () => {
    const awaited = [
      'gh run watch 46124140079 --exit-status',
      'gh pr checks 123 --watch',
      'npm run build',
      'npm test',
      'npm ci',
      'npm install',
      'pnpm build && pnpm test',
      'pnpm --filter server typecheck',
      'yarn lint',
      'bun run check',
      'vite build',
      'npx vite build',
      'next build',
      'cargo build --release',
      'cargo test',
      'go test ./...',
      'go build ./cmd/app',
      'mvn test',
      './gradlew build',
      'pytest tests/',
      'tsc -p tsconfig.json',
      'tsc --noEmit',
      'vitest run',
      'jest src/foo.test.ts',
      'sleep 30',
      'until gh run view 46124140079 --json status -q .status | grep -q completed; do sleep 30; done',
      'while ! curl -sf http://localhost:3000/health; do sleep 1; done',
      'timeout 60 ./check.sh',
      'git push origin main',
      'git clone https://example.com/repo.git',
      'git fetch --all',
      'git pull',
      'docker build -t app .',
      'docker pull node:22',
      'curl -L -o file.tar.gz https://example.com/file.tar.gz',
      'wget https://example.com/file.tar.gz',
    ];
    for (const cmd of awaited) {
      expect(classifyBashCommand(cmd), cmd).toBe('awaited');
    }
  });

  it('常驻标记优先于有终点标记（如先构建再启 dev server，或带 --watch 的测试）', () => {
    expect(classifyBashCommand('pnpm build && pnpm dev')).toBe('persistent');
    expect(classifyBashCommand('npm test -- --watch')).toBe('persistent');
    expect(classifyBashCommand('tsc -p tsconfig.json -w')).toBe('persistent');
  });

  it('路径里含 server 不会误命中 serve 常驻规则', () => {
    expect(classifyBashCommand('cd server && pnpm test')).toBe('awaited');
  });

  it('无条件死循环与 cargo run 归为 persistent', () => {
    expect(classifyBashCommand('while true; do curl -s localhost:3000/ping; sleep 5; done')).toBe('persistent');
    expect(classifyBashCommand('while :; do date; sleep 1; done')).toBe('persistent');
    expect(classifyBashCommand('cargo run --release')).toBe('persistent');
  });

  it('认不出来的命令或空命令默认 persistent', () => {
    expect(classifyBashCommand('')).toBe('persistent');
    expect(classifyBashCommand('   ')).toBe('persistent');
    expect(classifyBashCommand('./my-custom-daemon --port 9000')).toBe('persistent');
    expect(classifyBashCommand('echo hello')).toBe('persistent');
  });
});

describe('classifyBackgroundTask', () => {
  it('local_agent（后台子代理）归为 awaited', () => {
    expect(classifyBackgroundTask({ taskType: 'local_agent' })).toBe('awaited');
  });

  it('Monitor 工具或 monitor taskType 归为 awaited', () => {
    expect(classifyBackgroundTask({ taskType: 'local_bash', toolName: 'Monitor', toolInput: { command: 'tail -f app.log' } })).toBe('awaited');
    expect(classifyBackgroundTask({ taskType: 'monitor' })).toBe('awaited');
    expect(classifyBackgroundTask({ taskType: 'local_monitor' })).toBe('awaited');
  });

  it('local_bash 依据 Bash input.command 分类；缺 command 时默认 persistent', () => {
    expect(classifyBackgroundTask({ taskType: 'local_bash', toolName: 'Bash', toolInput: { command: 'gh run watch 46124140079 --exit-status' } })).toBe('awaited');
    expect(classifyBackgroundTask({ taskType: 'local_bash', toolName: 'Bash', toolInput: { command: 'npm run dev' } })).toBe('persistent');
    expect(classifyBackgroundTask({ taskType: 'local_bash' })).toBe('persistent');
    expect(classifyBackgroundTask({ taskType: 'local_bash', toolName: 'Bash', toolInput: {} })).toBe('persistent');
  });

  it('未知或缺失 taskType 默认 persistent', () => {
    expect(classifyBackgroundTask({})).toBe('persistent');
    expect(classifyBackgroundTask({ taskType: 'unknown_type' })).toBe('persistent');
  });
});
