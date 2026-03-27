/**
 * sync-server.js — Zoniq Sync Server
 *
 * Standalone Express server for syncing test data across team members.
 * Deploy to Railway, Render, Fly.io, or run locally.
 *
 * Environment variables:
 *   PORT            — Server port (default: 3200)
 *   ZONIQ_SYNC_KEY  — Optional shared API key for authentication
 *   DATA_DIR        — Directory for data storage (default: ./data)
 */

const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3200;
const SYNC_KEY = process.env.ZONIQ_SYNC_KEY || "";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "sync-data.json");

app.use(cors());
app.use(express.json({ limit: "50mb" }));

// ── Data Storage ──────────────────────────────────────────

function loadData() {
  try {
    if (fs.existsSync(DB_PATH)) {
      return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
    }
  } catch (err) {
    console.error("[sync] Failed to load data:", err.message);
  }
  return {
    scenarios: [],
    plans: [],
    apps: [],
    elementDBs: {},
    runs: [],
    analyses: [],
    deleted: [],
  };
}

function saveData(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// ── Auth Middleware ────────────────────────────────────────

function authMiddleware(req, res, next) {
  if (!SYNC_KEY) return next();
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token !== SYNC_KEY) {
    return res.status(401).json({ error: "Invalid or missing API key" });
  }
  next();
}

app.use("/api/sync", authMiddleware);

// ── Endpoints ─────────────────────────────────────────────

// Health check
app.get("/api/sync/status", (req, res) => {
  res.json({
    ok: true,
    serverTime: new Date().toISOString(),
    version: "1.0.0",
  });
});

// Pull — return entities modified after `since` timestamp
app.post("/api/sync/pull", (req, res) => {
  const { since } = req.body;
  const sinceDate = since ? new Date(since) : new Date(0);
  const data = loadData();

  const filter = (items) =>
    items.filter((item) => {
      const ts = item.updatedAt || item.createdAt;
      return ts && new Date(ts) > sinceDate;
    });

  // Filter deleted entries too
  const deletedSince = data.deleted.filter(
    (d) => new Date(d.deletedAt) > sinceDate
  );

  // Filter elementDBs — include if any element was updated after since
  const elementDBs = {};
  for (const [appId, elDB] of Object.entries(data.elementDBs || {})) {
    if (elDB.updatedAt && new Date(elDB.updatedAt) > sinceDate) {
      elementDBs[appId] = elDB;
    }
  }

  res.json({
    serverTime: new Date().toISOString(),
    scenarios: filter(data.scenarios),
    plans: filter(data.plans),
    apps: filter(data.apps),
    elementDBs,
    runs: filter(data.runs),
    analyses: filter(data.analyses),
    deleted: deletedSince,
  });
});

// Push — receive changed entities, merge with last-write-wins
app.post("/api/sync/push", (req, res) => {
  const {
    scenarios = [],
    plans = [],
    apps = [],
    elementDBs = {},
    runs = [],
    analyses = [],
    deleted = [],
  } = req.body;

  const data = loadData();
  const conflicts = {
    scenarios: [],
    plans: [],
    apps: [],
    runs: [],
    analyses: [],
  };

  // Merge helper: last-write-wins by updatedAt
  function mergeCollection(collectionName, incoming) {
    if (!data[collectionName]) data[collectionName] = [];
    for (const item of incoming) {
      if (!item.id) continue;
      const idx = data[collectionName].findIndex((e) => e.id === item.id);
      if (idx >= 0) {
        const existing = data[collectionName][idx];
        const existingTime = new Date(
          existing.updatedAt || existing.createdAt || 0
        );
        const incomingTime = new Date(
          item.updatedAt || item.createdAt || 0
        );
        if (incomingTime >= existingTime) {
          data[collectionName][idx] = item;
        } else {
          // Server version is newer — return as conflict
          conflicts[collectionName].push(existing);
        }
      } else {
        // Check if this was previously deleted
        const wasDeleted = data.deleted.some(
          (d) => d.id === item.id && d.type === collectionName
        );
        if (!wasDeleted) {
          data[collectionName].push(item);
        }
      }
    }
  }

  mergeCollection("scenarios", scenarios);
  mergeCollection("plans", plans);
  mergeCollection("apps", apps);
  mergeCollection("runs", runs);
  mergeCollection("analyses", analyses);

  // Merge element DBs (last-write-wins by updatedAt)
  for (const [appId, elDB] of Object.entries(elementDBs)) {
    const existing = data.elementDBs[appId];
    if (!existing || !existing.updatedAt || new Date(elDB.updatedAt || 0) >= new Date(existing.updatedAt)) {
      data.elementDBs[appId] = elDB;
    }
  }

  // Process deletions
  for (const del of deleted) {
    if (!del.id || !del.type) continue;
    const collectionName = del.type;
    if (data[collectionName]) {
      data[collectionName] = data[collectionName].filter(
        (e) => e.id !== del.id
      );
    }
    // Track deletion if not already tracked
    if (!data.deleted.some((d) => d.id === del.id)) {
      data.deleted.push({
        id: del.id,
        type: del.type,
        deletedAt: del.deletedAt || new Date().toISOString(),
      });
    }
  }

  // Prune old deletions (older than 30 days)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  data.deleted = data.deleted.filter(
    (d) => new Date(d.deletedAt) > thirtyDaysAgo
  );

  saveData(data);

  res.json({
    ok: true,
    serverTime: new Date().toISOString(),
    conflicts,
  });
});

// ── Start ─────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[zoniq-sync] Server running on port ${PORT}`);
  if (SYNC_KEY) {
    console.log("[zoniq-sync] API key authentication enabled");
  } else {
    console.log(
      "[zoniq-sync] No ZONIQ_SYNC_KEY set — running without authentication"
    );
  }
});
