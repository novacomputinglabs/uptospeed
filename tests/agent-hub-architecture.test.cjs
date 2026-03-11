const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('settings modal includes agents section and connection controls', async () => {
  const html = await readFile(path.join(__dirname, '..', 'index.html'), 'utf8');
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');

  assert.ok(html.includes('id="settingsAgentProviders"'), 'Expected generic provider container in settings.');
  assert.ok(html.includes('id="settingsAgentCatalogStatus"'), 'Expected provider catalog status hint in settings.');
  assert.ok(html.includes('id="settingsAgentDefaultModel"'), 'Expected global default model selector in settings.');
  assert.ok(html.includes('id="settingsAgentProjectDefaultModel"'), 'Expected project default model selector in settings.');
  assert.ok(html.includes('id="settingsAgentEnableStreaming"'), 'Expected streaming toggle in settings.');
  assert.ok(html.includes('id="settingsAgentStrictSafety"'), 'Expected strict safety toggle in settings.');
  assert.ok(html.includes('id="settingsAgentAutoMentions"'), 'Expected auto-mentions toggle in settings.');
  assert.ok(html.includes('id="settingsAgentTrustRules"'), 'Expected trust rules container in settings.');
  assert.ok(appJs.includes('function performAgentProviderAuthAction('), 'Expected generic provider auth action helper.');
  assert.ok(appJs.includes('function saveAgentConnectionFromSettings('), 'Expected generic provider connection save helper.');
  assert.ok(appJs.includes('function renderAgentProviderCards()'), 'Expected dynamic provider card renderer.');
  assert.ok(appJs.includes('function getConnectedAgentProviders('), 'Expected helper for authenticated provider filtering.');
  assert.ok(appJs.includes('function getAgentAvailableModelCatalog('), 'Expected helper for authenticated model filtering.');
  assert.ok(appJs.includes('function getAgentPreferredModelRef('), 'Expected helper for preferred authenticated model selection.');
  assert.ok(appJs.includes("model_discovery: entry?.model_discovery && typeof entry.model_discovery === 'object' ? entry.model_discovery : {}"), 'Expected provider catalog state to preserve model discovery metadata.');
  assert.ok(appJs.includes("const discoverySuffix = discoveredCount > 0 ? ` · ${discoveredCount} models` : '';"), 'Expected provider status copy to reflect discovered model counts.');
  assert.ok(appJs.includes('Connected ${connectedCount}/${providers.length} providers'), 'Expected settings status copy to reflect connected provider counts.');
});

test('mention directory derives agent handles from the provider catalog', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');

  assert.ok(appJs.includes('function getAgentMentionEntries()'), 'Expected provider-driven mention entry builder.');
  assert.ok(
    appJs.includes("...(Array.isArray(provider?.aliases) ? provider.aliases : [])"),
    'Expected mention builder to include provider aliases.'
  );
  assert.ok(
    appJs.includes("...(Array.isArray(DEFAULT_AGENT_PROVIDER_META[providerId]?.aliases) ? DEFAULT_AGENT_PROVIDER_META[providerId].aliases : [])"),
    'Expected mention builder to preserve built-in legacy aliases like @claude.'
  );
  assert.ok(appJs.includes('const providers = getConnectedAgentProviders();'), 'Expected mention entries to follow authenticated providers only.');
  assert.ok(appJs.includes('function getAgentMentionTargets('), 'Expected mention target resolver for provider/model selection.');
  assert.ok(
    appJs.includes('const directory = getTaskNotesMentionDirectory(taskNotesUiState.taskId)'),
    'Expected mention target resolver to read from the task notes mention directory.'
  );
});

test('task-note mention flow triggers agent run creation', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');

  assert.ok(appJs.includes('function triggerAgentRunsFromTaskNoteMentions('), 'Expected mention-trigger helper for agent runs.');
  assert.ok(appJs.includes("agentRequest('/api/agents/runs'"), 'Expected task-note mention flow to create agent runs.');
  assert.ok(appJs.includes('model_ref: modelRef'), 'Expected task-note mention runs to send model_ref.');
  assert.ok(appJs.includes('provider: providerId'), 'Expected task-note mention runs to send canonical provider ids.');
  assert.ok(appJs.includes('triggerAgentRunsFromTaskNoteMentions({'), 'Expected composer submit flow to trigger mention agent runs.');
});

test('agent chat backfills persisted thread messages after fast runs', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');

  assert.ok(appJs.includes('function replaceAgentThreadsSnapshot('), 'Expected thread snapshot replacement helper.');
  assert.ok(appJs.includes('function agentTimestampMs('), 'Expected timestamp normalization for persisted agent timelines.');
  assert.ok(appJs.includes('function createNewAgentChatSession()'), 'Expected explicit new chat session helper.');
  assert.ok(appJs.includes('function toggleAgentChatHistoryPopover(event)'), 'Expected history popover toggle helper.');
  assert.ok(appJs.includes('agentChat: {'), 'Expected UI state snapshot to persist agent chat sessions.');
  assert.ok(appJs.includes('const agentChat = parsed.agentChat && typeof parsed.agentChat === \'object\' ? parsed.agentChat : null;'), 'Expected UI state restore path for persisted chat sessions.');
  assert.ok(appJs.includes("const scopeQuery = `project_scope=${encodeURIComponent(currentAgentProjectScope())}&user_id=${encodeURIComponent(appSettings.localUserId || '')}`;"), 'Expected scoped query helper for agent refreshes.');
  assert.ok(appJs.includes("agentRequest(`/api/agents/threads?${scopeQuery}`)"), 'Expected agent refresh to load persisted threads.');
  assert.ok(appJs.includes("source.addEventListener('thread.snapshot'"), 'Expected SSE thread snapshot listener.');
  assert.ok(appJs.includes("source.addEventListener('message.assistant.delta'"), 'Expected SSE listener for streamed assistant drafts.');
  assert.ok(appJs.includes('mergeAgentThreadSnapshot(thread);'), 'Expected SSE snapshot to hydrate thread messages.');
});

test('agent chat renders inline tool cards, drafts, and working state', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');
  const css = await readFile(path.join(__dirname, '..', 'styles.css'), 'utf8');

  assert.ok(appJs.includes('function renderAgentInlineActionCard('), 'Expected inline tool card renderer in chat.');
  assert.ok(appJs.includes('function renderAgentRuntimeProgress('), 'Expected runtime progress renderer for streamed Codex updates.');
  assert.ok(appJs.includes('function renderAgentTypingIndicator('), 'Expected typing indicator renderer.');
  assert.ok(appJs.includes('function buildAgentChatTimeline('), 'Expected combined chat timeline renderer.');
  assert.ok(appJs.includes('function upsertAgentStreamDraft('), 'Expected transient streamed assistant draft storage.');
  assert.ok(appJs.includes('function upsertAgentStreamProgress('), 'Expected transient runtime progress storage.');
  assert.ok(appJs.includes('function clearAgentStreamDraft('), 'Expected streamed assistant drafts to clear when a final message arrives.');
  assert.ok(appJs.includes("source.addEventListener('run.progress'"), 'Expected SSE listener for streamed runtime progress.');
  assert.ok(appJs.includes("source.addEventListener('action.queued'"), 'Expected SSE listener for queued tool actions.');
  assert.ok(appJs.includes("kind: 'draft_message'"), 'Expected chat timeline to include streamed assistant draft entries.');
  assert.ok(appJs.includes("kind: 'runtime_progress'"), 'Expected chat timeline to include streamed runtime progress entries.');
  assert.ok(appJs.includes("if (itemType === 'agent_message')"), 'Expected streamed agent progress text to hydrate the assistant draft view.');
  assert.ok(!appJs.includes('is preparing a tool step'), 'Expected generic tool-step placeholder copy to be removed.');
  assert.ok(css.includes('.agent-chat-shimmer-detail'), 'Expected shimmer detail styling for live tool context.');
  assert.ok(css.includes('.agent-chat-shimmer-note'), 'Expected shimmer note styling for command output context.');
  assert.ok(appJs.includes('Remember this rule</button>'), 'Expected clearer remembered-rule button copy.');
});

test('agent catalog is refreshed when agent surfaces are revisited', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');

  assert.ok(appJs.includes("if (state.agentChatUi.open) void loadAgentCatalogFromServer();"), 'Expected opening the agent chat dock to refresh the provider catalog.');
  assert.ok(appJs.includes("window.addEventListener('focus', () => {"), 'Expected window focus to refresh the provider catalog after external Codex changes.');
  assert.ok(appJs.includes('renderAgentProviderCards();'), 'Expected catalog refreshes to update provider cards.');
  assert.ok(appJs.includes('renderAgentModelRoutingControls();'), 'Expected catalog refreshes to update model routing selectors.');
  assert.ok(appJs.includes("toggleBtn.setAttribute('aria-label', 'Agent chat');"), 'Expected the live chat toggle render to preserve its accessible name.');
  assert.ok(appJs.includes("badge.setAttribute('aria-hidden', 'true');"), 'Expected the pending badge to stay hidden from assistive naming.');
});

test('agent chat model picker preserves discovered selections across catalog refreshes and reloads', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');

  assert.ok(appJs.includes('function persistAgentChatUiState(options = {})'), 'Expected agent chat UI persistence helper to support immediate saves.');
  assert.ok(appJs.includes('persistAgentChatUiState({ immediate: true });'), 'Expected model picker changes to persist immediately.');
  assert.ok(appJs.includes('const models = getOrderedAgentAvailableModels();'), 'Expected picker rendering to use authenticated available models.');
  assert.ok(appJs.includes("select.innerHTML = '<option value=\"\">Connect a provider in Settings</option>';"), 'Expected picker to show a settings placeholder when no providers are connected.');
  assert.ok(appJs.includes('const resolvedModelRef = hasCurrent ? currentModelRef : (preferredModelRef || select.options[0]?.value || fallbackModelRef);'), 'Expected picker to fall back to the preferred authenticated model.');
  assert.ok(appJs.includes('sendBtn.disabled = availableModels.length === 0 || !agentRuntimeCanMutate();'), 'Expected chat send button to disable when the runtime or providers are unavailable.');
});

test('agent permissions view wiring and decision controls are present', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');
  const html = await readFile(path.join(__dirname, '..', 'index.html'), 'utf8');

  assert.ok(appJs.includes("setViewMode('agent_permissions')"), 'Expected agent permissions view mode entry point.');
  assert.ok(appJs.includes('state.agentChatUi.open = false;'), 'Expected agent permissions view to close the chat dock before approvals.');
  assert.ok(appJs.includes('function renderAgentPermissionsView()'), 'Expected agent permissions view renderer.');
  assert.ok(appJs.includes('function agentPendingApprovalActions(options = {})'), 'Expected pending approvals helper to support thread scoping.');
  assert.ok(appJs.includes('<h3>Current chat</h3>'), 'Expected permissions view to separate the active thread approvals.');
  assert.ok(appJs.includes('<h3>Other chats</h3>'), 'Expected permissions view to keep stale approvals separate.');
  assert.ok(appJs.includes('function setAgentToolPermission('), 'Expected persistent tool permission updater.');
  assert.ok(appJs.includes("decideAgentAction(actionId, decision)"), 'Expected action decision handler.');
  assert.ok(appJs.includes("{ value: 'allow', label: 'Allow' }"), 'Expected allow button config in tool permission rows.');
  assert.ok(appJs.includes("{ value: 'deny', label: 'Deny' }"), 'Expected deny button config in tool permission rows.');
  assert.ok(appJs.includes("{ value: 'trust', label: 'Trust', disabled: trustDisabled }"), 'Expected trust button config in tool permission rows.');
  assert.ok(appJs.includes('Approve</button>'), 'Expected approve button in agent actions rows.');
  assert.ok(appJs.includes('Reject</button>'), 'Expected reject button in agent actions rows.');
  assert.ok(appJs.includes('Remember this rule</button>'), 'Expected explicit remembered-rule button copy in agent actions rows.');

  assert.ok(html.includes('id="sidebarAgentPermissionsBtn"'), 'Expected sidebar entry for Agent Permissions view.');
  assert.ok(html.includes('id="agentChatDock"'), 'Expected global docked agent chat panel.');
  assert.ok(html.includes('id="agentChatNewSessionBtn"'), 'Expected explicit new chat button in the dock header.');
  assert.ok(html.includes('id="agentChatHistoryBtn"'), 'Expected header history button for past chats.');
  assert.ok(html.includes('id="agentChatHistoryPopover"'), 'Expected history popover container in the dock header.');
  assert.ok(html.includes('id="agentChatToggleBtn"'), 'Expected a dedicated global agent chat toggle button.');
  assert.ok(html.includes('aria-label="Agent chat"'), 'Expected the agent chat toggle to preserve its accessible name.');
  assert.ok(html.includes('id="agentChatPendingBadge" hidden aria-hidden="true"'), 'Expected the pending badge to stay out of the accessible name.');
});

test('trust button is disabled for destructive tools', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.ok(
    appJs.includes("const trustDisabled = runtimeDisabled || AGENT_DESTRUCTIVE_TOOLS.has(String(action?.tool_name || '').trim()) || status !== 'proposed';"),
    'Expected trust button disable guard for destructive tools.'
  );
});

test('runtime banner and agent profile settings are present', async () => {
  const html = await readFile(path.join(__dirname, '..', 'index.html'), 'utf8');
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');
  const css = await readFile(path.join(__dirname, '..', 'styles.css'), 'utf8');

  assert.ok(html.includes('id="agentRuntimeBanner"'), 'Expected persistent runtime banner in the shell.');
  assert.ok(html.includes('id="settingsAgentProfiles"'), 'Expected settings container for agent profiles.');
  assert.ok(appJs.includes('function renderAgentRuntimeBanner()'), 'Expected runtime banner renderer.');
  assert.ok(appJs.includes('function refreshAgentRuntimeHealth('), 'Expected runtime health refresh helper.');
  assert.ok(appJs.includes('function renderAgentProfiles()'), 'Expected agent profile settings renderer.');
  assert.ok(appJs.includes('agent_profile_id: agentProfileId || undefined,'), 'Expected new runs to carry agent_profile_id.');
  assert.ok(css.includes('.agent-runtime-banner'), 'Expected runtime banner styling.');
  assert.ok(css.includes('.agent-profile-card'), 'Expected agent profile card styling.');
});

test('static fallback disables workspace mutations across controls and API writes', async () => {
  const html = await readFile(path.join(__dirname, '..', 'index.html'), 'utf8');
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');

  assert.ok(html.includes('id="newTaskButton"'), 'Expected a dedicated New Task button to lock in static mode.');
  assert.ok(html.includes('disabled title="Checking runtime'), 'Expected New Task to start disabled until runtime health is known.');
  assert.ok(appJs.includes('function workspaceRuntimeCanMutate() {'), 'Expected a shared workspace mutation gate.');
  assert.ok(appJs.includes('Workspace changes are disabled in read-only static mode.'), 'Expected explicit static-mode lock messaging.');
  assert.ok(appJs.includes('newTaskButton.disabled = !canMutate;'), 'Expected New Task to follow runtime mutability.');
  assert.ok(appJs.includes("const quickFieldDisabledAttr = canMutate ? '' : 'disabled';"), 'Expected card quick-edit fields to disable when the workspace is read-only.');
  assert.ok(appJs.includes("const menuButtonDisabledAttr = canMutate ? '' : 'disabled';"), 'Expected task card menus to disable mutation actions when read-only.');
  assert.ok(appJs.includes("if (!workspaceRuntimeCanMutate()) return blockWorkspaceMutationResult();"), 'Expected API-level write guards to block workspace mutations in static mode.');
});

test('agent profiles preserve provider-specific model defaults when providers are disconnected', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');

  assert.ok(appJs.includes('function getAgentProfileModelOptions(profile = null) {'), 'Expected profile-specific model option resolver.');
  assert.ok(
    appJs.includes("const modelCatalog = getAgentModelCatalog().filter((entry) => entry?.enabled !== false);"),
    'Expected model option resolution to use the full catalog instead of only connected-provider models.'
  );
  assert.ok(
    appJs.includes("normalizeAgentProviderId(entry?.provider_id || entry?.provider) === requestedProviderId"),
    'Expected profile model options to stay scoped to the selected provider.'
  );
  assert.ok(appJs.includes('const fallback = getAgentProviderEntry(requestedProviderId);'), 'Expected disconnected providers to fall back to their stored provider defaults.');
  assert.ok(appJs.includes('model_ref: fallbackModelRef,'), 'Expected provider fallback entries to preserve the provider-specific model ref.');
  assert.ok(
    appJs.includes("const isSelected = modelRef === normalizeAgentModelRef(profile.default_model_ref, '');"),
    'Expected profile rendering to keep the saved model selected instead of collapsing to another provider.'
  );
});

test('planning chips and task-note run links are surfaced in the UI', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');
  const css = await readFile(path.join(__dirname, '..', 'styles.css'), 'utf8');

  assert.ok(appJs.includes('function renderTaskPlanningIndicators(task)'), 'Expected planning chip renderer on cards.');
  assert.ok(appJs.includes("label: 'Criteria missing'"), 'Expected acceptance-criteria completeness chip.');
  assert.ok(appJs.includes('function openTaskNotesAgentRun('), 'Expected task-note backlink helper for runs.');
  assert.ok(css.includes('.card-planning-chip'), 'Expected planning chip styling.');
  assert.ok(css.includes('.task-notes-run-meta'), 'Expected task-note run meta styling.');
});

test('new chat requests reuse or create a dedicated thread id and title', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');

  assert.ok(appJs.includes('const optimisticThreadId = selectedThreadId || `local-thread-${generateId()}`;'), 'Expected chat sends to allocate a local thread id for new sessions.');
  assert.ok(appJs.includes('thread_id: optimisticThreadId || undefined,'), 'Expected new chat sends to preserve the allocated thread id.');
  assert.ok(appJs.includes('title: promptTitle,'), 'Expected new chat sends to persist a thread title.');
  assert.ok(appJs.includes("showToast('Connect a provider in Settings first.'"), 'Expected chat entry points to guard against missing authenticated providers.');
});

test('desktop runtime controls and autonomous supervisor are wired into the app shell', async () => {
  const html = await readFile(path.join(__dirname, '..', 'index.html'), 'utf8');
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');
  const desktopMain = await readFile(path.join(__dirname, '..', 'desktop', 'src', 'main.mjs'), 'utf8');
  const css = await readFile(path.join(__dirname, '..', 'styles.css'), 'utf8');

  assert.ok(html.includes('id="settingsDesktopRuntimeProfile"'), 'Expected a desktop runtime profile selector in settings.');
  assert.ok(html.includes('id="settingsDesktopMigrationPolicy"'), 'Expected a desktop migration policy selector in settings.');
  assert.ok(html.includes('id="settingsDesktopRuntimeLogsPreview"'), 'Expected a desktop runtime log preview in settings.');
  assert.ok(html.includes('id="settingsAgentSupervisorEnabled"'), 'Expected an autonomous supervisor toggle in settings.');
  assert.ok(html.includes('id="settingsAgentSupervisorInterval"'), 'Expected an autonomous supervisor interval control in settings.');
  assert.ok(html.includes('id="settingsAgentSupervisorProfile"'), 'Expected an autonomous supervisor profile selector in settings.');
  assert.ok(appJs.includes('function initDesktopRuntimeBridge()'), 'Expected desktop runtime bridge initialization.');
  assert.ok(appJs.includes('function renderDesktopRuntimeSettingsCard()'), 'Expected desktop runtime settings renderer.');
  assert.ok(appJs.includes('function runAgentSupervisorSweep('), 'Expected an autonomous supervisor sweep function.');
  assert.ok(appJs.includes("source: 'background_supervisor'"), 'Expected autonomous supervisor runs to use a dedicated background source.');
  assert.ok(appJs.includes('function syncAgentSupervisorLoop('), 'Expected autonomous supervisor loop synchronization.');
  assert.ok(appJs.includes('desktopRuntime: { ...(state.desktopRuntime || {}) }'), 'Expected API state payload to include desktop runtime status.');
  assert.ok(desktopMain.includes('const MANUAL_RUNTIME_RESTART_DEFER_MS = 180;'), 'Expected manual desktop restarts to defer long enough for IPC responses to resolve.');
  assert.ok(desktopMain.includes("runtime: queueRuntimeRestart(reason, {\n        deferMs: MANUAL_RUNTIME_RESTART_DEFER_MS,"), 'Expected workspace-initiated desktop restarts to use the deferred restart queue.');
  assert.ok(desktopMain.includes("return queueRuntimeRestart(`Switching runtime profile to ${nextProfileId}`, {\n    deferMs: MANUAL_RUNTIME_RESTART_DEFER_MS,"), 'Expected runtime profile switches to use the deferred restart queue.');
  assert.ok(css.includes('.agent-settings-log-preview'), 'Expected styled desktop runtime log preview.');
  assert.ok(css.includes('.agent-runtime-banner-actions'), 'Expected runtime banner action styling.');
});
