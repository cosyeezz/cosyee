import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 测试里启动的服务不去访问官方价格页
    env: { COSYEE_NO_PRICING_FETCH: '1' },
  },
});
