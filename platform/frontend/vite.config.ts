import path from 'path';
import { defineConfig, searchForWorkspaceRoot } from 'vite';
import react from '@vitejs/plugin-react';

// 共享模块 pet/ 位于 vite root（platform/frontend）之外：
// 必须同时配置 resolve.alias 与 server.fs.allow，否则 dev server 对 /@fs/ 请求返回 403。
const petDir = path.resolve(__dirname, '../../pet');

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@pet': petDir,
    },
  },
  server: {
    port: 5174,
    fs: {
      allow: [searchForWorkspaceRoot(process.cwd()), petDir],
    },
    proxy: {
      '/api': 'http://localhost:3001',
      '/uploads': 'http://localhost:3001',
    },
  },
});
