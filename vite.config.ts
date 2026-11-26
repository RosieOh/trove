import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'shared'),
    },
  },
  plugins: [
    electron({
      main: {
        // The two workers are separate entries: they are loaded by path at runtime
        // (new Worker(.../indexWorker.cjs)), not imported. mcpServer.cjs is run on its
        // own by Claude Code (`node`, or the app binary with ELECTRON_RUN_AS_NODE=1).
        entry: ['electron/main.ts', 'electron/indexWorker.ts', 'electron/queryWorker.ts', 'electron/mcpServer.ts'],
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['electron', 'better-sqlite3'],
              // Emit CommonJS (.cjs): Electron loads the native CJS modules
              // (electron, better-sqlite3) reliably from a CJS main; the ESM
              // loader otherwise crashes preparsing those imports.
              output: { format: 'cjs', entryFileNames: '[name].cjs', chunkFileNames: '[name]-[hash].cjs' },
            },
          },
        },
      },
      preload: {
        input: 'electron/preload.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['electron'],
              output: { format: 'cjs', entryFileNames: '[name].cjs' },
            },
          },
        },
      },
    }),
    react(),
  ],
  root: '.',
  build: {
    outDir: 'dist',
  },
})
