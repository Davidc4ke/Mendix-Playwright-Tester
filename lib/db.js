/**
 * JSON file storage for scenarios, runs, plans, apps, and element DBs.
 *
 * Reads paths from `lib/paths.js`, which works in both Electron and
 * standalone Node (Railway) modes.
 */

const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { getPaths } = require("./paths");

let _dbCache = null;
let _appsCache = null;

function loadDB() {
  if (_dbCache) return _dbCache;
  const { DB_PATH } = getPaths();
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
  const { DB_PATH } = getPaths();
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

function loadApps() {
  if (_appsCache) return _appsCache;
  const { APPS_PATH } = getPaths();
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
  const { APPS_PATH } = getPaths();
  _appsCache = apps;
  fs.writeFileSync(APPS_PATH, JSON.stringify(apps, null, 2));
}

function loadElementDBForApp(appId) {
  const { APPS_DIR } = getPaths();
  const dbPath = path.join(APPS_DIR, appId, "elements.json");
  try {
    if (fs.existsSync(dbPath)) {
      return JSON.parse(fs.readFileSync(dbPath, "utf-8"));
    }
  } catch {}
  return { elements: {} };
}

function saveElementDBForApp(appId, elementDB) {
  const { APPS_DIR } = getPaths();
  const appDir = path.join(APPS_DIR, appId);
  if (!fs.existsSync(appDir)) fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, "elements.json"), JSON.stringify(elementDB, null, 2));
}

/**
 * Find an existing app by base URL, or create one automatically.
 * Returns the app object. Requires `element-db` lazy-loaded to avoid circular deps.
 */
function findOrCreateApp(targetUrl, getElementDBHelper) {
  if (!targetUrl) return null;
  const elementDB = getElementDBHelper();
  const baseUrl = elementDB.normalizeAppUrl(targetUrl);
  if (!baseUrl) return null;

  const apps = loadApps();
  const existing = apps.find(a => a.baseUrl === baseUrl);
  if (existing) return existing;

  const newApp = {
    id: uuidv4(),
    name: elementDB.deriveAppName(baseUrl),
    baseUrl,
    credentials: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  apps.push(newApp);
  saveApps(apps);
  return newApp;
}

function migrateScenarioApps(getElementDBHelper) {
  const db = loadDB();
  let changed = false;
  for (const sc of db.scenarios) {
    if (!sc.appId && sc.targetUrl) {
      const app = findOrCreateApp(sc.targetUrl, getElementDBHelper);
      if (app) {
        sc.appId = app.id;
        changed = true;
      }
    }
  }
  if (changed) saveDB(db);
  return db;
}

function clearCaches() {
  _dbCache = null;
  _appsCache = null;
}

module.exports = {
  loadDB,
  saveDB,
  addSavedUrl,
  loadApps,
  saveApps,
  loadElementDBForApp,
  saveElementDBForApp,
  findOrCreateApp,
  migrateScenarioApps,
  clearCaches,
};
