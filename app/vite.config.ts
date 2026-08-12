import { spawn, type ChildProcess } from 'node:child_process'
import { builtinModules } from 'node:module'
import { resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import { defineConfig, type Plugin } from 'vite'

const electronExternals = ['electron', ...builtinModules, ...builtinModules.map((name) => `node:${name}`)]

function launchElectron(): Plugin {
  let child: ChildProcess | null = null

  return {
    name: 'ddf-launch-electron',
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        const address = server.httpServer?.address() as AddressInfo | null
        if (address === null) return

        const electronBinary = resolve('node_modules/.bin/electron')
        child = spawn(electronBinary, [resolve('dist/main.js')], {
          env: {
            ...process.env,
            VITE_DEV_SERVER_URL: `http://127.0.0.1:${address.port}`,
          },
          stdio: 'inherit',
        })
      })
      server.httpServer?.once('close', () => child?.kill())
    },
  }
}

export default defineConfig(({ mode }) => {
  if (mode === 'electron-main') {
    return {
      build: {
        emptyOutDir: false,
        lib: {
          entry: resolve('electron/main.ts'),
          formats: ['es'],
          fileName: () => 'main.js',
        },
        outDir: 'dist',
        rollupOptions: { external: electronExternals },
      },
    }
  }

  if (mode === 'electron-preload') {
    return {
      build: {
        emptyOutDir: false,
        lib: {
          entry: resolve('electron/preload.ts'),
          formats: ['cjs'],
          fileName: () => 'preload.cjs',
        },
        outDir: 'dist',
        rollupOptions: { external: electronExternals },
      },
    }
  }

  return {
    plugins: [launchElectron()],
    server: {
      fs: {
        allow: ['..'],
      },
    },
  }
})
