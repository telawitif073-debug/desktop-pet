import path from 'path';
import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  resolve: {
    // 宠物共享模块（仓库根 pet/，纯 TS 零依赖）：主进程经 @pet/* 引用
    alias: {
      '@pet': path.resolve(__dirname, 'pet'),
    },
  },
  build: {
    rollupOptions: {
      // msedge-tts 依赖 ws（WebSocket）：bundle 后运行时 require 可选依赖易出问题，保持外部化
      external: ['msedge-tts'],
    },
  },
});
