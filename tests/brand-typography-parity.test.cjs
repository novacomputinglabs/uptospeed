const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const FONT_IMPORT_URL = 'https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&family=Syne:wght@700;800&display=swap';

const read = (relativePath) => readFile(path.join(ROOT, relativePath), 'utf8');

test('app and landing pages share the same brand font import URL', async () => {
  const htmlFiles = [
    'index.html',
    'desktop/ui/bootstrap.html',
    'landing/index.html',
    'landing/getting-started.html',
    'landing/server-config.html',
  ];

  for (const file of htmlFiles) {
    const html = await read(file);
    assert.ok(
      html.includes(FONT_IMPORT_URL),
      `Expected ${file} to include the shared brand font import URL.`,
    );
  }
});

test('app stylesheet uses brand font tokens with no raw system mono stack', async () => {
  const css = await read('styles.css');

  assert.ok(
    css.includes("font-family: var(--brand-font-body"),
    'Expected app typography to use --brand-font-body for primary text.',
  );

  assert.ok(
    css.includes("font-family: var(--brand-font-display"),
    'Expected app typography to use --brand-font-display for display text.',
  );

  assert.ok(
    css.includes("font-family: var(--brand-font-mono"),
    'Expected app typography to use --brand-font-mono for mono text.',
  );

  assert.equal(
    /font-family:\s*ui-monospace/.test(css),
    false,
    'Expected no raw ui-monospace stack in styles.css.',
  );
});

test('rounds report export uses brand typography stacks', async () => {
  const appJs = await read('app.js');

  assert.ok(
    appJs.includes(FONT_IMPORT_URL),
    'Expected rounds report export HTML to include the shared brand font import URL.',
  );

  assert.ok(
    appJs.includes("--report-font-body:'Instrument Sans'"),
    'Expected rounds report export to define a brand body font stack.',
  );

  assert.ok(
    appJs.includes("--report-font-display:'Syne'"),
    'Expected rounds report export to define a brand display font stack.',
  );

  assert.ok(
    appJs.includes("--report-font-mono:'JetBrains Mono'"),
    'Expected rounds report export to define a brand mono font stack.',
  );
});
