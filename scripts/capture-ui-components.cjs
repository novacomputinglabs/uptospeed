#!/usr/bin/env node
/*
 * Capture high-quality screenshots of key UI components and views.
 * Output:
 *   output/playwright/component-screenshots/<timestamp>/
 */

const fsp = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

function printUsage() {
  console.log(
    "Usage: node scripts/capture-ui-components.cjs [--out <absolute-or-relative-dir>] [--url <base-url>] [--themes <comma-separated-theme-ids>] [--keep-storage] [--skip-gifs] [--motion-formats <gif,webm,mp4>] [--motion-speed <slow,normal,fast>]"
  );
}

function parseArgs(argv) {
  const args = {
    outDir: null,
    baseUrl: null,
    themes: null,
    keepStorage: false,
    captureGifs: true,
    motionFormats: null,
    motionSpeed: "slow"
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--out") {
      if (i + 1 >= argv.length) {
        throw new Error("Missing value for --out");
      }
      args.outDir = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--url") {
      if (i + 1 >= argv.length) {
        throw new Error("Missing value for --url");
      }
      args.baseUrl = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--themes") {
      if (i + 1 >= argv.length) {
        throw new Error("Missing value for --themes");
      }
      args.themes = argv[i + 1]
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      i += 1;
      continue;
    }
    if (arg === "--keep-storage") {
      args.keepStorage = true;
      continue;
    }
    if (arg === "--skip-gifs") {
      args.captureGifs = false;
      continue;
    }
    if (arg === "--motion-formats") {
      if (i + 1 >= argv.length) {
        throw new Error("Missing value for --motion-formats");
      }
      args.motionFormats = argv[i + 1]
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
      i += 1;
      continue;
    }
    if (arg === "--motion-speed") {
      if (i + 1 >= argv.length) {
        throw new Error("Missing value for --motion-speed");
      }
      args.motionSpeed = (argv[i + 1] || "").toString().trim().toLowerCase();
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function timestampString() {
  return new Date().toISOString().replace(/[:]/g, "-").replace(/\.\d{3}Z$/, "Z");
}

function toRelativePosix(fromDir, targetPath) {
  return path.relative(fromDir, targetPath).split(path.sep).join("/");
}

function makeSafeFileName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeThemeId(value) {
  return (value || "").toString().trim().toLowerCase();
}

function formatThemeTag(themeId) {
  return `theme-${makeSafeFileName(themeId || "unknown")}`;
}

function normalizeMotionFormats(formats, captureGifs) {
  const allowed = new Set(["gif", "webm", "mp4"]);
  const fallback = captureGifs ? ["webm", "mp4", "gif"] : ["webm", "mp4"];
  const source = Array.isArray(formats) && formats.length ? formats : fallback;
  const seen = new Set();
  const out = [];
  for (const format of source) {
    const normalized = (format || "").toString().trim().toLowerCase();
    if (!allowed.has(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

const MOTION_SPEED_PROFILES = {
  slow: {
    label: "Slow",
    waitMultiplier: 2.0,
    dragSteps: 36,
    dragStepDelayMs: 22
  },
  normal: {
    label: "Normal",
    waitMultiplier: 1.35,
    dragSteps: 24,
    dragStepDelayMs: 16
  },
  fast: {
    label: "Fast",
    waitMultiplier: 0.9,
    dragSteps: 16,
    dragStepDelayMs: 10
  }
};

function resolveMotionProfile(speedId) {
  const key = (speedId || "").toString().trim().toLowerCase();
  if (MOTION_SPEED_PROFILES[key]) {
    return { id: key, ...MOTION_SPEED_PROFILES[key] };
  }
  return { id: "slow", ...MOTION_SPEED_PROFILES.slow };
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function runCommand(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.stdio || "pipe"
    });

    let stderr = "";
    let stdout = "";
    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
    }

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ code, stdout, stderr });
        return;
      }
      const err = new Error(
        `${command} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`
      );
      err.code = code;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}

async function hasCommand(command) {
  try {
    await runCommand(command, ["-version"]);
    return true;
  } catch (_err) {
    return false;
  }
}

function resolveFilePath(rootDir, requestPath) {
  const normalized = path.normalize(requestPath).replace(/^(\.\.(\/|\\|$))+/, "");
  const resolved = path.resolve(rootDir, `.${path.sep}${normalized}`);
  if (!resolved.startsWith(rootDir)) return null;
  return resolved;
}

async function startStaticServer(rootDir) {
  const server = http.createServer(async (req, res) => {
    try {
      const parsed = new URL(req.url || "/", "http://127.0.0.1");
      let requestPath = decodeURIComponent(parsed.pathname);
      if (requestPath === "/") requestPath = "/index.html";

      let filePath = resolveFilePath(rootDir, requestPath);
      if (!filePath) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        res.end("Forbidden");
        return;
      }

      let stat = null;
      try {
        stat = await fsp.stat(filePath);
      } catch (_err) {
        stat = null;
      }

      if (stat && stat.isDirectory()) {
        filePath = path.join(filePath, "index.html");
      }

      const fileBuffer = await fsp.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mime = MIME_TYPES[ext] || "application/octet-stream";
      res.writeHead(200, { "content-type": mime });
      res.end(fileBuffer);
    } catch (err) {
      const status = err && err.code === "ENOENT" ? 404 : 500;
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
      res.end(status === 404 ? "Not Found" : `Server Error: ${err.message}`);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address !== "object") {
    throw new Error("Failed to start local server");
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}/index.html`
  };
}

async function waitVisible(page, selector, timeout = 20000) {
  await page.locator(selector).first().waitFor({ state: "visible", timeout });
}

async function captureFull(page, fullDir, manifest, name, stateLabel, themeId) {
  const fileName = `${makeSafeFileName(name)}.png`;
  const outPath = path.join(fullDir, fileName);
  await page.screenshot({
    path: outPath,
    fullPage: false,
    animations: "disabled"
  });
  manifest.shots.push({
    type: "full",
    name,
    state: stateLabel,
    theme: themeId,
    file: toRelativePosix(manifest.outputDir, outPath)
  });
  return outPath;
}

async function captureComponent(page, componentsDir, manifest, name, selector, stateLabel, themeId) {
  const locator = page.locator(selector).first();
  const count = await locator.count();
  if (!count) {
    throw new Error(`Selector not found: ${selector}`);
  }
  await locator.scrollIntoViewIfNeeded();
  await locator.waitFor({ state: "visible", timeout: 15000 });

  const fileName = `${makeSafeFileName(name)}.png`;
  const outPath = path.join(componentsDir, fileName);
  await locator.screenshot({
    path: outPath,
    animations: "disabled"
  });

  manifest.shots.push({
    type: "component",
    name,
    state: stateLabel,
    theme: themeId,
    selector,
    file: toRelativePosix(manifest.outputDir, outPath)
  });
  return outPath;
}

async function detectThemes(page) {
  const discovered = await page.evaluate(() => {
    const select = document.getElementById("settingsTheme");
    if (!select || !Array.isArray([...select.options])) return [];
    return [...select.options]
      .map((option) => ({
        id: (option.value || "").toString().trim().toLowerCase(),
        label: (option.textContent || option.value || "").toString().trim()
      }))
      .filter((theme) => theme.id);
  });
  if (Array.isArray(discovered) && discovered.length > 0) {
    return discovered;
  }
  return [
    { id: "default", label: "Default" },
    { id: "classic", label: "Classic" },
    { id: "light", label: "Light" }
  ];
}

async function applyThemeOnPage(page, themeId) {
  await page.evaluate((nextThemeId) => {
    const theme = (nextThemeId || "").toString();
    if (typeof globalThis.applyTheme === "function") {
      globalThis.applyTheme(theme);
    } else {
      document.body.classList.remove("theme-classic", "theme-light");
      if (theme === "classic") document.body.classList.add("theme-classic");
      if (theme === "light") document.body.classList.add("theme-light");
    }

    const select = document.getElementById("settingsTheme");
    if (select) select.value = theme;
  }, themeId);
  await page.waitForTimeout(250);
}

async function resetUi(page) {
  await page.evaluate(() => {
    const call = (fnName, ...args) => {
      const fn = globalThis[fnName];
      if (typeof fn === "function") {
        try {
          return fn(...args);
        } catch (_err) {}
      }
      return undefined;
    };

    [
      "closeEditModal",
      "closeCreateModal",
      "closeSubmitModal",
      "closeSettingsModal",
      "closeShortcutsModal",
      "closeBalanceModal",
      "closeSpotlight",
      "closeGanttChart",
      "closeRoundsMode",
      "closeOnboardingModal",
      "closeAssetDetail",
      "closeColumnConfig"
    ].forEach((fnName) => call(fnName));

    const sprintPanel = document.getElementById("sprintPanel");
    if (sprintPanel) sprintPanel.classList.remove("open");

    const workloadPanel = document.getElementById("workloadPanel");
    if (workloadPanel) workloadPanel.classList.remove("open");

    const dropOverlay = document.getElementById("dropOverlay");
    if (dropOverlay) dropOverlay.classList.remove("open");

    document.querySelectorAll(".custom-select.open").forEach((el) => el.classList.remove("open"));
    document.body.style.overflow = "";

    if (globalThis.ShotgridKanbanAPI && typeof globalThis.ShotgridKanbanAPI.clearFilters === "function") {
      globalThis.ShotgridKanbanAPI.clearFilters();
    }
    call("setViewMode", "kanban");
    call("renderBoard");

    const toast = document.getElementById("toast");
    if (toast) {
      toast.classList.remove("show", "success", "error");
    }
  });
  await page.waitForTimeout(300);
}

async function setViewMode(page, mode) {
  await page.evaluate((viewMode) => {
    if (typeof globalThis.setViewMode === "function") {
      globalThis.setViewMode(viewMode);
    }
  }, mode);
  await page.waitForTimeout(300);
}

async function shapeWorkloadBalanceForShowcase(page) {
  const result = await page.evaluate(() => {
    if (typeof globalThis.renderWorkloadPanel === "function") {
      globalThis.renderWorkloadPanel();
    }

    const rows = Array.from(document.querySelectorAll("#workloadContent .workload-row"));
    if (rows.length < 3) {
      return { ok: false, reason: "Need at least three artists in workload table." };
    }

    const headerWeekCols = Array.from(document.querySelectorAll("#workloadContent .workload-header-row .workload-week-col"));
    const fallbackWeekCount = headerWeekCols.length;
    if (fallbackWeekCount === 0) {
      return { ok: false, reason: "No workload week columns available." };
    }

    const weekKeys = headerWeekCols.map((_, index) => `demo-week-${index + 1}`);

    const applyCellValue = (cell, percent, status, artistName, weekKey, taskIdSeed) => {
      cell.classList.remove("under", "full", "over", "critical");
      cell.classList.add("clickable");
      cell.classList.add(status);
      cell.dataset.artist = artistName;
      cell.dataset.week = weekKey;
      cell.dataset.taskIds = `demo-${taskIdSeed}`;
      cell.title = `${artistName}: ${percent}%`;
      cell.innerHTML = `${percent}%<span class="workload-task-count">1 task</span>`;
    };

    rows.forEach((row, rowIndex) => {
      const artistName = (row.querySelector(".workload-artist-name")?.textContent || `Artist ${rowIndex + 1}`).trim();
      const weekCols = Array.from(row.querySelectorAll(".workload-week-col"));
      const targetCols = weekCols.length > 0 ? weekCols : [];

      row.classList.remove("has-overallocation");
      const isOrange = rowIndex === 1;
      const isRed = rowIndex === 2;
      const percent = isRed ? 130 : isOrange ? 110 : 100;
      const status = isRed ? "critical" : isOrange ? "over" : "full";

      targetCols.forEach((weekCol, colIndex) => {
        let cell = weekCol.querySelector(".workload-cell");
        if (!cell) {
          cell = document.createElement("div");
          weekCol.innerHTML = "";
          weekCol.appendChild(cell);
        }
        applyCellValue(cell, percent, status, artistName, weekKeys[colIndex] || `demo-week-${colIndex + 1}`, `${rowIndex + 1}-${colIndex + 1}`);
      });

      if (isOrange || isRed) {
        row.classList.add("has-overallocation");
      }
    });

    const overallocatedCount = document.getElementById("overallocatedCount");
    if (overallocatedCount) overallocatedCount.textContent = "2";
    const artistCount = document.getElementById("artistCount");
    if (artistCount) artistCount.textContent = String(rows.length);

    return { ok: true };
  });

  if (!result || !result.ok) {
    throw new Error(result?.reason || "Could not shape workload balance showcase.");
  }
}

async function preparePageForCapture(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await waitVisible(page, "#board .column");
  await page
    .waitForFunction(() => {
      if (!document.fonts || !document.fonts.ready) return true;
      return document.fonts.status === "loaded";
    }, null, { timeout: 30000 })
    .catch(() => {});
  await page.waitForTimeout(500);
}

async function pauseForMotion(page, baseMs, motionProfile) {
  const multiplier = Number.isFinite(motionProfile?.waitMultiplier) ? motionProfile.waitMultiplier : 1;
  const ms = Math.max(0, Math.round(baseMs * multiplier));
  await page.waitForTimeout(ms);
}

function buildMotionBaseName(name, themeId) {
  return `${makeSafeFileName(name)}-${makeSafeFileName(themeId)}`;
}

async function convertVideoToGif(videoPath, gifPath, options = {}) {
  const fps = Number.isFinite(options.fps) ? options.fps : 12;
  const width = Number.isFinite(options.width) ? options.width : 1280;
  const filter = `fps=${fps},scale=${width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5`;
  await runCommand("ffmpeg", [
    "-y",
    "-i",
    videoPath,
    "-filter_complex",
    filter,
    "-loop",
    "0",
    gifPath
  ]);
}

async function convertVideoToMp4(videoPath, mp4Path, options = {}) {
  const fps = Number.isFinite(options.fps) ? options.fps : 24;
  const width = Number.isFinite(options.width) ? options.width : 1600;
  await runCommand("ffmpeg", [
    "-y",
    "-i",
    videoPath,
    "-vf",
    `fps=${fps},scale=${width}:-2:flags=lanczos,format=yuv420p`,
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "24",
    "-movflags",
    "+faststart",
    mp4Path
  ]);
}

async function exportMotionFormats(videoPath, outputBasePath, formats, options = {}) {
  const outputs = [];
  for (const format of formats) {
    if (format === "webm") {
      const outPath = `${outputBasePath}.webm`;
      await fsp.copyFile(videoPath, outPath);
      outputs.push({ format, path: outPath });
      continue;
    }
    if (format === "gif") {
      const outPath = `${outputBasePath}.gif`;
      await convertVideoToGif(videoPath, outPath, options.gif || {});
      outputs.push({ format, path: outPath });
      continue;
    }
    if (format === "mp4") {
      const outPath = `${outputBasePath}.mp4`;
      await convertVideoToMp4(videoPath, outPath, options.mp4 || {});
      outputs.push({ format, path: outPath });
    }
  }
  return outputs;
}

async function recordMotionClip(browser, options) {
  const {
    baseUrl,
    themeId,
    outputBasePath,
    interaction,
    keepStorage = false,
    formats = ["webm", "mp4", "gif"],
    viewport = { width: 1920, height: 1080 },
    motionProfile = resolveMotionProfile("slow")
  } = options;

  const tempVideoDir = await fsp.mkdtemp(path.join(os.tmpdir(), "uts-motion-video-"));
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    recordVideo: {
      dir: tempVideoDir,
      size: viewport
    }
  });
  let videoPath = null;
  try {
    await context.addInitScript(({ shouldClearStorage, nextThemeId }) => {
      const theme = (nextThemeId || "").toString().trim().toLowerCase();
      try {
        if (shouldClearStorage) {
          localStorage.clear();
          sessionStorage.clear();
        }
      } catch (_err) {}

      try {
        const settingsKey = "vfx_kanban_settings";
        const currentRaw = localStorage.getItem(settingsKey);
        const current = currentRaw ? JSON.parse(currentRaw) : {};
        const merged = { ...(current || {}), theme: theme || "default" };
        localStorage.setItem(settingsKey, JSON.stringify(merged));
      } catch (_err) {}

      const applyThemeClass = () => {
        const body = document.body;
        if (!body) return;
        body.classList.remove("theme-classic", "theme-light");
        if (theme === "classic") body.classList.add("theme-classic");
        else if (theme === "light") body.classList.add("theme-light");
      };
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", applyThemeClass, { once: true });
      } else {
        applyThemeClass();
      }
    }, { shouldClearStorage: !keepStorage, nextThemeId: themeId });

    const page = await context.newPage();
    await preparePageForCapture(page, baseUrl);
    await applyThemeOnPage(page, themeId);
    await resetUi(page);
    await interaction(page);
    await pauseForMotion(page, 350, motionProfile);

    const video = page.video();
    await page.close();
    videoPath = await video.path();
  } finally {
    await context.close();
  }

  try {
    if (!videoPath) {
      throw new Error("Failed to produce Playwright motion clip.");
    }
    return await exportMotionFormats(videoPath, outputBasePath, formats, {
      gif: { width: 1280, fps: 14 },
      mp4: { width: 1600, fps: 24 }
    });
  } finally {
    await fsp.rm(tempVideoDir, { recursive: true, force: true });
  }
}

async function dragElementBy(page, selector, dx, dy = 0, motionProfile = resolveMotionProfile("slow")) {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: "visible", timeout: 10000 });
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error(`Cannot drag selector without bounding box: ${selector}`);
  const startX = box.x + box.width * 0.6;
  const startY = box.y + box.height * 0.5;
  const steps = Math.max(8, Number.isFinite(motionProfile?.dragSteps) ? Math.round(motionProfile.dragSteps) : 18);
  const stepDelay = Math.max(4, Number.isFinite(motionProfile?.dragStepDelayMs) ? Math.round(motionProfile.dragStepDelayMs) : 16);
  await page.mouse.move(startX, startY);
  await pauseForMotion(page, 60, motionProfile);
  await page.mouse.down();
  for (let step = 1; step <= steps; step += 1) {
    const x = startX + (dx * step) / steps;
    const y = startY + (dy * step) / steps;
    await page.mouse.move(x, y);
    await page.waitForTimeout(stepDelay);
  }
  await page.mouse.up();
  await pauseForMotion(page, 80, motionProfile);
}

async function captureThemeMotion(browser, baseUrl, theme, themeDir, manifest, keepStorage, motionFormats, motionProfile) {
  const themeId = normalizeThemeId(theme.id);
  const motionDir = path.join(themeDir, "motion");
  await ensureDir(motionDir);
  const wait = async (page, ms) => pauseForMotion(page, ms, motionProfile);

  const registerMotion = async (name, description, interaction) => {
    await safeStep(`[${themeId}] Motion ${name}`, async () => {
      const outputBasePath = path.join(motionDir, buildMotionBaseName(name, themeId));
      const outputs = await recordMotionClip(browser, {
        baseUrl,
        themeId,
        outputBasePath,
        keepStorage,
        formats: motionFormats,
        motionProfile,
        interaction
      });

      manifest.motion.push({
        name,
        description,
        theme: themeId,
        files: outputs.map((entry) => ({
          format: entry.format,
          file: toRelativePosix(manifest.outputDir, entry.path)
        }))
      });

      for (const entry of outputs) {
        if (entry.format !== "gif") continue;
        manifest.gifs.push({
          name,
          description,
          theme: themeId,
          file: toRelativePosix(manifest.outputDir, entry.path)
        });
      }
    }, manifest);
  };

  await registerMotion("quick-filtering", "Search and department filtering flow in the main board.", async (page) => {
    await setViewMode(page, "kanban");
    await waitVisible(page, "#board .column");
    await page.fill("#filterSearch", "model");
    await wait(page, 450);
    await page.fill("#filterSearch", "rig");
    await wait(page, 450);
    await page.evaluate(() => {
      const dept = document.getElementById("filterDept");
      if (dept && dept.options.length > 1) {
        dept.value = dept.options[1].value;
        if (typeof globalThis.renderBoard === "function") globalThis.renderBoard();
      }
    });
    await wait(page, 600);
    await page.evaluate(() => {
      if (globalThis.ShotgridKanbanAPI?.clearFilters) {
        globalThis.ShotgridKanbanAPI.clearFilters();
      }
    });
    await wait(page, 450);
  });

  await registerMotion("view-switching", "Switch between board views and timeline overlays.", async (page) => {
    await setViewMode(page, "kanban");
    await wait(page, 350);
    await setViewMode(page, "list");
    await wait(page, 550);
    await page.evaluate(() => {
      if (typeof globalThis.openGanttChart === "function") {
        globalThis.openGanttChart();
      }
    });
    await waitVisible(page, "#ganttOverlay.open");
    await wait(page, 700);
    await page.evaluate(() => {
      if (typeof globalThis.closeGanttChart === "function") {
        globalThis.closeGanttChart();
      }
    });
    await wait(page, 300);
    await page.evaluate(() => {
      if (typeof globalThis.openRoundsMode === "function") {
        globalThis.openRoundsMode();
      }
    });
    await waitVisible(page, "#roundsOverlay.open");
    await wait(page, 700);
    await page.evaluate(() => {
      if (typeof globalThis.closeRoundsMode === "function") {
        globalThis.closeRoundsMode();
      }
    });
    await setViewMode(page, "kanban");
    await wait(page, 400);
  });

  await registerMotion("asset-detail-tabs", "Open one asset and switch between tasks, gantt, and notes tabs.", async (page) => {
    const opened = await page.evaluate(() => {
      const assets = globalThis.ShotgridKanbanAPI?.getAssets?.() || [];
      if (!assets.length) return false;
      if (typeof globalThis.openAssetDetail === "function") {
        globalThis.openAssetDetail(assets[0].name);
        return true;
      }
      return false;
    });
    if (!opened) throw new Error("Asset detail not available");
    await waitVisible(page, "#assetDetailOverlay.open");
    await wait(page, 500);
    await page.evaluate(() => {
      if (typeof globalThis.setAssetDetailTab === "function") globalThis.setAssetDetailTab("gantt");
    });
    await wait(page, 700);
    await page.evaluate(() => {
      if (typeof globalThis.setAssetDetailTab === "function") globalThis.setAssetDetailTab("notes");
    });
    await wait(page, 700);
    await page.evaluate(() => {
      if (typeof globalThis.setAssetDetailTab === "function") globalThis.setAssetDetailTab("tasks");
    });
    await wait(page, 600);
    await page.evaluate(() => {
      if (typeof globalThis.closeAssetDetail === "function") globalThis.closeAssetDetail();
    });
    await wait(page, 300);
  });

  await registerMotion("command-palette", "Spotlight search and quick command navigation.", async (page) => {
    await page.evaluate(() => {
      if (typeof globalThis.openSpotlight === "function") {
        globalThis.openSpotlight();
      }
    });
    await waitVisible(page, "#spotlightBackdrop.open");
    await page.fill("#spotlightInput", "theme");
    await wait(page, 600);
    await page.keyboard.press("ArrowDown");
    await wait(page, 250);
    await page.keyboard.press("ArrowDown");
    await wait(page, 250);
    await page.fill("#spotlightInput", "rounds");
    await wait(page, 600);
    await page.keyboard.press("Escape");
    await wait(page, 300);
  });

  await registerMotion("asset-dept-group-switch", "Filter by asset+department and switch to a second combination with different grouping.", async (page) => {
    await setViewMode(page, "list");
    await waitVisible(page, "#listBody .list-row");
    const filterData = await page.evaluate(() => {
      const assets = (globalThis.ShotgridKanbanAPI?.getAssets?.() || []).map((entry) => entry.name).filter(Boolean);
      const depts = (globalThis.ShotgridKanbanAPI?.getDepartments?.() || []).map((entry) => entry.name).filter(Boolean);
      return {
        assets: [...new Set(assets)].slice(0, 3),
        depts: [...new Set(depts)].slice(0, 3)
      };
    });
    if ((filterData.assets || []).length < 2 || (filterData.depts || []).length < 2) {
      throw new Error("Need at least two assets and two departments for grouped filter demo.");
    }
    await page.evaluate(({ firstAsset, firstDept }) => {
      globalThis.ShotgridKanbanAPI?.setFilters?.({
        asset: firstAsset,
        department: firstDept,
        search: "",
        sprintOnly: false
      });
      if (typeof globalThis.setListGroupBy === "function") globalThis.setListGroupBy("Link");
    }, { firstAsset: filterData.assets[0], firstDept: filterData.depts[0] });
    await wait(page, 900);

    await page.evaluate(({ secondAsset, secondDept }) => {
      globalThis.ShotgridKanbanAPI?.setFilters?.({
        asset: secondAsset,
        department: secondDept,
        search: "",
        sprintOnly: false
      });
      if (typeof globalThis.setListGroupBy === "function") globalThis.setListGroupBy("Pipeline Step");
    }, { secondAsset: filterData.assets[1], secondDept: filterData.depts[1] });
    await wait(page, 900);

    await page.evaluate(() => {
      if (typeof globalThis.setListGroupBy === "function") globalThis.setListGroupBy("Assigned To");
    });
    await wait(page, 700);
    await page.evaluate(() => {
      globalThis.ShotgridKanbanAPI?.clearFilters?.();
      if (typeof globalThis.setListGroupBy === "function") globalThis.setListGroupBy("");
    });
    await wait(page, 500);
  });

  await registerMotion("gantt-drag-reschedule", "Drag task bars in Gantt to show instant rescheduling updates.", async (page) => {
    await page.evaluate(() => {
      if (typeof globalThis.openGanttChart === "function") globalThis.openGanttChart();
    });
    await waitVisible(page, "#ganttOverlay.open");
    await waitVisible(page, "#ganttOverlay .gantt-bar[data-id]");
    await dragElementBy(page, "#ganttOverlay .gantt-bar[data-id]", 190, 0, motionProfile);
    await wait(page, 550);
    await dragElementBy(page, "#ganttOverlay .gantt-bar[data-id]", -120, 0, motionProfile);
    await wait(page, 550);
    await page.evaluate(() => {
      if (typeof globalThis.closeGanttChart === "function") globalThis.closeGanttChart();
    });
    await wait(page, 350);
  });

  await registerMotion("list-gantt-drag-sync", "Drag list-gantt bars while row data and timeline stay synchronized.", async (page) => {
    await setViewMode(page, "list");
    await waitVisible(page, "#listGanttTimeline .list-gantt-bar[data-id]");
    await dragElementBy(page, "#listGanttTimeline .list-gantt-bar[data-id]", 160, 0, motionProfile);
    await wait(page, 500);
    await dragElementBy(page, "#listGanttTimeline .list-gantt-bar[data-id]", -100, 0, motionProfile);
    await wait(page, 650);
  });
}

async function safeStep(name, fn, manifest) {
  process.stdout.write(`[capture] ${name}\n`);
  try {
    await fn();
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    process.stdout.write(`[capture] Warning in "${name}": ${message}\n`);
    manifest.warnings.push({ step: name, message });
  }
}

async function captureThemeStates(page, theme, runFolder, manifest, options = {}) {
  const browser = options.browser;
  const baseUrl = options.baseUrl;
  const captureMotion = options.captureMotion !== false;
  const keepStorage = options.keepStorage === true;
  const motionFormats = Array.isArray(options.motionFormats) ? options.motionFormats : ["webm", "mp4", "gif"];
  const motionProfile = options.motionProfile || resolveMotionProfile("slow");
  const themeId = normalizeThemeId(theme.id);
  const themeTag = formatThemeTag(themeId);
  const themeDir = path.join(runFolder, themeTag);
  const fullDir = path.join(themeDir, "full");
  const componentsDir = path.join(themeDir, "components");
  await ensureDir(fullDir);
  await ensureDir(componentsDir);

  await applyThemeOnPage(page, themeId);
  await resetUi(page);

  const startCount = manifest.shots.length;
  const startMotionCount = manifest.motion.length;
  const startGifCount = manifest.gifs.length;
  const step = (name) => `[${themeId}] ${name}`;

  await safeStep(step("Kanban baseline"), async () => {
    const stateName = "kanban-baseline";
    await resetUi(page);
    await setViewMode(page, "kanban");
    await waitVisible(page, "#board .column");
    await captureFull(page, fullDir, manifest, `01-${stateName}`, stateName, themeId);
    await captureComponent(page, componentsDir, manifest, "header", "header", stateName, themeId);
    await captureComponent(page, componentsDir, manifest, "toolbar", ".toolbar", stateName, themeId);
    await captureComponent(
      page,
      componentsDir,
      manifest,
      "kanban-column",
      ".column[data-column='inprogress']",
      stateName,
      themeId
    );
    await captureComponent(page, componentsDir, manifest, "kanban-card", ".column[data-column] .card", stateName, themeId);

    await page.locator(".toolbar .custom-select .custom-select-trigger").first().click();
    await waitVisible(page, ".toolbar .custom-select.open .custom-select-dropdown");
    await captureComponent(
      page,
      componentsDir,
      manifest,
      "toolbar-filter-dropdown",
      ".toolbar .custom-select.open .custom-select-dropdown",
      stateName,
      themeId
    );
    await page.keyboard.press("Escape").catch(() => {});
    await page.mouse.click(10, 10);

    await page.evaluate(() => {
      if (typeof globalThis.showToast === "function") {
        globalThis.showToast("Screenshot capture ready", "success");
      }
    });
    await waitVisible(page, "#toast.show");
    await captureComponent(page, componentsDir, manifest, "toast-notification", "#toast.show", stateName, themeId);
  }, manifest);

  await safeStep(step("Sprint panel"), async () => {
    const stateName = "sprint-panel";
    await resetUi(page);
    await page.evaluate(() => {
      if (typeof globalThis.toggleSprintPanel === "function") {
        globalThis.toggleSprintPanel();
      }
    });
    await waitVisible(page, "#sprintPanel.open");
    await captureFull(page, fullDir, manifest, `02-${stateName}`, stateName, themeId);
    await captureComponent(page, componentsDir, manifest, "sprint-panel", "#sprintPanel.open", stateName, themeId);
  }, manifest);

  await safeStep(step("Workload panel"), async () => {
    const stateName = "workload-panel";
    await resetUi(page);
    await page.evaluate(() => {
      if (typeof globalThis.toggleWorkloadPanel === "function") {
        globalThis.toggleWorkloadPanel();
      }
    });
    await waitVisible(page, "#workloadPanel.open");
    await captureFull(page, fullDir, manifest, `03-${stateName}`, stateName, themeId);
    await captureComponent(page, componentsDir, manifest, "workload-panel", "#workloadPanel.open", stateName, themeId);
    await captureComponent(page, componentsDir, manifest, "workload-grid", "#workloadContent", stateName, themeId);
  }, manifest);

  await safeStep(step("Workload artist balance breakdown"), async () => {
    const stateName = "workload-artist-balance-breakdown";
    await resetUi(page);
    await page.evaluate(() => {
      if (typeof globalThis.toggleWorkloadPanel === "function") {
        globalThis.toggleWorkloadPanel();
      }
    });
    await waitVisible(page, "#workloadPanel.open");
    await shapeWorkloadBalanceForShowcase(page);
    await page.waitForTimeout(250);
    await captureFull(page, fullDir, manifest, `03b-${stateName}`, stateName, themeId);
    await captureComponent(
      page,
      componentsDir,
      manifest,
      "workload-balance-breakdown-grid",
      "#workloadContent",
      stateName,
      themeId
    );
  }, manifest);

  await safeStep(step("List view + list gantt"), async () => {
    const stateName = "list-view";
    await resetUi(page);
    await setViewMode(page, "list");
    await waitVisible(page, "#listBody .list-row");
    await captureFull(page, fullDir, manifest, `04-${stateName}`, stateName, themeId);
    await captureComponent(page, componentsDir, manifest, "list-toolbar", ".list-toolbar", stateName, themeId);
    await captureComponent(page, componentsDir, manifest, "list-table", ".list-view", stateName, themeId);
    await captureComponent(page, componentsDir, manifest, "list-gantt", ".list-gantt-container", stateName, themeId);

    await page.evaluate(() => {
      if (typeof globalThis.openColumnConfig === "function") {
        globalThis.openColumnConfig();
      }
    });
    await waitVisible(page, "#columnConfigModal.open");
    await captureFull(page, fullDir, manifest, "05-list-column-config", stateName, themeId);
    await captureComponent(page, componentsDir, manifest, "column-config-modal", "#columnConfigModal.open .modal", stateName, themeId);
  }, manifest);

  await safeStep(step("List Gantt grouped by assets"), async () => {
    const stateName = "list-gantt-grouped-assets";
    await resetUi(page);
    await setViewMode(page, "list");
    await waitVisible(page, "#listBody .list-row");
    await page.evaluate(() => {
      if (typeof globalThis.setListGroupBy === "function") {
        globalThis.setListGroupBy("Link");
      }
    });
    await waitVisible(page, "#listBody .list-group");
    await waitVisible(page, "#listGanttTimeline .list-gantt-group-summary-bar");
    await page.waitForTimeout(250);
    await captureFull(page, fullDir, manifest, `04b-${stateName}`, stateName, themeId);
    await captureComponent(page, componentsDir, manifest, "list-gantt-grouped-assets", ".list-gantt-container", stateName, themeId);
    await captureComponent(page, componentsDir, manifest, "list-groups-asset", "#listBody .list-group", stateName, themeId);
    await page.evaluate(() => {
      if (typeof globalThis.setListGroupBy === "function") {
        globalThis.setListGroupBy("");
      }
    });
  }, manifest);

  await safeStep(step("Gantt overlay"), async () => {
    const stateName = "gantt-overlay";
    await resetUi(page);
    await page.evaluate(() => {
      if (typeof globalThis.openGanttChart === "function") {
        globalThis.openGanttChart();
      }
    });
    await waitVisible(page, "#ganttOverlay.open");
    await captureFull(page, fullDir, manifest, `06-${stateName}`, stateName, themeId);
    await captureComponent(page, componentsDir, manifest, "gantt-overlay", "#ganttOverlay", stateName, themeId);
    await captureComponent(page, componentsDir, manifest, "gantt-timeline", "#ganttTimeline", stateName, themeId);
  }, manifest);

  await safeStep(step("Rounds overlay"), async () => {
    const stateName = "rounds-overlay";
    await resetUi(page);
    await page.evaluate(() => {
      if (typeof globalThis.openRoundsMode === "function") {
        globalThis.openRoundsMode();
      }
    });
    await waitVisible(page, "#roundsOverlay.open");
    await captureFull(page, fullDir, manifest, `07-${stateName}`, stateName, themeId);
    await captureComponent(page, componentsDir, manifest, "rounds-overlay", "#roundsOverlay", stateName, themeId);
    await captureComponent(page, componentsDir, manifest, "rounds-artist-card", ".rounds-artist-card", stateName, themeId);
  }, manifest);

  await safeStep(step("Create task modal"), async () => {
    const stateName = "create-modal";
    await resetUi(page);
    await page.evaluate(() => {
      if (typeof globalThis.openCreateModal === "function") {
        globalThis.openCreateModal();
      }
    });
    await waitVisible(page, "#createModal.open");
    await captureFull(page, fullDir, manifest, `08-${stateName}`, stateName, themeId);
    await captureComponent(page, componentsDir, manifest, "create-task-modal", "#createModal.open .modal", stateName, themeId);
  }, manifest);

  await safeStep(step("Edit task modal"), async () => {
    const stateName = "edit-modal";
    await resetUi(page);
    const opened = await page.evaluate(() => {
      const tasks = globalThis.ShotgridKanbanAPI?.getTasks?.() || [];
      if (!tasks.length) return false;
      const firstTask = tasks[0];
      if (typeof globalThis.editTask === "function") {
        globalThis.editTask(firstTask.id);
        return true;
      }
      return false;
    });
    if (!opened) {
      throw new Error("Could not open edit modal");
    }
    await waitVisible(page, "#editModal.open");
    await captureFull(page, fullDir, manifest, `09-${stateName}`, stateName, themeId);
    await captureComponent(page, componentsDir, manifest, "edit-task-modal", "#editModal.open .modal", stateName, themeId);
  }, manifest);

  await safeStep(step("Submit modal"), async () => {
    const stateName = "submit-modal";
    await resetUi(page);
    await page.evaluate(() => {
      if (typeof globalThis.openSubmitModal === "function") {
        globalThis.openSubmitModal();
        const include = document.getElementById("includeRoundsReport");
        if (include) {
          include.checked = true;
          if (typeof globalThis.toggleRoundsEmailSection === "function") {
            globalThis.toggleRoundsEmailSection();
          }
        }
      }
    });
    await waitVisible(page, "#submitModal.open");
    await captureFull(page, fullDir, manifest, `10-${stateName}`, stateName, themeId);
    await captureComponent(page, componentsDir, manifest, "submit-modal", "#submitModal.open .modal", stateName, themeId);
  }, manifest);

  await safeStep(step("Settings modal"), async () => {
    const stateName = "settings-modal";
    await resetUi(page);
    await page.evaluate(() => {
      if (typeof globalThis.openSettingsModal === "function") {
        globalThis.openSettingsModal();
      }
    });
    await waitVisible(page, "#settingsModal.open");
    await captureFull(page, fullDir, manifest, `11-${stateName}`, stateName, themeId);
    await captureComponent(page, componentsDir, manifest, "settings-modal", "#settingsModal.open .modal", stateName, themeId);
  }, manifest);

  await safeStep(step("Keyboard shortcuts modal"), async () => {
    const stateName = "shortcuts-modal";
    await resetUi(page);
    await page.evaluate(() => {
      if (typeof globalThis.toggleShortcutsModal === "function") {
        globalThis.toggleShortcutsModal();
      }
    });
    await waitVisible(page, "#shortcutsModal.open");
    await captureFull(page, fullDir, manifest, `12-${stateName}`, stateName, themeId);
    await captureComponent(page, componentsDir, manifest, "shortcuts-modal", "#shortcutsModal.open .modal", stateName, themeId);
  }, manifest);

  await safeStep(step("Spotlight command palette"), async () => {
    const stateName = "spotlight";
    await resetUi(page);
    await page.evaluate(() => {
      if (typeof globalThis.openSpotlight === "function") {
        globalThis.openSpotlight();
      }
    });
    await waitVisible(page, "#spotlightBackdrop.open");
    await page.fill("#spotlightInput", "model");
    await page.waitForTimeout(250);
    await captureFull(page, fullDir, manifest, `13-${stateName}`, stateName, themeId);
    await captureComponent(
      page,
      componentsDir,
      manifest,
      "spotlight-command-palette",
      "#spotlightBackdrop.open .spotlight",
      stateName,
      themeId
    );
    await captureComponent(page, componentsDir, manifest, "spotlight-results", "#spotlightResults", stateName, themeId);
  }, manifest);

  await safeStep(step("ShotGrid onboarding modal"), async () => {
    const stateName = "onboarding-modal";
    await resetUi(page);
    await page.evaluate(() => {
      if (typeof globalThis.openOnboardingModal === "function") {
        globalThis.openOnboardingModal({ startStep: 2 });
      }
    });
    await waitVisible(page, "#onboardingModal.open");
    await captureFull(page, fullDir, manifest, `14-${stateName}`, stateName, themeId);
    await captureComponent(page, componentsDir, manifest, "onboarding-modal", "#onboardingModal.open .modal", stateName, themeId);
  }, manifest);

  await safeStep(step("Asset detail overlay"), async () => {
    const stateName = "asset-detail";
    await resetUi(page);
    const opened = await page.evaluate(() => {
      const assets = globalThis.ShotgridKanbanAPI?.getAssets?.() || [];
      if (!assets.length) return false;
      if (typeof globalThis.openAssetDetail === "function") {
        globalThis.openAssetDetail(assets[0].name);
        return true;
      }
      return false;
    });
    if (!opened) {
      throw new Error("Could not open asset detail overlay");
    }
    await waitVisible(page, "#assetDetailOverlay.open");
    await captureFull(page, fullDir, manifest, `15-${stateName}`, stateName, themeId);
    await captureComponent(page, componentsDir, manifest, "asset-detail-overlay", "#assetDetailOverlay.open", stateName, themeId);
    await captureComponent(page, componentsDir, manifest, "asset-detail-content", "#assetDetailContent", stateName, themeId);
  }, manifest);

  await resetUi(page);

  if (captureMotion) {
    await captureThemeMotion(
      browser,
      baseUrl,
      theme,
      themeDir,
      manifest,
      keepStorage,
      motionFormats,
      motionProfile
    );
  }

  manifest.themes.push({
    id: themeId,
    label: theme.label || theme.id,
    path: toRelativePosix(manifest.outputDir, themeDir),
    shotCount: manifest.shots.length - startCount,
    motionCount: manifest.motion.length - startMotionCount,
    gifCount: manifest.gifs.length - startGifCount
  });
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(__dirname, "..");
  const outputRoot = path.join(repoRoot, "output", "playwright", "component-screenshots");
  const runFolder = args.outDir
    ? path.resolve(process.cwd(), args.outDir)
    : path.join(outputRoot, timestampString());
  await ensureDir(runFolder);

  const manifest = {
    createdAt: new Date().toISOString(),
    outputDir: runFolder,
    source: args.baseUrl || "local-static-server",
    themes: [],
    shots: [],
    motion: [],
    gifs: [],
    warnings: []
  };

  let staticServer = null;
  let baseUrl = args.baseUrl;
  if (!baseUrl) {
    staticServer = await startStaticServer(repoRoot);
    baseUrl = staticServer.baseUrl;
  }
  manifest.resolvedBaseUrl = baseUrl;

  process.stdout.write(`[capture] Output: ${runFolder}\n`);
  process.stdout.write(`[capture] URL: ${baseUrl}\n`);

  let motionFormats = normalizeMotionFormats(args.motionFormats, args.captureGifs);
  const motionProfile = resolveMotionProfile(args.motionSpeed);
  if ((args.motionSpeed || "").toString().trim() && motionProfile.id !== (args.motionSpeed || "").toString().trim().toLowerCase()) {
    const message = `Unknown motion speed "${args.motionSpeed}", using "${motionProfile.id}".`;
    process.stdout.write(`[capture] ${message}\n`);
    manifest.warnings.push({ step: "motion-speed", message });
  }
  const needsFfmpeg = motionFormats.includes("gif") || motionFormats.includes("mp4");
  if (needsFfmpeg) {
    const ffmpegAvailable = await hasCommand("ffmpeg");
    if (!ffmpegAvailable) {
      const reduced = motionFormats.filter((format) => format === "webm");
      const removed = motionFormats.filter((format) => format !== "webm");
      motionFormats = reduced;
      const message = `ffmpeg is not available; skipping formats: ${removed.join(", ")}`;
      process.stdout.write(`[capture] ${message}\n`);
      manifest.warnings.push({ step: "motion-formats", message });
    }
  }
  const motionCaptureEnabled = motionFormats.length > 0;
  if (!motionCaptureEnabled) {
    const message = "No motion formats enabled; skipping interaction clips.";
    process.stdout.write(`[capture] ${message}\n`);
    manifest.warnings.push({ step: "motion-capture", message });
  }
  manifest.motionFormats = motionFormats;
  manifest.motionSpeed = motionProfile.id;

  const browser = await chromium.launch({
    headless: true
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1200 },
    deviceScaleFactor: 2
  });

  if (!args.keepStorage) {
    await context.addInitScript(() => {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch (_err) {}
    });
  }

  const page = await context.newPage();

  try {
    await preparePageForCapture(page, baseUrl);

    const allThemes = await detectThemes(page);
    const requestedThemes = Array.isArray(args.themes) && args.themes.length > 0
      ? new Set(args.themes.map((themeId) => normalizeThemeId(themeId)))
      : null;
    const selectedThemes = requestedThemes
      ? allThemes.filter((theme) => requestedThemes.has(normalizeThemeId(theme.id)))
      : allThemes;

    if (!selectedThemes.length) {
      throw new Error(
        `No matching themes found. Available: ${allThemes.map((theme) => normalizeThemeId(theme.id)).join(", ")}`
      );
    }
    manifest.requestedThemes = requestedThemes ? [...requestedThemes] : null;
    manifest.availableThemes = allThemes.map((theme) => ({
      id: normalizeThemeId(theme.id),
      label: theme.label || theme.id
    }));
    manifest.selectedThemes = selectedThemes.map((theme) => ({
      id: normalizeThemeId(theme.id),
      label: theme.label || theme.id
    }));

    process.stdout.write(
      `[capture] Themes: ${selectedThemes.map((theme) => normalizeThemeId(theme.id)).join(", ")}\n`
    );
    process.stdout.write(`[capture] Motion formats: ${motionFormats.join(", ") || "(none)"}\n`);
    process.stdout.write(`[capture] Motion speed: ${motionProfile.id}\n`);

    for (const theme of selectedThemes) {
      await captureThemeStates(page, theme, runFolder, manifest, {
        browser,
        baseUrl,
        captureMotion: motionCaptureEnabled,
        motionFormats,
        motionProfile,
        keepStorage: args.keepStorage
      });
    }
  } finally {
    await context.close();
    await browser.close();
    if (staticServer) {
      await new Promise((resolve, reject) => {
        staticServer.server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }

  const manifestPath = path.join(runFolder, "manifest.json");
  await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const motionFilesCount = manifest.motion.reduce((total, clip) => total + ((clip.files || []).length || 0), 0);
  process.stdout.write(`[capture] Saved ${manifest.shots.length} images\n`);
  process.stdout.write(`[capture] Saved ${manifest.motion.length} motion clips (${motionFilesCount} files)\n`);
  process.stdout.write(`[capture] Saved ${manifest.gifs.length} GIFs\n`);
  process.stdout.write(`[capture] Manifest: ${manifestPath}\n`);
  if (manifest.warnings.length) {
    process.stdout.write(`[capture] Completed with ${manifest.warnings.length} warning(s)\n`);
  }
}

run().catch((err) => {
  process.stderr.write(`[capture] Failed: ${err.stack || err.message || String(err)}\n`);
  process.exit(1);
});
