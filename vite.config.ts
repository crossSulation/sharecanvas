import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // Tauri WebView 会把页面 origin 改写为 tauri.localhost，HMR 需要显式指定可访问的地址
  let hmrHost: string | undefined
  let hmrPort: number | undefined
  if (env.LOCAL_DATA_URL) {
    try {
      const u = new URL(env.LOCAL_DATA_URL)
      hmrHost = u.hostname
      hmrPort = u.port ? Number(u.port) : undefined
    } catch {
      /* LOCAL_DATA_URL 格式不合法时忽略 */
    }
  }

  return {
    envPrefix: ['VITE_', 'LOCAL_DATA_'],
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico'],
      manifest: {
        name: '共享画布 · ShareCanvas',
        short_name: 'ShareCanvas',
        description: '基于画布的共享创作涂鸦：2D 涂鸦 + 3D 草稿 + 好友实时协作',
        theme_color: '#18181b',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
        runtimeCaching: [
          {
            urlPattern: /^https?:\/\/.*\/api\/.*/i,
            handler: 'NetworkFirst',
            options: { cacheName: 'api-cache', expiration: { maxEntries: 50, maxAgeSeconds: 300 } },
          },
        ],
      },
      }),
    ],
    server: {
      host: '0.0.0.0',
      port: 5173,
      hmr: hmrHost ? { host: hmrHost, port: hmrPort ?? 5173 } : undefined,
      proxy: {
        '/api': 'http://localhost:8787',
        '/ws': { target: 'ws://localhost:8787', ws: true },
      },
    },
    optimizeDeps: {
      exclude: ['@tauri-apps/api'],
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
      chunkSizeWarningLimit: 1200,
      rollupOptions: {
        output: {
          manualChunks: {
            three: ['three', '@react-three/fiber', '@react-three/drei'],
            react: ['react', 'react-dom', 'zustand'],
          },
        },
      },
    },
    test: {
      environment: 'happy-dom',
      include: ['src/**/*.test.ts'],
    },
  }
})
