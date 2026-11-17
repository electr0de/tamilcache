import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * `test` is consumed by Vitest, which reads this file at runtime. It is not part of the
 * typecheck program: Vitest 2 bundles Vite 5 types while this app builds on Vite 6, and the
 * `PluginOption` types are not interchangeable. Keeping the config out of `tsc` avoids a
 * permanent type error that says nothing about application code.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist' },
  server: {
    proxy: { '/api': { target: 'http://localhost:8484', changeOrigin: true } },
  },
  // @ts-expect-error Vitest-only key, typed by Vitest's own config module at runtime.
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.tsx', 'test/**/*.test.ts'],
    globals: true,
  },
});
