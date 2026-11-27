/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@icons': path.resolve(__dirname, '../icons') } },
  server: {
    host: '127.0.0.1',
    // 与后端 server/src/security.ts 的 devPort() 一致；端口被占时直接报错，而不是换端口导致 Origin 校验失败
    port: Number(process.env.COSYEE_WEB_PORT) || 5273,
    strictPort: true,
    fs: { allow: [path.resolve(__dirname, '..')] },
    proxy: {
      '/api/browser/stream': { target: 'ws://127.0.0.1:7878', ws: true },
      '/api/terminal/ws': { target: 'ws://127.0.0.1:7878', ws: true },
      '/api': 'http://127.0.0.1:7878',
      '/ws': { target: 'ws://127.0.0.1:7878', ws: true },
    },
  },
  test: { environment: 'jsdom' },
});
