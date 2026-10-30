import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { munMacro } from '@mun-ui/ui/vite'

export default defineConfig({
  plugins: [
    munMacro(),
    react(),
  ],
})
