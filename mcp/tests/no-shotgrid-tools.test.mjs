import test from 'node:test';
import assert from 'node:assert/strict';
import { MCP_TOOL_DEFINITIONS } from '../src/server.mjs';

const EXPECTED_TOOL_NAMES = [
  'uts_get_state',
  'uts_get_stats',
  'uts_get_tasks',
  'uts_get_task',
  'uts_get_filtered_tasks',
  'uts_get_endeavors',
  'uts_get_endeavor_tasks',
  'uts_get_workload_snapshot',
  'uts_set_filters',
  'uts_clear_filters',
  'uts_update_task',
  'uts_bulk_update_tasks',
  'uts_auto_balance_workload',
  'uts_create_task',
  'uts_create_asset',
  'uts_create_sequence',
  'uts_create_shot',
  'uts_create_artist',
  'uts_create_department',
  'uts_delete_task',
  'uts_create_endeavor',
  'uts_update_endeavor',
  'uts_delete_endeavor',
  'uts_add_tasks_to_endeavor',
  'uts_remove_tasks_from_endeavor',
  'uts_clear_endeavor',
  'uts_undo',
  'uts_redo'
];

test('tool manifest is limited to local board tools and excludes ShotGrid network ops', () => {
  const names = MCP_TOOL_DEFINITIONS.map((tool) => tool.name);
  assert.deepEqual(names, EXPECTED_TOOL_NAMES);

  for (const name of names) {
    assert.equal(/shotgrid|sg_|sync|push|auth|login|logout|project/i.test(name), false);
  }
});
