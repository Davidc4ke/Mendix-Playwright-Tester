/**
 * Path resolution for Zoniq Test Runner.
 *
 * Works in two modes:
 *   - Electron mode: data dir comes from `app.getPath("userData")`
 *   - Node mode (cloud server): data dir comes from `process.env.DATA_DIR`
 *
 * Call `initFromElectron(app)` from main.js before any other code requires
 * data paths. In Node mode, paths resolve lazily from DATA_DIR.
 */

const path = require("path");
const fs = require("fs");

let _dataDir = null;
let _unpackedBase = null;

function initFromElectron(electronApp) {
  _dataDir = electronApp.getPath("userData");
  _unpackedBase = electronApp.isPackaged
    ? path.join(process.resourcesPath, "app.asar.unpacked")
    : path.resolve(__dirname, "..");
}

function getDataDir() {
  if (_dataDir) return _dataDir;
  const fromEnv = process.env.DATA_DIR;
  if (!fromEnv) {
    throw new Error(
      "DATA_DIR not set. Either call initFromElectron(app) or set the DATA_DIR env var."
    );
  }
  if (!fs.existsSync(fromEnv)) fs.mkdirSync(fromEnv, { recursive: true });
  _dataDir = fromEnv;
  return _dataDir;
}

function getUnpackedBase() {
  if (_unpackedBase) return _unpackedBase;
  // In Node mode, the project root is the parent of lib/
  _unpackedBase = path.resolve(__dirname, "..");
  return _unpackedBase;
}

function getPaths() {
  const dataDir = getDataDir();
  const unpackedBase = getUnpackedBase();
  return {
    DATA_DIR: dataDir,
    SCRIPTS_DIR: path.join(dataDir, "scripts"),
    RESULTS_DIR: path.join(dataDir, "results"),
    TEMP_DIR: path.join(dataDir, "temp"),
    DB_PATH: path.join(dataDir, "scenarios.json"),
    APPS_PATH: path.join(dataDir, "apps.json"),
    APPS_DIR: path.join(dataDir, "apps"),
    LOG_PATH: path.join(dataDir, "zoniq-debug.log"),
    PLAYWRIGHT_CONFIG_PATH: path.join(dataDir, "playwright.config.js"),
    UNPACKED_BASE: unpackedBase,
    HELPERS_DIR: path.join(unpackedBase, "helpers"),
    UNPACKED_NODE_MODULES: path.join(unpackedBase, "node_modules"),
    PLAYWRIGHT_CLI_JS: path.join(unpackedBase, "node_modules", "playwright", "cli.js"),
    PLAYWRIGHT_CORE_PATH: path.join(unpackedBase, "node_modules", "playwright-core"),
  };
}

function ensureDirs() {
  const p = getPaths();
  for (const dir of [p.SCRIPTS_DIR, p.RESULTS_DIR, p.TEMP_DIR, p.APPS_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

module.exports = {
  initFromElectron,
  getPaths,
  getDataDir,
  ensureDirs,
};
