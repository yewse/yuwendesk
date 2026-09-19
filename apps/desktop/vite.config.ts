import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// 渲染层作为本地静态资源打包，生产环境通过 file:// 加载，不依赖任何开发服务器或监听端口。
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome126'
  },
  server: {
    host: '127.0.0.1',
    port: 5199,
    strictPort: true
  }
});
