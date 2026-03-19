/**
 * main.js — Electron Main Process
 *
 * Runs the embedded Express server + Playwright engine.
 * Communicates with the renderer (UI) via IPC.
 */

const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { exec, spawn } = require("child_process");
const { v4: uuidv4 } = require("uuid");
const express = require("express");
const cors = require("cors");

// ── Paths ────────────────────────────────────────────────
const USER_DATA = app.getPath("userData");
const SCRIPTS_DIR = path.join(USER_DATA, "scripts");
const RESULTS_DIR = path.join(USER_DATA, "results");
const TEMP_DIR = path.join(__dirname, "temp");
const HELPERS_DIR = path.join(__dirname, "helpers");
const DB_PATH = path.join(USER_DATA, "scenarios.json");

[SCRIPTS_DIR, RESULTS_DIR, TEMP_DIR].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ── Simple JSON DB for scenarios & runs ──────────────────
function loadDB() {
  try {
    if (fs.existsSync(DB_PATH)) {
      return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
    }
  } catch {}
  return { scenarios: [], runs: [] };
}

function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ── Playwright helpers path ──────────────────────────────
const MENDIX_HELPERS_PATH = path
  .resolve(HELPERS_DIR, "mendix-helpers.js")
  .replace(/\\/g, "/");

// ── Security helpers ─────────────────────────────────────
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateRunId(id) {
  if (!UUID_REGEX.test(id)) throw new Error(`Invalid runId format: ${id}`);
  return id;
}

/** Escape a value for safe embedding inside a single-quoted JS string literal. */
function escapeJsString(str) {
  return String(str ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

function wrapScript(script, targetUrl, credentials) {
  let scriptBody = script.trim();

  // Strip Codegen's own imports (both ESM and CommonJS)
  scriptBody = scriptBody
    .replace(/^import\s+\{[^}]*\}\s+from\s+['"][^'"]*['"];\s*$/gm, '')
    .replace(/^const\s+\{[^}]*\}\s*=\s*require\s*\([^)]*\);\s*$/gm, '')
    .trim();

  // Strip test.use() blocks (viewport config etc.)
  scriptBody = scriptBody
    .replace(/test\.use\s*\(\s*\{[\s\S]*?\}\s*\)\s*;/g, '')
    .trim();

  // Clean fragile Mendix selectors
  scriptBody = cleanMendixSelectors(scriptBody);

  // Check if there's still a test() block after stripping
  const hasTestBlock = /\btest\s*\(/.test(scriptBody);

  if (!hasTestBlock) {
    scriptBody = `
test('Recorded Test', async ({ page }) => {
  await page.goto(TARGET_URL);
  await mx.waitForMendix(page);

  ${scriptBody}
});
`;
  }

  return `
const { test, expect } = require('@playwright/test');
const mx = require('${MENDIX_HELPERS_PATH}');
const TARGET_URL = ${JSON.stringify(targetUrl)};
const CREDENTIALS = ${JSON.stringify(credentials || {})};

${scriptBody}
`;
}

function cleanMendixSelectors(script) {
  let cleaned = script;

  // 1. Replace #mxui_widget_Underlay_N clicks with class-based selector
  cleaned = cleaned.replace(
    /await page\.locator\(['"]#mxui_widget_Underlay_\d+['"]\)\.click\(\);/g,
    'await page.locator(".mx-underlay").click();'
  );

  // 2. Replace #mxui_widget_*_N selectors with class-based fallbacks
  cleaned = cleaned.replace(
    /(['"])#mxui_widget_(\w+?)_\d+\1/g,
    (match, quote, widgetType) => {
      const classMap = {
        'TextBox': '.mx-textbox',
        'TextArea': '.mx-textarea',
        'Button': '.mx-button',
        'DataGrid': '.mx-datagrid',
        'DropDown': '.mx-dropdown',
        'CheckBox': '.mx-checkbox',
        'RadioButton': '.mx-radiobutton',
        'DatePicker': '.mx-datepicker',
        'ReferenceSelector': '.mx-referenceselector',
      };
      if (classMap[widgetType]) {
        return `${quote}${classMap[widgetType]}${quote}`;
      }
      return match;
    }
  );

  // 3. Flag fragile Mendix page-composition IDs with a comment
  cleaned = cleaned.replace(
    /page\.locator\(['"](\[id="p\.[^"]+""])['"]\)/g,
    (match, selector) => {
      return `page.locator('${selector}') /* FRAGILE: Mendix page-composition ID — consider using getByRole or getByText */`;
    }
  );

  return cleaned;
}

function generateStepCode(step) {
  const widgetName = (sel) =>
    escapeJsString(String(sel || "").replace(/^mx:/, ""));
  const val = escapeJsString(step.value);
  const sel = escapeJsString(step.selector);

  switch (step.action) {
    case "Navigate":
      return `  await page.goto('${val}');\n  await mx.waitForMendix(page);`;
    case "Login":
      return `  await mx.login(page, TARGET_URL, CREDENTIALS.username, CREDENTIALS.password);`;
    case "Click":
      if (step.selector?.startsWith("mx:"))
        return `  await mx.clickWidget(page, '${widgetName(step.selector)}');`;
      return `  await page.click('${sel}');`;
    case "Fill":
      if (step.selector?.startsWith("mx:"))
        return `  await mx.fillWidget(page, '${widgetName(step.selector)}', '${val}');`;
      return `  await page.fill('${sel}', '${val}');`;
    case "SelectDropdown":
      return `  await mx.selectDropdown(page, '${widgetName(step.selector)}', '${val}');`;
    case "AssertText":
      if (step.selector?.startsWith("mx:"))
        return `  const text_${step.order} = await mx.getWidgetText(page, '${widgetName(step.selector)}');\n  expect(text_${step.order}).toContain('${val}');`;
      return `  await expect(page.locator('${sel}')).toContainText('${val}');`;
    case "AssertVisible":
      return `  await expect(page.locator('${sel}')).toBeVisible();`;
    case "Wait":
      return `  await page.waitForTimeout(${parseInt(step.value, 10) || 1000});`;
    case "WaitForMendix":
      return `  await mx.waitForMendix(page);`;
    case "WaitForPopup":
      return `  await mx.waitForPopup(page);`;
    case "ClosePopup":
      return `  await mx.closePopup(page);`;
    case "WaitForMicroflow":
      return `  await mx.waitForMicroflow(page);`;
    case "Screenshot":
      return `  await page.screenshot({ path: 'results/${val || "screenshot"}.png', fullPage: true });`;
    default:
      return `  // Unknown action: ${escapeJsString(step.action)}`;
  }
}

function generateScriptFromSteps(steps, testName, targetUrl) {
  const lines = steps.map((step, idx) => {
    const code = generateStepCode(step);
    const desc = escapeJsString(`${step.action}${step.selector ? ' ' + step.selector : ''}${step.value ? ' = ' + step.value : ''}`);
    // Wrap each step with progress markers so the runner can track execution
    return `  console.log('[ZONIQ_STEP:START:${idx}:${desc}]');\n` +
      `  try {\n  ${code}\n` +
      `  console.log('[ZONIQ_STEP:DONE:${idx}]');\n` +
      `  } catch (_stepErr_${idx}) {\n` +
      `    console.log('[ZONIQ_STEP:FAIL:${idx}:' + _stepErr_${idx}.message.replace(/\\n/g, ' ') + ']');\n` +
      `    throw _stepErr_${idx};\n` +
      `  }`;
  });

  return `
test('${escapeJsString(testName)}', async ({ page }) => {
  console.log('[ZONIQ_STEP:START:-1:Navigate to target URL]');
  await page.goto(TARGET_URL);
  await mx.waitForMendix(page);
  console.log('[ZONIQ_STEP:DONE:-1]');

${lines.join("\n\n")}
});
`;
}

// ── Playwright execution ─────────────────────────────────
function extractSpecs(suites) {
  const specs = [];
  for (const suite of suites) {
    if (suite.specs) specs.push(...suite.specs);
    if (suite.suites) specs.push(...extractSpecs(suite.suites));
  }
  return specs;
}

async function runPlaywright(scriptPath, runId, onStepProgress) {
  const runResultsDir = path.join(RESULTS_DIR, runId);
  fs.mkdirSync(runResultsDir, { recursive: true });

  const reportPath = path.join(runResultsDir, "report.json");
  const configPath = path.resolve(__dirname, "playwright.config.js");

  // Debug: save a copy of the generated script for inspection
  try {
    fs.copyFileSync(scriptPath, path.join(runResultsDir, "debug-script.js"));
  } catch {}

  return new Promise((resolve) => {
    const env = {
      ...process.env,
      PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath,
    };

    const playwrightCli = path.resolve(__dirname, "node_modules", ".bin", process.platform === "win32" ? "playwright.cmd" : "playwright");
    const runIdPrefix = path.basename(scriptPath, ".spec.js");
    // Default to headed on desktop; set ZONIQ_HEADED=false to run headless (e.g. on CI)
    const headedFlag = process.env.ZONIQ_HEADED !== "false" ? "--headed" : "";

    const args = [
      "test", runIdPrefix,
      `--config=${configPath}`,
      "--reporter=json",
      `--output=${runResultsDir}`,
    ];
    if (headedFlag) args.push("--headed");

    console.log(`[${runId}] CMD: ${playwrightCli} ${args.join(" ")}`);

    let stdoutBuf = "";
    let stderrBuf = "";

    const proc = spawn(playwrightCli, args, { env, shell: true, timeout: 300_000 });

    proc.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdoutBuf += text;

      // Parse step progress markers from stdout
      if (onStepProgress) {
        const lines = text.split("\n");
        for (const line of lines) {
          const startMatch = line.match(/\[ZONIQ_STEP:START:(-?\d+):(.*?)\]/);
          const doneMatch = line.match(/\[ZONIQ_STEP:DONE:(-?\d+)\]/);
          const failMatch = line.match(/\[ZONIQ_STEP:FAIL:(-?\d+):(.*?)\]/);
          if (startMatch) {
            onStepProgress({ runId, stepIndex: parseInt(startMatch[1]), status: "running", description: startMatch[2] });
          } else if (doneMatch) {
            onStepProgress({ runId, stepIndex: parseInt(doneMatch[1]), status: "done" });
          } else if (failMatch) {
            onStepProgress({ runId, stepIndex: parseInt(failMatch[1]), status: "failed", error: failMatch[2] });
          }
        }
      }
    });

    proc.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString();
    });

    proc.on("close", () => {
      // Debug: save stdout/stderr
      try {
        fs.writeFileSync(path.join(runResultsDir, "debug-stdout.txt"), stdoutBuf);
        fs.writeFileSync(path.join(runResultsDir, "debug-stderr.txt"), stderrBuf);
      } catch {}

      let report = null;
      try {
        if (fs.existsSync(reportPath)) {
          report = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
        }
      } catch {}

      if (!report && stdoutBuf) {
        try {
          report = JSON.parse(stdoutBuf);
          fs.writeFileSync(reportPath, stdoutBuf);
        } catch {}
      }

      const artifacts = [];
      if (fs.existsSync(runResultsDir)) {
        try {
          const walkDir = (dir, prefix = "") => {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const e of entries) {
              const rel = prefix ? `${prefix}/${e.name}` : e.name;
              if (e.isDirectory()) walkDir(path.join(dir, e.name), rel);
              else if (e.name.match(/\.(png|jpg|webm|zip)$/)) artifacts.push(rel);
            }
          };
          walkDir(runResultsDir);
        } catch {}
      }

      let status = "error";
      let summary = { total: 0, passed: 0, failed: 0 };
      const errors = [];

      if (report && report.suites) {
        const specs = extractSpecs(report.suites);
        summary.total = specs.length;
        summary.passed = specs.filter((s) => s.ok).length;
        summary.failed = specs.filter((s) => !s.ok).length;

        if (summary.total === 0) {
          status = "error";
          if (report.errors?.length) {
            errors.push(...report.errors.map(e => ({ test: "Global", message: e.message || "", snippet: e.stack || "" })));
          }
        } else {
          status = summary.failed === 0 ? "passed" : "failed";
        }

        for (const spec of specs) {
          if (!spec.ok && spec.tests) {
            for (const t of spec.tests) {
              for (const r of t.results || []) {
                if (r.error) {
                  errors.push({
                    test: spec.title,
                    message: r.error.message || "",
                    snippet: r.error.snippet || "",
                  });
                }
              }
            }
          }
        }
      }

      resolve({ status, summary, errors, artifacts, stderr: stderrBuf?.substring(0, 2000) });
    });
  });
}

// ── Embedded Express API server (for Zoniq REST calls) ───
let apiServer = null;
const API_PORT = 3100;

function startAPIServer() {
  const api = express();
  api.use(cors());
  api.use(express.json({ limit: "10mb" }));

  // Optional API key authentication (set ZONIQ_API_KEY env var to enable)
  const API_KEY = process.env.ZONIQ_API_KEY || null;
  if (API_KEY) {
    api.use((req, res, next) => {
      if (req.path === "/api/health") return next(); // Health checks are unauthenticated
      const key = req.headers["x-api-key"];
      if (key !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
      next();
    });
  }

  api.get("/api/health", (req, res) => {
    exec(
      `${process.platform === "win32" ? "npx.cmd" : "npx"} playwright --version`,
      (error, stdout) => {
        res.json({
          status: "ok",
          server: "zoniq-test-runner",
          playwrightVersion: stdout?.trim() || "not found",
          platform: process.platform,
        });
      }
    );
  });

  api.post("/api/execute", async (req, res) => {
    const { testRunId, testName, targetUrl, script, credentials, callbackUrl } = req.body;
    if (!targetUrl || !script) return res.status(400).json({ error: "targetUrl and script required" });

    let runId;
    try {
      runId = testRunId ? validateRunId(testRunId) : uuidv4();
    } catch {
      return res.status(400).json({ error: "Invalid testRunId — must be a UUID" });
    }
    const scriptPath = path.join(TEMP_DIR, `run-${runId}.spec.js`);
    fs.writeFileSync(scriptPath, wrapScript(script, targetUrl, credentials));

    res.json({ runId, status: "running" });

    const results = await runPlaywright(scriptPath, runId);
    const db = loadDB();
    db.runs.push({
      runId,
      testName: testName || "API Test",
      targetUrl,
      status: results.status,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      results,
    });
    saveDB(db);

    if (callbackUrl) {
      try {
        await fetch(callbackUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId, ...results, completedAt: new Date().toISOString() }),
        });
      } catch {}
    }

    try { fs.unlinkSync(scriptPath); } catch {}
    if (mainWindow) mainWindow.webContents.send("runs-updated");
  });

  api.post("/api/execute-steps", async (req, res) => {
    const { testRunId, testName, targetUrl, credentials, steps, callbackUrl } = req.body;
    if (!targetUrl || !steps?.length) return res.status(400).json({ error: "targetUrl and steps required" });

    let runId;
    try {
      runId = testRunId ? validateRunId(testRunId) : uuidv4();
    } catch {
      return res.status(400).json({ error: "Invalid testRunId — must be a UUID" });
    }
    const name = testName || "Step Test";
    const scriptBody = generateScriptFromSteps(steps, name, targetUrl);
    const scriptPath = path.join(TEMP_DIR, `run-${runId}.spec.js`);
    fs.writeFileSync(scriptPath, wrapScript(scriptBody, targetUrl, credentials));

    res.json({ runId, status: "running" });

    const results = await runPlaywright(scriptPath, runId);
    const db = loadDB();
    db.runs.push({
      runId,
      testName: name,
      targetUrl,
      status: results.status,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      results,
    });
    saveDB(db);

    if (callbackUrl) {
      try {
        await fetch(callbackUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId, ...results, completedAt: new Date().toISOString() }),
        });
      } catch {}
    }

    try { fs.unlinkSync(scriptPath); } catch {}
    if (mainWindow) mainWindow.webContents.send("runs-updated");
  });

  api.get("/api/runs/:runId", (req, res) => {
    const db = loadDB();
    const run = db.runs.find((r) => r.runId === req.params.runId);
    if (!run) return res.status(404).json({ error: "Not found" });
    res.json(run);
  });

  api.get("/api/runs", (req, res) => {
    const db = loadDB();
    res.json(db.runs.slice(-50).reverse());
  });

  api.get("/api/runs/:runId/artifacts/:filename", (req, res) => {
    // Validate runId to prevent path traversal
    if (!UUID_REGEX.test(req.params.runId)) return res.status(400).json({ error: "Invalid runId" });
    // Reject filenames with path separators
    if (/[/\\]/.test(req.params.filename)) return res.status(400).json({ error: "Invalid filename" });
    const filePath = path.join(RESULTS_DIR, req.params.runId, req.params.filename);
    // Ensure resolved path stays within RESULTS_DIR
    if (!filePath.startsWith(path.resolve(RESULTS_DIR) + path.sep)) {
      return res.status(400).json({ error: "Invalid path" });
    }
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Not found" });
    res.sendFile(filePath);
  });

  apiServer = api.listen(API_PORT, () => {
    console.log(`API server on http://localhost:${API_PORT}`);
  });
}

// ── IPC Handlers (UI ↔ Main process) ────────────────────

// Health check
ipcMain.handle("health-check", async () => {
  return new Promise((resolve) => {
    const npx = process.platform === "win32" ? "npx.cmd" : "npx";
    exec(`${npx} playwright --version`, (error, stdout) => {
      resolve({
        playwright: stdout?.trim() || "Not installed",
        apiPort: API_PORT,
        dataDir: USER_DATA,
        platform: process.platform,
        scenarioCount: loadDB().scenarios.length,
        runCount: loadDB().runs.length,
      });
    });
  });
});

// Get all scenarios
ipcMain.handle("get-scenarios", () => {
  return loadDB().scenarios;
});

// Save a scenario
ipcMain.handle("save-scenario", (event, scenario) => {
  const db = loadDB();
  const existing = db.scenarios.findIndex((s) => s.id === scenario.id);
  if (existing >= 0) {
    db.scenarios[existing] = { ...db.scenarios[existing], ...scenario, updatedAt: new Date().toISOString() };
  } else {
    scenario.id = scenario.id || uuidv4();
    scenario.createdAt = new Date().toISOString();
    scenario.updatedAt = scenario.createdAt;
    db.scenarios.push(scenario);
  }
  saveDB(db);
  return scenario;
});

// Delete a scenario
ipcMain.handle("delete-scenario", (event, id) => {
  const db = loadDB();
  db.scenarios = db.scenarios.filter((s) => s.id !== id);
  saveDB(db);
  return true;
});

// Get all runs
ipcMain.handle("get-runs", () => {
  return loadDB().runs.slice(-100).reverse();
});

// Launch Codegen recorder
ipcMain.handle("launch-recorder", async (event, targetUrl) => {
  return new Promise((resolve, reject) => {
    const npx = process.platform === "win32" ? "npx.cmd" : "npx";
    const outputFile = `recording-${Date.now()}.js`;
    const outputPath = path.join(SCRIPTS_DIR, outputFile);

    const proc = spawn(
      npx,
      [
        "playwright",
        "codegen",
        targetUrl,
        "--output",
        outputPath,
        "--viewport-size=1920,1080",
      ],
      { shell: true }
    );

    proc.on("close", () => {
      try {
        if (fs.existsSync(outputPath)) {
          const script = fs.readFileSync(outputPath, "utf-8");
          resolve({ outputFile, script });
        } else {
          resolve({ outputFile: null, script: null });
        }
      } catch (err) {
        reject(err);
      }
    });

    proc.on("error", reject);
  });
});

// Import script from file dialog
ipcMain.handle("import-script", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: "Import Playwright Script",
    filters: [{ name: "JavaScript", extensions: ["js", "ts"] }],
    properties: ["openFile"],
  });
  if (canceled || !filePaths.length) return null;
  const script = fs.readFileSync(filePaths[0], "utf-8");
  return { filename: path.basename(filePaths[0]), script };
});

// Execute a scenario
ipcMain.handle("execute-scenario", async (event, scenario) => {
  const runId = uuidv4();
  const scriptPath = path.join(TEMP_DIR, `run-${runId}.spec.js`);

  let scriptContent;
  if (scenario.steps && scenario.steps.length > 0) {
    const body = generateScriptFromSteps(scenario.steps, scenario.name, scenario.targetUrl);
    scriptContent = wrapScript(body, scenario.targetUrl, scenario.credentials);
  } else if (scenario.script) {
    scriptContent = wrapScript(scenario.script, scenario.targetUrl, scenario.credentials);
  } else {
    return { runId, status: "error", errors: [{ message: "No script or steps defined" }] };
  }

  fs.writeFileSync(scriptPath, scriptContent);

  const db = loadDB();
  const run = {
    runId,
    scenarioId: scenario.id,
    testName: scenario.name,
    targetUrl: scenario.targetUrl,
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    results: null,
  };
  db.runs.push(run);
  saveDB(db);

  // Notify UI that run started
  mainWindow.webContents.send("run-started", run);

  // Send step info to renderer so it can show the step list
  if (scenario.steps?.length) {
    const stepList = [
      { index: -1, action: "Navigate", description: "Navigate to target URL" },
      ...scenario.steps.map((s, i) => ({
        index: i,
        action: s.action,
        selector: s.selector || "",
        value: s.value || "",
        description: `${s.action}${s.selector ? ' ' + s.selector : ''}${s.value ? ' = ' + s.value : ''}`,
      })),
    ];
    mainWindow.webContents.send("step-list", { runId, steps: stepList });
  }

  // Step progress callback — streams real-time updates to the renderer
  const onStepProgress = (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("step-progress", progress);
    }
  };

  try {
    const results = await runPlaywright(scriptPath, runId, onStepProgress);
    run.status = results.status;
    run.completedAt = new Date().toISOString();
    run.results = results;

    const db2 = loadDB();
    const idx = db2.runs.findIndex((r) => r.runId === runId);
    if (idx >= 0) db2.runs[idx] = run;
    saveDB(db2);

    mainWindow.webContents.send("run-completed", run);
    return run;
  } catch (err) {
    run.status = "error";
    run.completedAt = new Date().toISOString();
    run.results = { status: "error", errors: [{ message: err.message }] };

    const db2 = loadDB();
    const idx = db2.runs.findIndex((r) => r.runId === runId);
    if (idx >= 0) db2.runs[idx] = run;
    saveDB(db2);

    mainWindow.webContents.send("run-completed", run);
    return run;
  } finally {
    try { fs.unlinkSync(scriptPath); } catch {}
  }
});

// Open results folder
ipcMain.handle("open-results-folder", (event, runId) => {
  const dir = path.join(RESULTS_DIR, runId);
  if (fs.existsSync(dir)) shell.openPath(dir);
  else shell.openPath(RESULTS_DIR);
});

// ── Window ───────────────────────────────────────────────
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: "Zoniq Test Runner",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: "#0a0e17",
    show: false,
  });

  mainWindow.loadFile("index.html");

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  // Remove menu bar on Windows/Linux
  mainWindow.setMenuBarVisibility(false);
}

app.whenReady().then(() => {
  createWindow();
  startAPIServer();
});

app.on("window-all-closed", () => {
  if (apiServer) apiServer.close();
  app.quit();
});
