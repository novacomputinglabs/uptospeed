const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('gantt shows weekday fill with weekend gaps + live drag range tooltip', async () => {
  const css = await readFile(path.join(__dirname, '..', 'styles.css'), 'utf8');
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');

  assert.ok(css.includes('.gantt-drag-tooltip'), 'Expected CSS for a custom gantt drag tooltip.');

  assert.ok(
    /var\(--bar-fill[\s\S]*calc\(var\(--gantt-cell-width[\s\S]*color-mix\(in srgb,\s*var\(--bar-fill[\s\S]*transparent\)/.test(css),
    'Expected gantt bars to render with weekend gaps via transparent weekend segments.',
  );

  assert.ok(
    /function handleGanttDrag[\s\S]*updateGanttDragTooltip/.test(appJs),
    'Expected fullscreen gantt drag to update the live range tooltip while dragging.',
  );

  assert.ok(
    /function handleListGanttDrag[\s\S]*updateGanttDragTooltip/.test(appJs),
    'Expected list gantt drag to update the live range tooltip while dragging.',
  );
});
