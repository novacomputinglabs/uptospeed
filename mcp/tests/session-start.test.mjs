import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { createBrowserSession, REQUIRED_API_METHODS } from '../src/session/browser-session.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

test('browser session starts and exposes ShotgridKanbanAPI', async () => {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'uts-mcp-profile-'));
  let session;

  try {
    session = await createBrowserSession({
      headless: true,
      profileDir,
      repoRoot: REPO_ROOT,
      navTimeoutMs: 45000
    });

    const availability = await session.page.evaluate((methods) => {
      const api = globalThis.ShotgridKanbanAPI;
      if (!api) return false;
      return methods.every((name) => typeof api[name] === 'function');
    }, REQUIRED_API_METHODS);

    assert.equal(availability, true);
    assert.match(session.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/index\.html$/);
  } finally {
    if (session) await session.close();
    await rm(profileDir, { recursive: true, force: true });
  }
});
