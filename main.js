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
const { loadSettings, saveSettings, getDefaultModel } = require("./settings");
const { LLMClient } = require("./agents/llm-client");
const { HealerAgent } = require("./agents/healer-agent");
const ScriptUtils = require("./lib/script-utils");

// ── Paths ────────────────────────────────────────────────
const USER_DATA = app.getPath("userData");
const SCRIPTS_DIR = path.join(USER_DATA, "scripts");
const RESULTS_DIR = path.join(USER_DATA, "results");
const TEMP_DIR = path.join(__dirname, "temp");
const HELPERS_DIR = path.join(__dirname, "helpers");
const DB_PATH = path.join(USER_DATA, "scenarios.json");

// ── Playwright paths ────────────────────────────────────
const PLAYWRIGHT_CLI = path.resolve(
  __dirname,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "playwright.cmd" : "playwright"
);

// Support bundled browsers: if a "browsers" directory exists next to the app
// AND contains a working Chromium executable, tell Playwright to look there.
// This lets users pre-install browsers once (or copy them from another machine)
// without needing network access.
const LOCAL_BROWSERS_DIR = path.join(__dirname, "browsers");
let _localBrowsersValid = null; // cached result of validation

function isLocalBrowsersDirValid() {
  if (_localBrowsersValid !== null) return _localBrowsersValid;
  if (!fs.existsSync(LOCAL_BROWSERS_DIR)) {
    _localBrowsersValid = false;
    return false;
  }
  // Verify that bundled Chromium actually exists inside the local dir
  try {
    const origEnv = process.env.PLAYWRIGHT_BROWSERS_PATH;
    process.env.PLAYWRIGHT_BROWSERS_PATH = LOCAL_BROWSERS_DIR;
    const pw = require("playwright-core");
    const execPath = pw.chromium.executablePath();
    // Restore original env
    if (origEnv !== undefined) {
      process.env.PLAYWRIGHT_BROWSERS_PATH = origEnv;
    } else {
      delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    }
    _localBrowsersValid = !!(execPath && fs.existsSync(execPath));
  } catch {
    _localBrowsersValid = false;
  }
  if (!_localBrowsersValid) {
    console.log("[browser] Local browsers directory exists but is incomplete, ignoring it");
  }
  return _localBrowsersValid;
}

function getPlaywrightEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  if (isLocalBrowsersDirValid()) {
    env.PLAYWRIGHT_BROWSERS_PATH = LOCAL_BROWSERS_DIR;
  }
  return env;
}

// Detect whether Playwright's bundled Chromium is installed.
// If not, fall back to the system browser (Edge on Windows, Chrome on others).
function detectBrowserChannel() {
  // If we have a valid local browsers dir, check there first
  if (isLocalBrowsersDirValid()) {
    return null; // validated local Chromium is available
  }
  try {
    const pw = require("playwright-core");
    const execPath = pw.chromium.executablePath();
    if (execPath && fs.existsSync(execPath)) {
      return null; // bundled Chromium is available
    }
    return getFallbackChannel();
  } catch {
    return getFallbackChannel();
  }
}

function getFallbackChannel() {
  if (process.platform === "win32") return "msedge";
  if (process.platform === "darwin") return "chrome";
  return "chrome";
}

// Cache the channel detection at startup
let _browserChannel = null;
let _browserChannelDetected = false;
function getBrowserChannel() {
  if (!_browserChannelDetected) {
    _browserChannel = detectBrowserChannel();
    _browserChannelDetected = true;
    if (_browserChannel) {
      console.log(`[browser] Playwright Chromium not found, using system browser: ${_browserChannel}`);
    } else {
      console.log("[browser] Using Playwright bundled Chromium");
    }
  }
  return _browserChannel;
}

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
  return { scenarios: [], runs: [], savedUrls: [] };
}

function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function addSavedUrl(db, url) {
  if (!url || typeof url !== "string") return;
  const normalized = url.trim();
  if (!normalized) return;
  if (!db.savedUrls) db.savedUrls = [];
  if (!db.savedUrls.includes(normalized)) {
    db.savedUrls.push(normalized);
  }
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

function wrapScript(script, targetUrl, credentials) {
  let scriptBody = script.trim();

  // Strip Codegen's own imports (both ESM and CommonJS)
  scriptBody = scriptBody
    .replace(/^import\s+\{[^}]*\}\s+from\s+['"][^'"]*['"];\s*$/gm, '')
    .replace(/^import\s+\*\s+as\s+\w+\s+from\s+['"][^'"]*['"];\s*$/gm, '')
    .replace(/^import\s+\w+\s+from\s+['"][^'"]*['"];\s*$/gm, '')
    .replace(/^const\s+\{[^}]*\}\s*=\s*require\s*\([^)]*\);\s*$/gm, '')
    .replace(/^const\s+\w+\s*=\s*require\s*\([^)]*\);\s*$/gm, '')
    // Strip existing TARGET_URL and CREDENTIALS declarations to avoid duplicates
    .replace(/^const\s+TARGET_URL\s*=\s*.*;\s*$/gm, '')
    .replace(/^const\s+CREDENTIALS\s*=\s*\{[\s\S]*?\}\s*;\s*$/gm, '')
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

  // Inject per-statement progress markers into the test body
  scriptBody = injectStepMarkers(scriptBody);

  return `
const { test, expect, chromium } = require('@playwright/test');
const mx = require('${MENDIX_HELPERS_PATH}');
const TARGET_URL = ${JSON.stringify(targetUrl)};
const CREDENTIALS = ${JSON.stringify(credentials || {})};

${scriptBody}
`;
}

/**
 * Inject [ZONIQ_STEP:START/DONE/FAIL] markers around each statement in the
 * test body so the runner can report per-step progress.
 */
function injectStepMarkers(scriptBody) {
  const body = ScriptUtils.extractTestBody(scriptBody);
  if (!body) return scriptBody;

  const statements = ScriptUtils.splitIntoStatements(body);
  if (!statements.length) return scriptBody;

  // Build wrapped version of each statement
  const wrapped = statements.map((stmt, idx) => {
    const desc = ScriptUtils.describeStatement(stmt.text);
    // Raw / multi-statement blocks should not be wrapped in try/catch to avoid
    // scoping issues with const/let declarations.
    const isRaw = /^(?:const|let|var)\s/.test(stmt.text);
    if (isRaw) {
      return `  console.log('[ZONIQ_STEP:START:${idx}:${desc}]');\n` +
        `  ${stmt.text}\n` +
        `  console.log('[ZONIQ_STEP:DONE:${idx}]');`;
    }
    return `  console.log('[ZONIQ_STEP:START:${idx}:${desc}]');\n` +
      `  try {\n    ${stmt.text}\n` +
      `    console.log('[ZONIQ_STEP:DONE:${idx}]');\n` +
      `  } catch (_stepErr_${idx}) {\n` +
      `    console.log('[ZONIQ_STEP:FAIL:${idx}:' + _stepErr_${idx}.message.replace(/\\n/g, ' ') + ']');\n` +
      `    throw _stepErr_${idx};\n` +
      `  }`;
  });

  // Replace the test body with the wrapped version
  // Find the test body boundaries in scriptBody and splice in the wrapped code
  const testBodyMatch = scriptBody.match(
    /(\btest\s*\(\s*['"][^'"]*['"]\s*,\s*async\s*\(\s*\{\s*page\s*\}\s*\)\s*=>\s*\{)([\s\S]*)(\}\s*\)\s*;?\s*$)/
  );
  if (testBodyMatch) {
    return testBodyMatch[1] + '\n' + wrapped.join('\n\n') + '\n' + testBodyMatch[3];
  }
  return scriptBody;
}

function cleanMendixSelectors(script) {
  let cleaned = script;

  // 1. Replace #mxui_widget_Underlay_N clicks with class-based selector
  cleaned = cleaned.replace(
    /await page\.locator\(['"]#mxui_widget_Underlay_\d+['"]\)\.click\(\);/g,
    'await page.locator(".mx-underlay").click();'
  );

  // 2. Replace #mxui_widget_*_N selectors with class-based fallbacks
  //    and suggest role-based alternatives where applicable
  cleaned = cleaned.replace(
    /(['"])#mxui_widget_(\w+?)_\d+\1/g,
    (match, quote, widgetType) => {
      const classMap = {
        'TextBox': { css: '.mx-textbox', alt: 'page.getByRole("textbox")' },
        'TextArea': { css: '.mx-textarea', alt: 'page.getByRole("textbox")' },
        'Button': { css: '.mx-button', alt: 'page.getByRole("button", { name: "..." })' },
        'DataGrid': { css: '.mx-datagrid', alt: null },
        'DropDown': { css: '.mx-dropdown', alt: null },
        'CheckBox': { css: '.mx-checkbox', alt: 'page.getByRole("checkbox")' },
        'RadioButton': { css: '.mx-radiobutton', alt: 'page.getByRole("radio")' },
        'DatePicker': { css: '.mx-datepicker', alt: null },
        'ReferenceSelector': { css: '.mx-referenceselector', alt: 'page.getByLabel("Label text")' },
      };
      if (classMap[widgetType]) {
        const comment = classMap[widgetType].alt
          ? ` /* Consider: ${classMap[widgetType].alt} */`
          : '';
        return `${quote}${classMap[widgetType].css}${quote}${comment}`;
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

// ── Playwright execution ─────────────────────────────────
function extractSpecs(suites) {
  const specs = [];
  for (const suite of suites) {
    if (suite.specs) specs.push(...suite.specs);
    if (suite.suites) specs.push(...extractSpecs(suite.suites));
  }
  return specs;
}

/** Extract step-level data from the Playwright JSON report.
 *  Returns { stepList, stepResults } or null if no steps found. */
function extractStepsFromReport(report) {
  if (!report?.suites) return null;
  const specs = extractSpecs(report.suites);
  const stepList = [];
  const stepResults = {};
  let index = 0;

  for (const spec of specs) {
    for (const test of spec.tests || []) {
      for (const result of test.results || []) {
        for (const step of result.steps || []) {
          stepList.push({
            index,
            action: step.title,
            description: step.title,
          });
          const failed = step.error != null;
          stepResults[String(index)] = {
            status: failed ? "failed" : "done",
            error: failed ? (step.error.message || step.error.snippet || "") : undefined,
            durationMs: step.duration || 0,
          };
          index++;
        }
      }
    }
  }

  return stepList.length > 0 ? { stepList, stepResults } : null;
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
    const channel = getBrowserChannel();
    const settings = loadSettings();
    const env = getPlaywrightEnv({
      PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath,
      ...(channel ? { ZONIQ_BROWSER_CHANNEL: channel } : {}),
      ZONIQ_RETRIES: settings.testExecution.retryOnFailure ? "1" : "0",
      ZONIQ_STEP_TIMEOUT: String(settings.testExecution.stepTimeout || 30),
    });
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

    console.log(`[${runId}] CMD: ${PLAYWRIGHT_CLI} ${args.join(" ")}`);

    let stdoutBuf = "";
    let stderrBuf = "";

    const proc = spawn(PLAYWRIGHT_CLI, args, { env, shell: true, timeout: 300_000 });

    proc.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdoutBuf += text;

      // Parse step progress markers from stdout
      if (onStepProgress) {
        const lines = text.split("\n");
        for (const line of lines) {
          const cl = line.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
          const startMatch = cl.match(/^\[ZONIQ_STEP:START:(-?\d+):(.*)\]/);
          const doneMatch = cl.match(/^\[ZONIQ_STEP:DONE:(-?\d+)\]/);
          const failMatch = cl.match(/^\[ZONIQ_STEP:FAIL:(-?\d+):(.*)\]$/);
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

      const resultObj = { status, summary, errors, artifacts, stderr: stderrBuf?.substring(0, 2000) };

      // Extract step data from Playwright JSON report as a fallback for
      // tests that don't use real-time ZONIQ_STEP marker tracking.
      if (report) {
        const reportSteps = extractStepsFromReport(report);
        if (reportSteps) {
          resultObj.reportStepList = reportSteps.stepList;
          resultObj.reportStepResults = reportSteps.stepResults;
        }
      }

      resolve(resultObj);
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

    const settings = loadSettings();
    if (!settings.llm.apiKey) return res.status(400).json({ error: "No LLM API key configured" });

    let llmClient;
    try {
      llmClient = new LLMClient(settings);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const healer = new HealerAgent(llmClient, {
      maxIterations: settings.agent.maxIterations,
      headless: true,
      browserChannel: getBrowserChannel(),
    });
    activeAgent = { type: "healer", agent: healer };

    // Resolve results directory when healing by run ID
    let runResultsDir = null;
    let healArtifacts = [];
    if (runId) {
      const dir = path.join(RESULTS_DIR, runId);
      if (fs.existsSync(dir)) runResultsDir = dir;
      const run = loadDB().runs.find((r) => r.runId === runId);
      healArtifacts = run?.results?.artifacts || [];
    }

    res.json({ status: "running" });

    try {
      const result = await healer.heal({
        script: healScript,
        errors: healErrors,
        targetUrl: healUrl,
        credentials: healCreds,
        runResultsDir,
        artifacts: healArtifacts,
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

  api.post("/api/agent/preheal", async (req, res) => {
    if (activeAgent) return res.status(409).json({ error: "An agent is already running" });

    const { scenarioId, script, targetUrl, credentials } = req.body;

    let healScript, healUrl, healCreds;

    if (scenarioId) {
      const db = loadDB();
      const scenario = db.scenarios.find((s) => s.id === scenarioId);
      if (!scenario) return res.status(404).json({ error: "Scenario not found" });
      healScript = scenario.script;
      healUrl = scenario.targetUrl;
      healCreds = scenario.credentials;
    } else if (script && targetUrl) {
      healScript = script;
      healUrl = targetUrl;
      healCreds = credentials;
    } else {
      return res.status(400).json({ error: "Provide scenarioId or (script + targetUrl)" });
    }

    const settings = loadSettings();
    if (!settings.llm.apiKey) return res.status(400).json({ error: "No LLM API key configured" });

    if (!healScript) {
      return res.status(400).json({ error: "No script defined" });
    }
    const scriptContent = wrapScript(healScript, healUrl, healCreds);

    activeAgent = { type: "prehealer", agent: null };
    res.json({ status: "running" });

    try {
      // Run the test first
      const runId = uuidv4();
      const scriptPath = path.join(TEMP_DIR, `preheal-${runId}.spec.js`);
      fs.writeFileSync(scriptPath, scriptContent);
      const results = await runPlaywright(scriptPath, runId);
      try { fs.unlinkSync(scriptPath); } catch {}

      if (results.status === "passed") {
        activeAgent = null;
        return; // Test passed, nothing to heal
      }

      if (!results.errors?.length) {
        activeAgent = null;
        return;
      }

      // Heal the failures
      let llmClient;
      try {
        llmClient = new LLMClient(settings);
      } catch {
        activeAgent = null;
        return;
      }

      const healer = new HealerAgent(llmClient, {
        maxIterations: settings.agent.maxIterations,
        headless: true,
        browserChannel: getBrowserChannel(),
      });
      activeAgent = { type: "prehealer", agent: healer };

      const result = await healer.heal({
        script: healScript || "",
        errors: results.errors,
        targetUrl: healUrl,
        credentials: healCreds,
      });
      activeAgent = null;

      // Auto-apply if scenarioId was provided
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
  // Steps are ephemeral (derived from script) — never persist them
  delete scenario.steps;
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

// Get saved URLs
ipcMain.handle("get-saved-urls", () => {
  const db = loadDB();
  return db.savedUrls || [];
});

// Launch Codegen recorder
ipcMain.handle("launch-recorder", async (event, targetUrl, options = {}) => {
  return new Promise((resolve, reject) => {
    const outputFile = `recording-${Date.now()}.js`;
    const outputPath = path.join(SCRIPTS_DIR, outputFile);

    const codegenArgs = [
      "codegen",
      "--target=javascript",
      `--output=${outputPath}`,
      `--viewport-size=1920,1080`,
    ];
    const channel = getBrowserChannel();
    if (channel) {
      codegenArgs.push(`--channel=${channel}`);
    }

    // Normalize URL
    let normalizedUrl = targetUrl;
    if (normalizedUrl && !normalizedUrl.startsWith("http") && !normalizedUrl.startsWith("file://") && !normalizedUrl.startsWith("about:")) {
      normalizedUrl = "http://" + normalizedUrl;
    }
    if (normalizedUrl) {
      codegenArgs.push(normalizedUrl);
    }

    const db = loadDB();
    addSavedUrl(db, normalizedUrl);
    saveDB(db);

    console.log(`[recorder] CMD: ${PLAYWRIGHT_CLI} ${codegenArgs.join(" ")}`);

    const proc = spawn(PLAYWRIGHT_CLI, codegenArgs, {
      env: getPlaywrightEnv(),
      shell: true,
    });

    proc.stdout.on("data", (chunk) => {
      console.log(`[recorder stdout] ${chunk}`);
    });
    proc.stderr.on("data", (chunk) => {
      console.error(`[recorder stderr] ${chunk}`);
    });

    proc.on("close", (code) => {
      console.log(`[recorder] exited with code ${code}`);
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

    proc.on("error", (err) => {
      console.error(`[recorder] spawn error:`, err);
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

// Execute a scenario
ipcMain.handle("execute-scenario", async (event, scenario) => {
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
    const results = await runPlaywright(scriptPath, runId, onStepProgress);
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

// ── Agent State ──────────────────────────────────────────
let activeAgent = null; // { type, agent, runId }

// ── Settings IPC Handlers ────────────────────────────────

ipcMain.handle("get-settings", () => {
  return loadSettings();
});

ipcMain.handle("save-settings", (event, settings) => {
  return saveSettings(settings);
});

ipcMain.handle("test-llm-connection", async (event, settings) => {
  try {
    const client = new LLMClient(settings);
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

  const settings = loadSettings();
  if (!settings.llm.apiKey) {
    return { error: "No API key configured. Go to Settings to add one." };
  }

  let llmClient;
  try {
    llmClient = new LLMClient(settings);
  } catch (err) {
    return { error: err.message };
  }

  const healer = new HealerAgent(llmClient, {
    maxIterations: settings.agent.maxIterations,
    headless: settings.agent.headless,
    browserChannel: getBrowserChannel(),
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

  const runResultsDir = path.join(RESULTS_DIR, runId);

  try {
    const result = await healer.heal({
      script: scenario.script || "",
      errors: run.results.errors,
      targetUrl: scenario.targetUrl,
      credentials: scenario.credentials,
      runResultsDir: fs.existsSync(runResultsDir) ? runResultsDir : null,
      artifacts: run.results?.artifacts || [],
      onProgress,
    });

    activeAgent = null;
    return {
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

ipcMain.handle("agent-preheal", async (event, { scenarioId }) => {
  if (activeAgent) {
    return { error: "An agent is already running. Cancel it first." };
  }

  const db = loadDB();
  const scenario = db.scenarios.find((s) => s.id === scenarioId);
  if (!scenario) return { error: "Scenario not found" };

  const settings = loadSettings();
  if (!settings.llm.apiKey) {
    return { error: "No API key configured. Go to Settings to add one." };
  }

  // Generate the script to test
  if (!scenario.script) {
    return { error: "No script defined in this scenario" };
  }
  const scriptContent = wrapScript(scenario.script, scenario.targetUrl, scenario.credentials);

  activeAgent = { type: "prehealer", agent: null };

  const onProgress = (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("agent-progress", {
        agentType: "prehealer",
        ...data,
      });
    }
  };

  try {
    // Phase 1: Run the test to check if it already works
    onProgress({ status: "running", message: "Running test to check for issues..." });

    const runId = uuidv4();
    const scriptPath = path.join(TEMP_DIR, `preheal-${runId}.spec.js`);
    fs.writeFileSync(scriptPath, scriptContent);

    const results = await runPlaywright(scriptPath, runId);

    try { fs.unlinkSync(scriptPath); } catch {}

    // If the test passed, no healing needed
    if (results.status === "passed") {
      activeAgent = null;
      onProgress({ status: "done", message: "Test passed — no healing needed" });
      return { status: "passed", message: "Script is working correctly, no healing needed." };
    }

    // Phase 2: Test failed — heal it
    if (!results.errors?.length) {
      activeAgent = null;
      return { error: "Test failed but no error details were captured" };
    }

    onProgress({ status: "healing", message: "Test failed — starting AI healer..." });

    let llmClient;
    try {
      llmClient = new LLMClient(settings);
    } catch (err) {
      activeAgent = null;
      return { error: err.message };
    }

    const healer = new HealerAgent(llmClient, {
      maxIterations: settings.agent.maxIterations,
      headless: settings.agent.headless,
      browserChannel: getBrowserChannel(),
    });

    activeAgent = { type: "prehealer", agent: healer };

    const result = await healer.heal({
      script: scenario.script || "",
      errors: results.errors,
      targetUrl: scenario.targetUrl,
      credentials: scenario.credentials,
      onProgress,
    });

    activeAgent = null;

    if (!result.healedScript) {
      return { error: "Healer could not produce a fixed script. Analysis: " + (result.analysis || "No analysis") };
    }

    return {
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

ipcMain.handle("agent-heal-apply", async (event, { scenarioId, healedScript }) => {
  const db = loadDB();
  const idx = db.scenarios.findIndex((s) => s.id === scenarioId);
  if (idx < 0) return { error: "Scenario not found" };

  db.scenarios[idx].script = healedScript;
  db.scenarios[idx].updatedAt = new Date().toISOString();
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
  // Clean up any running agents
  if (activeAgent) {
    if (activeAgent.agent) activeAgent.agent.cancel();
    activeAgent = null;
  }
  if (apiServer) apiServer.close();
  app.quit();
});
