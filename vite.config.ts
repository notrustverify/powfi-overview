import { defineConfig } from 'vite'

// GitHub Pages serves a project site from /<repo-name>/, so the deploy
// workflow passes VITE_BASE=/<repo-name>/ at build time. Local dev and
// previews fall back to root.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
})
