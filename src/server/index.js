/**
 * Standalone Zoniq server entry point — runs the Express API in pure Node mode
 * (no Electron). Designed for cloud deployment (Railway, etc).
 *
 * Required env vars:
 *   DATA_DIR         — Directory for scenarios.json, results/, scripts/, etc.
 *
 * Optional env vars:
 *   PORT             — HTTP port (default 3100)
 *   ZONIQ_API_KEY    — If set, all endpoints (except /api/health) require this
 *                      key in the `x-api-key` header or `Authorization: Bearer`.
 *   ZONIQ_HEADED     — If "true", launches a headed browser (requires X server).
 *                      Default false in standalone mode.
 *
 * Run:
 *   DATA_DIR=/data ZONIQ_API_KEY=changeme node src/server/index.js
 */

const Paths = require("../../lib/paths");
Paths.ensureDirs(); // creates SCRIPTS_DIR, RESULTS_DIR, TEMP_DIR, APPS_DIR if missing

const Runner = require("../../lib/playwright-runner");
Runner.ensurePlaywrightConfig();

const { buildApp } = require("./app");

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
