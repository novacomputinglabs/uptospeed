# UP TO SPEED Desktop Installer

Publish this package to npm to expose a one-command desktop installer for the latest GitHub release.

Website command:

```bash
bunx --bun uptospeed-desktop-installer
```

That command:

- downloads the installer package itself from the npm registry
- resolves the latest GitHub release from the configured release repo
- downloads the matching desktop zip for the current OS and CPU architecture
- installs it into a user-writable location
- launches the app

It does not clone or download the GitHub repository source tree. The only GitHub fetch is the packaged desktop release asset.

By default the installer reads the release repo from `UPTOSPEED_RELEASE_REPO`. If you omit it, the package falls back to the repo baked into `installer/src/shared.mjs`.

## Local development

Run the installer directly from the repo:

```bash
bun run ./installer/bin/uptospeed.mjs --help
```

Run tests:

```bash
cd installer
npm test
```

## Publish

```bash
cd installer
npm publish --access public
```

## CI publish

This repo includes a publish workflow at `.github/workflows/publish-installer.yml`.

Required secret:

- `NPM_TOKEN`

Release flow:

1. Bump the version in `installer/package.json`.
2. Push a tag like `installer-v0.1.0`.
3. GitHub Actions publishes the installer package to npm.
