# UP TO SPEED

UP TO SPEED is a locally-run workspace for producing and managing creative projects with humans in the loop and agent automation on top.

The supported runtime is the launcher-managed local stack:

```bash
python3 scripts/launch_agent_stack.py
```

That starts the writable UI/backend, the local ShotGrid proxy, and the agent gateway together. Opening `index.html` directly is still supported as a read-only fallback for humans, but agent mutations stay disabled in static mode.

## Desktop install (Bun)

After publishing the installer package from `installer/package.json`, the website install command is:

```bash
bunx --bun uptospeed-desktop-installer
```

That installer package downloads the latest GitHub desktop release for the current platform, installs it into a user-writable location, and launches the app. The installer package lives in `installer/package.json`.

## Public launch export

To remove local runtime data from this checkout and create a publish-safe snapshot without git history, run:

```bash
node scripts/purge-local-runtime-data.mjs
node scripts/export-public-launch.mjs
```

That produces `public-launch/`, which excludes local caches, local broker databases, build outputs, hidden Codex workspace files, and other non-public artifacts. Use that exported directory as the starting point for a new public repo or clean release branch.

## ShotGrid Live Sync (Optional)

To sync directly with a real ShotGrid site (instead of CSV import/export), run the included local proxy server.

### Authentication options

ShotGrid’s REST API uses token grants (there isn’t a browser-based “authorize” redirect flow). This app supports:

- **Studio script (recommended):** `client_credentials` via `SHOTGRID_SCRIPT_NAME` + `SHOTGRID_API_KEY` (best for teams)
- **Personal sign-in:** `password` (legacy username + API passphrase/token) or `session_token` (advanced)

### 1) Configure (choose one)

#### Option A (Recommended): Studio script credentials (service account)

- Copy `.env.example` → `.env.local`
- Fill in:
  - `SHOTGRID_URL` (e.g. `https://your-studio.shotgrid.autodesk.com`)
  - `SHOTGRID_SCRIPT_NAME`
  - `SHOTGRID_API_KEY`
  - Optional: `SHOTGRID_PROJECT_ID` (default project id)

#### Option B: Personal sign-in (no script)

- You can leave `.env.local` empty (or set `SHOTGRID_URL` to pre-fill the “Site URL” field).
- You’ll sign in in the UI using your **ShotGrid API passphrase/token** (not your Autodesk SSO password).

#### Optional: Encrypt local broker DB (at rest)

- Install SQLCipher support:

```bash
python3 -m pip install sqlcipher3
```

- Default behavior is automatic:
  - `LOCAL_BROKER_AUTO_ENCRYPTION=1` (default) provisions a managed key file per user and enables SQLCipher.
  - Existing plaintext `.local_sync_broker.sqlite3` is auto-migrated to encrypted format by default (`LOCAL_BROKER_AUTO_MIGRATE_PLAINTEXT=1`) and a timestamped plaintext backup is kept next to the DB.
- Optional overrides in `.env.local`:
  - `LOCAL_BROKER_MANAGED_KEY_FILE=...` (or `LOCAL_BROKER_MANAGED_KEY_DIR=...`)
  - `LOCAL_BROKER_ENCRYPTION_KEY=...` or `LOCAL_BROKER_ENCRYPTION_KEY_FILE=...` (explicit key source)
  - `LOCAL_BROKER_ENCRYPTION_REQUIRED=1` (fail startup if no key is available)
- Verify runtime mode at `GET /api/local/health` (`encryption.enabled: true`, `encryption.key_source: "managed"`).

### 2) Start the supported runtime

```bash
python3 -m pip install -r server/requirements.txt
python3 scripts/launch_agent_stack.py
```

### 3) Open the app

- Recommended: the launcher opens `http://127.0.0.1:7331/` automatically.
- Static fallback: if you open `index.html` directly, the board remains usable for inspection, but agent mutations are disabled and you should point Settings → ShotGrid → “ShotGrid server URL” to `http://127.0.0.1:7331`.

### 4) Connect + choose a project

- Complete onboarding (or go to Settings → ShotGrid → “Connect to ShotGrid…”)
- Choose an authentication method, then select the Project you want to sync
- Use `SG Sync` to pull tasks from ShotGrid; use `SG Push` to push changes back

### Troubleshooting

If `SG Sync` fails with an HTTP error, the UI will show the upstream ShotGrid status (and a hint when available).

For demoing with old “Autodesk default” projects (e.g. tasks dated in 2016), there is a dev-only Settings action to shift + push task Start/End dates to 2026 (run on `localhost`/`127.0.0.1` or add `?dev=1`).

Manual backend-only debugging is still available:

```bash
SHOTGRID_DEBUG=1 python3 server/shotgrid_server.py
```

Common causes:
- `401` / `400`: invalid/expired credentials (reconnect, or verify script name/key)
- `403`: permissions (script/user role can see projects but not tasks in that project)
- `404`: wrong `SHOTGRID_URL` (must be your studio site, e.g. `https://your-studio.shotgrid.autodesk.com`)
- `422`: field mismatch (remove/adjust any `SHOTGRID_FIELD_*` overrides)
- Startup error mentioning SQLCipher: install `sqlcipher3` (or disable auto encryption with `LOCAL_BROKER_AUTO_ENCRYPTION=0`)
- Startup error about local broker key: verify managed key file permissions/path or your explicit `LOCAL_BROKER_ENCRYPTION_KEY*` overrides

Optional/custom fields (only set these if your ShotGrid has them):
- `SHOTGRID_FIELD_DEPT_PROD_NOTE`
- `SHOTGRID_FIELD_TARGET_STATUS_SUMMARY`
- `SHOTGRID_FIELD_TASK_COMMENTS`

#### Performance notes

- The proxy caches `/api/shotgrid/tasks` responses in-memory for 5 minutes by default (and persists a small disk cache for fast restarts). Override with `SHOTGRID_CACHE_TTL_SECONDS` (set `0` to disable).
- The browser UI loads cached tasks immediately and refreshes in the background when “Auto-sync on load” is enabled.

## Features

### Kanban Board
- Drag-and-drop tasks between columns: Backlog → Scheduled → In Progress → Review → Done
- Visual status indicators (on-target, potential delay, push, approved)
- Department color coding (CFX, Rig, Model, Look Dev, Texture, Groom, Client)
- Search highlighting across all task fields

### Endeavors
- Project-scoped, recursive endeavor hierarchy (parent/child tree)
- Tasks can belong to multiple endeavors
- Duration and target date auto-derive from rolled-up task start/end (business days)
- Progress auto-derives from rolled-up task completion (undated tasks still count in denominator)
- Status auto-derives (`planned`, `active`, `completed`)
- Endeavor filtering supports `All tasks`, `Any endeavor`, and `Specific endeavor`
- Gantt view includes collapsible endeavor rows with parent bars

### Workload Management
- Full-page `Workload` dashboard view (sidebar or topbar toggle) for deep planning
- Quick workload side panel for at-a-glance checks while staying in Kanban/List
- KPI strip for utilization and risk signals (overallocation, at-risk, unassigned scheduled)
- Artist-by-week heatmap with overload hotspot and department pressure summaries
- Inspector-first cell interaction in full-page mode, then `Apply To Board` to return to Kanban/List with filters applied
- Quick panel cell interaction remains immediate filter-to-board for speed
- Auto-balance suggestions for overallocated weeks, including task split recommendations

### Gantt Chart
- Timeline view of all tasks
- Drag to reschedule tasks
- Resize to adjust duration
- Sort by start date, artist, department, or duration
- Today marker and weekend highlighting

### Rounds Mode (Stand-Up)
- Artist-by-artist task review
- Navigate with arrow keys
- Filter by department or endeavor
- Daily notes per task

### Data Management
- CSV import/export (ShotGrid compatible)
- Auto-save to browser localStorage
- Full undo/redo support (50 steps)
- Daily notes merged into export

### Spotlight Search
- Quick search with `⌘K`
- Multi-select filters (assets, artists, departments)
- Tab to add filters, Enter to apply

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `⌘K` | Spotlight search |
| `N` | New task |
| `S` | Toggle endeavors panel |
| `W` | Toggle workload panel (Kanban/List only) |
| `Shift+W` | Open full workload dashboard |
| `G` | Open Gantt chart |
| `R` | Rounds (stand-up) mode |
| `⇧P` | Toggle performance overlay |
| `/` | Focus search |
| `E` | Edit selected task |
| `Space` | Manage endeavors (selected task) |
| `⌫` | Delete selected task |
| `⌘Z` | Undo |
| `⌘⇧Z` | Redo |
| `Esc` | Close modal/panel |
| `←` `→` | Navigate artists (Rounds mode) |

## Performance Overlay (for demos)

Enable an on-screen FPS + timing overlay:

- URL flag: add `?perf=1` (or `?fps=1`)
- Shortcut: `⇧P`

Optional (debug only): add artificial fetch latency with `?perfDelayMs=200` (milliseconds).

### ShotGrid comparison

For the ShotGrid web app (or any site), you can enable similar numbers in Chrome DevTools:

- **More tools → Rendering → FPS meter**, or
- **More tools → Performance monitor** (shows FPS/CPU/heap/DOM nodes).

If you want an on-page FPS overlay (useful for screen recordings), paste this into the browser console on ShotGrid:

```js
(() => {
  const id = '__fps_overlay__';
  const existing = document.getElementById(id);
  if (existing) return existing.remove();
  const el = document.createElement('div');
  el.id = id;
  el.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:999999;background:rgba(0,0,0,.72);color:#9ef7c7;border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:8px 10px;font:11px/1.35 ui-monospace,Menlo,Monaco,Consolas,monospace;white-space:pre;pointer-events:none';
  document.body.appendChild(el);
  let last = performance.now();
  let frames = 0;
  function loop() {
    frames++;
    const now = performance.now();
    const dt = now - last;
    if (dt >= 1000) {
      const fps = Math.round((frames * 1000) / dt);
      el.textContent = `FPS: ${fps}`;
      frames = 0;
      last = now;
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
```

## CSV Format

Import CSVs with these columns:

| Column | Description |
|--------|-------------|
| `Id` | Unique task identifier |
| `Task Name` | Task title |
| `Link` | Asset name |
| `Status` | Current status (hld, sch, ip, pqc, review, cmp, apr) |
| `Assigned To` | Artist name |
| `Start` | Start date (YYYY-MM-DD) |
| `End` | End date (YYYY-MM-DD) |
| `Pipeline Step` | Department (Rig, CFX, Model, Look Dev, etc.) |
| `% Allocation` | Artist allocation percentage |
| `Dept Prod Note` | Production notes |
| `Target Status Summary` | Target status (ON TARGET, PUSH, etc.) |
| `Task Comments` | Additional comments |
| `Project` | Project name |

## Status Codes

| Code | Column | Description |
|------|--------|-------------|
| `hld` | Backlog | Hold |
| `kbc` | Backlog | Kickback |
| `revs` | Backlog | Revisions |
| `wtg` | Scheduled | Waiting to Start (ShotGrid default) |
| `rdy` | Scheduled | Ready (ShotGrid default) |
| `sch` | Scheduled | Scheduled |
| `ip` | In Progress | In Progress |
| `pqc` | In Progress | PQC Review |
| `dirfbk` | In Progress | Director Feedback |
| `rev` | Review | Review (ShotGrid default) |
| `review` | Review | In Review |
| `done` | Done | Done |
| `cmp` | Done | Complete |
| `apr` | Done | Approved |
| `fin` | Done | Final (ShotGrid default) |

## Browser Support

Works in all modern browsers (Chrome, Firefox, Safari, Edge). Data persists in localStorage.

## MCP Server (Local)

UP TO SPEED includes a local MCP server for board automation under `mcp/`.

### What it does

- Uses a managed Playwright browser session against the local app
- Calls `window.ShotgridKanbanAPI` methods for read/write board operations
- Enforces preview-first write guards (`confirm: true` required for mutating tools)
- Publishes status-schema MCP resources for validation hints
- Excludes ShotGrid network auth/sync/push tools in MCP v1

ShotGrid auto-sync behavior in the app remains unchanged.

### Setup

```bash
cd mcp
npm install
npx playwright install chromium
```

### Run

```bash
cd mcp
npm start
```

Entrypoint:

```bash
node ./mcp/src/server.mjs
```

### Test

```bash
cd mcp
npm test
```

### Verify Data Source

```bash
cd mcp
npm run verify:data
```

This exits non-zero when MCP is not attached to CDP, ShotGrid is disabled, or no ShotGrid project is selected.

### MCP Resources

- `uts://schema/statuses` - status-like field schema for current session
- `uts://schema/statuses/status` - allowed task status values
- `uts://schema/statuses/targetStatus` - allowed target status values

Mutating tools use this schema to surface better invalid-status hints before write execution.

### MCP Tools

Read tools:

- `uts_get_state`
- `uts_get_stats`
- `uts_get_tasks`
- `uts_get_task`
- `uts_get_filtered_tasks`
- `uts_get_endeavors`
- `uts_get_endeavor_tasks`
- `uts_set_filters`
- `uts_clear_filters`
- `uts_undo`
- `uts_redo`

Mutating tools (preview-first with `confirm: true`):

- `uts_update_task`
- `uts_create_task`
- `uts_delete_task`
- `uts_create_endeavor`
- `uts_update_endeavor`
- `uts_delete_endeavor`
- `uts_add_tasks_to_endeavor`
- `uts_remove_tasks_from_endeavor`
- `uts_clear_endeavor`
- `uts_create_asset`
- `uts_create_sequence`
- `uts_create_shot` (requires `sequenceName` or `sequenceId`)
- `uts_create_artist` (requires `firstName`, `lastName`, `login`, `email`)
- `uts_create_department`

MCP/API note: sprint-named MCP tools were removed in favor of endeavor-only names (breaking change).

Entity creation tools use local broker queueing and `ifExists: return_existing` semantics:

- Duplicate create requests are idempotent and return the existing entity when found.
- New entities are queued for background ShotGrid propagation via the local broker worker.
- Newly created entities are registered in the board entity catalog for immediate selector visibility.

### Environment Variables

- `UTS_MCP_SESSION_MODE` (default: `managed`; values: `auto`, `cdp`, `managed`; use `cdp` only when you intentionally want to attach to an open Chrome tab)
- `UTS_MCP_REQUIRE_CDP` (default: `0`; when `1`, MCP fails startup instead of falling back to managed mode)
- `UTS_MCP_CDP_URL` (default: `http://127.0.0.1:9222`)
- `UTS_MCP_CDP_REUSE_PAGE` (default: `1`; in CDP mode, reuse an existing dashboard tab so MCP changes are visible live in that page)
- `UTS_MCP_HEADLESS` (default: `1`)
- `UTS_MCP_PROFILE_DIR` (default: `~/.codex/uptospeed-mcp-profile`)
- `UTS_MCP_NAV_TIMEOUT_MS` (default: `30000`)
- `UTS_MCP_TOOL_TIMEOUT_MS` (default: `30000`)
- `UTS_MCP_SHOTGRID_REFRESH_COOLDOWN_MS` (default: `15000`)
- `UTS_MCP_BOOTSTRAP_SYNC` (default: `1`; runs a background ShotGrid refresh at startup when enabled)
- `UTS_MCP_SHOTGRID_PROJECT_ID` (optional; forces project selection in MCP session so data source is deterministic even across tabs/profiles)
- `UTS_MCP_BASE_URL` (default: `http://127.0.0.1:7331/index.html`; if unreachable, MCP falls back to a local static server)

Optional (CDP mode only): use your current browser-authenticated ShotGrid session by running Chrome with remote debugging and keeping your UP TO SPEED tab open on the same origin:

```bash
open -na "Google Chrome" --args --remote-debugging-port=9222
```

### Codex Registration (manual)

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.uptospeed]
command = "node"
args = ["/absolute/path/to/uptospeed/mcp/src/server.mjs"]

[mcp_servers.uptospeed.env]
UTS_MCP_SESSION_MODE = "managed"
UTS_MCP_REQUIRE_CDP = "0"
UTS_MCP_CDP_URL = "http://127.0.0.1:9222"
UTS_MCP_CDP_REUSE_PAGE = "1"
UTS_MCP_HEADLESS = "1"
UTS_MCP_PROFILE_DIR = "~/.codex/uptospeed-mcp-profile"
UTS_MCP_NAV_TIMEOUT_MS = "30000"
UTS_MCP_TOOL_TIMEOUT_MS = "30000"
UTS_MCP_SHOTGRID_REFRESH_COOLDOWN_MS = "15000"
UTS_MCP_BOOTSTRAP_SYNC = "1"
# Optional: lock MCP to one ShotGrid project
# UTS_MCP_SHOTGRID_PROJECT_ID = "123"
UTS_MCP_BASE_URL = "http://127.0.0.1:7331/index.html"
```

## License

MIT
