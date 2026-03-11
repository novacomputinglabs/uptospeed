# Up to Speed Benchmarks

Performance benchmarks comparing Up to Speed vs ShotGrid.

## Quick Start

### Run Benchmarks (Up to Speed)

1. Open the app with `?benchmark=1` to auto-show the benchmark panel:
   ```
   http://127.0.0.1:7331/?benchmark=1
   ```

2. Or open Settings (gear icon) → Developer section → "Run Benchmarks"

3. Or use the console:
   ```javascript
   showBenchmarkUI()           // Show benchmark panel
   benchmarkRunner.run()       // Run all benchmarks
   ```

### Run Benchmarks (ShotGrid)

1. Click "ShotGrid Script" in the benchmark panel to copy the script
2. Open your ShotGrid project page in Chrome
3. Open DevTools (F12) → Console
4. Paste and run the script
5. Interact with ShotGrid normally for 10 seconds
6. Copy the JSON output
7. Import into the results viewer

### View Results

Open `benchmarks/results.html` or click "View Results" in the benchmark panel.

## What's Measured

| Test | Description |
|------|-------------|
| Board Render | Full Kanban/List view render |
| Kanban Render | Kanban-specific render |
| List Render | List view render |
| Gantt Render | Gantt chart render |
| Filter Tasks | Filter operation (no UI) |
| Filter + Render | Filter with full re-render |
| Task Status Update | Simulated drag-drop |
| Undo/Redo | Undo/redo cycle |
| Workload Panel | Workload calculation + render |
| Sprint Render | Sprint list render |
| CSV Parse | Parse CSV data |
| CSV Generate | Generate CSV export |
| Spotlight Search | Search results render |
| Memory Usage | JS heap usage |
| Scroll FPS | Frame rate during interaction |

## Interpreting Results

- **avg**: Mean time across all samples
- **p50**: Median (50th percentile)
- **p95**: 95th percentile (worst 5% of cases)
- **p99**: 99th percentile

### Performance Targets

| Metric | Good | Acceptable | Needs Work |
|--------|------|------------|------------|
| Render time | <16ms | <50ms | >50ms |
| FPS | >55 | >30 | <30 |
| Filter | <5ms | <20ms | >20ms |

## Files

- `benchmark-runner.js` - Main benchmark suite
- `results.html` - Results viewer/comparison UI
- `README.md` - This file
