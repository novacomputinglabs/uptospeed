const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('server exposes agent hub endpoints and sqlite tables', async () => {
  const serverPy = await readFile(path.join(__dirname, '..', 'server', 'shotgrid_server.py'), 'utf8');

  assert.ok(serverPy.includes('if parsed.path.startswith("/api/agents/"):'), 'Expected /api/agents route handling.');
  assert.ok(serverPy.includes('if parsed.path == "/api/agents/health":'), 'Expected /api/agents/health endpoint.');
  assert.ok(serverPy.includes('if parsed.path == "/api/agents/config":'), 'Expected /api/agents/config endpoint.');
  assert.ok(serverPy.includes('if parsed.path == "/api/agents/catalog":'), 'Expected /api/agents/catalog endpoint.');
  assert.ok(serverPy.includes('if parsed.path == "/api/agents/connections":'), 'Expected /api/agents/connections endpoint.');
  assert.ok(serverPy.includes('if parsed.path in {"/api/agents/connections", "/api/agents/connections/test"}:'), 'Expected generic agent connection create/test endpoint.');
  assert.ok(serverPy.includes('if parsed.path == "/api/agents/provider-auth":'), 'Expected generic provider auth endpoint.');
  assert.ok(serverPy.includes('if parsed.path == "/api/agents/profiles":'), 'Expected /api/agents/profiles endpoint.');
  assert.ok(serverPy.includes('if parsed.path == "/api/agents/runs":'), 'Expected /api/agents/runs endpoint.');
  assert.ok(serverPy.includes('if parsed.path == "/api/agents/runs/cancel":'), 'Expected /api/agents/runs/cancel endpoint.');
  assert.ok(serverPy.includes('if parsed.path == "/api/agents/runs/resume":'), 'Expected /api/agents/runs/resume endpoint.');
  assert.ok(serverPy.includes('if parsed.path == "/api/agents/runs/retry":'), 'Expected /api/agents/runs/retry endpoint.');
  assert.ok(serverPy.includes('if parsed.path == "/api/agents/threads":'), 'Expected /api/agents/threads endpoint.');
  assert.ok(serverPy.includes('existing_thread_id = str(thread.get("id") or thread_id or "").strip() if isinstance(thread, dict) else str(thread_id or "").strip()'), 'Expected run creation to handle missing threads safely.');
  assert.ok(serverPy.includes('if parsed.path == "/api/agents/runs/stream":'), 'Expected run stream SSE endpoint.');
  assert.ok(serverPy.includes('"thread.snapshot"'), 'Expected run stream to emit thread snapshot backfill events.');
  assert.ok(serverPy.includes('"message.assistant.delta"'), 'Expected run stream to emit assistant draft updates.');
  assert.ok(serverPy.includes('"run.progress"'), 'Expected run stream to emit live runtime progress events.');
  assert.ok(serverPy.includes('if parsed.path == "/api/agents/actions":'), 'Expected /api/agents/actions endpoint.');
  assert.ok(serverPy.includes('if parsed.path == "/api/agents/actions/decision":'), 'Expected action decision endpoint.');
  assert.ok(serverPy.includes('if parsed.path == "/api/agents/tool-permissions":'), 'Expected tool permissions endpoint.');
  assert.ok(serverPy.includes('if parsed.path == "/api/agents/trust-rules":'), 'Expected trust rules list endpoint.');
  assert.ok(serverPy.includes('if parsed.path == "/api/agents/trust-rules/revoke":'), 'Expected trust rule revoke endpoint.');

  assert.ok(serverPy.includes('CREATE TABLE IF NOT EXISTS agent_profiles'), 'Expected agent_profiles table migration.');
  assert.ok(serverPy.includes('CREATE TABLE IF NOT EXISTS agent_connections'), 'Expected agent_connections table migration.');
  assert.ok(serverPy.includes('CREATE TABLE IF NOT EXISTS agent_threads'), 'Expected agent_threads table migration.');
  assert.ok(serverPy.includes('CREATE TABLE IF NOT EXISTS agent_messages'), 'Expected agent_messages table migration.');
  assert.ok(serverPy.includes('CREATE TABLE IF NOT EXISTS agent_runs'), 'Expected agent_runs table migration.');
  assert.ok(serverPy.includes('CREATE TABLE IF NOT EXISTS agent_actions'), 'Expected agent_actions table migration.');
  assert.ok(serverPy.includes('CREATE TABLE IF NOT EXISTS agent_trust_rules'), 'Expected agent_trust_rules table migration.');
  assert.ok(serverPy.includes("permission TEXT NOT NULL DEFAULT 'trust'"), 'Expected persisted tool permission mode.');
  assert.ok(serverPy.includes('CREATE TABLE IF NOT EXISTS agent_audit'), 'Expected agent_audit table migration.');
  assert.ok(serverPy.includes('provider_id TEXT'), 'Expected provider_id persistence columns.');
  assert.ok(serverPy.includes('model_ref TEXT'), 'Expected model_ref persistence columns.');
  assert.ok(serverPy.includes('agent_profile_id TEXT'), 'Expected agent_profile_id persistence columns.');
  assert.ok(serverPy.includes('heartbeat_at REAL'), 'Expected heartbeat_at persistence on runs.');
  assert.ok(serverPy.includes('lease_expires_at REAL'), 'Expected lease_expires_at persistence on runs.');
  assert.ok(serverPy.includes('cancel_requested_at REAL'), 'Expected cancel_requested_at persistence on runs.');
  assert.ok(serverPy.includes('interrupted_reason TEXT'), 'Expected interrupted_reason persistence on runs.');
  assert.ok(serverPy.includes('auth_profile_id TEXT'), 'Expected auth_profile_id persistence on runs.');
  assert.ok(serverPy.includes('def _agent_list_threads('), 'Expected thread list helper.');
  assert.ok(serverPy.includes('def _agent_list_messages('), 'Expected message list helper.');
  assert.ok(serverPy.includes('def _agent_compact_thread_payload('), 'Expected compact thread payload helper.');
  assert.ok(serverPy.includes('"launcher_command": _AGENT_RUNTIME_LAUNCHER_COMMAND'), 'Expected runtime health payload to expose the launcher command.');
  assert.ok(serverPy.includes('_agent_reconcile_stale_runs(repo_root)'), 'Expected stale runs to be reconciled on startup and health checks.');
});

test('server enforces trust policy constraints and retry handling', async () => {
  const serverPy = await readFile(path.join(__dirname, '..', 'server', 'shotgrid_server.py'), 'utf8');

  assert.ok(
    serverPy.includes('_AGENT_DESTRUCTIVE_TOOLS = {"uts_delete_task", "uts_clear_endeavor", "uts_delete_endeavor"}'),
    'Expected destructive tool blocklist.'
  );
  assert.ok(serverPy.includes('def _agent_set_tool_permission('), 'Expected tool permission persistence helper.');
  assert.ok(serverPy.includes('Trust is not allowed for destructive tools.'), 'Expected trust denial message for destructive actions.');
  assert.ok(serverPy.includes("permission_mode in {\"allow\", \"trust\"}"), 'Expected automatic apply path for remembered tool permissions.');
  assert.ok(serverPy.includes('is disallowed by agent permissions.'), 'Expected denied tool failure message.');
  assert.ok(serverPy.includes('if int(action.get("retry_count") or 0) < 1:'), 'Expected one-retry limit after disapproval.');
  assert.ok(serverPy.includes('_agent_recompute_run_status'), 'Expected run status recomputation after action decisions.');
  assert.ok(serverPy.includes('def _agent_build_run_context('), 'Expected run context builder with thread and tool history.');
  assert.ok(serverPy.includes('def _agent_preview_assistant_text('), 'Expected helper that extracts a streamed assistant preview from partial JSON.');
  assert.ok(serverPy.includes('def _agent_extract_partial_actions('), 'Expected helper that salvages complete action objects from partial JSON.');
  assert.ok(serverPy.includes('def _agent_structured_output_has_content('), 'Expected helper that detects salvageable structured provider output.');
  assert.ok(serverPy.includes('def _agent_append_run_failure_message('), 'Expected helper that persists visible run failures into the thread.');
  assert.ok(serverPy.includes('class _AgentRunCanceled(RuntimeError):'), 'Expected explicit cancellation error type.');
  assert.ok(serverPy.includes('def _agent_cancel_run('), 'Expected helper that records agent run cancellation requests.');
  assert.ok(serverPy.includes('def _agent_iter_sse_messages('), 'Expected SSE line parser helper for provider streaming.');
  assert.ok(serverPy.includes('def _agent_resume_run('), 'Expected run resume helper after manual approval.');
  assert.ok(serverPy.includes('_agent_supersede_pending_actions('), 'Expected stale pending actions cleanup before continuation.');
  assert.ok(serverPy.includes('context = _agent_build_run_context(repo_root, run)'), 'Expected run worker to rebuild planner context from persisted state.');
  assert.ok(serverPy.includes('on_output_delta=on_output_delta'), 'Expected provider adapters to receive a streaming callback.');
  assert.ok(serverPy.includes('on_progress_event=on_progress_event'), 'Expected provider adapters to receive a runtime progress callback.');
  assert.ok(serverPy.includes('should_cancel=should_cancel'), 'Expected provider adapters to receive a cancellation callback.');
  assert.ok(serverPy.includes('def _agent_truncate_text('), 'Expected helper to clip streamed command output for chat progress events.');
  assert.ok(serverPy.includes('_agent_resume_run(repo_root, run_id'), 'Expected action approvals to restart the run worker.');
  assert.ok(serverPy.includes('stable_structured_since = 0.0'), 'Expected Codex CLI runs to watch for stable last-message output.');
  assert.ok(serverPy.includes('return _structured_result_payload(structured_snapshot or stable_structured)'), 'Expected Codex CLI timeouts to salvage the last structured output.');
  assert.ok(serverPy.includes('timeout_s = 75'), 'Expected Codex CLI timeout default to leave room for staged write previews.');
  assert.ok(serverPy.includes('_agent_append_run_failure_message('), 'Expected failed runs to emit a persisted assistant error message.');
  assert.ok(serverPy.includes('"status": "interrupted"'), 'Expected stale or expired runs to transition to interrupted.');
  assert.ok(serverPy.includes('def _agent_interrupt_run('), 'Expected helper for lease-expired or interrupted runs.');
  assert.ok(serverPy.includes('def _agent_reconcile_stale_runs('), 'Expected stale-run reconciler.');
});

test('server scopes run and action listings to the active user and workspace', async () => {
  const serverPy = await readFile(path.join(__dirname, '..', 'server', 'shotgrid_server.py'), 'utf8');

  assert.ok(serverPy.includes('def _agent_list_runs('), 'Expected scoped run list helper.');
  assert.ok(serverPy.includes('def _agent_list_actions('), 'Expected scoped action list helper.');
  assert.ok(serverPy.includes('user_id = self._agent_request_user_id(query=query)'), 'Expected endpoints to resolve the active user scope.');
  assert.ok(serverPy.includes('project_scope = self._agent_request_project_scope(query=query)'), 'Expected endpoints to resolve the active project scope.');
  assert.ok(serverPy.includes('runs = _agent_list_runs(repo_root, user_id=user_id, project_scope=project_scope, limit=limit, offset=offset)'), 'Expected run listings to respect the active scope.');
  assert.ok(serverPy.includes('user_id=user_id,'), 'Expected action listings to pass through the active user scope.');
  assert.ok(serverPy.includes('project_scope=project_scope,'), 'Expected action listings to pass through the active project scope.');
});

test('run stream subscribes before sending the initial snapshot', async () => {
  const serverPy = await readFile(path.join(__dirname, '..', 'server', 'shotgrid_server.py'), 'utf8');
  const streamRouteStart = serverPy.indexOf('if parsed.path == "/api/agents/runs/stream":');
  assert.notEqual(streamRouteStart, -1, 'Expected run stream endpoint.');
  const subscriberIndex = serverPy.indexOf('subscriber = _agent_subscribe_run_stream(run_id)', streamRouteStart);
  const snapshotIndex = serverPy.indexOf('_sse_send(self, "run.status", _agent_compact_run_payload(run), event_id=f"run-{run_id}-snapshot")', streamRouteStart);
  assert.notEqual(subscriberIndex, -1, 'Expected run stream endpoint to subscribe to the run event queue.');
  assert.notEqual(snapshotIndex, -1, 'Expected run stream endpoint to send an initial run snapshot.');
  assert.ok(subscriberIndex < snapshotIndex, 'Expected run stream subscription to happen before the initial snapshot to avoid missing state transitions.');
});

test('server supports Codex OAuth verification without API key requirement', async () => {
  const serverPy = await readFile(path.join(__dirname, '..', 'server', 'shotgrid_server.py'), 'utf8');

  assert.ok(serverPy.includes('def _agent_codex_start_device_auth('), 'Expected Codex device auth starter helper.');
  assert.ok(serverPy.includes('def _agent_codex_app_server_model_list('), 'Expected Codex app-server model discovery helper.');
  assert.ok(serverPy.includes('"method": "model/list"'), 'Expected Codex model discovery to call app-server model/list.');
  assert.ok(serverPy.includes('def _agent_discover_model_catalog('), 'Expected dynamic provider model catalog discovery helper.');
  assert.ok(serverPy.includes('"list_models": _agent_codex_discovered_models,'), 'Expected provider registry to expose model discovery hooks.');
  assert.ok(serverPy.includes('def _agent_openai_discovered_models('), 'Expected OpenAI model discovery helper.');
  assert.ok(serverPy.includes('def _agent_anthropic_discovered_models('), 'Expected Anthropic model discovery helper.');
  assert.ok(serverPy.includes('def _agent_gemini_discovered_models('), 'Expected Gemini model discovery helper.');
  assert.ok(serverPy.includes('"list_models": _agent_openai_discovered_models,'), 'Expected provider registry to expose OpenAI model discovery.');
  assert.ok(serverPy.includes('"list_models": _agent_anthropic_discovered_models,'), 'Expected provider registry to expose Anthropic model discovery.');
  assert.ok(serverPy.includes('"list_models": _agent_gemini_discovered_models,'), 'Expected provider registry to expose Gemini model discovery.');
  assert.ok(serverPy.includes('url="https://api.openai.com/v1/models?limit=200"'), 'Expected OpenAI discovery to read the live models endpoint.');
  assert.ok(serverPy.includes('url="https://api.anthropic.com/v1/models"'), 'Expected Anthropic discovery to read the live models endpoint.');
  assert.ok(serverPy.includes("url=f\"https://generativelanguage.googleapis.com/v1beta/models?{urlencode({'key': api_key})}\""), 'Expected Gemini discovery to read the live models endpoint.');
  assert.ok(serverPy.includes('discovered_models=discovered_models,'), 'Expected catalog payload to merge discovered models into the UI catalog.');
  assert.ok(serverPy.includes('"model_discovery": discovery_info.get(provider_id, {}),'), 'Expected catalog payload to expose provider discovery metadata.');
  assert.ok(serverPy.includes('Codex OAuth started. Open the verification URL, finish login, then click Verify.'), 'Expected OAuth start guidance message.');
  assert.ok(serverPy.includes('"message": "Codex OAuth verified."'), 'Expected OAuth verify success message.');
  assert.ok(serverPy.includes('"message": "Codex OAuth is still pending. Complete login and verify again."'), 'Expected pending OAuth verify response.');
  assert.ok(serverPy.includes('def _agent_provider_codex_cli_generate('), 'Expected Codex CLI provider execution for OAuth mode.');
  assert.ok(serverPy.includes('def _agent_provider_registry() -> dict[str, dict[str, Any]]:'), 'Expected provider adapter registry.');
  assert.ok(serverPy.includes('def _agent_test_and_store_connection('), 'Expected generic connection test/store helper.');
  assert.ok(serverPy.includes('def _agent_provider_gemini_generate('), 'Expected Gemini provider execution helper.');
});

test('server normalizes extended task fields and scoped action targets', async () => {
  const serverPy = await readFile(path.join(__dirname, '..', 'server', 'shotgrid_server.py'), 'utf8');

  assert.ok(serverPy.includes('"Project Stage": "Project Stage"'), 'Expected local task alias for Project Stage.');
  assert.ok(serverPy.includes('"Location": "Location"'), 'Expected local task alias for Location.');
  assert.ok(serverPy.includes('"Deadline": "Deadline"'), 'Expected local task alias for Deadline.');
  assert.ok(serverPy.includes('"Dept Est": "Dept Est"'), 'Expected local task alias for Dept Est.');
  assert.ok(serverPy.includes('"Total Work": "Total Work"'), 'Expected local task alias for Total Work.');
  assert.ok(serverPy.includes('task["Project Stage"] = str(task.get("Project Stage") or "")'), 'Expected Project Stage normalization defaults.');
  assert.ok(serverPy.includes('task["Deadline"] = str(task.get("Deadline") or "")'), 'Expected Deadline normalization defaults.');
  assert.ok(serverPy.includes('task:{task_id or \'*\'}:notes'), 'Expected note action target scoping.');
  assert.ok(serverPy.includes('milestone:{milestone_id or title or \'*\'}'), 'Expected milestone action target scoping.');
  assert.ok(serverPy.includes('task:{task_id or \'*\'}:dependencies'), 'Expected dependency action target scoping.');
  assert.ok(serverPy.includes('task:{task_id or \'*\'}:blockers'), 'Expected blocker action target scoping.');
});
