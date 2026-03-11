const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('ShotGrid server exposes task notes GET/POST/DELETE endpoints', async () => {
  const serverPy = await readFile(path.join(__dirname, '..', 'server', 'shotgrid_server.py'), 'utf8');

  assert.ok(serverPy.includes('if parsed.path == "/api/shotgrid/task-notes":'), 'Expected /api/shotgrid/task-notes route handling.');
  assert.ok(serverPy.includes('def _sg_task_notes_threads'), 'Expected task notes thread fetch helper.');
  assert.ok(serverPy.includes('def _sg_note_record_linked_to_task'), 'Expected strict task-link filter helper for notes.');
  assert.ok(serverPy.includes('def _sg_note_belongs_to_task'), 'Expected note-to-task enforcement helper.');
  assert.ok(serverPy.includes('def _sg_task_has_note'), 'Expected helper that validates note belongs to task before reply create.');
  assert.ok(serverPy.includes('def _sg_fetch_task_note_context'), 'Expected task context helper for note_links + tasks create shape.');
  assert.ok(serverPy.includes('["tasks", "in", rel_filter]'), 'Expected tasks multi-entity filter to use "in" operator.');
  assert.ok(serverPy.includes('def _sg_create_note_for_task'), 'Expected note create helper.');
  assert.ok(serverPy.includes('def _sg_create_reply_for_note'), 'Expected reply create helper.');
  assert.ok(serverPy.includes('def _sg_delete_entity'), 'Expected note/reply delete helper.');
  assert.ok(serverPy.includes('reply_to_note_id must reference a note linked to task_id'), 'Expected reply-to-note linkage validation error.');

  assert.ok(serverPy.includes('def do_DELETE(self):'), 'Expected DELETE method handler on HTTP server.');
  assert.ok(serverPy.includes('Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS"'), 'Expected CORS DELETE allowance.');
});
