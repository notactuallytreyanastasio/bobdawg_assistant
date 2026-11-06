import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// The dev server forwards /v1 and /chat/record to the local ds4-server, so the page never needs
// CORS and the browser only ever talks to one origin. DS4_API_TARGET moves the
// proxy when the server runs on another host or port.
const apiTarget = process.env['DS4_API_TARGET'] ?? 'http://127.0.0.1:8000';

// The page lives at /chat because that is where ds4-server serves it, and the
// prefix has to match DS4_UI_URL_PREFIX in ds4_ui.h: the built index asks for
// its assets under that prefix, and the server answers the asset URLs it wrote.
export default defineConfig({
  base: '/chat/',
  plugins: [react()],
  server: {
    proxy: {
      '/v1': {
        target: apiTarget,
        changeOrigin: false,
      },
      '/chat/record': {
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
