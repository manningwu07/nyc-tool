import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['network.json'],
      workbox: {
        // the whole app must work with zero signal: precache everything,
        // including the ~1.5MB network.json
        globPatterns: ['**/*.{js,css,html,json,png,svg,woff2}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
      manifest: {
        name: 'NYC Subway Speedrun Planner',
        short_name: 'Speedrun',
        display: 'standalone',
        background_color: '#0b0e14',
        theme_color: '#0b0e14',
        icons: [],
      },
    }),
  ],
});
