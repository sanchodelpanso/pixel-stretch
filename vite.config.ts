import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  worker: {
    format: 'iife',
  },
  optimizeDeps: {
    exclude: ['@huggingface/transformers'],
  },
  // Allow importing .glsl files as raw strings
  assetsInclude: ['**/*.glsl'],
})
