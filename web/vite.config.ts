import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// VITE_MOCK=1          → in-browser mock arcade-server (no backend needed)
// VITE_API_BASE=http://localhost:8080 → dev server proxies /api and /ws to a
//   port-forwarded arcade-server (kubectl port-forward -n arcade-system svc/arcade-server 8080:80)
// VITE_DEV_TOKEN=…     → sent as Authorization: Bearer on mutating calls
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.VITE_API_BASE || 'http://localhost:8080';
  return {
    plugins: [react(), tailwindcss()],
    // In dev the client talks to same-origin /api and /ws and Vite proxies them
    // to VITE_API_BASE (see src/api.ts); in production the Go server serves both.
    server: {
      port: 5173,
      host: true,
      watch: { ignored: ['**/tsconfig.tsbuildinfo', '**/dist/**'] },
      proxy: {
        '/api': { target, changeOrigin: true },
        '/ws': { target, ws: true, changeOrigin: true },
        '/metrics': { target, changeOrigin: true },
      },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: false,
      chunkSizeWarningLimit: 1500,
      rollupOptions: {
        output: {
          manualChunks: { three: ['three'], r3f: ['@react-three/fiber'] },
        },
      },
    },
  };
});
