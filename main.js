/**
 * main.js — Electron Main Process
 *
 * Runs the embedded Express server + Playwright engine.
 * Communicates with the renderer (UI) via IPC.
 */

const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require("electron");
const path = require("path");
const fs = require("fs");
const { exec, spawn } = require("child_process");
const { v4: uuidv4 } = require("uuid");
const ScriptUtils = require("./lib/script-utils");

// ── Initialize paths from Electron BEFORE any module that calls getDataDir() ──
const Paths = require("./lib/paths");
Paths.initFromElectron(app);
Paths.ensureDirs();
const {
  DATA_DIR: USER_DATA,
  SCRIPTS_DIR,
  RESULTS_DIR,
  TEMP_DIR,
  DB_PATH,
  APPS_PATH,
  APPS_DIR,
  LOG_PATH,
  PLAYWRIGHT_CONFIG_PATH,
  UNPACKED_BASE,
  HELPERS_DIR,
  UNPACKED_NODE_MODULES,
  PLAYWRIGHT_CLI_JS,
  PLAYWRIGHT_CORE_PATH,
} = Paths.getPaths();

// ── Shared core modules (used by both Electron main process and standalone server) ──
const DB = require("./lib/db");
const ScriptTransforms = require("./lib/script-transforms");
const Runner = require("./lib/playwright-runner");

// Re-export so existing main.js code can call them by their old names without changes
const {
  loadDB,
  saveDB,
  addSavedUrl,
  loadApps,
  saveApps,
  loadElementDBForApp,
  saveElementDBForApp,
} = DB;
const {
  wrapScript,
  injectStepMarkers,
  cleanMendixSelectors,
  transformSelectOptionCalls,
  transformDatePickerClicks,
  disambiguateSelectors,
  transformListViewRowClicks,
  transformDataGridRowClicks,
  extractSpecs,
  extractStepsFromReport,
} = ScriptTransforms;
const {
  ensurePlaywrightConfig,
  getBrowserChannel,
  getPlaywrightEnv,
  isLocalBrowsersDirValid,
  validateRunId,
  UUID_REGEX,
} = Runner;

// ── Lazy-loaded modules (deferred to speed up window creation) ──
let _express, _cors, _settings, _LLMClient, _HealerAgent, _ElementDB;
function getExpress() { return _express || (_express = require("express")); }
function getCors() { return _cors || (_cors = require("cors")); }
function getSettings() { return _settings || (_settings = require("./settings")); }
function getLLMClient() { return _LLMClient || (_LLMClient = require("./agents/llm-client").LLMClient); }
function getHealerAgent() { return _HealerAgent || (_HealerAgent = require("./agents/healer-agent").HealerAgent); }
function getElementDB() { return _ElementDB || (_ElementDB = require("./lib/element-db")); }

// findOrCreateApp / migrateScenarioApps need element-db helpers — pass them through
function findOrCreateApp(targetUrl) {
  return DB.findOrCreateApp(targetUrl, getElementDB);
}
function migrateScenarioApps() {
  return DB.migrateScenarioApps(getElementDB);
}

// runPlaywright wrapper that injects Electron-only viewport + settings dependencies
async function runPlaywright(scriptPath, runId, onStepProgress, headed) {
  const settings = getSettings().loadSettings();
  const vp = resolveViewport(settings);
  return Runner.runPlaywright(scriptPath, runId, onStepProgress, headed, vp, settings);
}

// ── Debug logging to file ────────────────────────────────
const _logStream = fs.createWriteStream(LOG_PATH, { flags: "a" });
function zlog(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(" ")}\n`;
  process.stdout.write(line);
  _logStream.write(line);
}
// Capture console.log / console.error too
const _origLog = console.log.bind(console);
const _origErr = console.error.bind(console);
console.log = (...a) => { _origLog(...a); _logStream.write(`[LOG] ${a.join(" ")}\n`); };
console.error = (...a) => { _origErr(...a); _logStream.write(`[ERR] ${a.join(" ")}\n`); };
zlog("=== Zoniq started ===");
zlog("resourcesPath:", process.resourcesPath);
zlog("__dirname:", __dirname);
zlog("UNPACKED_BASE:", UNPACKED_BASE);
zlog("HELPERS_DIR:", HELPERS_DIR, "| exists:", fs.existsSync(HELPERS_DIR));
zlog("recorder.js exists:", fs.existsSync(path.join(HELPERS_DIR, "recorder.js")));
zlog("playwright-core exists:", fs.existsSync(path.join(UNPACKED_NODE_MODULES, "playwright-core")));

zlog("PLAYWRIGHT_CORE_PATH:", PLAYWRIGHT_CORE_PATH, "| exists:", fs.existsSync(PLAYWRIGHT_CORE_PATH));
zlog("PLAYWRIGHT_CLI_JS:", PLAYWRIGHT_CLI_JS, "| exists:", fs.existsSync(PLAYWRIGHT_CLI_JS));
zlog("TEMP_DIR:", TEMP_DIR);


// ── Embedded Express API server (for Zoniq REST calls) ───
let apiServer = null;
const API_PORT = 3100;

function startAPIServer() {
  const api = getExpress()();
  api.use(getCors()());
  api.use(getExpress().json({ limit: "10mb" }));

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
    // Promote report-extracted steps for script-based API tests
    if (results.reportStepList) {
      results.stepList = results.reportStepList;
      results.stepResults = results.reportStepResults;
      delete results.reportStepList;
      delete results.reportStepResults;
    }
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
    // Build a script from the step definitions
    let stepLines;
    try {
      stepLines = steps.map((step, idx) => {
        step.order = idx;
        return ScriptUtils.generateStepCode(step);
      });
    } catch (validationErr) {
      return res.status(400).json({ error: validationErr.message });
    }
    const scriptBody = `test('${ScriptUtils.escapeJsString(name)}', async ({ page }) => {\n` +
      `  await page.goto(TARGET_URL);\n  await mx.waitForMendix(page);\n\n` +
      stepLines.join('\n') + '\n});';
    const scriptPath = path.join(TEMP_DIR, `run-${runId}.spec.js`);
    fs.writeFileSync(scriptPath, wrapScript(scriptBody, targetUrl, credentials));

    res.json({ runId, status: "running" });

    const results = await runPlaywright(scriptPath, runId);
    // Promote report-extracted steps for API step tests
    if (results.reportStepList) {
      results.stepList = results.reportStepList;
      results.stepResults = results.reportStepResults;
      delete results.reportStepList;
      delete results.reportStepResults;
    }
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

  // ── Agent API Endpoints ──────────────────────────────────

  api.post("/api/agent/heal", async (req, res) => {
    if (activeAgent) return res.status(409).json({ error: "An agent is already running" });

    const { scenarioId, runId, script, errors, targetUrl, credentials } = req.body;

    // Support both by-ID and inline mode
    let healScript, healErrors, healUrl, healCreds;

    if (scenarioId && runId) {
      const db = loadDB();
      const scenario = db.scenarios.find((s) => s.id === scenarioId);
      const run = db.runs.find((r) => r.runId === runId);
      if (!scenario) return res.status(404).json({ error: "Scenario not found" });
      if (!run) return res.status(404).json({ error: "Run not found" });
      healScript = scenario.script;
      healErrors = run.results?.errors || [];
      healUrl = scenario.targetUrl;
      healCreds = scenario.credentials;
    } else if (script && targetUrl) {
      healScript = script;
      healErrors = errors || [];
      healUrl = targetUrl;
      healCreds = credentials;
    } else {
      return res.status(400).json({ error: "Provide (scenarioId + runId) or (script + targetUrl + errors)" });
    }

    const settings = getSettings().loadSettings();
    if (!settings.llm.apiKey) return res.status(400).json({ error: "No LLM API key configured" });

    let llmClient;
    try {
      llmClient = new (getLLMClient())(settings);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const healer = new (getHealerAgent())(llmClient, {
      maxIterations: settings.agent.maxIterations,
      headless: true,
      browserChannel: getBrowserChannel(),
      viewport: resolveViewport(settings),
    });
    activeAgent = { type: "healer", agent: healer };

    res.json({ status: "running" });

    try {
      const result = await healer.heal({
        script: healScript,
        errors: healErrors,
        targetUrl: healUrl,
        credentials: healCreds,
      });
      activeAgent = null;
      // If a scenarioId was provided, save the healed script
      if (scenarioId && result.healedScript) {
        const db = loadDB();
        const idx = db.scenarios.findIndex((s) => s.id === scenarioId);
        if (idx >= 0) {
          db.scenarios[idx].script = result.healedScript;
          db.scenarios[idx].updatedAt = new Date().toISOString();
          saveDB(db);
        }
      }
    } catch {
      activeAgent = null;
    }
  });

  api.get("/api/agent/status", (req, res) => {
    res.json({
      running: !!activeAgent,
      type: activeAgent?.type || null,
    });
  });

  api.post("/api/agent/cancel", (req, res) => {
    if (activeAgent) {
      if (activeAgent.agent) activeAgent.agent.cancel();
      activeAgent = null;
      res.json({ ok: true });
    } else {
      res.json({ ok: false, error: "No agent running" });
    }
  });

  apiServer = api.listen(API_PORT, () => {
    console.log(`API server on http://localhost:${API_PORT}`);
  });

  apiServer.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      const { dialog } = require("electron");
      dialog.showErrorBox(
        "Port Already In Use",
        `Port ${API_PORT} is already in use.\n\nThis usually means Zoniq Test Runner is already running. Check your taskbar or system tray and close the existing instance before opening a new one.`
      );
      app.quit();
    } else {
      console.error("API server error:", err);
    }
  });
}

// ── IPC Handlers (UI ↔ Main process) ────────────────────

// Open debug log in default text editor
ipcMain.handle("open-log", () => { shell.openPath(LOG_PATH); });

// Health check
ipcMain.handle("health-check", async () => {
  return new Promise((resolve) => {
    const finish = (playwrightVersion) => {
      const db = loadDB();
      resolve({
        playwright: playwrightVersion,
        apiPort: API_PORT,
        dataDir: USER_DATA,
        platform: process.platform,
        scenarioCount: db.scenarios.length,
        runCount: db.runs.length,
      });
    };

    // Use the bundled playwright CLI JS + ELECTRON_RUN_AS_NODE (no system Node needed)
    const cliExists = fs.existsSync(PLAYWRIGHT_CLI_JS);
    if (cliExists) {
      const versionProc = spawn(
        process.execPath,
        [PLAYWRIGHT_CLI_JS, "--version"],
        { env: getPlaywrightEnv({ ELECTRON_RUN_AS_NODE: "1" }) }
      );
      let out = "";
      versionProc.stdout.on("data", (d) => { out += d.toString(); });
      versionProc.on("close", (code) => {
        if (!code && out.trim()) {
          finish(out.trim());
        } else {
          finish(isLocalBrowsersDirValid() ? "Bundled (browser ready)" : "Not installed");
        }
      });
      versionProc.on("error", () => {
        finish(isLocalBrowsersDirValid() ? "Bundled (browser ready)" : "Not installed");
      });
    } else {
      // Fallback: try system npx (dev mode / non-packaged)
      const npx = process.platform === "win32" ? "npx.cmd" : "npx";
      exec(`${npx} playwright --version`, (error, stdout) => {
        finish(stdout?.trim() || "Not installed");
      });
    }
  });
});

// Get all scenarios (with auto-migration for apps)
ipcMain.handle("get-scenarios", () => {
  return migrateScenarioApps().scenarios;
});

// Save a scenario
ipcMain.handle("save-scenario", (event, scenario) => {
  // Steps are ephemeral (derived from script) — never persist them
  delete scenario.steps;

  // Auto-assign appId if not set
  if (!scenario.appId && scenario.targetUrl) {
    const app = findOrCreateApp(scenario.targetUrl);
    if (app) scenario.appId = app.id;
  }

  const db = loadDB();
  const existing = db.scenarios.findIndex((s) => s.id === scenario.id);
  if (existing >= 0) {
    db.scenarios[existing] = { ...db.scenarios[existing], ...scenario, updatedAt: new Date().toISOString() };
    // Clean any legacy stored steps
    delete db.scenarios[existing].steps;
  } else {
    scenario.id = scenario.id || uuidv4();
    scenario.createdAt = new Date().toISOString();
    scenario.updatedAt = scenario.createdAt;
    db.scenarios.push(scenario);
  }
  addSavedUrl(db, scenario.targetUrl);
  saveDB(db);

  // Enrich element DB from script selectors
  const savedSc = existing >= 0 ? db.scenarios[existing] : scenario;
  if (savedSc.appId && savedSc.script) {
    try {
      const steps = ScriptUtils.parseScriptToSteps(savedSc.script);
      if (steps.length) {
        const elDB = loadElementDBForApp(savedSc.appId);
        const updated = getElementDB().enrichFromSteps(elDB, steps);
        saveElementDBForApp(savedSc.appId, updated);
      }
    } catch {}
  }

  return scenario;
});

// Duplicate a scenario
ipcMain.handle("duplicate-scenario", (event, id) => {
  const db = loadDB();
  const original = db.scenarios.find((s) => s.id === id);
  if (!original) return null;
  const now = new Date().toISOString();
  const duplicate = {
    ...original,
    id: uuidv4(),
    name: `${original.name} (copy)`,
    createdAt: now,
    updatedAt: now,
  };
  delete duplicate.steps;
  db.scenarios.push(duplicate);
  saveDB(db);
  return duplicate;
});

// Delete a scenario
ipcMain.handle("delete-scenario", (event, id) => {
  const db = loadDB();
  db.scenarios = db.scenarios.filter((s) => s.id !== id);
  saveDB(db);
  return true;
});

// ── Export / Import Scenarios ────────────────────────────

// Module-level variable to hold parsed import data between preview and confirm steps
let _pendingImport = null;

ipcMain.handle("export-scenarios", async (event, opts) => {
  const { scenarioIds, includePlans, includeCredentials } = opts;
  const db = loadDB();

  // Gather scenarios by IDs
  let exportScenarios = db.scenarios.filter((s) => scenarioIds.includes(s.id));
  if (!exportScenarios.length) return { error: "No scenarios to export" };

  // Clean scenarios for export
  exportScenarios = exportScenarios.map((s) => {
    const clean = { ...s };
    delete clean.steps; // ephemeral
    if (!includeCredentials) delete clean.credentials;
    return clean;
  });

  // Optionally include plans where ALL referenced scenarios are in the export set
  const idSet = new Set(scenarioIds);
  let exportPlans = [];
  if (includePlans && db.plans) {
    exportPlans = (db.plans || []).filter(
      (p) => p.scenarioIds && p.scenarioIds.length && p.scenarioIds.every((id) => idSet.has(id))
    );
  }

  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    scenarios: exportScenarios,
    plans: exportPlans,
  };

  const defaultName = `zoniq-scenarios-${new Date().toISOString().slice(0, 10)}.json`;
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: "Export Scenarios",
    defaultPath: defaultName,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (canceled || !filePath) return null;

  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf-8");
  return { success: true, scenarioCount: exportScenarios.length, planCount: exportPlans.length };
});

ipcMain.handle("import-scenarios", async () => {
  _pendingImport = null;
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: "Import Scenarios",
    filters: [{ name: "JSON", extensions: ["json"] }],
    properties: ["openFile"],
  });
  if (canceled || !filePaths.length) return null;

  try {
    const raw = fs.readFileSync(filePaths[0], "utf-8");
    const data = JSON.parse(raw);

    if (!data.version || data.version !== 1) {
      return { error: "Unsupported export file version" };
    }
    if (!Array.isArray(data.scenarios) || !data.scenarios.length) {
      return { error: "Invalid export file: no scenarios found" };
    }

    const hasCredentials = data.scenarios.some((s) => s.credentials && s.credentials.username);

    // Hold data in memory for the confirm step
    _pendingImport = data;

    return {
      filename: path.basename(filePaths[0]),
      scenarioCount: data.scenarios.length,
      planCount: (data.plans || []).length,
      scenarioNames: data.scenarios.map((s) => s.name),
      hasCredentials,
    };
  } catch (err) {
    return { error: `Failed to parse file: ${err.message}` };
  }
});

ipcMain.handle("confirm-import-scenarios", (event, opts) => {
  if (!_pendingImport) return { error: "No pending import data" };

  const { stripCredentials } = opts;
  const data = _pendingImport;
  _pendingImport = null;

  const db = loadDB();
  const now = new Date().toISOString();

  // Build old ID → new ID map for scenario remapping
  const idMap = {};

  // Helper: deduplicate name against existing names
  function uniqueName(name, existingNames) {
    if (!existingNames.includes(name)) return name;
    let suffix = "imported";
    let candidate = `${name} (${suffix})`;
    let counter = 2;
    while (existingNames.includes(candidate)) {
      candidate = `${name} (${suffix} ${counter})`;
      counter++;
    }
    return candidate;
  }

  const existingScenarioNames = db.scenarios.map((s) => s.name);

  for (const sc of data.scenarios) {
    const newId = uuidv4();
    idMap[sc.id] = newId;

    const imported = { ...sc, id: newId, createdAt: now, updatedAt: now };
    delete imported.steps;

    // Resolve appId via targetUrl
    if (imported.targetUrl) {
      const app = findOrCreateApp(imported.targetUrl);
      if (app) imported.appId = app.id;
    } else {
      delete imported.appId;
    }

    if (stripCredentials) delete imported.credentials;

    imported.name = uniqueName(imported.name, existingScenarioNames);
    existingScenarioNames.push(imported.name);

    db.scenarios.push(imported);
  }

  // Import plans with remapped scenario IDs
  let importedPlanCount = 0;
  if (data.plans && data.plans.length) {
    if (!db.plans) db.plans = [];
    const existingPlanNames = db.plans.map((p) => p.name);

    for (const plan of data.plans) {
      const remappedIds = plan.scenarioIds.map((id) => idMap[id]).filter(Boolean);
      if (!remappedIds.length) continue; // skip plans with no valid scenarios

      const imported = {
        ...plan,
        id: uuidv4(),
        scenarioIds: remappedIds,
        createdAt: now,
        updatedAt: now,
      };
      imported.name = uniqueName(imported.name, existingPlanNames);
      existingPlanNames.push(imported.name);

      db.plans.push(imported);
      importedPlanCount++;
    }
  }

  saveDB(db);
  return { importedScenarios: data.scenarios.length, importedPlans: importedPlanCount };
});

// ── Plan CRUD ────────────────────────────────────────────

ipcMain.handle("get-plans", () => {
  const db = loadDB();
  return db.plans || [];
});

ipcMain.handle("save-plan", (event, plan) => {
  const db = loadDB();
  if (!db.plans) db.plans = [];

  // Validate scenarioIds reference existing scenarios
  if (plan.scenarioIds) {
    plan.scenarioIds = plan.scenarioIds.filter(id =>
      db.scenarios.some(s => s.id === id)
    );
  }

  const existing = db.plans.findIndex(p => p.id === plan.id);
  if (existing >= 0) {
    db.plans[existing] = { ...db.plans[existing], ...plan, updatedAt: new Date().toISOString() };
  } else {
    plan.id = plan.id || uuidv4();
    plan.createdAt = new Date().toISOString();
    plan.updatedAt = plan.createdAt;
    db.plans.push(plan);
  }
  saveDB(db);
  return plan;
});

ipcMain.handle("delete-plan", (event, id) => {
  const db = loadDB();
  if (!db.plans) return true;
  db.plans = db.plans.filter(p => p.id !== id);
  saveDB(db);
  return true;
});

ipcMain.handle("duplicate-plan", (event, id) => {
  const db = loadDB();
  if (!db.plans) return null;
  const original = db.plans.find(p => p.id === id);
  if (!original) return null;
  const now = new Date().toISOString();
  const duplicate = {
    ...original,
    id: uuidv4(),
    name: `${original.name} (copy)`,
    createdAt: now,
    updatedAt: now,
  };
  db.plans.push(duplicate);
  saveDB(db);
  return duplicate;
});

// ── Workflow Config Import & Generation ───────────────────

/**
 * Compute a unique credential key for a workflow status.
 * Same UserRole.Name can be different people at different levels/roles.
 */
function getWorkflowCredentialKey(status) {
  const role = status.UserRole?.Name || status.UserRole || '';
  const level = status.Level || '';
  const decisionRole = status.Role || status.GroupRole || '';
  if (!decisionRole && !level) return role;
  return [role, level, decisionRole].filter(Boolean).join(':');
}

/**
 * Classify a workflow status for inclusion in the main flow.
 * Returns: 'main' | 'multi-sub' | 'feedback' | 'terminal' | 'multi-parent'
 */
function classifyWorkflowStatus(status, allStatuses) {
  const order = status.Order;
  const isWholeNumber = Math.floor(order) === order;
  const hasActions = status.WorkFlowActions && status.WorkFlowActions.length > 0;

  if (!hasActions) return 'terminal';
  if (status.UserAccessType === 'Multiple') return 'multi-parent';
  if (!isWholeNumber) {
    // Check if parent is Multiple
    const parentOrder = Math.floor(order);
    const parent = allStatuses.find(s => s.Order === parentOrder);
    if (parent && parent.UserAccessType === 'Multiple') return 'multi-sub';
    if (status.UserAccessType === 'Dynamic') return 'feedback';
    return 'feedback'; // Default sub-status to feedback
  }
  return 'main';
}

/**
 * Pick the default action index for the full escalation path.
 */
function getDefaultEscalationAction(status) {
  const actions = status.WorkFlowActions || [];
  if (actions.length <= 1) return 0;

  const patterns = [
    /push.*(for|escalation)/i,
    /validate\s*proposal/i,
    /no\s*further\s*escalation/i,
    /ready\s*for\s*escalation/i,
    /accept/i,
  ];
  for (const pattern of patterns) {
    const idx = actions.findIndex(a => pattern.test(a.Name));
    if (idx >= 0) return idx;
  }
  return 0;
}

/**
 * Load workflow credentials for an app.
 */
function loadWorkflowCredentials(appId) {
  const filePath = path.join(USER_DATA, `workflow-credentials-${appId}.json`);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch { return {}; }
}

/**
 * Save workflow credentials for an app.
 */
function saveWorkflowCredentials(appId, creds) {
  const filePath = path.join(USER_DATA, `workflow-credentials-${appId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(creds, null, 2));
}

/**
 * Load workflow admin config (BU setup widget names) for an app.
 */
function loadWorkflowAdminConfig(appId) {
  const filePath = path.join(USER_DATA, `workflow-admin-${appId}.json`);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch { return {}; }
}

/**
 * Save workflow admin config for an app.
 */
function saveWorkflowAdminConfigFile(appId, config) {
  const filePath = path.join(USER_DATA, `workflow-admin-${appId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2));
}

// Import workflow config JSON from file
ipcMain.handle("import-workflow-config", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: "Import Workflow Configuration",
    filters: [{ name: "JSON", extensions: ["json"] }],
    properties: ["openFile"],
  });
  if (canceled || !filePaths.length) return null;

  try {
    const raw = fs.readFileSync(filePaths[0], "utf-8");
    const jsonArray = JSON.parse(raw);

    // Handle both array and object-with-array formats
    const statuses = Array.isArray(jsonArray) ? jsonArray : (jsonArray.statuses || jsonArray.data || []);
    if (!statuses.length) return { error: "No statuses found in JSON" };

    // Deduplicate by UUID
    const seen = new Set();
    const unique = statuses.filter(s => {
      const key = s.UUID || s.uuid || s.Id || JSON.stringify({ o: s.Order, d: s.DisplayValue });
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Sort by Order
    unique.sort((a, b) => (a.Order || 0) - (b.Order || 0));

    // Classify and compute credential keys
    const enriched = unique.map(s => ({
      ...s,
      _classification: classifyWorkflowStatus(s, unique),
      _credentialKey: getWorkflowCredentialKey(s),
      _defaultActionIndex: getDefaultEscalationAction(s),
      _included: false, // will be set by UI
    }));

    // Auto-include: main flow + multi-sub statuses
    enriched.forEach(s => {
      if (s._classification === 'main' || s._classification === 'multi-sub') {
        s._included = true;
      }
    });

    return {
      filename: path.basename(filePaths[0]),
      statuses: enriched,
      ticketType: unique[0]?.TicketType || '',
    };
  } catch (err) {
    return { error: `Failed to parse JSON: ${err.message}` };
  }
});

// Generate a workflow plan from wizard data
ipcMain.handle("generate-workflow-plan", (event, opts) => {
  const {
    statuses,        // Selected statuses (Order > 1 only, or all non-requestor)
    firstScenarioId, // Existing recorded Requestor scenario
    actionSelections, // { statusUUID_or_order: actionIndex }
    credentialMap,   // { credKey: { username, password } }
    commentWidget,   // e.g. 'mx:txtDBComment'
    planName,
    targetUrl,
    appId,
    buSetup,         // Optional: { targetBU, adminCredentials, widgets }
  } = opts;

  const db = loadDB();
  if (!db.plans) db.plans = [];
  const now = new Date().toISOString();
  const scenarioIds = [];

  // 1. Generate BU Setup scenario if requested
  if (buSetup && buSetup.targetBU) {
    const uniqueUsernames = [...new Set(
      Object.values(credentialMap).map(c => c.username).filter(Boolean)
    )];

    const userListStr = uniqueUsernames.map(u => `    '${ScriptUtils.escapeJsString(u)}'`).join(',\n');
    const adminUser = ScriptUtils.escapeJsString(buSetup.adminCredentials?.username || '');
    const adminPass = ScriptUtils.escapeJsString(buSetup.adminCredentials?.password || '');
    const navWidget = (buSetup.widgets?.nav || '').replace(/^mx:/, '');
    const searchWidget = (buSetup.widgets?.search || '').replace(/^mx:/, '');
    const buDropdown = (buSetup.widgets?.buDropdown || '').replace(/^mx:/, '');
    const saveWidget = (buSetup.widgets?.save || '').replace(/^mx:/, '');
    const targetBU = ScriptUtils.escapeJsString(buSetup.targetBU);

    const buScript = `test('BU Setup - Assign users to ${targetBU}', async ({ page }) => {
  await page.goto(TARGET_URL);
  await mx.login(page, TARGET_URL, '${adminUser}', '${adminPass}');
  await mx.waitForMendix(page);

  const users = [
${userListStr}
  ];
  const targetBU = '${targetBU}';

  for (const username of users) {
    ${navWidget ? `await mx.clickWidget(page, '${navWidget}');` : '// Navigate to user management page'}
    await mx.waitForMendix(page);
    ${searchWidget ? `await mx.fillWidget(page, '${searchWidget}', username);` : '// Search for user by username'}
    await mx.waitForMendix(page);
    await mx.clickDataGridFirstRow(page);
    await mx.waitForMendix(page);
    ${buDropdown ? `await mx.selectDropdown(page, '${buDropdown}', targetBU);` : '// Select target BU from dropdown'}
    await mx.waitForMendix(page);
    ${saveWidget ? `await mx.clickWidget(page, '${saveWidget}');` : '// Click save button'}
    await mx.waitForMendix(page);
  }
});`;

    const buScenario = {
      id: uuidv4(),
      name: `BU Setup - ${buSetup.targetBU}`,
      targetUrl,
      appId,
      credentials: buSetup.adminCredentials || {},
      script: buScript,
      createdAt: now,
      updatedAt: now,
    };
    db.scenarios.push(buScenario);
    scenarioIds.push(buScenario.id);
  }

  // 2. Add the existing Requestor scenario
  if (firstScenarioId) {
    scenarioIds.push(firstScenarioId);
  }

  // 3. Generate a scenario for each workflow status
  for (const status of statuses) {
    const credKey = status._credentialKey || getWorkflowCredentialKey(status);
    const creds = credentialMap[credKey] || {};
    const statusKey = status.UUID || status.uuid || String(status.Order);
    const actionIndex = actionSelections?.[statusKey] ?? status._defaultActionIndex ?? 0;
    const action = (status.WorkFlowActions || [])[actionIndex];

    const steps = [];

    // Login
    steps.push({ action: 'Login', username: creds.username || '', password: creds.password || '' });
    steps.push({ action: 'WaitForMendix' });

    // Click first row (most recent ticket)
    steps.push({ action: 'ClickFirstDataGridRow' });
    steps.push({ action: 'WaitForMendix' });

    // Fill comment if required
    if (status.HasDBComment && commentWidget) {
      steps.push({ action: 'Fill', selector: commentWidget, value: 'Auto-test comment' });
    }

    // Click the action button by visible text
    if (action && action.Name) {
      steps.push({ action: 'Click', selector: `text:${action.Name}` });
      steps.push({ action: 'WaitForMendix' });
    }

    // Screenshot
    const safeStatusName = (status.DisplayValue || status.EnumSelection || `Step_${status.Order}`)
      .replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
    steps.push({ action: 'Screenshot', value: `${status.Order}-${safeStatusName}` });

    // Build scenario
    const scenarioName = `${status.DisplayValue || status.EnumSelection} (${credKey})`;
    const script = ScriptUtils.buildScriptFromSteps(steps, scenarioName);

    const scenario = {
      id: uuidv4(),
      name: scenarioName,
      targetUrl,
      appId,
      credentials: creds,
      script,
      createdAt: now,
      updatedAt: now,
    };
    db.scenarios.push(scenario);
    scenarioIds.push(scenario.id);
  }

  // 4. Create the plan
  const plan = {
    id: uuidv4(),
    name: planName || 'Generated Workflow Plan',
    description: `Auto-generated from workflow config. ${statuses.length} statuses.`,
    scenarioIds,
    createdAt: now,
    updatedAt: now,
  };
  db.plans.push(plan);
  saveDB(db);

  return { plan, scenarioCount: scenarioIds.length };
});

// Workflow credential CRUD
ipcMain.handle("get-workflow-credentials", (event, appId) => {
  return loadWorkflowCredentials(appId);
});

ipcMain.handle("save-workflow-credentials", (event, appId, creds) => {
  saveWorkflowCredentials(appId, creds);
  return true;
});

// Workflow admin config CRUD (BU setup widget names)
ipcMain.handle("get-workflow-admin-config", (event, appId) => {
  return loadWorkflowAdminConfig(appId);
});

ipcMain.handle("save-workflow-admin-config", (event, appId, config) => {
  saveWorkflowAdminConfigFile(appId, config);
  return true;
});

// Get all runs
ipcMain.handle("get-runs", () => {
  return loadDB().runs.slice(-100).reverse();
});

// Get saved URLs
ipcMain.handle("get-saved-urls", () => {
  const db = loadDB();
  return db.savedUrls || [];
});

// ── App & Element DB IPC Handlers ────────────────────────

ipcMain.handle("get-apps", () => {
  return loadApps();
});

ipcMain.handle("create-app", (event, appData) => {
  const apps = loadApps();
  const baseUrl = getElementDB().normalizeAppUrl(appData.baseUrl || appData.targetUrl || '');
  // Check for duplicate
  const existing = apps.find(a => a.baseUrl === baseUrl);
  if (existing) return existing;

  const newApp = {
    id: uuidv4(),
    name: appData.name || getElementDB().deriveAppName(baseUrl),
    baseUrl,
    credentials: appData.credentials || null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  apps.push(newApp);
  saveApps(apps);
  return newApp;
});

ipcMain.handle("update-app", (event, appData) => {
  const apps = loadApps();
  const idx = apps.findIndex(a => a.id === appData.id);
  if (idx < 0) return { error: "App not found" };
  apps[idx] = { ...apps[idx], ...appData, updatedAt: new Date().toISOString() };
  saveApps(apps);
  return apps[idx];
});

ipcMain.handle("delete-app", (event, appId) => {
  let apps = loadApps();
  apps = apps.filter(a => a.id !== appId);
  saveApps(apps);
  // Remove element DB directory
  const appDir = path.join(APPS_DIR, appId);
  try { fs.rmSync(appDir, { recursive: true, force: true }); } catch {}
  return true;
});

ipcMain.handle("get-element-db", (event, appId) => {
  if (!appId) return { elements: {} };
  return loadElementDBForApp(appId);
});

ipcMain.handle("scan-elements", (event, appId) => {
  const apps = loadApps();
  const app = apps.find(a => a.id === appId);
  if (!app) return { error: "App not found" };

  const db = loadDB();
  const appScenarios = db.scenarios.filter(s => s.appId === appId && s.script);
  if (!appScenarios.length) return { error: "No scenarios with scripts found for this app" };

  let elDB = loadElementDBForApp(appId);
  let totalElements = 0;

  for (const sc of appScenarios) {
    try {
      const steps = ScriptUtils.parseScriptToSteps(sc.script);
      if (steps.length) {
        elDB = getElementDB().enrichFromSteps(elDB, steps, sc.targetUrl || app.baseUrl);
        totalElements += steps.filter(s => s.selector).length;
      }
    } catch (err) {
      console.log(`[scan-elements] Skipped scenario "${sc.name}": ${err.message}`);
    }
  }

  saveElementDBForApp(appId, elDB);
  const count = Object.keys(elDB.elements || {}).length;
  return { success: true, count, scenariosScanned: appScenarios.length };
});

ipcMain.handle("generate-script", async (event, { appId, description }) => {
  const settings = getSettings().loadSettings();
  if (!settings.llm.apiKey) return { error: "No LLM API key configured. Go to Settings to add one." };

  const apps = loadApps();
  const app = apps.find(a => a.id === appId);
  if (!app) return { error: "App not found" };

  const elementDB = loadElementDBForApp(appId);
  const db = loadDB();
  const appScenarios = db.scenarios.filter(s => s.appId === appId && s.script);
  const exampleScripts = appScenarios.slice(0, 2).map(s => s.script);

  let llmClient;
  try {
    llmClient = new (getLLMClient())(settings);
  } catch (err) {
    return { error: err.message };
  }

  try {
    const { ScriptGenerator } = require("./agents/script-generator");
    const generator = new ScriptGenerator(llmClient);
    const result = await generator.generate({
      appName: app.name,
      baseUrl: app.baseUrl,
      elementDB,
      existingScripts: exampleScripts,
      description,
      credentials: app.credentials,
    });
    return result;
  } catch (err) {
    return { error: err.message };
  }
});

// Launch Codegen recorder
ipcMain.handle("launch-recorder", async (event, targetUrl, options = {}) => {
  return new Promise((resolve, reject) => {
    const outputFile = `recording-${Date.now()}.js`;
    const outputPath = path.join(SCRIPTS_DIR, outputFile);

    // Normalize URL
    let normalizedUrl = targetUrl;
    if (normalizedUrl && !normalizedUrl.startsWith("http") && !normalizedUrl.startsWith("file://") && !normalizedUrl.startsWith("about:")) {
      normalizedUrl = "http://" + normalizedUrl;
    }

    const db = loadDB();
    addSavedUrl(db, normalizedUrl);
    saveDB(db);

    // Clean up old .raw.js debug files from previous recordings (keep last 5)
    try {
      const rawFiles = fs.readdirSync(SCRIPTS_DIR)
        .filter(f => f.endsWith('.raw.js'))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(SCRIPTS_DIR, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      for (const old of rawFiles.slice(5)) {
        fs.unlinkSync(path.join(SCRIPTS_DIR, old.name));
      }
    } catch (e) { /* ignore cleanup errors */ }

    // Use our custom recorder which injects a script to swap <option> GUID
    // values with visible text BEFORE the user interacts — so codegen records
    // human-readable labels instead of Mendix GUIDs. No post-processing needed.
    const recorderScript = path.join(HELPERS_DIR, "recorder.js");
    const recSettings = getSettings().loadSettings();
    const recVp = resolveViewport(recSettings);
    const showHighlights = options.showHighlights ? "true" : "false";
    const recorderArgs = [recorderScript, normalizedUrl || "", outputPath, showHighlights];
    const channel = getBrowserChannel();
    if (channel) {
      recorderArgs.push(channel);
    }

    zlog(`[recorder] execPath: ${process.execPath}`);
    zlog(`[recorder] recorderScript: ${recorderScript}`);
    zlog(`[recorder] recorderScript exists: ${fs.existsSync(recorderScript)}`);
    zlog(`[recorder] CMD: ${process.execPath} ${recorderArgs.join(" ")}`);
    zlog(`[recorder] localBrowsers valid: ${isLocalBrowsersDirValid()}`);

    // In Electron, process.execPath is the Electron binary. Setting
    // ELECTRON_RUN_AS_NODE=1 makes it behave as a plain Node.js runtime.
    const proc = spawn(process.execPath, recorderArgs, {
      env: getPlaywrightEnv({
        ELECTRON_RUN_AS_NODE: "1",
        ...(PLAYWRIGHT_CORE_PATH ? { PLAYWRIGHT_CORE_PATH } : {}),
        ZONIQ_VIEWPORT_WIDTH: String(recVp.width),
        ZONIQ_VIEWPORT_HEIGHT: String(recVp.height),
      }),
    });

    proc.on("error", (err) => {
      zlog(`[recorder] SPAWN ERROR: ${err.message}`);
    });

    // Collect GUID→label map emitted by the recorder
    const recorderGuidMap = new Map();
    proc.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      zlog(`[recorder stdout] ${text.trim()}`);
      for (const line of text.split("\n")) {
        // Parse GUID map line (emitted just before recorder exits)
        const guidIdx = line.indexOf("[ZONIQ_GUID_MAP]");
        if (guidIdx !== -1) {
          try {
            const obj = JSON.parse(line.slice(guidIdx + "[ZONIQ_GUID_MAP]".length));
            for (const [guid, label] of Object.entries(obj)) {
              recorderGuidMap.set(guid, label);
            }
          } catch (e) {
            console.error("[recorder] Failed to parse GUID map:", e.message);
          }
        }
      }
    });
    proc.stderr.on("data", (chunk) => {
      zlog(`[recorder stderr] ${chunk.toString().trim()}`);
    });

    proc.on("close", (code) => {
      zlog(`[recorder] exited with code ${code}`);
      try {
        if (fs.existsSync(outputPath)) {
          let script = fs.readFileSync(outputPath, "utf-8");
          console.log(`[recorder] Script after recorder post-processing: ${script.length} chars, ${script.split('\n').length} lines`);

          // Fallback: if the recorder's own replacement missed any GUIDs
          // (race with codegen file write), apply them here.
          if (recorderGuidMap.size > 0) {
            let patched = 0;
            for (const [guid, label] of recorderGuidMap) {
              const escaped = label.replace(/'/g, "\\'");
              const before = script;
              script = script.split(`'${guid}'`).join(`'${escaped}'`);
              script = script.split(`"${guid}"`).join(`"${escaped}"`);
              if (script !== before) patched++;
            }
            if (patched > 0) {
              fs.writeFileSync(outputPath, script);
              console.log(`[recorder] Fallback: replaced ${patched} remaining GUID(s) with labels`);
            }
          }

          // Process captured elements from sidecar file
          const elementsPath = outputPath + ".elements.json";
          try {
            if (fs.existsSync(elementsPath)) {
              const discovered = JSON.parse(fs.readFileSync(elementsPath, "utf-8"));
              const app = findOrCreateApp(normalizedUrl);
              if (app && discovered.length) {
                let elDB = loadElementDBForApp(app.id);
                elDB = getElementDB().mergeElements(elDB, discovered, {
                  pageUrl: normalizedUrl,
                  pageTitle: '',
                });
                // Also enrich from parsed script steps
                try {
                  const steps = ScriptUtils.parseScriptToSteps(script);
                  if (steps.length) elDB = getElementDB().enrichFromSteps(elDB, steps, normalizedUrl);
                } catch {}
                saveElementDBForApp(app.id, elDB);
                console.log(`[recorder] Captured ${discovered.length} elements for app "${app.name}"`);
              }
              fs.unlinkSync(elementsPath);
            }
          } catch (elemErr) {
            console.error(`[recorder] Element capture error:`, elemErr.message);
          }

          resolve({ outputFile, script });
        } else {
          resolve({ outputFile: null, script: null });
        }
      } catch (err) {
        reject(err);
      }
    });

    proc.on("error", (err) => {
      console.error(`[recorder] spawn error:`, err);
      reject(err);
    });
  });
});

// Launch recorder from a specific step ("Record from here")
// Replays prefix statements, then enables codegen for new recording.
ipcMain.handle("launch-recorder-from-step", async (event, { scenario, stepIndex }) => {
  return new Promise((resolve, reject) => {
    const outputFile = `recording-from-step-${Date.now()}.js`;
    const outputPath = path.join(SCRIPTS_DIR, outputFile);

    // Parse steps and split the script at the requested step
    const { prefixStatements } = ScriptUtils.splitScriptAtStep(scenario.script, stepIndex);

    // Normalize URL
    let normalizedUrl = scenario.targetUrl;
    if (normalizedUrl && !normalizedUrl.startsWith("http") && !normalizedUrl.startsWith("file://") && !normalizedUrl.startsWith("about:")) {
      normalizedUrl = "http://" + normalizedUrl;
    }

    // Apply the same transformations that wrapScript() uses for normal execution.
    // Without these, .selectOption() calls hang on disabled Mendix dropdowns,
    // fragile #mxui_widget_* selectors fail, and duplicate selectors cause
    // strict mode violations.
    const transformedStatements = prefixStatements.map(stmt => {
      let s = cleanMendixSelectors(stmt);
      s = transformSelectOptionCalls(s);
      s = disambiguateSelectors(s);
      return s;
    });

    // Write prefix data to a temp JSON file for the recorder subprocess
    const prefixJsonPath = path.join(TEMP_DIR, `prefix-${Date.now()}.json`);
    fs.writeFileSync(prefixJsonPath, JSON.stringify({
      statements: transformedStatements,
      credentials: scenario.credentials || {},
      targetUrl: normalizedUrl,
    }));

    const recorderScript = path.join(HELPERS_DIR, "recorder-from-step.js");
    const settings = getSettings().loadSettings();
    const rfsVp = resolveViewport(settings);
    const showHighlights = settings.recorder?.showHighlights ? "true" : "false";
    const recorderArgs = [recorderScript, normalizedUrl || "", outputPath, showHighlights, prefixJsonPath];
    const channel = getBrowserChannel();
    if (channel) {
      recorderArgs.push(channel);
    }

    console.log(`[recorder-from-step] CMD: node ${recorderArgs.join(" ")}`);
    console.log(`[recorder-from-step] Replaying ${prefixStatements.length} steps before recording`);

    const proc = spawn(process.execPath, recorderArgs, {
      env: getPlaywrightEnv({
        ELECTRON_RUN_AS_NODE: "1",
        ...(PLAYWRIGHT_CORE_PATH ? { PLAYWRIGHT_CORE_PATH } : {}),
        ZONIQ_VIEWPORT_WIDTH: String(rfsVp.width),
        ZONIQ_VIEWPORT_HEIGHT: String(rfsVp.height),
      }),
    });

    // Collect GUID map and replay progress
    const recorderGuidMap = new Map();
    proc.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      console.log(`[recorder-from-step stdout] ${text}`);

      for (const line of text.split("\n")) {
        // GUID map
        const guidIdx = line.indexOf("[ZONIQ_GUID_MAP]");
        if (guidIdx !== -1) {
          try {
            const obj = JSON.parse(line.slice(guidIdx + "[ZONIQ_GUID_MAP]".length));
            for (const [guid, label] of Object.entries(obj)) {
              recorderGuidMap.set(guid, label);
            }
          } catch (e) {
            console.error("[recorder-from-step] Failed to parse GUID map:", e.message);
          }
        }

        // Forward replay progress to the UI
        const replayStepIdx = line.indexOf("[ZONIQ_REPLAY_STEP]");
        if (replayStepIdx !== -1) {
          try {
            const data = JSON.parse(line.slice(replayStepIdx + "[ZONIQ_REPLAY_STEP]".length));
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send("recorder-from-step-progress", data);
            }
          } catch {}
        }

        const replayStatusIdx = line.indexOf("[ZONIQ_REPLAY_STATUS]");
        if (replayStatusIdx !== -1) {
          try {
            const data = JSON.parse(line.slice(replayStatusIdx + "[ZONIQ_REPLAY_STATUS]".length));
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send("recorder-from-step-status", data);
            }
          } catch {}
        }
      }
    });
    proc.stderr.on("data", (chunk) => {
      console.error(`[recorder-from-step stderr] ${chunk}`);
    });

    proc.on("close", (code) => {
      console.log(`[recorder-from-step] exited with code ${code}`);
      // Clean up prefix JSON
      try { fs.unlinkSync(prefixJsonPath); } catch {}

      try {
        if (fs.existsSync(outputPath)) {
          let newScript = fs.readFileSync(outputPath, "utf-8");

          // Fallback GUID replacement
          if (recorderGuidMap.size > 0) {
            let patched = 0;
            for (const [guid, label] of recorderGuidMap) {
              const escaped = label.replace(/'/g, "\\'");
              const before = newScript;
              newScript = newScript.split(`'${guid}'`).join(`'${escaped}'`);
              newScript = newScript.split(`"${guid}"`).join(`"${escaped}"`);
              if (newScript !== before) patched++;
            }
            if (patched > 0) {
              console.log(`[recorder-from-step] Fallback: replaced ${patched} remaining GUID(s)`);
            }
          }

          // Extract just the body from the newly recorded script
          const newBody = ScriptUtils.extractTestBody(newScript);

          // Merge the new recording into the original script
          const mergedScript = ScriptUtils.mergeRecordedCode(
            scenario.script,
            stepIndex,
            newBody || newScript
          );

          // Process captured elements
          const elementsPath = outputPath + ".elements.json";
          try {
            if (fs.existsSync(elementsPath)) {
              const discovered = JSON.parse(fs.readFileSync(elementsPath, "utf-8"));
              const app = findOrCreateApp(normalizedUrl);
              if (app && discovered.length) {
                let elDB = loadElementDBForApp(app.id);
                elDB = getElementDB().mergeElements(elDB, discovered, {
                  pageUrl: normalizedUrl,
                  pageTitle: '',
                });
                try {
                  const steps = ScriptUtils.parseScriptToSteps(mergedScript);
                  if (steps.length) elDB = getElementDB().enrichFromSteps(elDB, steps, normalizedUrl);
                } catch {}
                saveElementDBForApp(app.id, elDB);
                console.log(`[recorder-from-step] Captured ${discovered.length} elements`);
              }
              fs.unlinkSync(elementsPath);
            }
          } catch (elemErr) {
            console.error(`[recorder-from-step] Element capture error:`, elemErr.message);
          }

          // Clean up the recorded file
          try { fs.unlinkSync(outputPath); } catch {}

          resolve({ mergedScript, newBody: newBody || newScript, stepIndex });
        } else {
          resolve({ mergedScript: null, newBody: null, stepIndex });
        }
      } catch (err) {
        reject(err);
      }
    });

    proc.on("error", (err) => {
      console.error(`[recorder-from-step] spawn error:`, err);
      try { fs.unlinkSync(prefixJsonPath); } catch {}
      reject(err);
    });
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

// ── Shared scenario execution logic ──────────────────────
// Used by both the IPC handler and plan execution.
// planRunId is optional — set when executing as part of a plan.
async function executeScenarioInternal(scenario, planRunId, opts = {}) {
  const runId = uuidv4();
  const scriptPath = path.join(TEMP_DIR, `run-${runId}.spec.js`);

  if (!scenario.script) {
    return { runId, status: "error", errors: [{ message: "No script defined" }] };
  }
  const scriptContent = wrapScript(scenario.script, scenario.targetUrl, scenario.credentials);

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
  if (planRunId) run.planRunId = planRunId;
  db.runs.push(run);
  saveDB(db);

  // Notify UI that run started
  mainWindow.webContents.send("run-started", run);

  // Build step list for tracking (used by both UI and persisted results)
  let stepList = null;
  const stepResults = {}; // { stepIndex: { status, error, startedAt, completedAt } }

  // Derive steps from script for progress tracking.
  // Step indices must match the marker indices injected by injectStepMarkers(),
  // which are 0-based per statement in the test body.
  const parsedSteps = scenario.script ? ScriptUtils.parseScriptToSteps(scenario.script) : [];
  if (parsedSteps.length) {
    stepList = parsedSteps.map((s, i) => ({
      index: i,
      action: s.action,
      selector: s.selector || "",
      value: s.value || "",
      description: `${s.action}${s.selector ? ' ' + s.selector : ''}${s.value ? ' = ' + s.value : ''}`,
    }));
    mainWindow.webContents.send("step-list", { runId, steps: stepList });
  }

  // Step progress callback — streams real-time updates to the renderer
  // and collects results for persistence
  const onStepProgress = (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("step-progress", progress);
    }
    // Accumulate step results for saving with the run
    const idx = progress.stepIndex;
    if (!stepResults[idx]) stepResults[idx] = {};
    if (progress.status === "running") {
      stepResults[idx].status = "running";
      stepResults[idx].startedAt = new Date().toISOString();
    } else if (progress.status === "done") {
      stepResults[idx].status = "done";
      stepResults[idx].completedAt = new Date().toISOString();
    } else if (progress.status === "failed") {
      stepResults[idx].status = "failed";
      stepResults[idx].error = progress.error;
      stepResults[idx].completedAt = new Date().toISOString();
    }
  };

  try {
    const results = await runPlaywright(scriptPath, runId, onStepProgress, opts.headed);
    run.status = results.status;
    run.completedAt = new Date().toISOString();
    // Attach step data to results for persistence
    if (stepList) {
      results.stepList = stepList;
      results.stepResults = stepResults;
    } else if (results.reportStepList) {
      // Fallback for script-based scenarios: use report-extracted steps
      results.stepList = results.reportStepList;
      results.stepResults = results.reportStepResults;
    }
    delete results.reportStepList;
    delete results.reportStepResults;
    run.results = results;

    // ── Auto-heal script: replace GUIDs with resolved label text ──
    if (results.guidResolutions && results.guidResolutions.size > 0 && scenario.id) {
      const db2pre = loadDB();
      const sc = db2pre.scenarios.find(s => s.id === scenario.id);
      if (sc && sc.script) {
        let updated = sc.script;
        for (const [guid, label] of results.guidResolutions) {
          const escaped = label.replace(/'/g, "\\'");
          updated = updated.split(`'${guid}'`).join(`'${escaped}'`);
          updated = updated.split(`"${guid}"`).join(`"${escaped}"`);
        }
        if (updated !== sc.script) {
          sc.script = updated;
          sc.updatedAt = new Date().toISOString();
          saveDB(db2pre);
          console.log(`[guid-heal] Replaced ${results.guidResolutions.size} GUID(s) with labels in scenario "${sc.name}"`);
        }
      }
    }
    // Remove guidResolutions from persisted results (internal only)
    delete results.guidResolutions;

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
}

// Execute a scenario
ipcMain.handle("execute-scenario", async (event, scenario, opts = {}) => {
  return executeScenarioInternal(scenario, null, opts);
});

// ── Plan Execution ───────────────────────────────────────
let activePlanExecution = null; // { planRunId, cancelled }

ipcMain.handle("execute-plan", async (event, plan) => {
  const db = loadDB();
  if (!db.plans) db.plans = [];
  const fromIndex = plan.fromIndex != null ? plan.fromIndex : 0;
  const upToIndex = plan.upToIndex != null ? plan.upToIndex : null;
  const retryRunId = plan.retryRunId || null;
  const scenarioIds = upToIndex != null
    ? (plan.scenarioIds || []).slice(0, upToIndex + 1)
    : (plan.scenarioIds || []);
  const resolvedScenarios = scenarioIds
    .map(id => db.scenarios.find(s => s.id === id))
    .filter(Boolean);

  const planRunId = retryRunId || uuidv4();

  if (!resolvedScenarios.length) {
    return { runId: planRunId, status: "error", errors: [{ message: "No valid scenarios in plan" }] };
  }

  // Reuse existing plan run on retry, or create a new one
  const db2 = loadDB();
  let planRun;
  if (retryRunId) {
    planRun = db2.runs.find(r => r.runId === retryRunId);
    if (planRun) {
      planRun.status = "running";
      planRun.startedAt = new Date().toISOString();
      planRun.completedAt = null;
      planRun.results = null;
      // Reset scenarios from fromIndex onward; keep earlier results
      for (let i = fromIndex; i < planRun.scenarioRuns.length; i++) {
        // Delete old child runs for retried scenarios
        if (planRun.scenarioRuns[i].runId) {
          db2.runs = db2.runs.filter(r => r.runId !== planRun.scenarioRuns[i].runId);
        }
        planRun.scenarioRuns[i].runId = null;
        planRun.scenarioRuns[i].status = "pending";
      }
      saveDB(db2);
    }
  }
  if (!planRun) {
    planRun = {
      runId: planRunId,
      planId: plan.id,
      testName: `Plan: ${plan.name}`,
      status: "running",
      startedAt: new Date().toISOString(),
      completedAt: null,
      results: null,
      scenarioRuns: resolvedScenarios.map(s => ({
        scenarioId: s.id,
        scenarioName: s.name,
        runId: null,
        status: "pending",
      })),
    };
    db2.runs.push(planRun);
    saveDB(db2);
  }

  mainWindow.webContents.send("plan-run-started", {
    planRunId, planId: plan.id, planName: plan.name,
    scenarioRuns: planRun.scenarioRuns,
  });

  activePlanExecution = { planRunId, cancelled: false };

  for (let i = 0; i < resolvedScenarios.length; i++) {
    if (activePlanExecution?.cancelled) {
      // Mark remaining as skipped
      const dbSkip = loadDB();
      const prSkip = dbSkip.runs.find(r => r.runId === planRunId);
      if (prSkip) {
        for (let j = i; j < prSkip.scenarioRuns.length; j++) {
          prSkip.scenarioRuns[j].status = "skipped";
        }
        saveDB(dbSkip);
      }
      break;
    }

    const scenario = resolvedScenarios[i];

    // Skip scenarios before fromIndex (retry-from-here)
    if (i < fromIndex) {
      const dbSkipPre = loadDB();
      const prSkipPre = dbSkipPre.runs.find(r => r.runId === planRunId);
      if (prSkipPre) {
        // On retry, preserve existing results for pre-fromIndex scenarios
        if (!retryRunId || !prSkipPre.scenarioRuns[i].status || prSkipPre.scenarioRuns[i].status === "pending") {
          prSkipPre.scenarioRuns[i].status = "skipped";
          saveDB(dbSkipPre);
        }
      }
      const prevStatus = retryRunId ? (prSkipPre?.scenarioRuns[i]?.status || "skipped") : "skipped";
      const prevRunId = retryRunId ? (prSkipPre?.scenarioRuns[i]?.runId || null) : null;
      mainWindow.webContents.send("plan-scenario-completed", {
        planRunId, scenarioId: scenario.id, scenarioIndex: i,
        status: prevStatus, runId: prevRunId,
      });
      continue;
    }

    mainWindow.webContents.send("plan-scenario-started", {
      planRunId, scenarioId: scenario.id, scenarioIndex: i,
      totalScenarios: resolvedScenarios.length,
    });

    const run = await executeScenarioInternal(scenario, planRunId);

    // Update plan run record
    const db3 = loadDB();
    const pr = db3.runs.find(r => r.runId === planRunId);
    if (pr) {
      pr.scenarioRuns[i].runId = run.runId;
      pr.scenarioRuns[i].status = run.status;
      saveDB(db3);
    }

    mainWindow.webContents.send("plan-scenario-completed", {
      planRunId, scenarioId: scenario.id, scenarioIndex: i,
      status: run.status, runId: run.runId,
    });

    // Stop on failure
    if (run.status !== "passed") {
      const db4 = loadDB();
      const pr2 = db4.runs.find(r => r.runId === planRunId);
      if (pr2) {
        for (let j = i + 1; j < pr2.scenarioRuns.length; j++) {
          pr2.scenarioRuns[j].status = "skipped";
        }
        saveDB(db4);
      }
      break;
    }
  }

  // Finalize plan run
  const dbFinal = loadDB();
  const prFinal = dbFinal.runs.find(r => r.runId === planRunId);
  if (prFinal) {
    const allStatuses = prFinal.scenarioRuns.map(sr => sr.status);
    prFinal.status = allStatuses.some(s => s === "failed" || s === "error") ? "failed"
      : allStatuses.every(s => s === "passed" || s === "skipped") ? "passed"
      : "error";
    prFinal.completedAt = new Date().toISOString();
    prFinal.results = {
      status: prFinal.status,
      summary: {
        total: prFinal.scenarioRuns.length,
        passed: prFinal.scenarioRuns.filter(sr => sr.status === "passed").length,
        failed: prFinal.scenarioRuns.filter(sr => sr.status === "failed" || sr.status === "error").length,
        skipped: prFinal.scenarioRuns.filter(sr => sr.status === "skipped").length,
      },
    };
    saveDB(dbFinal);
  }

  activePlanExecution = null;
  mainWindow.webContents.send("plan-run-completed", {
    planRunId, status: prFinal?.status, scenarioRuns: prFinal?.scenarioRuns,
  });
  mainWindow.webContents.send("runs-updated");

  return prFinal;
});

ipcMain.handle("stop-plan-execution", () => {
  if (activePlanExecution) {
    activePlanExecution.cancelled = true;
    return true;
  }
  return false;
});

// Get absolute path for a run artifact (for displaying images in the renderer)
ipcMain.handle("get-artifact-path", (event, runId, filename) => {
  if (!runId || !filename) return null;
  // Security: prevent directory traversal (block ".." but allow subdirectories)
  if (filename.includes('..')) return null;
  const filePath = path.join(RESULTS_DIR, runId, filename);
  if (!filePath.startsWith(path.resolve(RESULTS_DIR) + path.sep)) return null;
  if (fs.existsSync(filePath)) return filePath;
  return null;
});

// Open results folder
ipcMain.handle("open-results-folder", (event, runId) => {
  const dir = path.join(RESULTS_DIR, runId);
  if (fs.existsSync(dir)) shell.openPath(dir);
  else shell.openPath(RESULTS_DIR);
});

// ── Agent State ──────────────────────────────────────────
let activeAgent = null; // { type, agent, runId }

// ── Settings IPC Handlers ────────────────────────────────

ipcMain.handle("get-settings", () => {
  return getSettings().loadSettings();
});

ipcMain.handle("get-screen-size", () => {
  const display = screen.getPrimaryDisplay();
  return { width: display.size.width, height: display.size.height };
});

/**
 * Resolve the effective viewport dimensions from settings.
 * When viewportAuto is true, uses the primary display size.
 */
function resolveViewport(settings) {
  if (settings.testExecution.viewportAuto) {
    const display = screen.getPrimaryDisplay();
    return { width: display.size.width, height: display.size.height };
  }
  return {
    width: settings.testExecution.viewportWidth || 1920,
    height: settings.testExecution.viewportHeight || 1080,
  };
}

ipcMain.handle("save-settings", (event, settings) => {
  return getSettings().saveSettings(settings);
});

ipcMain.handle("test-llm-connection", async (event, settings) => {
  try {
    const client = new (getLLMClient())(settings);
    return await client.testConnection();
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── Agent IPC Handlers ───────────────────────────────────

ipcMain.handle("agent-heal", async (event, { scenarioId, runId }) => {
  if (activeAgent) {
    return { error: "An agent is already running. Cancel it first." };
  }

  const db = loadDB();
  const scenario = db.scenarios.find((s) => s.id === scenarioId);
  const run = db.runs.find((r) => r.runId === runId);

  if (!scenario) return { error: "Scenario not found" };
  if (!run) return { error: "Run not found" };
  if (!run.results?.errors?.length) return { error: "No errors to heal" };

  const settings = getSettings().loadSettings();
  if (!settings.llm.apiKey) {
    return { error: "No API key configured. Go to Settings to add one." };
  }

  let llmClient;
  try {
    llmClient = new (getLLMClient())(settings);
  } catch (err) {
    return { error: err.message };
  }

  const healer = new (getHealerAgent())(llmClient, {
    maxIterations: settings.agent.maxIterations,
    headless: settings.agent.headless,
    browserChannel: getBrowserChannel(),
    viewport: resolveViewport(settings),
  });

  activeAgent = { type: "healer", agent: healer };

  const onProgress = (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("agent-progress", {
        agentType: "healer",
        ...data,
      });
    }
  };

  // Load element DB for enhanced healing context
  const elementDB = scenario.appId ? loadElementDBForApp(scenario.appId) : null;

  try {
    const result = await healer.heal({
      script: scenario.script || "",
      errors: run.results.errors,
      targetUrl: scenario.targetUrl,
      credentials: scenario.credentials,
      onProgress,
      elementDB,
    });

    activeAgent = null;

    // Persist analysis to history
    const dbForSave = loadDB();
    if (!dbForSave.analyses) dbForSave.analyses = [];
    const analysisEntry = {
      id: uuidv4(),
      scenarioId,
      runId,
      type: "heal",
      analysis: result.analysis || null,
      confidence: result.confidence || null,
      changes: result.changes || [],
      healedScript: result.healedScript || null,
      applied: false,
      createdAt: new Date().toISOString(),
    };
    dbForSave.analyses.push(analysisEntry);
    saveDB(dbForSave);

    return {
      analysisId: analysisEntry.id,
      healedScript: result.healedScript,
      changes: result.changes,
      analysis: result.analysis,
      confidence: result.confidence,
    };
  } catch (err) {
    activeAgent = null;
    return { error: err.message };
  }
});

ipcMain.handle("agent-analyze", async (event, { scenarioId, runId }) => {
  if (activeAgent) {
    return { error: "An agent is already running. Cancel it first." };
  }

  const db = loadDB();
  const scenario = db.scenarios.find((s) => s.id === scenarioId);
  const run = db.runs.find((r) => r.runId === runId);

  if (!scenario) return { error: "Scenario not found" };
  if (!run) return { error: "Run not found" };
  if (!run.results?.errors?.length) return { error: "No errors to analyse" };

  const settings = getSettings().loadSettings();
  if (!settings.llm.apiKey) {
    return { error: "No API key configured. Go to Settings to add one." };
  }

  let llmClient;
  try {
    llmClient = new (getLLMClient())(settings);
  } catch (err) {
    return { error: err.message };
  }

  const healer = new (getHealerAgent())(llmClient, {});

  activeAgent = { type: "analyzer", agent: healer };

  const onProgress = (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("agent-progress", {
        agentType: "analyzer",
        ...data,
      });
    }
  };

  try {
    const result = await healer.analyzeOnly({
      script: scenario.script || "",
      errors: run.results.errors,
      targetUrl: scenario.targetUrl,
      onProgress,
    });

    activeAgent = null;

    // Persist analysis to history
    const dbForSave = loadDB();
    if (!dbForSave.analyses) dbForSave.analyses = [];
    const analysisEntry = {
      id: uuidv4(),
      scenarioId,
      runId,
      type: "analysis",
      analysis: result.analysis || null,
      confidence: result.confidence || null,
      changes: result.changes || [],
      healedScript: result.healedScript || null,
      applied: false,
      createdAt: new Date().toISOString(),
    };
    dbForSave.analyses.push(analysisEntry);
    saveDB(dbForSave);

    return {
      analysisId: analysisEntry.id,
      healedScript: result.healedScript || null,
      changes: result.changes,
      analysis: result.analysis,
      confidence: result.confidence,
    };
  } catch (err) {
    activeAgent = null;
    return { error: err.message };
  }
});

ipcMain.handle("agent-heal-apply", async (event, { scenarioId, healedScript, analysisId }) => {
  const db = loadDB();
  const idx = db.scenarios.findIndex((s) => s.id === scenarioId);
  if (idx < 0) return { error: "Scenario not found" };

  db.scenarios[idx].script = healedScript;
  db.scenarios[idx].updatedAt = new Date().toISOString();

  // Mark analysis as applied
  if (analysisId && db.analyses) {
    const analysis = db.analyses.find((a) => a.id === analysisId);
    if (analysis) {
      analysis.applied = true;
      analysis.appliedAt = new Date().toISOString();
    }
  }

  saveDB(db);
  return { ok: true };
});

ipcMain.handle("get-analyses", async (event, { scenarioId }) => {
  const db = loadDB();
  if (!db.analyses) return [];
  return db.analyses
    .filter((a) => a.scenarioId === scenarioId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
});

ipcMain.handle("delete-analysis", async (event, analysisId) => {
  const db = loadDB();
  if (!db.analyses) return { ok: false };
  const idx = db.analyses.findIndex((a) => a.id === analysisId);
  if (idx < 0) return { error: "Analysis not found" };
  db.analyses.splice(idx, 1);
  saveDB(db);
  return { ok: true };
});

ipcMain.handle("agent-cancel", () => {
  if (activeAgent) {
    if (activeAgent.agent) activeAgent.agent.cancel();
    activeAgent = null;
    return { ok: true };
  }
  return { ok: false, error: "No agent running" };
});

// ── Script Cleanup ─────────────────────────────────────────

ipcMain.handle("cleanup-script", async (event, scenarioId) => {
  try {
    const db = loadDB();
    const scenario = db.scenarios.find((s) => s.id === scenarioId);
    if (!scenario) return { error: "Scenario not found" };
    if (!scenario.script) return { error: "Scenario has no script" };

    const result = ScriptUtils.cleanupScript(scenario.script);
    result.originalScript = scenario.script;
    return result;
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle("cleanup-script-ai", async (event, scenarioId) => {
  try {
    const db = loadDB();
    const scenario = db.scenarios.find((s) => s.id === scenarioId);
    if (!scenario) return { error: "Scenario not found" };
    if (!scenario.script) return { error: "Scenario has no script" };

    const settings = getSettings().loadSettings();
    if (!settings.llm?.apiKey) return { error: "LLM API key not configured. Go to Settings to add one." };

    // Run rule-based cleanup first
    const ruleResult = ScriptUtils.cleanupScript(scenario.script);

    // Run AI cleanup on the (possibly rule-cleaned) script
    const { CleanupAgent } = require("./agents/cleanup-agent");
    const llmClient = new (getLLMClient())(settings);
    const agent = new CleanupAgent(llmClient);

    const scriptForAI = ruleResult.removedCount > 0 ? ruleResult.cleanedScript : scenario.script;
    const aiResult = await agent.cleanup({
      script: scriptForAI,
      ruleChanges: ruleResult.changes,
    });

    return {
      originalScript: scenario.script,
      cleanedScript: aiResult.cleanedScript || scriptForAI,
      ruleChanges: ruleResult.changes,
      aiChanges: aiResult.changes || [],
      analysis: aiResult.analysis || "",
      removedCount: ruleResult.removedCount + (aiResult.changes?.length || 0),
    };
  } catch (err) {
    return { error: err.message };
  }
});

// ── Window ───────────────────────────────────────────────
let mainWindow;

function createSplash() {
  const splash = new BrowserWindow({
    width: 420,
    height: 240,
    frame: false,
    transparent: false,
    resizable: false,
    alwaysOnTop: true,
    center: true,
    show: true,
    skipTaskbar: false,
    backgroundColor: "#0a0e17",
    webPreferences: { nodeIntegration: false },
  });
  splash.loadFile("splash.html");
  return splash;
}

function updateSplashStatus(splash, text) {
  if (splash && !splash.isDestroyed()) {
    splash.webContents.executeJavaScript(
      `document.querySelector('.status').textContent = ${JSON.stringify(text)};`
    ).catch(() => {});
  }
}

function createWindow(splash) {
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
    if (splash && !splash.isDestroyed()) splash.close();
    mainWindow.show();
  });

  // Remove menu bar on Windows/Linux
  mainWindow.setMenuBarVisibility(false);
}

app.whenReady().then(() => {
  // Show splash immediately, before any heavy initialization
  const splash = createSplash();

  updateSplashStatus(splash, "Preparing workspace…");
  ensurePlaywrightConfig();

  updateSplashStatus(splash, "Loading UI…");
  createWindow(splash);

  updateSplashStatus(splash, "Starting API server…");
  startAPIServer();
});

app.on("window-all-closed", () => {
  // Clean up any running agents
  if (activeAgent) {
    if (activeAgent.agent) activeAgent.agent.cancel();
    activeAgent = null;
  }
  if (apiServer) apiServer.close();
  app.quit();
});
