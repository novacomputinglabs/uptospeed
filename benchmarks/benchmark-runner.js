/**
 * Up to Speed - Benchmark Runner
 * Automated performance benchmarks comparing Up to Speed vs ShotGrid
 */

(function() {
  'use strict';

  const BENCHMARK_VERSION = '1.0.0';

  // ============================================================================
  // Utility Functions
  // ============================================================================

  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
  }

  function percentile(arr, p) {
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }

  function stats(times) {
    if (!times.length) return { avg: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0, samples: 0 };
    const sum = times.reduce((a, b) => a + b, 0);
    return {
      avg: Math.round((sum / times.length) * 100) / 100,
      min: Math.round(Math.min(...times) * 100) / 100,
      max: Math.round(Math.max(...times) * 100) / 100,
      p50: Math.round(percentile(times, 50) * 100) / 100,
      p95: Math.round(percentile(times, 95) * 100) / 100,
      p99: Math.round(percentile(times, 99) * 100) / 100,
      samples: times.length
    };
  }

  async function waitFrame() {
    return new Promise(resolve => requestAnimationFrame(resolve));
  }

  async function waitIdle() {
    return new Promise(resolve => {
      if ('requestIdleCallback' in window) {
        requestIdleCallback(resolve, { timeout: 100 });
      } else {
        setTimeout(resolve, 16);
      }
    });
  }

  async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ============================================================================
  // Benchmark Tests
  // ============================================================================

  const benchmarks = {
    /**
     * Measure initial board render time
     */
    async boardRender(iterations = 20) {
      const times = [];
      for (let i = 0; i < iterations; i++) {
        await waitIdle();
        const start = performance.now();
        renderBoard();
        await waitFrame();
        times.push(performance.now() - start);
        await sleep(50);
      }
      return { name: 'Board Render', ...stats(times), unit: 'ms' };
    },

    /**
     * Measure Kanban view render
     */
    async kanbanRender(iterations = 20) {
      const times = [];
      const originalMode = state.viewMode;
      state.viewMode = 'kanban';
      
      for (let i = 0; i < iterations; i++) {
        await waitIdle();
        const start = performance.now();
        renderKanbanView();
        await waitFrame();
        times.push(performance.now() - start);
        await sleep(50);
      }
      
      state.viewMode = originalMode;
      return { name: 'Kanban Render', ...stats(times), unit: 'ms' };
    },

    /**
     * Measure List view render
     */
    async listRender(iterations = 20) {
      const times = [];
      const originalMode = state.viewMode;
      state.viewMode = 'list';
      
      for (let i = 0; i < iterations; i++) {
        await waitIdle();
        const start = performance.now();
        renderListView();
        await waitFrame();
        times.push(performance.now() - start);
        await sleep(50);
      }
      
      state.viewMode = originalMode;
      renderBoard();
      return { name: 'List View Render', ...stats(times), unit: 'ms' };
    },

    /**
     * Measure Gantt chart render
     */
    async ganttRender(iterations = 15) {
      const times = [];
      const modal = document.getElementById('ganttModal');
      const wasVisible = modal?.classList.contains('visible');
      
      if (modal && !wasVisible) {
        modal.classList.add('visible');
        await sleep(100);
      }
      
      for (let i = 0; i < iterations; i++) {
        await waitIdle();
        const start = performance.now();
        renderGanttChart();
        await waitFrame();
        times.push(performance.now() - start);
        await sleep(50);
      }
      
      if (modal && !wasVisible) {
        modal.classList.remove('visible');
      }
      
      return { name: 'Gantt Render', ...stats(times), unit: 'ms' };
    },

    /**
     * Measure filter operation speed
     */
    async filterTasks(iterations = 50) {
      const times = [];
      const artists = [...new Set(state.tasks.map(t => t['Assigned To']).filter(Boolean))];
      const testArtist = artists[0] || 'Test';
      
      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        getFilteredTasks();
        times.push(performance.now() - start);
      }
      
      return { name: 'Filter Tasks (no UI)', ...stats(times), unit: 'ms' };
    },

    /**
     * Measure filter + render cycle
     */
    async filterAndRender(iterations = 20) {
      const times = [];
      const artists = [...new Set(state.tasks.map(t => t['Assigned To']).filter(Boolean))];
      const filterSelect = document.getElementById('filterArtist');
      const originalValue = filterSelect?.value || '';
      
      for (let i = 0; i < iterations; i++) {
        // Alternate between filtered and unfiltered
        if (filterSelect) {
          filterSelect.value = i % 2 === 0 ? (artists[0] || '') : '';
        }
        
        await waitIdle();
        const start = performance.now();
        renderBoard();
        await waitFrame();
        times.push(performance.now() - start);
        await sleep(50);
      }
      
      if (filterSelect) filterSelect.value = originalValue;
      renderBoard();
      
      return { name: 'Filter + Render', ...stats(times), unit: 'ms' };
    },

    /**
     * Measure task status update (drag-drop simulation)
     */
    async taskStatusUpdate(iterations = 20) {
      const times = [];
      const testTask = state.tasks[0];
      if (!testTask) return { name: 'Task Status Update', ...stats([]), unit: 'ms', error: 'No tasks' };
      
      const originalStatus = testTask.Status;
      const statuses = ['sch', 'ip', 'review', 'done'];
      
      for (let i = 0; i < iterations; i++) {
        const newStatus = statuses[i % statuses.length];
        
        await waitIdle();
        const start = performance.now();
        testTask.Status = newStatus;
        renderBoard();
        await waitFrame();
        times.push(performance.now() - start);
        await sleep(30);
      }
      
      testTask.Status = originalStatus;
      renderBoard();
      
      return { name: 'Task Status Update', ...stats(times), unit: 'ms' };
    },

    /**
     * Measure undo/redo performance
     */
    async undoRedo(iterations = 20) {
      const times = [];
      const testTask = state.tasks[0];
      if (!testTask) return { name: 'Undo/Redo Cycle', ...stats([]), unit: 'ms', error: 'No tasks' };
      
      // Create some undo history
      for (let i = 0; i < 5; i++) {
        const oldStatus = testTask.Status;
        testTask.Status = i % 2 === 0 ? 'ip' : 'sch';
        saveState({
          undoOps: [{ op: 'task.update', taskId: testTask.Id, patch: { Status: oldStatus } }],
          redoOps: [{ op: 'task.update', taskId: testTask.Id, patch: { Status: testTask.Status } }]
        });
      }
      
      for (let i = 0; i < iterations; i++) {
        await waitIdle();
        const start = performance.now();
        if (i % 2 === 0) {
          undo();
        } else {
          redo();
        }
        await waitFrame();
        times.push(performance.now() - start);
        await sleep(30);
      }
      
      return { name: 'Undo/Redo Cycle', ...stats(times), unit: 'ms' };
    },

    /**
     * Measure workload panel render
     */
    async workloadRender(iterations = 15) {
      const times = [];
      const panel = document.getElementById('workloadPanel');
      const wasVisible = panel?.classList.contains('visible');
      
      if (panel && !wasVisible) {
        panel.classList.add('visible');
        await sleep(100);
      }
      
      for (let i = 0; i < iterations; i++) {
        await waitIdle();
        const start = performance.now();
        renderWorkloadPanel();
        await waitFrame();
        times.push(performance.now() - start);
        await sleep(50);
      }
      
      if (panel && !wasVisible) {
        panel.classList.remove('visible');
      }
      
      return { name: 'Workload Panel', ...stats(times), unit: 'ms' };
    },

    /**
     * Measure sprint list render
     */
    async sprintRender(iterations = 20) {
      const times = [];
      
      for (let i = 0; i < iterations; i++) {
        await waitIdle();
        const start = performance.now();
        renderSprintList();
        await waitFrame();
        times.push(performance.now() - start);
        await sleep(30);
      }
      
      return { name: 'Sprint List Render', ...stats(times), unit: 'ms' };
    },

    /**
     * Measure CSV parsing performance
     */
    async csvParse(iterations = 30) {
      const times = [];
      const csv = generateCSV(state.tasks);
      
      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        parseCSV(csv);
        times.push(performance.now() - start);
      }
      
      return { name: 'CSV Parse', ...stats(times), unit: 'ms', dataSize: csv.length };
    },

    /**
     * Measure CSV generation performance
     */
    async csvGenerate(iterations = 30) {
      const times = [];
      
      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        generateCSV(state.tasks);
        times.push(performance.now() - start);
      }
      
      return { name: 'CSV Generate', ...stats(times), unit: 'ms' };
    },

    /**
     * Measure spotlight search render
     */
    async spotlightSearch(iterations = 20) {
      const times = [];
      const queries = ['Elena', 'Model', 'ip', 'alpha', 'CFX'];
      
      for (let i = 0; i < iterations; i++) {
        const query = queries[i % queries.length];
        await waitIdle();
        const start = performance.now();
        renderSpotlightResults(query);
        await waitFrame();
        times.push(performance.now() - start);
        await sleep(30);
      }
      
      return { name: 'Spotlight Search', ...stats(times), unit: 'ms' };
    },

    /**
     * Measure memory usage
     */
    async memoryUsage() {
      if (!performance.memory) {
        return { name: 'Memory Usage', error: 'Not supported (use Chrome)', unit: 'MB' };
      }
      
      // Force GC if available
      if (window.gc) window.gc();
      await sleep(100);
      
      const mem = performance.memory;
      return {
        name: 'Memory Usage',
        heapUsed: Math.round(mem.usedJSHeapSize / 1024 / 1024 * 100) / 100,
        heapTotal: Math.round(mem.totalJSHeapSize / 1024 / 1024 * 100) / 100,
        heapLimit: Math.round(mem.jsHeapSizeLimit / 1024 / 1024 * 100) / 100,
        unit: 'MB'
      };
    },

    /**
     * Measure FPS during scroll simulation
     */
    async scrollFPS(durationMs = 2000) {
      const frames = [];
      let lastTime = performance.now();
      let running = true;
      
      const measureFrame = () => {
        if (!running) return;
        const now = performance.now();
        frames.push(now - lastTime);
        lastTime = now;
        requestAnimationFrame(measureFrame);
      };
      
      // Start measuring
      requestAnimationFrame(measureFrame);
      
      // Simulate scroll by re-rendering
      const startTime = performance.now();
      while (performance.now() - startTime < durationMs) {
        renderBoard();
        await waitFrame();
      }
      
      running = false;
      await sleep(50);
      
      // Calculate FPS from frame times
      const validFrames = frames.filter(f => f > 0 && f < 200);
      const avgFrameTime = validFrames.reduce((a, b) => a + b, 0) / validFrames.length;
      const fps = Math.round(1000 / avgFrameTime);
      
      return {
        name: 'Scroll FPS',
        fps: fps,
        avgFrameTime: Math.round(avgFrameTime * 100) / 100,
        droppedFrames: frames.filter(f => f > 33).length,
        totalFrames: frames.length,
        unit: 'fps'
      };
    }
  };

  // ============================================================================
  // Benchmark Runner
  // ============================================================================

  class BenchmarkRunner {
    constructor() {
      this.results = null;
      this.isRunning = false;
      this.progress = 0;
      this.currentTest = '';
      this.onProgress = null;
    }

    async run(testNames = null) {
      if (this.isRunning) {
        console.warn('Benchmark already running');
        return null;
      }

      this.isRunning = true;
      this.progress = 0;
      
      const testsToRun = testNames || Object.keys(benchmarks);
      const totalTests = testsToRun.length;
      
      this.results = {
        id: generateId(),
        version: BENCHMARK_VERSION,
        timestamp: new Date().toISOString(),
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        screenSize: `${window.screen.width}x${window.screen.height}`,
        windowSize: `${window.innerWidth}x${window.innerHeight}`,
        taskCount: state.tasks.length,
        sprintCount: state.sprintTasks.size,
        source: 'uptospeed',
        tests: {}
      };

      console.log(`🚀 Starting benchmark suite (${totalTests} tests, ${state.tasks.length} tasks)`);
      console.log('─'.repeat(60));

      for (let i = 0; i < testsToRun.length; i++) {
        const testName = testsToRun[i];
        const testFn = benchmarks[testName];
        
        if (!testFn) {
          console.warn(`Unknown test: ${testName}`);
          continue;
        }

        this.currentTest = testName;
        this.progress = Math.round((i / totalTests) * 100);
        
        if (this.onProgress) {
          this.onProgress(this.progress, testName);
        }

        try {
          console.log(`⏱️  Running: ${testName}...`);
          const result = await testFn();
          this.results.tests[testName] = result;
          
          if (result.error) {
            console.log(`   ⚠️  ${result.name}: ${result.error}`);
          } else if (result.fps) {
            console.log(`   ✓ ${result.name}: ${result.fps} fps (avg frame: ${result.avgFrameTime}ms)`);
          } else if (result.heapUsed) {
            console.log(`   ✓ ${result.name}: ${result.heapUsed} MB used / ${result.heapTotal} MB total`);
          } else {
            console.log(`   ✓ ${result.name}: avg=${result.avg}ms, p95=${result.p95}ms (${result.samples} samples)`);
          }
        } catch (err) {
          console.error(`   ✗ ${testName} failed:`, err);
          this.results.tests[testName] = { name: testName, error: err.message };
        }

        await sleep(100);
      }

      this.progress = 100;
      this.isRunning = false;
      
      console.log('─'.repeat(60));
      console.log('✅ Benchmark complete!');
      console.log(`📊 Results ID: ${this.results.id}`);
      
      // Store results
      this.saveResults();
      
      return this.results;
    }

    saveResults() {
      try {
        const stored = JSON.parse(localStorage.getItem('uptospeed_benchmarks') || '[]');
        stored.push(this.results);
        // Keep last 50 results
        while (stored.length > 50) stored.shift();
        localStorage.setItem('uptospeed_benchmarks', JSON.stringify(stored));
      } catch (err) {
        console.warn('Failed to save benchmark results:', err);
      }
    }

    getStoredResults() {
      try {
        return JSON.parse(localStorage.getItem('uptospeed_benchmarks') || '[]');
      } catch {
        return [];
      }
    }

    clearStoredResults() {
      localStorage.removeItem('uptospeed_benchmarks');
    }

    exportResults(format = 'json') {
      if (!this.results) {
        console.warn('No results to export');
        return;
      }

      const filename = `uptospeed-benchmark-${this.results.id}`;
      
      if (format === 'json') {
        const blob = new Blob([JSON.stringify(this.results, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${filename}.json`;
        a.click();
        URL.revokeObjectURL(url);
      } else if (format === 'csv') {
        let csv = 'Test,Avg (ms),P50 (ms),P95 (ms),P99 (ms),Min (ms),Max (ms),Samples\n';
        for (const [key, test] of Object.entries(this.results.tests)) {
          if (test.avg !== undefined) {
            csv += `${test.name},${test.avg},${test.p50},${test.p95},${test.p99},${test.min},${test.max},${test.samples}\n`;
          }
        }
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${filename}.csv`;
        a.click();
        URL.revokeObjectURL(url);
      }
    }

    async saveToRepo(result = null) {
      const data = result || this.results;
      if (!data) {
        console.warn('No results to save');
        return false;
      }

      try {
        // Fetch current results file
        const response = await fetch('benchmarks/results-data.json');
        const repoData = await response.json();
        
        // Check for duplicate
        if (repoData.results.some(r => r.id === data.id)) {
          console.log('Result already saved:', data.id);
          return true;
        }
        
        // Add new result
        repoData.results.push(data);
        repoData.lastUpdated = new Date().toISOString();
        
        // Download updated file for user to save
        const blob = new Blob([JSON.stringify(repoData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'results-data.json';
        a.click();
        URL.revokeObjectURL(url);
        
        console.log('📁 Downloaded results-data.json - save it to benchmarks/ folder');
        return true;
      } catch (err) {
        console.error('Failed to save to repo:', err);
        return false;
      }
    }
  }

  // ============================================================================
  // ShotGrid Benchmark Script Generator
  // ============================================================================

  function generateShotGridBenchmarkScript() {
    return `
// ShotGrid Automated Benchmark Script
// Paste in browser console on any ShotGrid Tasks/Gantt page
// This automatically simulates interactions to match Up to Speed benchmarks

(function() {
  'use strict';
  
  const BENCHMARK_DURATION_MS = 15000;
  const results = {
    id: Date.now().toString(36) + Math.random().toString(36).substr(2, 9),
    timestamp: new Date().toISOString(),
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    source: 'shotgrid',
    url: window.location.href,
    tests: {}
  };

  // Utility functions
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  
  function stats(times) {
    if (!times.length) return { avg: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0, samples: 0 };
    const sorted = [...times].sort((a, b) => a - b);
    const sum = times.reduce((a, b) => a + b, 0);
    const p = (pct) => sorted[Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1)] || 0;
    return {
      avg: Math.round((sum / times.length) * 100) / 100,
      min: Math.round(Math.min(...times) * 100) / 100,
      max: Math.round(Math.max(...times) * 100) / 100,
      p50: Math.round(p(50) * 100) / 100,
      p95: Math.round(p(95) * 100) / 100,
      p99: Math.round(p(99) * 100) / 100,
      samples: times.length
    };
  }

  // Find scrollable containers in ShotGrid
  function findScrollContainers() {
    const candidates = [
      '.sg_cell_content_wrapper',
      '.entity_query_page_body',
      '.sg_grid_body',
      '[class*="scroll"]',
      '[class*="grid"]',
      '[style*="overflow"]'
    ];
    const containers = [];
    for (const sel of candidates) {
      document.querySelectorAll(sel).forEach(el => {
        if (el.scrollHeight > el.clientHeight + 50 || el.scrollWidth > el.clientWidth + 50) {
          containers.push(el);
        }
      });
    }
    // Fallback to document
    if (!containers.length) containers.push(document.documentElement);
    return containers;
  }

  // Find filter/search inputs
  function findFilterInputs() {
    return [
      ...document.querySelectorAll('input[type="text"]'),
      ...document.querySelectorAll('input[type="search"]'),
      ...document.querySelectorAll('[class*="filter"] input'),
      ...document.querySelectorAll('[class*="search"] input')
    ].filter(el => el.offsetParent !== null);
  }

  // Find clickable rows/cells
  function findClickableElements() {
    return [
      ...document.querySelectorAll('.sg_cell'),
      ...document.querySelectorAll('[class*="row"]'),
      ...document.querySelectorAll('tr[data-entity-id]'),
      ...document.querySelectorAll('[class*="task"]')
    ].filter(el => el.offsetParent !== null).slice(0, 50);
  }

  // Simulate scroll
  async function simulateScroll(container, times) {
    const scrollTimes = [];
    const maxScroll = Math.max(container.scrollHeight - container.clientHeight, 500);
    
    for (let i = 0; i < times; i++) {
      const targetScroll = (i % 2 === 0) ? Math.min(maxScroll, (i + 1) * 200) : 0;
      const start = performance.now();
      container.scrollTo({ top: targetScroll, behavior: 'auto' });
      await sleep(16); // Wait for paint
      scrollTimes.push(performance.now() - start);
      await sleep(50);
    }
    return scrollTimes;
  }

  // Simulate filter typing
  async function simulateFilter(input, times) {
    const filterTimes = [];
    const testQueries = ['a', 'test', 'model', '', 'comp', 'anim', ''];
    
    for (let i = 0; i < times; i++) {
      const query = testQueries[i % testQueries.length];
      const start = performance.now();
      
      // Simulate typing
      input.focus();
      input.value = query;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      
      await sleep(100); // Wait for filter to apply
      filterTimes.push(performance.now() - start);
      await sleep(200);
    }
    
    // Clear filter
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    
    return filterTimes;
  }

  // Simulate clicks
  async function simulateClicks(elements, times) {
    const clickTimes = [];
    
    for (let i = 0; i < Math.min(times, elements.length); i++) {
      const el = elements[i % elements.length];
      const start = performance.now();
      
      el.click();
      await sleep(50);
      clickTimes.push(performance.now() - start);
      await sleep(100);
      
      // Click elsewhere to deselect
      document.body.click();
      await sleep(50);
    }
    return clickTimes;
  }

  // Main benchmark runner
  async function runBenchmarks() {
    console.log('🚀 ShotGrid Automated Benchmark Starting...');
    console.log('─'.repeat(50));
    
    // Setup FPS measurement
    const frames = [];
    let lastTime = performance.now();
    let measuring = true;
    
    function measureFrame() {
      if (!measuring) return;
      const now = performance.now();
      frames.push(now - lastTime);
      lastTime = now;
      requestAnimationFrame(measureFrame);
    }
    requestAnimationFrame(measureFrame);
    
    // Setup long task observer
    const longTasks = [];
    let observer;
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTasks.push(entry.duration);
        }
      });
      observer.observe({ entryTypes: ['longtask'] });
    } catch (e) {
      console.warn('Long task observer not supported');
    }
    
    // Find UI elements
    const scrollContainers = findScrollContainers();
    const filterInputs = findFilterInputs();
    const clickables = findClickableElements();
    
    console.log('Found:', scrollContainers.length, 'scroll containers,', 
                filterInputs.length, 'filter inputs,', 
                clickables.length, 'clickable elements');
    
    // Run scroll benchmark
    console.log('⏱️  Testing scroll performance...');
    if (scrollContainers.length > 0) {
      const scrollTimes = await simulateScroll(scrollContainers[0], 20);
      results.tests.scroll = { name: 'Scroll', ...stats(scrollTimes), unit: 'ms' };
      console.log('   ✓ Scroll: avg=' + results.tests.scroll.avg + 'ms');
    }
    
    await sleep(500);
    
    // Run filter benchmark
    console.log('⏱️  Testing filter performance...');
    if (filterInputs.length > 0) {
      const filterTimes = await simulateFilter(filterInputs[0], 10);
      results.tests.filter = { name: 'Filter', ...stats(filterTimes), unit: 'ms' };
      console.log('   ✓ Filter: avg=' + results.tests.filter.avg + 'ms');
    } else {
      console.log('   ⚠️  No filter inputs found');
    }
    
    await sleep(500);
    
    // Run click benchmark
    console.log('⏱️  Testing click/select performance...');
    if (clickables.length > 0) {
      const clickTimes = await simulateClicks(clickables, 15);
      results.tests.click = { name: 'Click/Select', ...stats(clickTimes), unit: 'ms' };
      console.log('   ✓ Click: avg=' + results.tests.click.avg + 'ms');
    }
    
    await sleep(500);
    
    // Additional scroll during measurement
    console.log('⏱️  Measuring sustained FPS...');
    const fpsStart = performance.now();
    while (performance.now() - fpsStart < 3000) {
      if (scrollContainers.length > 0) {
        scrollContainers[0].scrollTop = Math.random() * 500;
      }
      await sleep(16);
    }
    
    // Stop measurements
    measuring = false;
    if (observer) observer.disconnect();
    
    // Calculate FPS
    const validFrames = frames.filter(f => f > 0 && f < 200);
    const avgFrameTime = validFrames.length > 0 
      ? validFrames.reduce((a, b) => a + b, 0) / validFrames.length 
      : 16.67;
    
    results.tests.fps = {
      name: 'Average FPS',
      fps: Math.round(1000 / avgFrameTime),
      avgFrameTime: Math.round(avgFrameTime * 100) / 100,
      droppedFrames: frames.filter(f => f > 33).length,
      totalFrames: frames.length,
      unit: 'fps'
    };
    
    results.tests.longTasks = {
      name: 'Long Tasks (>50ms)',
      count: longTasks.length,
      ...stats(longTasks),
      unit: 'ms'
    };
    
    // Memory
    if (performance.memory) {
      results.tests.memory = {
        name: 'Memory Usage',
        heapUsed: Math.round(performance.memory.usedJSHeapSize / 1024 / 1024 * 100) / 100,
        heapTotal: Math.round(performance.memory.totalJSHeapSize / 1024 / 1024 * 100) / 100,
        unit: 'MB'
      };
    }
    
    // Count visible tasks
    const taskRows = document.querySelectorAll('tr[data-entity-id], [class*="task-row"], .sg_row');
    results.taskCount = taskRows.length || 'unknown';
    
    // Report results
    console.log('─'.repeat(50));
    console.log('✅ ShotGrid Benchmark Complete!');
    console.log('');
    console.log('📊 Results Summary:');
    console.log('   FPS:', results.tests.fps.fps, '(avg frame:', results.tests.fps.avgFrameTime + 'ms)');
    console.log('   Dropped Frames:', results.tests.fps.droppedFrames, 'of', results.tests.fps.totalFrames);
    console.log('   Long Tasks:', results.tests.longTasks.count, '(avg:', results.tests.longTasks.avg + 'ms)');
    if (results.tests.scroll) console.log('   Scroll:', results.tests.scroll.avg + 'ms avg');
    if (results.tests.filter) console.log('   Filter:', results.tests.filter.avg + 'ms avg');
    if (results.tests.click) console.log('   Click:', results.tests.click.avg + 'ms avg');
    if (results.tests.memory) console.log('   Memory:', results.tests.memory.heapUsed + 'MB');
    console.log('   Tasks visible:', results.taskCount);
    console.log('');
    console.log('─'.repeat(50));
    console.log('📋 JSON (copy this to import into Up to Speed):');
    console.log('');
    console.log(JSON.stringify(results, null, 2));
    console.log('');
    console.log('💡 Tip: Results also saved to window.sgBenchmarkResults');
    
    window.sgBenchmarkResults = results;
    return results;
  }
  
  // Run it
  runBenchmarks();
})();
`;
  }

  // ============================================================================
  // UI Integration
  // ============================================================================

  function createBenchmarkUI() {
    const existing = document.getElementById('benchmarkPanel');
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.id = 'benchmarkPanel';
    panel.innerHTML = `
      <style>
        #benchmarkPanel {
          position: fixed;
          bottom: 20px;
          right: 20px;
          background: #1a1a2e;
          border: 1px solid #333;
          border-radius: 12px;
          padding: 16px;
          z-index: 10000;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          color: #e0e0e0;
          min-width: 280px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.4);
        }
        #benchmarkPanel h3 {
          margin: 0 0 12px 0;
          font-size: 14px;
          color: #9ef7c7;
        }
        #benchmarkPanel .btn {
          background: #2d2d44;
          border: 1px solid #444;
          color: #e0e0e0;
          padding: 8px 16px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 13px;
          margin: 4px;
          transition: all 0.2s;
        }
        #benchmarkPanel .btn:hover {
          background: #3d3d54;
          border-color: #9ef7c7;
        }
        #benchmarkPanel .btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        #benchmarkPanel .btn.primary {
          background: #2a5a3a;
          border-color: #9ef7c7;
        }
        #benchmarkPanel .progress {
          height: 4px;
          background: #333;
          border-radius: 2px;
          margin: 12px 0;
          overflow: hidden;
        }
        #benchmarkPanel .progress-bar {
          height: 100%;
          background: #9ef7c7;
          width: 0%;
          transition: width 0.3s;
        }
        #benchmarkPanel .status {
          font-size: 12px;
          color: #888;
          margin-top: 8px;
        }
        #benchmarkPanel .close {
          position: absolute;
          top: 8px;
          right: 12px;
          background: none;
          border: none;
          color: #666;
          cursor: pointer;
          font-size: 18px;
        }
        #benchmarkPanel .close:hover { color: #fff; }
      </style>
      <button class="close" onclick="document.getElementById('benchmarkPanel').remove()">×</button>
      <h3>⚡ Benchmark Runner</h3>
      <div>
        <button class="btn primary" id="runBenchmarkBtn">Run Full Suite</button>
        <button class="btn" id="exportBenchmarkBtn" disabled>Export JSON</button>
        <button class="btn" id="saveToRepoBtn" disabled>Save to Repo</button>
      </div>
      <div class="progress">
        <div class="progress-bar" id="benchmarkProgress"></div>
      </div>
      <div class="status" id="benchmarkStatus">Ready to run (${state.tasks.length} tasks loaded)</div>
      <div style="margin-top: 12px; border-top: 1px solid #333; padding-top: 12px;">
        <button class="btn" id="viewResultsBtn">View Results</button>
        <button class="btn" id="sgScriptBtn">ShotGrid Script</button>
      </div>
    `;
    document.body.appendChild(panel);

    // Event handlers
    document.getElementById('runBenchmarkBtn').onclick = async () => {
      const btn = document.getElementById('runBenchmarkBtn');
      const exportBtn = document.getElementById('exportBenchmarkBtn');
      const saveBtn = document.getElementById('saveToRepoBtn');
      btn.disabled = true;
      exportBtn.disabled = true;
      saveBtn.disabled = true;
      
      window.benchmarkRunner.onProgress = (progress, test) => {
        document.getElementById('benchmarkProgress').style.width = progress + '%';
        document.getElementById('benchmarkStatus').textContent = `Running: ${test}... (${progress}%)`;
      };
      
      await window.benchmarkRunner.run();
      
      btn.disabled = false;
      exportBtn.disabled = false;
      saveBtn.disabled = false;
      document.getElementById('benchmarkStatus').textContent = 'Complete! Results saved.';
    };

    document.getElementById('exportBenchmarkBtn').onclick = () => {
      window.benchmarkRunner.exportResults('json');
    };

    document.getElementById('saveToRepoBtn').onclick = async () => {
      await window.benchmarkRunner.saveToRepo();
      document.getElementById('benchmarkStatus').textContent = 'Downloaded results-data.json - save to benchmarks/';
    };

    document.getElementById('viewResultsBtn').onclick = () => {
      window.open('benchmarks/results.html', '_blank');
    };

    document.getElementById('sgScriptBtn').onclick = () => {
      const script = generateShotGridBenchmarkScript();
      navigator.clipboard.writeText(script).then(() => {
        alert('ShotGrid benchmark script copied to clipboard!\n\nPaste it in the browser console on your ShotGrid page.');
      });
    };
  }

  // ============================================================================
  // Exports
  // ============================================================================

  window.benchmarkRunner = new BenchmarkRunner();
  window.benchmarks = benchmarks;
  window.showBenchmarkUI = createBenchmarkUI;
  window.generateShotGridBenchmarkScript = generateShotGridBenchmarkScript;

  // Auto-show UI if loaded with ?benchmark=1
  if (new URLSearchParams(window.location.search).has('benchmark')) {
    setTimeout(createBenchmarkUI, 1000);
  }

  console.log('📊 Benchmark runner loaded. Use window.benchmarkRunner.run() or window.showBenchmarkUI()');
})();
