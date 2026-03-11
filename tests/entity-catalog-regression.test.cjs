const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('app persists and exposes entity catalog APIs', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');

  assert.match(appJs, /ENTITY_CATALOG:\s*'vfx_kanban_entity_catalog'/, 'Expected entity catalog storage key.');
  assert.match(appJs, /registerEntities:\s*\(entries\)\s*=>\s*\{/, 'Expected ShotgridKanbanAPI.registerEntities method.');
  assert.match(
    appJs,
    /getEntityCatalog:\s*\(\)\s*=>\s*(\{|JSON\.parse\(JSON\.stringify\(ensureEntityCatalogState\(\)\)\))/,
    'Expected ShotgridKanbanAPI.getEntityCatalog method.',
  );
  assert.match(appJs, /function\s+getAllAssetNames\(/, 'Expected merged asset helper for selectors.');
});
