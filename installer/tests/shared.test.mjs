import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  APP_NAME,
  defaultInstallPlan,
  installerHelpText,
  parseInstallerArgs,
  pickDesktopZipAsset,
  releaseApiUrl,
} from '../src/shared.mjs';

test('parseInstallerArgs defaults to install latest release', () => {
  const parsed = parseInstallerArgs([]);
  assert.equal(parsed.command, 'install');
  assert.equal(parsed.tag, 'latest');
  assert.equal(parsed.launch, true);
});

test('parseInstallerArgs supports repo, tag, dir, and no-launch', () => {
  const parsed = parseInstallerArgs([
    'install',
    '--repo',
    'owner/repo',
    '--tag',
    'desktop-v1.2.3',
    '--dir',
    '/tmp/uptospeed',
    '--no-launch',
  ]);
  assert.equal(parsed.repo, 'owner/repo');
  assert.equal(parsed.tag, 'desktop-v1.2.3');
  assert.equal(parsed.installDir, '/tmp/uptospeed');
  assert.equal(parsed.launch, false);
});

test('pickDesktopZipAsset selects the matching platform zip', () => {
  const asset = pickDesktopZipAsset([
    { name: 'uptospeed-desktop-0.1.0-mac-arm64.zip' },
    { name: 'uptospeed-desktop-0.1.0-win-x64.zip' },
  ], {
    platform: 'darwin',
    arch: 'arm64',
  });
  assert.equal(asset.name, 'uptospeed-desktop-0.1.0-mac-arm64.zip');
});

test('releaseApiUrl handles latest and tagged releases', () => {
  assert.equal(
    releaseApiUrl('novacomputinglabs/uptospeed', 'latest'),
    'https://api.github.com/repos/novacomputinglabs/uptospeed/releases/latest',
  );
  assert.equal(
    releaseApiUrl('novacomputinglabs/uptospeed', 'desktop-v0.1.0'),
    'https://api.github.com/repos/novacomputinglabs/uptospeed/releases/tags/desktop-v0.1.0',
  );
});

test('defaultInstallPlan returns platform-specific install targets', () => {
  const macPlan = defaultInstallPlan({ platform: 'darwin', homeDir: '/Users/tester' });
  assert.equal(macPlan.installPath, `/Users/tester/Applications/${APP_NAME}.app`);

  const windowsPlan = defaultInstallPlan({
    platform: 'win32',
    homeDir: 'C:\\Users\\tester',
    env: { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' },
  });
  assert.equal(windowsPlan.installPath, path.join('C:\\Users\\tester\\AppData\\Local', 'Programs', APP_NAME));

  const linuxPlan = defaultInstallPlan({ platform: 'linux', homeDir: '/home/tester' });
  assert.equal(linuxPlan.installPath, '/home/tester/.local/opt/uptospeed');
  assert.equal(linuxPlan.symlinkPath, '/home/tester/.local/bin/uptospeed-desktop');
});

test('installerHelpText advertises the installed binary command', () => {
  assert.match(installerHelpText(), /^UP TO SPEED desktop installer[\s\S]*uptospeed-desktop-installer/m);
});
