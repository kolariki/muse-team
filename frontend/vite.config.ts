import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))

const API = process.env.ARENA_API ?? 'http://localhost:8000'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // the ad composition lives with the renderer (backend/video/src) and the «Anuncios» gallery plays it live: one source for both,
  // its imports resolved from this package
  resolve: {
    alias: [
      { find: '@ads', replacement: here('../backend/video/src') },
    ],
    dedupe: ['react', 'react-dom', 'remotion', '@remotion/player', '@remotion/transitions', '@remotion/google-fonts'],
  },
  server: {
    fs: { allow: ['..'] },
    port: 5173,
    proxy: {
      '/api': API,
      // public, server-rendered pages and files (blog, FAQ, sitemap, robots, llms.txt)
      '^/(en/)?(blog|faq|privacidad|terminos|sitemap\\.xml|robots\\.txt|llms\\.txt|llms-full\\.txt)([/?].*)?$': API,
      '^/r/': API,  // «Correr la app» through Muse Team (TABLY_RUN_URL=http://localhost:5173 to try it in dev, same origin as the UI)
      '/ws': { target: API.replace(/^http/, 'ws'), ws: true },
    },
  },
})
