import { spawn, type ChildProcess } from 'node:child_process'
import { builtinModules } from 'node:module'
import { resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import { defineConfig, type Plugin } from 'vite'
// @ts-expect-error -- a plain .mjs script, shared with `npm run dist`'s release gate
import { readBuild } from './scripts/releaseTree.mjs'

const electronExternals = ['electron', ...builtinModules, ...builtinModules.map((name) => `node:${name}`)]

function launchElectron(): Plugin {
  let child: ChildProcess | null = null

  return {
    name: 'pxdf-launch-electron',
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
      // What code this bundle was built from, printed on the launch line. See
      // `scripts/releaseTree.mjs` for why, and for what `-dirty` and `unknown` mean.
      define: { __PXDF_BUILD__: JSON.stringify(readBuild().buildString) },
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
    // Relative asset URLs, because the packaged app is loaded with `loadFile`
    // and therefore over `file://`. Vite's default of `/assets/...` resolves
    // against the filesystem root there, every asset 404s, and the window comes
    // up blank with an empty `#root` — no error dialog, no console the operator
    // would ever see. `npm run dev` cannot show this: the dev server is loaded
    // over `http://` with `loadURL`, where an absolute path is correct. The
    // production page had never been opened until the wire gate opened it.
    base: './',
    plugins: [launchElectron()],
    server: {
      fs: {
        allow: ['..'],
      },
    },
  }
})
