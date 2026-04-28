/**
 * Express application builder for the standalone (cloud) Zoniq server.
 *
 * Reuses the same lib/ modules as the Electron main process:
 *   - lib/paths        — data directory resolution (DATA_DIR env var)
 *   - lib/db           — JSON file storage
 *   - lib/script-transforms — wrapScript and friends
 *   - lib/playwright-runner — runPlaywright
 *
 * Authentication and other web-app concerns are added in later milestones;
 * this initial version mirrors the Electron API surface.
 */

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");

const ScriptUtils = require("../../lib/script-utils");
const { getPaths } = require("../../lib/paths");
const DB = require("../../lib/db");
const { wrapScript } = require("../../lib/script-transforms");
const Runner = require("../../lib/playwright-runner");

function buildApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "10mb" }));

  // Optional API key authentication (set ZONIQ_API_KEY env var to enable)
  const API_KEY = process.env.ZONIQ_API_KEY || null;
  if (API_KEY) {
    app.use((req, res, next) => {
      if (req.path === "/api/health") return next();
      const key = req.headers["x-api-key"] || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (key !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
      next();
    });
  } else {
    console.warn(
      "[security] ZONIQ_API_KEY is not set — the API is unauthenticated. " +
      "This is OK for local testing but UNSAFE for a public Railway deployment. " +
      "Set ZONIQ_API_KEY before exposing this server."
    );
  }

  app.get("/api/health", (req, res) => {
    res.json({
      status: "ok",
      server: "zoniq-test-runner",
      mode: "standalone",
      platform: process.platform,
    });
  });

  // ── Scenarios CRUD ────────────────────────────────────────
  app.get("/api/scenarios", (req, res) => {
    const db = DB.loadDB();
    res.json(db.scenarios || []);
  });

  app.get("/api/scenarios/:id", (req, res) => {
    const db = DB.loadDB();
    const sc = (db.scenarios || []).find((s) => s.id === req.params.id);
    if (!sc) return res.status(404).json({ error: "Not found" });
    res.json(sc);
  });

  app.post("/api/scenarios", (req, res) => {
    const sc = req.body || {};
    if (!sc.name || !sc.targetUrl || !sc.script) {
      return res.status(400).json({ error: "name, targetUrl, and script are required" });
    }
    const db = DB.loadDB();
    if (!db.scenarios) db.scenarios = [];
    const now = new Date().toISOString();
    if (sc.id) {
      const idx = db.scenarios.findIndex((s) => s.id === sc.id);
      if (idx >= 0) {
        const merged = { ...db.scenarios[idx], ...sc, updatedAt: now };
        delete merged.steps; // never persist ephemeral steps
        db.scenarios[idx] = merged;
      } else {
        db.scenarios.push({ ...sc, createdAt: now, updatedAt: now });
      }
    } else {
      const newSc = { ...sc, id: uuidv4(), createdAt: now, updatedAt: now };
      delete newSc.steps;
      db.scenarios.push(newSc);
    }
    DB.addSavedUrl(db, sc.targetUrl);
    DB.saveDB(db);
    res.json(db.scenarios.find((s) => s.id === sc.id) || db.scenarios[db.scenarios.length - 1]);
  });

  app.delete("/api/scenarios/:id", (req, res) => {
    const db = DB.loadDB();
    db.scenarios = (db.scenarios || []).filter((s) => s.id !== req.params.id);
    DB.saveDB(db);
    res.json({ ok: true });
  });

  // ── Plans CRUD ────────────────────────────────────────────
  app.get("/api/plans", (req, res) => {
    const db = DB.loadDB();
    res.json(db.plans || []);
  });

  app.post("/api/plans", (req, res) => {
    const plan = req.body || {};
    if (!plan.name || !Array.isArray(plan.scenarioIds)) {
      return res.status(400).json({ error: "name and scenarioIds[] are required" });
    }
    const db = DB.loadDB();
    if (!db.plans) db.plans = [];
    const now = new Date().toISOString();
    if (plan.id) {
      const idx = db.plans.findIndex((p) => p.id === plan.id);
      if (idx >= 0) {
        db.plans[idx] = { ...db.plans[idx], ...plan, updatedAt: now };
      } else {
        db.plans.push({ ...plan, createdAt: now, updatedAt: now });
      }
    } else {
      db.plans.push({ ...plan, id: uuidv4(), createdAt: now, updatedAt: now });
    }
    DB.saveDB(db);
    res.json(db.plans.find((p) => p.id === plan.id) || db.plans[db.plans.length - 1]);
  });

  app.delete("/api/plans/:id", (req, res) => {
    const db = DB.loadDB();
    db.plans = (db.plans || []).filter((p) => p.id !== req.params.id);
    DB.saveDB(db);
    res.json({ ok: true });
  });

  // ── Execution ─────────────────────────────────────────────
  app.post("/api/execute", async (req, res) => {
    const { testRunId, testName, targetUrl, script, credentials, callbackUrl } = req.body;
    if (!targetUrl || !script) return res.status(400).json({ error: "targetUrl and script required" });

    let runId;
    try {
      runId = testRunId ? Runner.validateRunId(testRunId) : uuidv4();
    } catch {
      return res.status(400).json({ error: "Invalid testRunId — must be a UUID" });
    }
    const { TEMP_DIR } = getPaths();
    const scriptPath = path.join(TEMP_DIR, `run-${runId}.spec.js`);
    fs.writeFileSync(scriptPath, wrapScript(script, targetUrl, credentials));

    res.json({ runId, status: "running" });

    const settings = require("../../settings").loadSettings();
    const viewport = {
      width: settings.testExecution.viewportWidth || 1920,
      height: settings.testExecution.viewportHeight || 1080,
    };
    // Cloud runs are always headless — no display server.
    const results = await Runner.runPlaywright(scriptPath, runId, null, false, viewport, settings);
    if (results.reportStepList) {
      results.stepList = results.reportStepList;
      results.stepResults = results.reportStepResults;
      delete results.reportStepList;
      delete results.reportStepResults;
    }

    const db = DB.loadDB();
    db.runs.push({
      runId,
      testName: testName || "API Test",
      targetUrl,
      status: results.status,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      results,
    });
    DB.saveDB(db);

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
  });

  app.post("/api/execute-scenario/:id", async (req, res) => {
    const db = DB.loadDB();
    const sc = (db.scenarios || []).find((s) => s.id === req.params.id);
    if (!sc) return res.status(404).json({ error: "Scenario not found" });

    const runId = uuidv4();
    const { TEMP_DIR } = getPaths();
    const scriptPath = path.join(TEMP_DIR, `run-${runId}.spec.js`);
    fs.writeFileSync(scriptPath, wrapScript(sc.script, sc.targetUrl, sc.credentials));

    res.json({ runId, status: "running" });

    const settings = require("../../settings").loadSettings();
    const viewport = {
      width: settings.testExecution.viewportWidth || 1920,
      height: settings.testExecution.viewportHeight || 1080,
    };
    const results = await Runner.runPlaywright(scriptPath, runId, null, false, viewport, settings);
    if (results.reportStepList) {
      results.stepList = results.reportStepList;
      results.stepResults = results.reportStepResults;
      delete results.reportStepList;
      delete results.reportStepResults;
    }

    const db2 = DB.loadDB();
    db2.runs.push({
      runId,
      scenarioId: sc.id,
      testName: sc.name,
      targetUrl: sc.targetUrl,
      status: results.status,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      results,
    });
    DB.saveDB(db2);

    try { fs.unlinkSync(scriptPath); } catch {}
  });

  // ── Runs ──────────────────────────────────────────────────
  app.get("/api/runs", (req, res) => {
    const db = DB.loadDB();
    res.json((db.runs || []).slice(-50).reverse());
  });

  app.get("/api/runs/:runId", (req, res) => {
    const db = DB.loadDB();
    const run = (db.runs || []).find((r) => r.runId === req.params.runId);
    if (!run) return res.status(404).json({ error: "Not found" });
    res.json(run);
  });

  app.get("/api/runs/:runId/artifacts/:filename", (req, res) => {
    if (!Runner.UUID_REGEX.test(req.params.runId)) {
      return res.status(400).json({ error: "Invalid runId" });
    }
    if (/[/\\]/.test(req.params.filename)) {
      return res.status(400).json({ error: "Invalid filename" });
    }
    const { RESULTS_DIR } = getPaths();
    const filePath = path.join(RESULTS_DIR, req.params.runId, req.params.filename);
    if (!filePath.startsWith(path.resolve(RESULTS_DIR) + path.sep)) {
      return res.status(400).json({ error: "Invalid path" });
    }
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Not found" });
    res.sendFile(filePath);
  });

  return app;
}

module.exports = { buildApp };
