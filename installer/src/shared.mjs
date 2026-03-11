import os from 'node:os';
import path from 'node:path';

export const APP_NAME = 'UP TO SPEED';
export const INSTALLER_PACKAGE_NAME = 'uptospeed-desktop-installer';
export const DEFAULT_GITHUB_REPO = process.env.UPTOSPEED_RELEASE_REPO || 'uptospeedhq/uptospeed';
export const DEFAULT_RELEASE_TAG = 'latest';
export const DESKTOP_ARTIFACT_BASENAME = 'uptospeed-desktop';

export function normalizePlatform(platform = process.platform) {
  if (platform === 'darwin') return 'mac';
  if (platform === 'win32') return 'win';
  if (platform === 'linux') return 'linux';
  throw new Error(`Unsupported platform: ${platform}`);
}

export function normalizeArch(arch = process.arch) {
  if (arch === 'arm64' || arch === 'x64') return arch;
  throw new Error(`Unsupported architecture: ${arch}`);
}

export function releaseApiUrl(repo = DEFAULT_GITHUB_REPO, tag = DEFAULT_RELEASE_TAG) {
  const normalizedRepo = String(repo || '').trim();
  const normalizedTag = String(tag || '').trim() || DEFAULT_RELEASE_TAG;
  if (!normalizedRepo.includes('/')) {
    throw new Error(`GitHub repo must be in owner/name format. Received: ${normalizedRepo}`);
  }
  if (normalizedTag === 'latest') {
    return `https://api.github.com/repos/${normalizedRepo}/releases/latest`;
  }
  return `https://api.github.com/repos/${normalizedRepo}/releases/tags/${encodeURIComponent(normalizedTag)}`;
}

export function desktopZipAssetPattern(platform = process.platform, arch = process.arch) {
  const normalizedPlatform = normalizePlatform(platform);
  const normalizedArch = normalizeArch(arch);
  return new RegExp(`^${DESKTOP_ARTIFACT_BASENAME}-(.+)-${normalizedPlatform}-${normalizedArch}\\.zip$`, 'i');
}

export function pickDesktopZipAsset(assets, options = {}) {
  const list = Array.isArray(assets) ? assets : [];
  const pattern = desktopZipAssetPattern(options.platform, options.arch);
  const match = list.find((asset) => pattern.test(String(asset?.name || '')));
  if (match) return match;
  const available = list.map((asset) => String(asset?.name || '')).filter(Boolean);
  throw new Error(`No desktop zip asset matched ${pattern}. Available assets: ${available.join(', ') || 'none'}`);
}

export function defaultInstallPlan(options = {}) {
  const platform = options.platform || process.platform;
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;

  if (platform === 'darwin') {
    const installPath = path.join(homeDir, 'Applications', `${APP_NAME}.app`);
    return {
      platform,
      installPath,
      launchTarget: installPath,
      executablePath: installPath,
    };
  }

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
    const installPath = path.join(localAppData, 'Programs', APP_NAME);
    return {
      platform,
      installPath,
      launchTarget: path.join(installPath, `${APP_NAME}.exe`),
      executablePath: path.join(installPath, `${APP_NAME}.exe`),
    };
  }

  if (platform === 'linux') {
    const installPath = path.join(homeDir, '.local', 'opt', 'uptospeed');
    return {
      platform,
      installPath,
      launchTarget: path.join(installPath, APP_NAME),
      executablePath: path.join(installPath, APP_NAME),
      desktopEntryPath: path.join(homeDir, '.local', 'share', 'applications', 'uptospeed.desktop'),
      symlinkPath: path.join(homeDir, '.local', 'bin', 'uptospeed-desktop'),
    };
  }

  throw new Error(`Unsupported platform: ${platform}`);
}

export function parseInstallerArgs(argv = []) {
  const args = Array.from(argv);
  const options = {
    command: 'install',
    repo: DEFAULT_GITHUB_REPO,
    tag: DEFAULT_RELEASE_TAG,
    installDir: '',
    launch: true,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index] || '');
    if (!value) continue;

    if (value === 'install') {
      options.command = 'install';
      continue;
    }
    if (value === '--help' || value === '-h') {
      options.help = true;
      continue;
    }
    if (value === '--no-launch') {
      options.launch = false;
      continue;
    }
    if (value === '--repo') {
      const next = String(args[index + 1] || '').trim();
      if (!next) throw new Error('--repo requires an owner/name value');
      options.repo = next;
      index += 1;
      continue;
    }
    if (value === '--tag') {
      const next = String(args[index + 1] || '').trim();
      if (!next) throw new Error('--tag requires a release tag value');
      options.tag = next;
      index += 1;
      continue;
    }
    if (value === '--dir') {
      const next = String(args[index + 1] || '').trim();
      if (!next) throw new Error('--dir requires a destination path');
      options.installDir = next;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }

  return options;
}

export function installerHelpText() {
  return [
    `${APP_NAME} desktop installer`,
    '',
    'Usage:',
    `  bunx --bun ${INSTALLER_PACKAGE_NAME}`,
    `  bunx --bun ${INSTALLER_PACKAGE_NAME} install --tag desktop-v0.1.0 --no-launch`,
    '',
    'Options:',
    '  --repo owner/name  GitHub repository that hosts the desktop releases',
    '  --tag <tag>        Install a specific GitHub release tag instead of latest',
    '  --dir <path>       Override the default install location',
    '  --no-launch        Install without opening the app afterward',
    '  --help             Show this help message',
    '',
    'Environment:',
    `  UPTOSPEED_RELEASE_REPO  Default GitHub repo when --repo is omitted (current default: ${DEFAULT_GITHUB_REPO})`,
  ].join('\n');
}
