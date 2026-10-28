import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * The Content-Security-Policy the production build is verified against (the browser suite runs under it via `vite preview`,
 * and any violation fails the tests). Serve the same policy from whatever hosts apps/web/dist. See docs/RELEASE.md.
 * style-src-attr allows only the four inline style="" attributes React renders for dynamic sizes; there are no inline scripts or style elements.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Same-origin in development: the browser only talks to :5173, so the session cookie (SameSite=Lax),
    // the CSRF header contract and CORS behave exactly as they will behind one origin in production.
    proxy: { '/api': { target: process.env.API_URL ?? 'http://localhost:3001', changeOrigin: false } },
  },
  preview: {
    headers: {
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    },
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
