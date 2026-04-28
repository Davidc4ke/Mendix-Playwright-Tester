/**
 * Standalone Zoniq server entry point — runs the Express API in pure Node mode
 * (no Electron). Designed for cloud deployment (Railway, etc).
 *
 * Required env vars:
 *   DATA_DIR         — Directory for scenarios.json, results/, scripts/, etc.
 *
 * Optional env vars:
 *   PORT                  — HTTP port (default 3100)
 *   ZONIQ_API_KEY         — Legacy static key (still accepted alongside JWT).
 *   ZONIQ_HEADED          — "true" to launch headed browser (requires X server).
 *   JWT_SECRET            — Signs/verifies JWT tokens; required for /api/auth/login.
 *   ADMIN_USERNAME        — Admin account username (default "admin").
 *   ADMIN_PASSWORD        — Admin account password; required to bootstrap first user.
 *   ZONIQ_ENCRYPTION_KEY  — base64-encoded 32-byte AES key for credential encryption.
 *                           Generate: openssl rand -base64 32
 *
 * Run:
 *   DATA_DIR=/data JWT_SECRET=... ADMIN_PASSWORD=... node src/server/index.js
 */

const Paths = require("../../lib/paths");
Paths.ensureDirs(); // creates SCRIPTS_DIR, RESULTS_DIR, TEMP_DIR, APPS_DIR if missing

const Runner = require("../../lib/playwright-runner");
Runner.ensurePlaywrightConfig();

const Users = require("../../lib/users");

const { buildApp } = require("./app");

// Bootstrap admin user (no-op if users already exist)
Users.ensureAdminUser().catch((err) => console.error("[auth] ensureAdminUser failed:", err));

const PORT = parseInt(process.env.PORT || "3100", 10);
const app = buildApp();

const server = app.listen(PORT, () => {
  const { DATA_DIR } = Paths.getPaths();
  console.log(`[zoniq-server] listening on :${PORT}`);
  console.log(`[zoniq-server] DATA_DIR=${DATA_DIR}`);
  console.log(`[zoniq-server] mode=standalone`);
});

const shutdown = (signal) => {
  console.log(`[zoniq-server] received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
