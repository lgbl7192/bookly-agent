import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/bookly-agent/',
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
})
