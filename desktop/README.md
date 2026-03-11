# UP TO SPEED Desktop

Electron desktop shell for the existing UP TO SPEED localhost runtime.

## Development

Install dependencies:

```bash
cd desktop
npm install
```

Start the desktop shell in development mode:

```bash
cd desktop
npm start
```

The desktop app launches:

- the existing Python backend on `http://127.0.0.1:<port>/`
- the agent gateway as a child Node process using Electron's bundled runtime
- MCP in CDP-only mode against the Electron window

## Build the packaged backend

```bash
cd desktop
npm run build:python
```

That writes the PyInstaller single-file backend into `desktop/resources/backend/`, which is then bundled by `electron-builder` and signed as a standalone nested binary on macOS.

## Website install command

After publishing the installer package from `installer/package.json`, the website install command is:

```bash
bunx --bun uptospeed-desktop-installer
```

That downloads the latest GitHub desktop release for the current OS and installs it locally.

## Package installers

```bash
cd desktop
npm run dist
```

For notarized macOS release builds in CI, configure these GitHub Actions secrets:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

## Desktop runtime env contract

- `UTS_APP_ROOT`: read-only static app assets served by the Python backend
- `UTS_DATA_DIR`: writable runtime data directory for broker DB, cache, and managed key
- `UTS_CONFIG_DIR`: optional config directory for `.env.local` / `.env`; defaults to `UTS_DATA_DIR`
- `HOST`, `PORT`: backend bind host and port
- `UTS_AGENT_GATEWAY_PORT`: local agent gateway port
- `UTS_MCP_SESSION_MODE=cdp`
- `UTS_MCP_REQUIRE_CDP=1`
- `UTS_MCP_CDP_URL`
- `UTS_MCP_BASE_URL`
- `UTS_MCP_PROFILE_DIR`
