/**
 * Playwright execution engine.
 *
 * Spawns `playwright test` as a child process, parses progress markers from
 * stdout, and returns a structured run result.
 *
 * Works in both Electron mode (uses Electron binary as Node, ELECTRON_RUN_AS_NODE)
 * and standalone Node mode (uses regular `node`).
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { getPaths } = require("./paths");
const { extractSpecs, extractStepsFromReport } = require("./script-transforms");

// In Electron, `process.versions.electron` is set; in plain Node it isn't.
const IS_ELECTRON = !!process.versions.electron;

let _localBrowsersValid = null;

function isLocalBrowsersDirValid() {
  if (_localBrowsersValid !== null) return _localBrowsersValid;
  const { PLAYWRIGHT_CORE_PATH, UNPACKED_BASE } = getPaths();
  const localBrowsersDir = IS_ELECTRON && process.resourcesPath
    ? path.join(process.resourcesPath, "browsers")
    : path.join(UNPACKED_BASE, "browsers");
  if (!fs.existsSync(localBrowsersDir)) {
    _localBrowsersValid = false;
    return false;
  }
  try {
    const origEnv = process.env.PLAYWRIGHT_BROWSERS_PATH;
    process.env.PLAYWRIGHT_BROWSERS_PATH = localBrowsersDir;
    const pw = require(PLAYWRIGHT_CORE_PATH);
    const execPath = pw.chromium.executablePath();
    if (origEnv !== undefined) {
      process.env.PLAYWRIGHT_BROWSERS_PATH = origEnv;
    } else {
      delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    }
    _localBrowsersValid = !!(execPath && fs.existsSync(execPath));
  } catch {
    _localBrowsersValid = false;
  }
  return _localBrowsersValid;
}

function getLocalBrowsersDir() {
  const { UNPACKED_BASE } = getPaths();
  return IS_ELECTRON && process.resourcesPath
    ? path.join(process.resourcesPath, "browsers")
    : path.join(UNPACKED_BASE, "browsers");
}

function getPlaywrightEnv(extra = {}) {
  const { UNPACKED_NODE_MODULES } = getPaths();
  const env = { ...process.env, ...extra };
  if (isLocalBrowsersDirValid()) {
    env.PLAYWRIGHT_BROWSERS_PATH = getLocalBrowsersDir();
  }
  if (!env.NODE_PATH) {
    env.NODE_PATH = UNPACKED_NODE_MODULES;
  }
  return env;
}

function getFallbackChannel() {
  if (process.platform === "win32") return "msedge";
  if (process.platform === "darwin") return "chrome";
  return "chrome";
}

function detectBrowserChannel() {
  if (isLocalBrowsersDirValid()) return null;
  try {
    const { PLAYWRIGHT_CORE_PATH } = getPaths();
    const pw = require(PLAYWRIGHT_CORE_PATH);
    const execPath = pw.chromium.executablePath();
    if (execPath && fs.existsSync(execPath)) {
      return null;
    }
    return getFallbackChannel();
  } catch {
    return getFallbackChannel();
  }
}

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

function ensurePlaywrightConfig() {
  const { TEMP_DIR, PLAYWRIGHT_CONFIG_PATH } = getPaths();
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
    viewport: { width: parseInt(process.env.ZONIQ_VIEWPORT_WIDTH) || 1920, height: parseInt(process.env.ZONIQ_VIEWPORT_HEIGHT) || 1080 },
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

/**
 * @param scriptPath  Absolute path to the .spec.js file to run.
 * @param runId       UUID for this run (used to namespace artifacts).
 * @param onStepProgress  Optional callback({ runId, stepIndex, status, description?, error? })
 * @param headed      Boolean override for --headed flag. Defaults to env-based.
 * @param viewport    { width, height } — pre-resolved viewport (so this module doesn't need Electron's screen API).
 * @param settings    Loaded settings object (already resolved by caller).
 */
async function runPlaywright(scriptPath, runId, onStepProgress, headed, viewport, settings) {
  const { RESULTS_DIR, PLAYWRIGHT_CONFIG_PATH, PLAYWRIGHT_CLI_JS } = getPaths();
  const runResultsDir = path.join(RESULTS_DIR, runId);
  fs.mkdirSync(runResultsDir, { recursive: true });

  const reportPath = path.join(runResultsDir, "report.json");
  const configPath = PLAYWRIGHT_CONFIG_PATH;

  fs.copyFile(scriptPath, path.join(runResultsDir, "debug-script.js"), () => {});

  return new Promise((resolve) => {
    const channel = getBrowserChannel();
    const vp = viewport || { width: 1920, height: 1080 };
    const env = getPlaywrightEnv({
      PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath,
      ...(channel ? { ZONIQ_BROWSER_CHANNEL: channel } : {}),
      ZONIQ_RETRIES: settings?.testExecution?.retryOnFailure ? "1" : "0",
      ZONIQ_STEP_TIMEOUT: String(settings?.testExecution?.stepTimeout || 30),
      ZONIQ_VIEWPORT_WIDTH: String(vp.width),
      ZONIQ_VIEWPORT_HEIGHT: String(vp.height),
      ZONIQ_RUN_RESULTS_DIR: runResultsDir,
    });
    const runIdPrefix = path.basename(scriptPath, ".spec.js");
    const useHeaded = headed !== undefined ? headed : process.env.ZONIQ_HEADED !== "false";
    const headedFlag = useHeaded ? "--headed" : "";

    const args = [
      "test", runIdPrefix,
      `--config=${configPath}`,
      "--reporter=json",
      `--output=${runResultsDir}`,
    ];
    if (headedFlag) args.push("--headed");

    console.log(`[${runId}] CMD: ${process.execPath} ${IS_ELECTRON ? "[ELECTRON_RUN_AS_NODE]" : ""} ${PLAYWRIGHT_CLI_JS} ${args.join(" ")}`);

    let stdoutBuf = "";
    let stderrBuf = "";
    const guidResolutions = new Map();

    const spawnEnv = IS_ELECTRON ? { ...env, ELECTRON_RUN_AS_NODE: "1" } : env;
    const proc = spawn(
      process.execPath,
      [PLAYWRIGHT_CLI_JS, ...args],
      { env: spawnEnv, timeout: 300_000 }
    );

    proc.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdoutBuf += text;

      const lines = text.split("\n");
      for (const line of lines) {
        const cl = line.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');

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

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validateRunId(id) {
  if (!UUID_REGEX.test(id)) throw new Error(`Invalid runId format: ${id}`);
  return id;
}

module.exports = {
  runPlaywright,
  ensurePlaywrightConfig,
  getBrowserChannel,
  getPlaywrightEnv,
  isLocalBrowsersDirValid,
  validateRunId,
  UUID_REGEX,
  IS_ELECTRON,
};
