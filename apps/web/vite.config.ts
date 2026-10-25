import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Same-origin in development: the browser only talks to :5173, so the session cookie (SameSite=Lax),
    // the CSRF header contract and CORS behave exactly as they will behind one origin in production.
    proxy: { '/api': { target: process.env.API_URL ?? 'http://localhost:3001', changeOrigin: false } },
  },
  build: { sourcemap: true },
  test: {
    environment: 'jsdom',
    setupFiles: ['test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    css: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
    // The smoke test starts a real API server against the shared test database.
    fileParallelism: false,
  },
});
