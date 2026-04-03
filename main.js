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
const ScriptUtils = require("./lib/script-utils");

// ── Lazy-loaded modules (deferred to speed up window creation) ──
let _express, _cors, _settings, _LLMClient, _HealerAgent, _ElementDB;
function getExpress() { return _express || (_express = require("express")); }
function getCors() { return _cors || (_cors = require("cors")); }
function getSettings() { return _settings || (_settings = require("./settings")); }
function getLLMClient() { return _LLMClient || (_LLMClient = require("./agents/llm-client").LLMClient); }
function getHealerAgent() { return _HealerAgent || (_HealerAgent = require("./agents/healer-agent").HealerAgent); }
function getElementDB() { return _ElementDB || (_ElementDB = require("./lib/element-db")); }

// ── Paths ────────────────────────────────────────────────
const USER_DATA = app.getPath("userData");
const SCRIPTS_DIR = path.join(USER_DATA, "scripts");
const RESULTS_DIR = path.join(USER_DATA, "results");
// TEMP_DIR must be writable — in a packaged exe __dirname is inside the read-only asar,
// so we use USER_DATA instead.
const TEMP_DIR = path.join(USER_DATA, "temp");
const DB_PATH = path.join(USER_DATA, "scenarios.json");
const APPS_PATH = path.join(USER_DATA, "apps.json");
const APPS_DIR = path.join(USER_DATA, "apps");

// In the packaged exe, files in asarUnpack land at:
//   resources/app.asar.unpacked/<path>
// This is the real filesystem — spawned child processes can require() from there
// and Node's module resolution works naturally (siblings/parents are checked).
// helpers/ and playwright packages are both in asarUnpack, so recorder.js at
// app.asar.unpacked/helpers/ can require('playwright-core') from
// app.asar.unpacked/node_modules/ without any NODE_PATH tricks.
const UNPACKED_BASE = app.isPackaged
  ? path.join(process.resourcesPath, "app.asar.unpacked")
  : __dirname;
const HELPERS_DIR = path.join(UNPACKED_BASE, "helpers");

// ── Playwright paths ────────────────────────────────────
const UNPACKED_NODE_MODULES = path.join(UNPACKED_BASE, "node_modules");
// Use the unscoped `playwright` package CLI — electron-builder's asarUnpack has a
// known bug with @-scoped package paths on Windows, so @playwright/test/cli.js may
// not exist in app.asar.unpacked. The `playwright` package ships the identical CLI
// and unpacks reliably because its path contains no @ character.
const PLAYWRIGHT_CLI_JS = path.join(UNPACKED_NODE_MODULES, "playwright", "cli.js");

// playwright.config.js is written to USER_DATA at startup so it has the correct
// absolute testDir and can be read from the real filesystem by the spawned process.
const PLAYWRIGHT_CONFIG_PATH = path.join(USER_DATA, "playwright.config.js");

// browsers/ is still in extraResources (separate from the asar entirely)
const LOCAL_BROWSERS_DIR = app.isPackaged
  ? path.join(process.resourcesPath, "browsers")
  : path.join(__dirname, "browsers");

// playwright-core is in extraResources so it always exists at a known real-filesystem
// path regardless of asarUnpack behavior or npm nesting inside node_modules.
const PLAYWRIGHT_CORE_PATH = app.isPackaged
  ? path.join(process.resourcesPath, "playwright-core")
  : path.join(__dirname, "node_modules", "playwright-core");

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
    const pw = require(PLAYWRIGHT_CORE_PATH);
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
  // Allow scripts on the real filesystem (helpers/, agents/, USER_DATA/temp/) to
  // resolve playwright and other modules from the unpacked node_modules directory.
  if (!env.NODE_PATH) {
    env.NODE_PATH = UNPACKED_NODE_MODULES;
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
    const pw = require(PLAYWRIGHT_CORE_PATH);
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

[SCRIPTS_DIR, RESULTS_DIR, TEMP_DIR, APPS_DIR].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ── Debug logging to file ────────────────────────────────
const LOG_PATH = path.join(USER_DATA, "zoniq-debug.log");
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
zlog("LOCAL_BROWSERS_DIR:", LOCAL_BROWSERS_DIR, "| exists:", fs.existsSync(LOCAL_BROWSERS_DIR));
zlog("PLAYWRIGHT_CLI_JS:", PLAYWRIGHT_CLI_JS, "| exists:", fs.existsSync(PLAYWRIGHT_CLI_JS));
zlog("TEMP_DIR:", TEMP_DIR);

// ── Simple JSON DB for scenarios & runs ──────────────────
let _dbCache = null;

function loadDB() {
  if (_dbCache) return _dbCache;
  try {
    if (fs.existsSync(DB_PATH)) {
      _dbCache = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
      return _dbCache;
    }
  } catch {}
  _dbCache = { scenarios: [], runs: [], savedUrls: [], analyses: [], plans: [] };
  return _dbCache;
}

function saveDB(db) {
  _dbCache = db;
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

// ── Apps & Element DB ────────────────────────────────────
let _appsCache = null;

function loadApps() {
  if (_appsCache) return _appsCache;
  try {
    if (fs.existsSync(APPS_PATH)) {
      _appsCache = JSON.parse(fs.readFileSync(APPS_PATH, "utf-8"));
      return _appsCache;
    }
  } catch {}
  _appsCache = [];
  return _appsCache;
}

function saveApps(apps) {
  _appsCache = apps;
  fs.writeFileSync(APPS_PATH, JSON.stringify(apps, null, 2));
}

function loadElementDBForApp(appId) {
  const dbPath = path.join(APPS_DIR, appId, "elements.json");
  try {
    if (fs.existsSync(dbPath)) {
      return JSON.parse(fs.readFileSync(dbPath, "utf-8"));
    }
  } catch {}
  return { elements: {} };
}

function saveElementDBForApp(appId, elementDB) {
  const appDir = path.join(APPS_DIR, appId);
  if (!fs.existsSync(appDir)) fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, "elements.json"), JSON.stringify(elementDB, null, 2));
}

/**
 * Find an existing app by base URL, or create one automatically.
 * Returns the app object.
 */
function findOrCreateApp(targetUrl) {
  if (!targetUrl) return null;
  const baseUrl = getElementDB().normalizeAppUrl(targetUrl);
  if (!baseUrl) return null;

  const apps = loadApps();
  const existing = apps.find(a => a.baseUrl === baseUrl);
  if (existing) return existing;

  const newApp = {
    id: uuidv4(),
    name: getElementDB().deriveAppName(baseUrl),
    baseUrl,
    credentials: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  apps.push(newApp);
  saveApps(apps);
  return newApp;
}

/**
 * Migrate existing scenarios without appId — assign them to apps based on targetUrl.
 */
function migrateScenarioApps() {
  const db = loadDB();
  let changed = false;
  for (const sc of db.scenarios) {
    if (!sc.appId && sc.targetUrl) {
      const app = findOrCreateApp(sc.targetUrl);
      if (app) {
        sc.appId = app.id;
        changed = true;
      }
    }
  }
  if (changed) saveDB(db);
  return db;
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
    .replace(/^const\s+\{[^}]*\}\s*=\s*require\s*\([^)]*\);.*$/gm, '')
    .replace(/^const\s+\w+\s*=\s*require\s*\([^)]*\);.*$/gm, '')
    // Strip existing TARGET_URL and CREDENTIALS declarations to avoid duplicates
    .replace(/^const\s+TARGET_URL\s*=\s*.*;\s*$/gm, '')
    .replace(/^const\s+CREDENTIALS\s*=\s*\{[\s\S]*?\}\s*;\s*$/gm, '')
    .trim();

  // Strip test.use() blocks (viewport config etc.)
  scriptBody = scriptBody
    .replace(/test\.use\s*\(\s*\{[\s\S]*?\}\s*\)\s*;/g, '')
    .trim();

  // Unwrap IIFE pattern from Playwright codegen: (async () => { ... })();
  const iifeMatch = scriptBody.match(/^\(\s*async\s*\(\s*\)\s*=>\s*\{([\s\S]*)\}\s*\)\s*\(\s*\)\s*;?\s*$/);
  if (iifeMatch) {
    scriptBody = iifeMatch[1].trim();
  }

  // Strip codegen boilerplate (browser/context/page lifecycle)
  scriptBody = scriptBody
    .replace(/const\s+browser\s*=\s*await\s+chromium\.launch\s*\(\s*\{[\s\S]*?\}\s*\)\s*;/g, '')
    .replace(/const\s+context\s*=\s*await\s+browser\.newContext\s*\(\s*\{[\s\S]*?\}\s*\)\s*;/g, '')
    .replace(/const\s+context\s*=\s*await\s+browser\.newContext\s*\(\s*\)\s*;/g, '')
    .replace(/const\s+page\s*=\s*await\s+context\.newPage\s*\(\s*\)\s*;/g, '')
    .replace(/await\s+page\.close\s*\(\s*\)\s*;/g, '')
    .replace(/await\s+context\.close\s*\(\s*\)\s*;/g, '')
    .replace(/await\s+browser\.close\s*\(\s*\)\s*;/g, '')
    .replace(/\/\/\s*-{3,}\s*$/gm, '')
    .trim();

  // Clean fragile Mendix selectors
  scriptBody = cleanMendixSelectors(scriptBody);

  // Transform .selectOption() calls to use mx.smartSelect() which handles
  // Mendix reference selectors (disabled <select> while loading) and
  // custom combobox widgets (non-native dropdowns).
  scriptBody = transformSelectOptionCalls(scriptBody);

  // Collapse fragile date picker sequences (Show date picker → year nav → gridcell)
  // into robust mx.pickDate() helper calls.
  scriptBody = transformDatePickerClicks(scriptBody);

  // Add .first() to bare locator calls that don't already have disambiguation,
  // preventing strict mode violations when multiple elements match (common in
  // Mendix apps with nested forms/dialogs containing duplicate button labels).
  scriptBody = disambiguateSelectors(scriptBody);

  // Transform clicks on ListView rows (li[role="button"]) into robust
  // mx.clickListViewRow() calls that wait for visibility and handle popup opening.
  scriptBody = transformListViewRowClicks(scriptBody);

  // Transform DataGrid gridcell clicks with dynamic IDs (e.g. 'DB00000772')
  // into mx.clickDataGridFirstRow() calls that click the first row.
  scriptBody = transformDataGridRowClicks(scriptBody);

  // Check if there's still a test() block after stripping
  const hasTestBlock = /\btest\s*\(/.test(scriptBody);

  if (!hasTestBlock) {
    // Only inject goto(TARGET_URL) + waitForMendix if the script doesn't already
    // have its own page.goto (e.g. from a Codegen recording that was unwrapped above)
    const hasOwnGoto = /await\s+page\.goto\s*\(/.test(scriptBody);
    const preamble = hasOwnGoto
      ? ''
      : '  await page.goto(TARGET_URL);\n  await mx.waitForMendix(page);\n\n  ';
    scriptBody = `
test('Recorded Test', async ({ page }) => {
${preamble}${hasOwnGoto ? '  ' : ''}${scriptBody}
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

  // Build wrapped version of each statement.
  // Marker indices must match the step indices from parseScriptToSteps().
  // We apply the same filtering (skip boilerplate, skip redundant navigates)
  // and assign index -1 to filtered statements so they don't affect step tracking.
  const visitedOrigins = new Set();
  let realIdx = 0;

  const wrapped = statements.map((stmt, stmtIdx) => {
    const desc = ScriptUtils.describeStatement(stmt.text);

    // Check if this statement would be filtered by parseScriptToSteps
    let isFiltered = false;

    // Skip codegen boilerplate (browser/context/page lifecycle)
    if (/const\s+browser\s*=\s*await\s+\S+\.launch\s*\(/.test(stmt.text)) isFiltered = true;
    if (/const\s+context\s*=\s*await\s+browser\.newContext\s*\(/.test(stmt.text)) isFiltered = true;
    if (/const\s+page\s*=\s*await\s+context\.newPage\s*\(/.test(stmt.text)) isFiltered = true;
    if (/await\s+page\.close\s*\(\s*\)/.test(stmt.text)) isFiltered = true;
    if (/await\s+context\.close\s*\(\s*\)/.test(stmt.text)) isFiltered = true;
    if (/await\s+browser\.close\s*\(\s*\)/.test(stmt.text)) isFiltered = true;

    // Skip injected helpers that don't appear in the original script's step list
    if (/await\s+page\.goto\s*\(\s*TARGET_URL\s*\)/.test(stmt.text)) isFiltered = true;
    if (/await\s+mx\.waitForMendix\s*\(/.test(stmt.text)) isFiltered = true;

    // Skip redundant navigates (same logic as parseScriptToSteps)
    if (!isFiltered) {
      const navMatch = stmt.text.match(/await\s+page\.goto\s*\(\s*['"]([^'"]+)['"]\s*\)/);
      if (navMatch) {
        try {
          const url = new URL(navMatch[1]);
          const isRootish = url.pathname === '/' || url.pathname === '';
          if (isRootish && visitedOrigins.has(url.origin)) isFiltered = true;
          // Click → goto(root) pattern: Mendix client-side navigation causes
          // codegen to emit spurious root-URL gotos after button clicks
          if (isRootish && !isFiltered && stmtIdx > 0) {
            const prevStmt = statements[stmtIdx - 1];
            if (/\.(click|dblclick|press|check|uncheck|selectOption)\s*\(/.test(prevStmt.text) ||
                /mx\.(clickWidget|selectDropdown|smartSelect)\s*\(/.test(prevStmt.text)) {
              isFiltered = true;
            }
          }
          visitedOrigins.add(url.origin);
        } catch { /* not a valid URL, keep it */ }
      }
    }

    // Actually remove filtered statements from the executed script
    if (isFiltered) return null;

    const idx = realIdx++;
    // Detect screenshot marker and strip it from the executed statement
    const wantsScreenshot = /\/\/\s*@zoniq:screenshot/.test(stmt.text);
    const cleanStmt = wantsScreenshot ? stmt.text.replace(/\s*\/\/\s*@zoniq:screenshot\s*$/, '') : stmt.text;
    // Screenshot: wait for page to settle, then capture BEFORE marking step done.
    // This prevents race conditions where the browser tears down (last step) or
    // the next step fires before the screenshot is written to disk.
    const screenshotBlock = wantsScreenshot && idx >= 0
      ? `\n    await page.waitForLoadState('load');\n` +
        `    await page.screenshot({ path: require('path').join(process.env.ZONIQ_RUN_RESULTS_DIR || 'results', 'step-${idx}-proof.png'), fullPage: true });`
      : '';
    const isRaw = /^(?:const|let|var)\s/.test(cleanStmt);
    if (isRaw) {
      return `  console.log('[ZONIQ_STEP:START:${idx}:${desc}]');\n` +
        `  ${cleanStmt}${screenshotBlock}\n` +
        `  console.log('[ZONIQ_STEP:DONE:${idx}]');`;
    }
    const errVar = `_stepErr_${stmtIdx}`;
    return `  console.log('[ZONIQ_STEP:START:${idx}:${desc}]');\n` +
      `  try {\n    ${cleanStmt}${screenshotBlock}\n` +
      `    console.log('[ZONIQ_STEP:DONE:${idx}]');\n` +
      `  } catch (${errVar}) {\n` +
      `    console.log('[ZONIQ_STEP:FAIL:${idx}:' + ${errVar}.message.replace(/\\n/g, ' ') + ']');\n` +
      `    throw ${errVar};\n` +
      `  }`;
  });

  // Replace the test body with the wrapped version
  // Find the test body boundaries in scriptBody and splice in the wrapped code
  const testBodyMatch = scriptBody.match(
    /(\btest\s*\(\s*['"][^'"]*['"]\s*,\s*async\s*\(\s*\{\s*page\s*\}\s*\)\s*=>\s*\{)([\s\S]*)(\}\s*\)\s*;?\s*$)/
  );
  if (testBodyMatch) {
    return testBodyMatch[1] + '\n' + wrapped.filter(Boolean).join('\n\n') + '\n' + testBodyMatch[3];
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

/**
 * Transform bare .selectOption() calls into mx.smartSelect() calls.
 * Mendix reference selectors render a <select> that starts disabled while
 * loading options from the server, causing Playwright's selectOption to timeout.
 * mx.smartSelect waits for the element to become enabled and also handles
 * custom combobox widgets.
 *
 * Transforms patterns like:
 *   await page.getByLabel('X').selectOption('Y');
 *   await page.locator('sel').selectOption('Y');
 *   await page.getByRole('combobox', { name: 'X' }).selectOption('Y');
 * Into:
 *   await mx.smartSelect(page, page.getByLabel('X'), 'Y');
 */
function transformSelectOptionCalls(script) {
  // Match: await <locator-expr>.selectOption(<value>);
  // Capture: the locator expression (page.getBy*/page.locator) and the selectOption argument
  return script.replace(
    /await\s+(page\.(?:getByLabel|getByRole|getByText|getByPlaceholder|locator)\s*\([^)]*\)(?:\s*\.(?:first|last|nth)\s*\([^)]*\))*)\s*\.selectOption\s*\(([^)]+)\)\s*;/g,
    (match, locatorExpr, valueExpr) => {
      return `await mx.smartSelect(page, ${locatorExpr}, ${valueExpr});`;
    }
  );
}

/**
 * Detect date picker interaction sequences recorded by Playwright Codegen and
 * collapse them into a single mx.pickDate() helper call.
 *
 * Recorded pattern (2–3 lines):
 *   await page.getByRole('button', { name: 'Show date picker' })...click();
 *   await page.getByText('2027').click();          // optional year nav
 *   await page.getByRole('gridcell', { name: '10/04/' })...click();
 *
 * Replacement:
 *   await mx.pickDate(page, <triggerLocator>, day, month, year);
 */
function transformDatePickerClicks(script) {
  const lines = script.split('\n');
  const result = [];

  // Trigger: "Show date picker" button click — capture the full locator expression
  const triggerRe = /^(\s*)await\s+(page\.getByRole\s*\(\s*['"]button['"]\s*,\s*\{[^}]*['"]Show date picker['"][^}]*\}\s*\)(?:\.\w+\s*\([^)]*\))*)\s*\.click\s*\([^)]*\)\s*;/;
  // Year navigation: getByText with a 4-digit year
  const yearNavRe = /^\s*await\s+page\.getByText\s*\(\s*['"](\d{4})['"]\s*(?:,\s*\{[^}]*\})?\s*\)[^;]*\.click\s*\([^)]*\)\s*;/;
  // Gridcell click: getByRole('gridcell', { name: 'DD/MM/...' })
  const gridcellRe = /^\s*await\s+page\.getByRole\s*\(\s*['"]gridcell['"]\s*,\s*\{\s*name:\s*['"](\d{1,2})\/(\d{1,2})\/(\d{0,4})['"]\s*\}\s*\)[^;]*\.click\s*\([^)]*\)\s*;/;

  let i = 0;
  while (i < lines.length) {
    const triggerMatch = lines[i].match(triggerRe);
    if (!triggerMatch) {
      result.push(lines[i]);
      i++;
      continue;
    }

    const indent = triggerMatch[1];
    const triggerExpr = triggerMatch[2];
    let year = null;
    let consumed = 1; // lines consumed so far (trigger line)

    // Look ahead for optional year navigation
    if (i + consumed < lines.length) {
      const yearMatch = lines[i + consumed].match(yearNavRe);
      if (yearMatch) {
        year = yearMatch[1];
        consumed++;
      }
    }

    // Look ahead for gridcell click
    if (i + consumed < lines.length) {
      const gridcellMatch = lines[i + consumed].match(gridcellRe);
      if (gridcellMatch) {
        const day = parseInt(gridcellMatch[1], 10);
        const month = parseInt(gridcellMatch[2], 10);
        // Year from gridcell name (if full date) or from year nav click
        const gridcellYear = gridcellMatch[3] ? parseInt(gridcellMatch[3], 10) : null;
        const finalYear = year || gridcellYear;
        consumed++;

        // Build replacement
        const yearArg = finalYear ? `, ${finalYear}` : '';
        result.push(`${indent}await mx.pickDate(page, ${triggerExpr}, ${day}, ${month}${yearArg});`);
        i += consumed;
        continue;
      }
    }

    // No gridcell found after trigger — leave original lines untouched
    result.push(lines[i]);
    i++;
  }

  return result.join('\n');
}

/**
 * Add .first() to bare Playwright locator calls (page.getByRole, page.getByText,
 * page.getByLabel, page.getByPlaceholder, page.locator) that are followed directly
 * by an action method (.click, .fill, etc.) without any existing disambiguation
 * (.first, .last, .nth, .filter) or scoped chaining (.getByRole, .getByText, etc.).
 *
 * Mendix apps frequently have nested forms/dialogs with duplicate button labels
 * (e.g. multiple "Save" buttons), causing Playwright strict mode violations.
 * This mirrors the .first() pattern already used in mendix-helpers.js.
 */
function disambiguateSelectors(script) {
  // Actions that trigger strict mode checks
  const actions = 'click|fill|press|dblclick|check|uncheck|hover|focus|clear|type|selectOption|setInputFiles|tap';
  // Locator methods that indicate the locator is already scoped/disambiguated
  const chainingIndicators = /\.(?:first|last|nth|filter|getByRole|getByText|getByLabel|getByPlaceholder|locator)\s*\(/;

  const re = new RegExp(
    `(await\\s+)(page\\.(?:getByRole|getByText|getByLabel|getByPlaceholder|locator)\\s*\\([^)]*\\))(\\s*\\.\\s*(?:${actions})\\s*\\()`,
    'g'
  );

  return script.replace(re, (match, prefix, locatorExpr, actionPart) => {
    // Skip if the locator already has chaining (disambiguation or scoping)
    if (chainingIndicators.test(locatorExpr.slice(locatorExpr.indexOf(')')))) {
      return match;
    }
    return `${prefix}${locatorExpr}.first()${actionPart}`;
  });
}

/**
 * Transform clicks on Mendix ListView rows into mx.clickListViewRow() calls.
 *
 * The recorder injects clicks like:
 *   await page.locator('li[role="button"]').filter({ hasText: 'Current' }).first().click();
 * or codegen (with our aria-label enhancement) may produce:
 *   await page.getByRole('button', { name: 'Current' }).first().click();
 *   (when the target is a <li role="button" aria-label="Current"> inside .mx-listview-clickable)
 *
 * We transform the explicit li[role="button"] pattern to use the robust helper
 * which waits for visibility and handles popup opening automatically.
 */
function transformListViewRowClicks(script) {
  // Pattern 1: injected by recorder post-processing
  //   await page.locator('li[role="button"]').filter({ hasText: '...' }).first().click();
  //   await page.locator('li[role="button"]').filter({ hasText: '...' }).click();
  let result = script.replace(
    /await\s+page\.locator\s*\(\s*['"]li\[role=["']?button["']?\]['"]\s*\)\s*\.filter\s*\(\s*\{\s*hasText:\s*['"]([^'"]+)['"]\s*\}\s*\)(?:\s*\.first\s*\(\s*\))?\s*\.click\s*\(\s*\)\s*;/g,
    (match, rowText) => {
      return `await mx.clickListViewRow(page, '${rowText.replace(/'/g, "\\'")}');`;
    }
  );

  // Pattern 2: codegen recorded a getByRole('button') click where the name
  // contains excessive whitespace — a telltale sign that it captured the full
  // concatenated text of a ListView row (e.g. 'Current             Delete').
  // Extract the first meaningful word(s) as the row text.
  result = result.replace(
    /await\s+page\.getByRole\s*\(\s*['"]button['"]\s*,\s*\{\s*name:\s*['"]([^'"]+)['"]\s*\}\s*\)(?:\s*\.first\s*\(\s*\))?\s*\.click\s*\(\s*\)\s*;/g,
    (match, name) => {
      // Only transform if the name has excessive whitespace (3+ consecutive
      // spaces), which indicates concatenated ListView row text content.
      if (!/\s{3,}/.test(name)) return match;
      // Extract the first non-empty token as the row's primary text
      const primaryText = name.split(/\s{2,}/)[0].trim();
      if (!primaryText) return match;
      return `await mx.clickListViewRow(page, '${primaryText.replace(/'/g, "\\'")}');`;
    }
  );

  return result;
}

/**
 * Transform DataGrid cell/row clicks into mx.clickDataGridFirstRow() calls.
 * Any getByRole('gridcell') click is unambiguously a datagrid interaction —
 * always transform regardless of cell content (France, Renewal, DB00000772, etc.).
 * getByText() clicks are only transformed when the value looks like a dynamic ID,
 * since getByText() could match non-grid elements.
 */
function transformDataGridRowClicks(script) {
  const ScriptUtils = require('./lib/script-utils');
  // Pattern 1: getByRole('gridcell', { name: '...' }).click()
  // Always transform — gridcell role is unambiguous proof of a datagrid click.
  let result = script.replace(
    /await\s+page\.getByRole\s*\(\s*['"]gridcell['"]\s*,\s*\{\s*name:\s*['"]([^'"]+)['"]\s*\}\s*\)(?:\s*\.first\s*\(\s*\))?\s*\.click\s*\(\s*\)\s*;/g,
    `await mx.clickDataGridFirstRow(page);`
  );
  // Pattern 2: getByRole('gridcell').first().click() (no name — clicks any cell)
  result = result.replace(
    /await\s+page\.getByRole\s*\(\s*['"]gridcell['"]\s*\)(?:\s*\.first\s*\(\s*\))?\s*\.click\s*\(\s*\)\s*;/g,
    `await mx.clickDataGridFirstRow(page);`
  );
  // Pattern 3: getByRole('row', { name: '...' }).click() — click on the row element itself
  result = result.replace(
    /await\s+page\.getByRole\s*\(\s*['"]row['"]\s*,\s*\{\s*name:\s*['"]([^'"]+)['"]\s*\}\s*\)(?:\s*\.first\s*\(\s*\))?\s*\.click\s*\(\s*\)\s*;/g,
    `await mx.clickDataGridFirstRow(page);`
  );
  // Pattern 4: getByText('DB00000777').first().click() or getByText('DB00000777').click()
  // Codegen sometimes records datagrid row clicks as getByText() with the cell value.
  // Only transform if value looks like a dynamic ID — getByText() is ambiguous.
  result = result.replace(
    /await\s+page\.getByText\s*\(\s*['"]([^'"]+)['"]\s*\)(?:\s*\.first\s*\(\s*\))?\s*\.click\s*\(\s*\)\s*;/g,
    (match, textValue) => {
      if (ScriptUtils.looksLikeDynamicId(textValue)) {
        return `await mx.clickDataGridFirstRow(page);`;
      }
      return match;
    }
  );
  return result;
}

// GUID resolution is handled at recording time — recorder.js collects
// GUID→label mappings from <option> elements (without mutating the DOM)
// and replaces GUIDs in the script after the user closes the browser.
// Runtime fallback: smartSelect() resolves any remaining GUIDs at playback.

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

// Write playwright.config.js to USER_DATA with absolute testDir so it works
// from any location and is writable (the asar is read-only in packaged builds).
function ensurePlaywrightConfig() {
  const config = `// Auto-generated at startup by Zoniq Test Runner — do not edit
module.exports = {
  testDir: ${JSON.stringify(TEMP_DIR)},
  timeout: 120000,
  fullyParallel: true,
  expect: { timeout: 15000 },
  use: {
    navigationTimeout: process.env.ZONIQ_STEP_TIMEOUT ? parseInt(process.env.ZONIQ_STEP_TIMEOUT) * 1000 : 45000,
    actionTimeout: process.env.ZONIQ_STEP_TIMEOUT ? parseInt(process.env.ZONIQ_STEP_TIMEOUT) * 1000 : 15000,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
    viewport: { width: 1920, height: 1080 },
    testIdAttribute: 'data-testid',
    ...(process.env.ZONIQ_BROWSER_CHANNEL ? { channel: process.env.ZONIQ_BROWSER_CHANNEL } : {}),
  },
  retries: process.env.ZONIQ_RETRIES ? parseInt(process.env.ZONIQ_RETRIES) : 0,
  reporter: [
    ['json', { outputFile: 'results/latest-report.json' }],
    ['html', { open: 'never', outputFolder: 'results/html-report' }],
  ],
};
`;
  try {
    if (fs.existsSync(PLAYWRIGHT_CONFIG_PATH) && fs.readFileSync(PLAYWRIGHT_CONFIG_PATH, "utf-8") === config) return;
  } catch {}
  fs.writeFileSync(PLAYWRIGHT_CONFIG_PATH, config);
}

async function runPlaywright(scriptPath, runId, onStepProgress, headed) {
  const runResultsDir = path.join(RESULTS_DIR, runId);
  fs.mkdirSync(runResultsDir, { recursive: true });

  const reportPath = path.join(runResultsDir, "report.json");
  const configPath = PLAYWRIGHT_CONFIG_PATH;

  // Debug: save a copy of the generated script for inspection (async — non-blocking)
  fs.copyFile(scriptPath, path.join(runResultsDir, "debug-script.js"), () => {});

  return new Promise((resolve) => {
    const channel = getBrowserChannel();
    const settings = getSettings().loadSettings();
    const env = getPlaywrightEnv({
      PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath,
      ...(channel ? { ZONIQ_BROWSER_CHANNEL: channel } : {}),
      ZONIQ_RETRIES: settings.testExecution.retryOnFailure ? "1" : "0",
      ZONIQ_STEP_TIMEOUT: String(settings.testExecution.stepTimeout || 30),
      ZONIQ_RUN_RESULTS_DIR: runResultsDir,
    });
    const runIdPrefix = path.basename(scriptPath, ".spec.js");
    // headed: explicit boolean from UI overrides env var; env var is the fallback default
    const useHeaded = headed !== undefined ? headed : process.env.ZONIQ_HEADED !== "false";
    const headedFlag = useHeaded ? "--headed" : "";

    const args = [
      "test", runIdPrefix,
      `--config=${configPath}`,
      "--reporter=json",
      `--output=${runResultsDir}`,
    ];
    if (headedFlag) args.push("--headed");

    console.log(`[${runId}] CMD: ${process.execPath} [ELECTRON_RUN_AS_NODE] ${PLAYWRIGHT_CLI_JS} ${args.join(" ")}`);

    let stdoutBuf = "";
    let stderrBuf = "";
    const guidResolutions = new Map(); // GUID → label resolved by smartSelect

    const proc = spawn(
      process.execPath,
      [PLAYWRIGHT_CLI_JS, ...args],
      { env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 300_000 }
    );

    proc.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdoutBuf += text;

      // Parse step progress markers and GUID resolution markers from stdout
      const lines = text.split("\n");
      for (const line of lines) {
        const cl = line.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');

        // Capture GUID → label resolutions emitted by smartSelect
        const guidMatch = cl.match(/^\[ZONIQ_GUID_RESOLVED:([^:]+):(.*)\]$/);
        if (guidMatch) {
          guidResolutions.set(guidMatch[1], guidMatch[2]);
          continue;
        }

        if (onStepProgress) {
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
      // Debug: save stdout/stderr (async — doesn't block result processing)
      fs.writeFile(path.join(runResultsDir, "debug-stdout.txt"), stdoutBuf, () => {});
      fs.writeFile(path.join(runResultsDir, "debug-stderr.txt"), stderrBuf, () => {});

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

      const resultObj = { status, summary, errors, artifacts, stderr: stderrBuf?.substring(0, 2000), guidResolutions };

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
    zlog(`[recorder] PLAYWRIGHT_BROWSERS_PATH: ${LOCAL_BROWSERS_DIR}`);
    zlog(`[recorder] browsers dir exists: ${fs.existsSync(LOCAL_BROWSERS_DIR)}`);

    // In Electron, process.execPath is the Electron binary. Setting
    // ELECTRON_RUN_AS_NODE=1 makes it behave as a plain Node.js runtime.
    const proc = spawn(process.execPath, recorderArgs, {
      env: getPlaywrightEnv({
        ELECTRON_RUN_AS_NODE: "1",
        ...(PLAYWRIGHT_CORE_PATH ? { PLAYWRIGHT_CORE_PATH } : {}),
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
