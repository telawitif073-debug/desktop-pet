import path from 'path';
import { defineConfig } from 'vitest/config';

// 测试 Electron 主进程/渲染端源码 + 宠物模块 pet/** 的纯逻辑；
// platform/backend 有自己的 Jest 测试，避免误收集
export default defineConfig({
  resolve: {
    // 与三个 vite 配置同口径：@pet/* → 仓库根 pet/*，供 src 侧引用共享模块的用例解析
    alias: {
      '@pet': path.resolve(__dirname, 'pet'),
    },
  },
  test: {
    include: ['src/**/*.spec.ts', 'pet/**/*.spec.ts'],
    environment: 'node',
  },
});
