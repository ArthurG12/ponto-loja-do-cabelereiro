import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.VITE_BASE || '/',
  server: {
    host: '0.0.0.0',
    port: 5175,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:5176',
    },
  },
  preview: {
    host: '0.0.0.0',
    proxy: {
      '/api': 'http://127.0.0.1:5176',
    },
  },
});
