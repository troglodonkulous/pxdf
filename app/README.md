# PXDF Electron sender shell

This app renders a diagnostic frame in Electron and streams raw RGB frames to the existing `mapper` Python sidecar.

## Development

From `app/`:

```sh
npm install
npm run dev
```

Development binds Vite to localhost and defaults the sidecar destination to `127.0.0.1`. Production-mode Electron defaults to `255.255.255.255`.

## Commands

```sh
npm run typecheck
npm test
npm run build
```

The build writes the renderer and Electron main/preload output to `dist/`.

## Sidecar environment

- `PXDF_ADDRESS`: destination address
- `PXDF_PORT`: destination port (default `60001`)
- `PXDF_LOCAL_IP`: optional local interface address
- `PXDF_PYTHON`: Python executable (default `python3`)
