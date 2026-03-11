import { spawn } from 'node:child_process';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DESKTOP_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(DESKTOP_ROOT, '..');
const BACKEND_SOURCE = path.join(REPO_ROOT, 'server', 'shotgrid_server.py');
const DIST_ROOT = path.join(DESKTOP_ROOT, 'dist');
const PYINSTALLER_WORK = path.join(DIST_ROOT, 'pyinstaller-work');
const PYINSTALLER_DIST = path.join(DIST_ROOT, 'pyinstaller-dist');
const RESOURCE_BACKEND_DIR = path.join(DESKTOP_ROOT, 'resources', 'backend');
const PYTHON_COMMAND = process.platform === 'win32' ? 'python' : 'python3';

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...(options.env || {}),
      },
      stdio: 'inherit',
    });
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code}`));
    });
    child.once('error', reject);
  });
}

async function main() {
  await rm(PYINSTALLER_WORK, { recursive: true, force: true });
  await rm(PYINSTALLER_DIST, { recursive: true, force: true });
  await rm(RESOURCE_BACKEND_DIR, { recursive: true, force: true });
  await mkdir(path.dirname(RESOURCE_BACKEND_DIR), { recursive: true });

  await run(PYTHON_COMMAND, ['-m', 'pip', 'install', '-r', path.join(REPO_ROOT, 'server', 'requirements.txt'), 'pyinstaller']);
  await run(PYTHON_COMMAND, [
    '-m',
    'PyInstaller',
    '--noconfirm',
    '--clean',
    '--onefile',
    '--name',
    'shotgrid_server',
    '--hidden-import',
    'sqlcipher3',
    '--distpath',
    PYINSTALLER_DIST,
    '--workpath',
    PYINSTALLER_WORK,
    BACKEND_SOURCE,
  ]);

  await mkdir(RESOURCE_BACKEND_DIR, { recursive: true });
  const backendArtifactName = process.platform === 'win32' ? 'shotgrid_server.exe' : 'shotgrid_server';
  await copyFile(
    path.join(PYINSTALLER_DIST, backendArtifactName),
    path.join(RESOURCE_BACKEND_DIR, backendArtifactName),
  );
}

main().catch((error) => {
  console.error(`[desktop-build-python] ${error?.stack || error}`);
  process.exit(1);
});
