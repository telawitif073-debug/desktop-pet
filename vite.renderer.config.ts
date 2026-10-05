import path from 'path';
import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  resolve: {
    // 宠物共享模块（仓库根 pet/）：渲染端经 @pet/* 引用纯逻辑与视图模型
    alias: {
      '@pet': path.resolve(__dirname, 'pet'),
    },
  },
});
