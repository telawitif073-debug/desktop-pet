import { defineConfig } from 'vitest/config';

// 仅测试 Electron 主进程/渲染端源码；platform/backend 有自己的 Jest 测试，避免误收集
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
  },
});
