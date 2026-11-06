import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// The dev server forwards /v1 to the local ds4-server, so the page never needs
// CORS and the browser only ever talks to one origin. DS4_API_TARGET moves the
// proxy when the server runs on another host or port.
const apiTarget = process.env['DS4_API_TARGET'] ?? 'http://127.0.0.1:8000';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/v1': {
        target: apiTarget,
        changeOrigin: false,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
