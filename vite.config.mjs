import path from 'path'
import { defineConfig, loadEnv } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '')
  const cacheDir = path.resolve('.vite_cache')
  return {
    cacheDir: cacheDir,
    server: {
      port: 8080,
      host: '0.0.0.0',
      strictPort: true,
      watch: {
        ignored: ['**/browser-profiles/**', '**/.profiles/**', '**/pup-server-portable/**', '**/dist-pup/**', '**/server/**', '**/scripts/**', '**/ops/**', '**/ssh-keys/**']
      }
    },
    preview: {
      port: 4173,
      strictPort: true
    },
    esbuild: {
      tsconfigRaw: {
        compilerOptions: {
          jsx: 'react-jsx'
        }
      }
    },
    plugins: [react(), tailwindcss()],
    optimizeDeps: {
      include: ['void-elements']
    },
    worker: {
      format: 'es',
      plugins: () => [react()]
    },
    build: {
      emptyOutDir: true,
      sourcemap: false,
      minify: 'esbuild',
      cssMinify: 'esbuild',
      rollupOptions: {
        cache: false,
        maxParallelFileOps: 10,
        // 🆕 多页面入口：主应用之外还有两个独立页
        //    · /tempmail   → 临时邮箱（免登录）
        //    · /adpublish  → 智能广告发布平台（免登录）
        input: {
          main: path.resolve('.', 'index.html'),
          tempmail: path.resolve('.', 'tempmail.html'),
          adpublish: path.resolve('.', 'adpublish.html'),
        },
        output: {
          manualChunks: (id) => {
            if (id.includes('node_modules')) {
              return 'vendor';
            }
          }
        }
      }
    },
    define: {
      'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      'process.env.LAUNCH_SERVER_URL': JSON.stringify(env.LAUNCH_SERVER_URL || ''),
      'process.env.STORAGE_SERVER_URL': JSON.stringify(''), // 浏览器端始终为空，用 VITE_STORAGE_SERVER_URL
      'process.env.NAV_PROXY_TARGET': JSON.stringify(env.NAV_PROXY_TARGET || '')
    },
    resolve: {
      alias: {
        '@': path.resolve('.', '.')
      }
    }
  }
})
