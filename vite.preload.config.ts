import path from 'path';
import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  resolve: {
    // 宠物共享模块（仓库根 pet/）：与主进程/渲染端同一处解析
    alias: {
      '@pet': path.resolve(__dirname, 'pet'),
    },
  },
});
