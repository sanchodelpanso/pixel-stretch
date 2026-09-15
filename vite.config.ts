import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig(({ command }) => ({
  // GitHub Pages serves the site from /pixel-stretch/; dev and Playwright stay at /
  base: command === 'build' ? '/pixel-stretch/' : '/',
  plugins: [
    react(),
    VitePWA({
      // No skipWaiting: a new deploy takes over on the next launch, never mid-edit
      registerType: 'prompt',
      injectRegister: 'script-defer',
      // globPatterns below already precache every icon in public/
      includeManifestIcons: false,
      manifest: {
        name: 'PixelStretch',
        short_name: 'PixelStretch',
        description: 'AI-powered pixel stretch photo editor',
        theme_color: '#111111',
        background_color: '#111111',
        display: 'standalone',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,webp}'],
        // The HEIC decoder (~3 MB) is lazy-loaded; cache it on first use instead
        globIgnores: ['**/heic-to-*.js'],
        runtimeCaching: [
          {
            // Hashed lazy chunks and the ONNX runtime wasm (~23 MB)
            urlPattern: /\/assets\/.+\.(?:js|wasm)$/,
            handler: 'CacheFirst',
            options: { cacheName: 'lazy-assets', expiration: { maxEntries: 20 } },
          },
          {
            urlPattern: /\.pixelstretch$/,
            handler: 'CacheFirst',
            options: { cacheName: 'sample-projects', expiration: { maxEntries: 4 } },
          },
        ],
      },
    }),
  ],
  worker: {
    format: 'iife',
  },
  optimizeDeps: {
    exclude: ['@huggingface/transformers'],
  },
  // Allow importing .glsl files as raw strings
  assetsInclude: ['**/*.glsl'],
}))
