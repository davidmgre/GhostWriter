import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/editor/',
  server: {
    port: 5173,
    allowedHosts: true,
    proxy: {
      '/api': 'http://localhost:3888',
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'codemirror': ['codemirror', '@codemirror/state', '@codemirror/view', '@codemirror/lang-markdown', '@codemirror/theme-one-dark', '@uiw/react-codemirror'],
          'markdown': ['react-markdown', 'remark-gfm', 'rehype-raw', 'rehype-sanitize'],
        },
      },
    },
  },
})
