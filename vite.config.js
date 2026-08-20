import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5180,
    strictPort: false,
  },
  build: {
    target: 'es2022',
    // three.js 体积本来就大，关掉无意义的告警
    chunkSizeWarningLimit: 2500,
    // 关闭 vite 自动清空 outDir：其 rmSync 会被本地 safe-delete 钩子拦截导致构建失败。
    // 改为在构建脚本里用 PowerShell 预清理（见 npm run build 包装）。
    emptyOutDir: false,
  },
});
