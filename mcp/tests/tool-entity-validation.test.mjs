import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolHandlers } from '../src/server.mjs';

test('entity create validation blocks invalid shot and artist payloads before write', async () => {
  let createShotCalls = 0;
  let createArtistCalls = 0;

  const handlers = createToolHandlers({
    createShot: async () => {
      createShotCalls += 1;
      return { success: true };
    },
    createArtist: async () => {
      createArtistCalls += 1;
      return { success: true };
    }
  });

  const invalidShot = await handlers.uts_create_shot({
    name: 'Shot010',
    confirm: true
  });
  assert.equal(invalidShot.ok, false);
  assert.match(invalidShot.summary, /sequenceName or sequenceId/i);

  const invalidArtist = await handlers.uts_create_artist({
    firstName: 'Ada',
    lastName: 'Lovelace',
    login: 'ada',
    email: '',
    confirm: true
  });
  assert.equal(invalidArtist.ok, false);
  assert.match(invalidArtist.summary, /artist email is required/i);

  assert.equal(createShotCalls, 0);
  assert.equal(createArtistCalls, 0);
});

test('entity create preview normalizes payload shape', async () => {
  const handlers = createToolHandlers({
    createSequence: async () => ({ success: true })
  });

  const preview = await handlers.uts_create_sequence({
    name: 'Seq010',
    confirm: false
  });

  assert.equal(preview.ok, true);
  assert.equal(preview.preview, true);
  assert.equal(preview.data.entityType, 'sequence');
  assert.equal(preview.data.ifExists, 'return_existing');
  assert.equal(preview.data.entity.name, 'Seq010');
  assert.equal(preview.data.entity.code, 'Seq010');
});
