import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,             // allow all hosts locally
    port: 5173,             // optional, default Vite dev port
  },
  preview: {
    host: true,             // allow dynamic BTP URL
    port: process.env.PORT || 5173,  // use BTP-assigned port
  },
});
