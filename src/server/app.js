/**
 * Express application builder for the standalone (cloud) Zoniq server.
 *
 * Milestone B additions over Milestone A:
 *   - helmet          — security headers (HSTS, CSP, etc.)
 *   - express-rate-limit — rate limiting (100 req/min general, 10/15 min on /auth/login)
 *   - JWT auth        — POST /api/auth/login returns a signed JWT; all other
 *                        endpoints require it (or the legacy ZONIQ_API_KEY)
 *   - Audit log       — every authenticated request is appended to DATA_DIR/audit.log
 *   - Credential encryption — scenario credentials are AES-256-GCM encrypted at
 *                        rest via lib/crypto.js; transparent on read/write
 *
 * Required env vars (Milestone B):
 *   JWT_SECRET         — signs/verifies tokens; required for JWT login to work
 *   ADMIN_USERNAME     — defaults to "admin"
 *   ADMIN_PASSWORD     — required to bootstrap the first user on startup
 *
 * Optional env vars:
 *   ZONIQ_API_KEY      — legacy static key (still accepted for backwards compat)
 *   ZONIQ_ENCRYPTION_KEY — base64-encoded 32-byte AES key for at-rest encryption
 *                          generate: openssl rand -base64 32
 */

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");

const ScriptUtils = require("../../lib/script-utils");
const { getPaths } = require("../../lib/paths");
const DB = require("../../lib/db");
const { wrapScript } = require("../../lib/script-transforms");
const Runner = require("../../lib/playwright-runner");
const { encryptCreds, decryptCreds } = require("../../lib/crypto");
const Users = require("../../lib/users");

// ── Auth helpers ─────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET || null;
const API_KEY = process.env.ZONIQ_API_KEY || null;
const JWT_EXPIRY = "8h";

function signToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function extractBearer(req) {
  return (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim() || null;
}

// Middleware: require valid API key or JWT (skip /api/health and /api/auth/login).
function requireAuth(req, res, next) {
  if (req.path === "/api/health" || req.path === "/api/auth/login") return next();

  const bearer = extractBearer(req);
  const xKey = (req.headers["x-api-key"] || "").trim();

  // 1) Legacy API key — exact match on either header
  if (API_KEY) {
    if (xKey === API_KEY || bearer === API_KEY) {
      req.user = { username: "api-key", role: "admin" };
      return next();
    }
  }

  // 2) JWT — try the bearer token (it's not the API key if we reach here)
  if (JWT_SECRET && bearer && bearer !== API_KEY) {
    const payload = verifyToken(bearer);
    if (payload) {
      req.user = payload;
      return next();
    }
  }

  return res.status(401).json({ error: "Unauthorized" });
}

// ── Audit log ─────────────────────────────────────────────────────────────────

let _auditStream = null;

function getAuditStream() {
  if (_auditStream) return _auditStream;
  try {
    const { DATA_DIR } = getPaths();
    _auditStream = fs.createWriteStream(path.join(DATA_DIR, "audit.log"), { flags: "a" });
  } catch {
    // DATA_DIR may not be set in test environments — silently skip
  }
  return _auditStream;
}

function auditMiddleware(req, res, next) {
  const start = Date.now();
  res.on("finish", () => {
    const stream = getAuditStream();
    if (!stream) return;
    const entry = {
      ts: new Date().toISOString(),
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - start,
      ip: req.ip,
      user: req.user?.username || null,
    };
    stream.write(JSON.stringify(entry) + "\n");
  });
  next();
}

// ── App factory ───────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();

  // Security headers
  app.use(helmet());

  app.use(cors());
  app.use(express.json({ limit: "10mb" }));

  // General rate limit: 100 requests per minute per IP
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      max: 100,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "Too many requests, please slow down." },
    })
  );

  // Stricter limit on login: 10 attempts per 15 minutes per IP
  app.use(
    "/api/auth/login",
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 10,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "Too many login attempts. Try again in 15 minutes." },
    })
  );

  // Warn if running without any auth configured
  if (!API_KEY && !JWT_SECRET) {
    console.warn(
      "[security] Neither ZONIQ_API_KEY nor JWT_SECRET is set — " +
      "the API is unauthenticated. Set at least one before exposing this server."
    );
  }

  // Auth guard
  app.use(requireAuth);

  // Audit log (runs after auth so req.user is populated)
  app.use(auditMiddleware);

  // ── Auth endpoints ──────────────────────────────────────────────────────────

  app.post("/api/auth/login", async (req, res) => {
    if (!JWT_SECRET) {
      return res.status(501).json({ error: "JWT_SECRET is not configured on this server." });
    }
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: "username and password are required" });
    }
    const user = await Users.verifyPassword(username, password);
    if (!user) return res.status(401).json({ error: "Invalid credentials" });
    const token = signToken(user);
    res.json({ token, expiresIn: JWT_EXPIRY, username: user.username, role: user.role });
  });

  app.get("/api/auth/me", (req, res) => {
    res.json({ username: req.user.username, role: req.user.role });
  });

  // ── Health ──────────────────────────────────────────────────────────────────

  app.get("/api/health", (req, res) => {
    res.json({
      status: "ok",
      server: "zoniq-test-runner",
      mode: "standalone",
      platform: process.platform,
      auth: JWT_SECRET ? "jwt" : API_KEY ? "api-key" : "none",
      encryption: !!process.env.ZONIQ_ENCRYPTION_KEY,
    });
  });

  // ── Scenarios CRUD ──────────────────────────────────────────────────────────

  app.get("/api/scenarios", (req, res) => {
    const db = DB.loadDB();
    res.json((db.scenarios || []).map(decryptCreds));
  });

  app.get("/api/scenarios/:id", (req, res) => {
    const db = DB.loadDB();
    const sc = (db.scenarios || []).find((s) => s.id === req.params.id);
    if (!sc) return res.status(404).json({ error: "Not found" });
    res.json(decryptCreds(sc));
  });

  app.post("/api/scenarios", (req, res) => {
    const sc = req.body || {};
    if (!sc.name || !sc.targetUrl || !sc.script) {
      return res.status(400).json({ error: "name, targetUrl, and script are required" });
    }
    const db = DB.loadDB();
    if (!db.scenarios) db.scenarios = [];
    const now = new Date().toISOString();
    const toStore = encryptCreds(sc);
    delete toStore.steps; // never persist ephemeral steps

    if (sc.id) {
      const idx = db.scenarios.findIndex((s) => s.id === sc.id);
      if (idx >= 0) {
        db.scenarios[idx] = { ...db.scenarios[idx], ...toStore, updatedAt: now };
      } else {
        db.scenarios.push({ ...toStore, createdAt: now, updatedAt: now });
      }
    } else {
      const newSc = { ...toStore, id: uuidv4(), createdAt: now, updatedAt: now };
      db.scenarios.push(newSc);
    }
    DB.addSavedUrl(db, sc.targetUrl);
    DB.saveDB(db);
    const saved = db.scenarios.find((s) => s.id === sc.id) || db.scenarios[db.scenarios.length - 1];
    res.json(decryptCreds(saved));
  });

  app.delete("/api/scenarios/:id", (req, res) => {
    const db = DB.loadDB();
    db.scenarios = (db.scenarios || []).filter((s) => s.id !== req.params.id);
    DB.saveDB(db);
    res.json({ ok: true });
  });

  // ── Plans CRUD ──────────────────────────────────────────────────────────────

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

  // ── Execution ───────────────────────────────────────────────────────────────

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
    const sc = decryptCreds((db.scenarios || []).find((s) => s.id === req.params.id));
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

  // ── Runs ────────────────────────────────────────────────────────────────────

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
