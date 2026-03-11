#!/usr/bin/env bun

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  APP_NAME,
  defaultInstallPlan,
  installerHelpText,
  parseInstallerArgs,
  pickDesktopZipAsset,
  releaseApiUrl,
} from '../src/shared.mjs';

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...(options.env || {}),
      },
      stdio: options.stdio || 'inherit',
      detached: options.detached === true,
      shell: options.shell === true,
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code}`));
    });
    if (options.detached === true) {
      child.unref();
    }
  });
}

function quotePowerShell(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

async function ensureCommand(command) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    await run(probe, [command], { stdio: 'ignore' });
    return true;
  } catch (_error) {
    return false;
  }
}

async function fetchReleaseJson(repo, tag) {
  const githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  const response = await fetch(releaseApiUrl(repo, tag), {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': '@uptospeed/desktop-installer',
      ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub release lookup failed (${response.status}): ${body}`);
  }
  return await response.json();
}

async function downloadAsset(asset, destinationPath) {
  const githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  const downloadUrl = githubToken && asset?.url
    ? String(asset.url)
    : String(asset?.browser_download_url || '');
  const response = await fetch(downloadUrl, {
    headers: {
      Accept: 'application/octet-stream',
      'User-Agent': '@uptospeed/desktop-installer',
      ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
    },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Asset download failed (${response.status}) for ${downloadUrl}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destinationPath));
}

async function extractZip(zipPath, destinationDir) {
  if (process.platform === 'darwin') {
    await run('ditto', ['-x', '-k', zipPath, destinationDir]);
    return;
  }

  if (process.platform === 'win32') {
    const command = `Expand-Archive -LiteralPath ${quotePowerShell(zipPath)} -DestinationPath ${quotePowerShell(destinationDir)} -Force`;
    await run('powershell', ['-NoProfile', '-Command', command]);
    return;
  }

  if (await ensureCommand('unzip')) {
    await run('unzip', ['-oq', zipPath, '-d', destinationDir]);
    return;
  }

  if (await ensureCommand('python3')) {
    await run('python3', ['-m', 'zipfile', '-e', zipPath, destinationDir]);
    return;
  }

  throw new Error('Could not extract zip archive. Install `unzip` or `python3`, then rerun the installer.');
}

async function findMacAppBundle(extractDir) {
  const entries = await readdir(extractDir, { withFileTypes: true });
  const match = entries.find((entry) => entry.isDirectory() && entry.name.endsWith('.app'));
  if (!match) {
    throw new Error(`No .app bundle found in ${extractDir}`);
  }
  return path.join(extractDir, match.name);
}

async function resolvePortableSourceDir(extractDir) {
  const entries = (await readdir(extractDir, { withFileTypes: true }))
    .filter((entry) => !entry.name.startsWith('.'));
  if (entries.length === 1 && entries[0].isDirectory()) {
    return path.join(extractDir, entries[0].name);
  }
  return extractDir;
}

async function ensureLinuxShortcuts(plan) {
  if (process.platform !== 'linux') return;
  if (plan.desktopEntryPath) {
    await mkdir(path.dirname(plan.desktopEntryPath), { recursive: true });
    const desktopEntry = [
      '[Desktop Entry]',
      'Type=Application',
      `Name=${APP_NAME}`,
      `Exec=${plan.executablePath}`,
      'Terminal=false',
      'Categories=Office;',
    ].join('\n');
    await writeFile(plan.desktopEntryPath, `${desktopEntry}\n`, 'utf8');
  }
  if (plan.symlinkPath) {
    await mkdir(path.dirname(plan.symlinkPath), { recursive: true });
    await rm(plan.symlinkPath, { force: true });
    await symlink(plan.executablePath, plan.symlinkPath);
  }
}

async function launchInstalledApp(plan) {
  if (process.platform === 'darwin') {
    await run('open', ['-a', plan.launchTarget]);
    return;
  }

  if (process.platform === 'win32') {
    const command = `Start-Process -FilePath ${quotePowerShell(plan.launchTarget)}`;
    await run('powershell', ['-NoProfile', '-Command', command]);
    return;
  }

  const child = spawn(plan.launchTarget, [], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

async function installDesktop(options) {
  const release = await fetchReleaseJson(options.repo, options.tag);
  const asset = pickDesktopZipAsset(release.assets, {
    platform: process.platform,
    arch: process.arch,
  });

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'uptospeed-installer-'));
  const zipPath = path.join(tempDir, asset.name);
  const extractDir = path.join(tempDir, 'extract');
  await mkdir(extractDir, { recursive: true });

  log(`Downloading ${asset.name} from ${options.repo}...`);
  await downloadAsset(asset, zipPath);
  log('Extracting desktop bundle...');
  await extractZip(zipPath, extractDir);

  const plan = options.installDir
    ? {
        ...defaultInstallPlan(),
        installPath: path.resolve(options.installDir),
        launchTarget: process.platform === 'darwin'
          ? path.resolve(options.installDir)
          : path.join(path.resolve(options.installDir), process.platform === 'win32' ? `${APP_NAME}.exe` : APP_NAME),
        executablePath: process.platform === 'darwin'
          ? path.resolve(options.installDir)
          : path.join(path.resolve(options.installDir), process.platform === 'win32' ? `${APP_NAME}.exe` : APP_NAME),
      }
    : defaultInstallPlan();

  const sourcePath = process.platform === 'darwin'
    ? await findMacAppBundle(extractDir)
    : await resolvePortableSourceDir(extractDir);

  await mkdir(path.dirname(plan.installPath), { recursive: true });
  await rm(plan.installPath, { recursive: true, force: true });
  if (process.platform === 'darwin') {
    await run('ditto', [sourcePath, plan.installPath]);
  } else {
    await cp(sourcePath, plan.installPath, { recursive: true });
  }
  await ensureLinuxShortcuts(plan);

  log(`Installed ${APP_NAME} to ${plan.installPath}`);
  if (options.launch) {
    log('Launching app...');
    await launchInstalledApp(plan);
  } else {
    log('Launch skipped (--no-launch).');
  }

  await rm(tempDir, { recursive: true, force: true });
  return {
    releaseTag: release.tag_name || options.tag,
    assetName: asset.name,
    installPath: plan.installPath,
  };
}

async function main() {
  const options = parseInstallerArgs(process.argv.slice(2));
  if (options.help) {
    log(installerHelpText());
    return;
  }
  if (options.command !== 'install') {
    fail(`Unsupported command: ${options.command}`);
    return;
  }
  const result = await installDesktop(options);
  log(`Installed release ${result.releaseTag} from asset ${result.assetName}.`);
}

main().catch((error) => {
  fail(`[uptospeed-installer] ${error?.stack || error}`);
});
