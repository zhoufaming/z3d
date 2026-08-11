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
  },
});
