import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      // ffmpeg-static 依赖 __dirname 定位预编译二进制，bundle 会破坏路径解析，必须保持外部 require
      external: ['ffmpeg-static'],
    },
  },
});
