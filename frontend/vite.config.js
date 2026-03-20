import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Replace this with your actual BTP app host
const BTP_APP_HOST = "hcl-america-solutions-inc--hclbuild-g03o2ijo-dev-transp4083dd13.cfapps.eu10-004.hana.ondemand.com";

export default defineConfig({
  plugins: [react()],
  server: {
    host: BTP_APP_HOST,       // directly bind to your BTP URL
    port: 5173,
  },
  preview: {
    host: BTP_APP_HOST,       // preview also uses your BTP URL
    port: process.env.PORT || 5173,
  },
});
