import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      // msedge-tts 依赖 ws（WebSocket）：bundle 后运行时 require 可选依赖易出问题，保持外部化
      external: ['msedge-tts'],
    },
  },
});
