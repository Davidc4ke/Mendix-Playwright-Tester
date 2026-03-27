/**
 * sync-client.js — Sync client for Zoniq Test Runner
 *
 * Handles pulling/pushing data to/from the sync server.
 * Uses Node built-in http/https modules (no extra deps needed in the Electron app).
 */

const http = require("http");
const https = require("https");
const { URL } = require("url");

/**
 * Make an HTTP(S) request and return parsed JSON response.
 */
function request(url, method, body, apiKey) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === "https:" ? https : http;
    const payload = body ? JSON.stringify(body) : null;

    const opts = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        "Content-Type": "application/json",
      },
      timeout: 30000,
    };

    if (apiKey) {
      opts.headers["Authorization"] = `Bearer ${apiKey}`;
    }

    if (payload) {
      opts.headers["Content-Length"] = Buffer.byteLength(payload);
    }

    const req = transport.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          if (res.statusCode === 401) {
            reject(new Error("Authentication failed — check your API key"));
            return;
          }
          if (res.statusCode >= 400) {
            reject(new Error(`Server returned ${res.statusCode}: ${data}`));
            return;
          }
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error(`Invalid server response: ${err.message}`));
        }
      });
    });

    req.on("error", (err) => reject(err));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });

    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Create a sync client instance.
 *
 * @param {string} serverUrl - Base URL of the sync server (e.g. "https://my-sync.up.railway.app")
 * @param {string} [apiKey] - Optional API key for authentication
 */
function createSyncClient(serverUrl, apiKey) {
  // Normalize URL: strip trailing slash
  const baseUrl = serverUrl.replace(/\/+$/, "");

  return {
    /**
     * Test connection to the sync server.
     * @returns {Promise<{ok: boolean, serverTime: string, version: string}>}
     */
    async testConnection() {
      return request(`${baseUrl}/api/sync/status`, "GET", null, apiKey);
    },

    /**
     * Pull changes from server since a given timestamp.
     * @param {string} [since] - ISO8601 timestamp. Omit or pass null to get everything.
     * @returns {Promise<{serverTime, scenarios, plans, apps, elementDBs, runs, analyses, deleted}>}
     */
    async pull(since) {
      return request(
        `${baseUrl}/api/sync/pull`,
        "POST",
        { since: since || null },
        apiKey
      );
    },

    /**
     * Push local changes to the server.
     * @param {Object} changes - { scenarios, plans, apps, elementDBs, runs, analyses, deleted }
     * @returns {Promise<{ok, serverTime, conflicts}>}
     */
    async push(changes) {
      return request(`${baseUrl}/api/sync/push`, "POST", changes, apiKey);
    },
  };
}

/**
 * Perform a full sync cycle: pull remote changes, merge locally, push local changes.
 *
 * @param {Object} opts
 * @param {Object} opts.client - Sync client from createSyncClient()
 * @param {string|null} opts.lastSyncedAt - ISO timestamp of last successful sync
 * @param {Function} opts.loadDB - Returns { scenarios, runs, analyses, plans, ... }
 * @param {Function} opts.saveDB - Saves the DB object
 * @param {Function} opts.loadApps - Returns apps array
 * @param {Function} opts.saveApps - Saves apps array
 * @param {Function} opts.loadElementDB - (appId) => element DB object
 * @param {Function} opts.saveElementDB - (appId, elDB) => void
 * @param {Array} opts.pendingDeletes - Array of { id, type, deletedAt } pending push
 * @param {Function} opts.onConflict - Called with conflicts object (for logging)
 * @returns {Promise<{lastSyncedAt: string, pendingDeletes: Array}>}
 */
async function fullSync(opts) {
  const {
    client,
    lastSyncedAt,
    loadDB,
    saveDB,
    loadApps,
    saveApps,
    loadElementDB,
    saveElementDB,
    pendingDeletes = [],
    onConflict,
  } = opts;

  // ── Step 1: Pull remote changes ──────────────────────
  const pulled = await client.pull(lastSyncedAt);

  // ── Step 2: Merge remote into local ──────────────────
  const db = loadDB();
  let apps = loadApps();

  // Merge helper: upsert by id, last-write-wins
  function mergeInto(localArray, remoteItems) {
    for (const item of remoteItems) {
      if (!item.id) continue;
      const idx = localArray.findIndex((e) => e.id === item.id);
      if (idx >= 0) {
        const localTime = new Date(
          localArray[idx].updatedAt || localArray[idx].createdAt || 0
        );
        const remoteTime = new Date(
          item.updatedAt || item.createdAt || 0
        );
        if (remoteTime >= localTime) {
          localArray[idx] = item;
        }
      } else {
        localArray.push(item);
      }
    }
  }

  mergeInto(db.scenarios, pulled.scenarios || []);
  mergeInto(db.plans || [], pulled.plans || []);
  if (!db.plans) db.plans = [];
  mergeInto(db.runs || [], pulled.runs || []);
  if (!db.runs) db.runs = [];
  mergeInto(db.analyses || [], pulled.analyses || []);
  if (!db.analyses) db.analyses = [];
  mergeInto(apps, pulled.apps || []);

  // Apply remote deletions locally
  for (const del of pulled.deleted || []) {
    if (!del.id || !del.type) continue;
    if (del.type === "scenarios")
      db.scenarios = db.scenarios.filter((e) => e.id !== del.id);
    if (del.type === "plans")
      db.plans = (db.plans || []).filter((e) => e.id !== del.id);
    if (del.type === "apps") apps = apps.filter((e) => e.id !== del.id);
    if (del.type === "runs")
      db.runs = (db.runs || []).filter((e) => e.id !== del.id);
    if (del.type === "analyses")
      db.analyses = (db.analyses || []).filter((e) => e.id !== del.id);
  }

  // Merge element DBs
  for (const [appId, remoteElDB] of Object.entries(
    pulled.elementDBs || {}
  )) {
    const localElDB = loadElementDB(appId);
    if (
      !localElDB.updatedAt ||
      new Date(remoteElDB.updatedAt || 0) >= new Date(localElDB.updatedAt)
    ) {
      saveElementDB(appId, remoteElDB);
    }
  }

  saveDB(db);
  saveApps(apps);

  // ── Step 3: Push local changes to server ─────────────
  // Find locally modified entities (updated after last sync)
  const sinceDate = lastSyncedAt ? new Date(lastSyncedAt) : new Date(0);
  const filterModified = (items) =>
    (items || []).filter((item) => {
      const ts = item.updatedAt || item.createdAt;
      return ts && new Date(ts) > sinceDate;
    });

  // Collect local element DBs that changed
  const localElementDBs = {};
  for (const a of apps) {
    const elDB = loadElementDB(a.id);
    if (elDB.updatedAt && new Date(elDB.updatedAt) > sinceDate) {
      localElementDBs[a.id] = elDB;
    }
  }

  const pushPayload = {
    scenarios: filterModified(db.scenarios),
    plans: filterModified(db.plans),
    apps: filterModified(apps),
    elementDBs: localElementDBs,
    runs: filterModified(db.runs),
    analyses: filterModified(db.analyses),
    deleted: pendingDeletes,
  };

  // Only push if there's something to send
  const hasChanges =
    pushPayload.scenarios.length > 0 ||
    pushPayload.plans.length > 0 ||
    pushPayload.apps.length > 0 ||
    Object.keys(pushPayload.elementDBs).length > 0 ||
    pushPayload.runs.length > 0 ||
    pushPayload.analyses.length > 0 ||
    pushPayload.deleted.length > 0;

  let conflicts = null;
  if (hasChanges) {
    const pushResult = await client.push(pushPayload);
    conflicts = pushResult.conflicts;

    // Apply any conflicts (server-wins) back to local
    if (conflicts) {
      const reloadedDB = loadDB();
      let reloadedApps = loadApps();
      let hasConflictUpdates = false;

      for (const [collection, items] of Object.entries(conflicts)) {
        if (!items || items.length === 0) continue;
        hasConflictUpdates = true;
        if (collection === "apps") {
          mergeInto(reloadedApps, items);
        } else if (reloadedDB[collection]) {
          mergeInto(reloadedDB[collection], items);
        }
      }

      if (hasConflictUpdates) {
        saveDB(reloadedDB);
        saveApps(reloadedApps);
        if (onConflict) onConflict(conflicts);
      }
    }
  }

  return {
    lastSyncedAt: pulled.serverTime,
    pendingDeletes: [], // cleared after successful push
  };
}

module.exports = { createSyncClient, fullSync };
