import { defineConfig } from 'vite'

// The custom domain serves the site from root. VITE_BASE can override
// this for deployments under a subpath (e.g. /powfi-overview/).
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
})
