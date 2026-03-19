// @ts-check
const { defineConfig } = require("@playwright/test");

/**
 * Playwright config optimized for Mendix applications.
 * Mendix apps have longer load times due to client-side rendering,
 * and use dynamic widget IDs — so we increase timeouts accordingly.
 *
 * Set ZONIQ_BROWSER_CHANNEL to use a system browser instead of
 * Playwright's bundled Chromium (e.g. "msedge", "chrome").
 */

const useOptions = {
  // Navigation & action timeouts
  navigationTimeout: 45_000,
  actionTimeout: 15_000,

  // Capture evidence on failure
  screenshot: "only-on-failure",
  video: "retain-on-failure",
  trace: "retain-on-failure",

  // Standard business app viewport
  viewport: { width: 1920, height: 1080 },

  // Slow down actions slightly — Mendix re-renders can lag
  // Increase this if tests are flaky
  // launchOptions: { slowMo: 100 },
};

// Allow the app to specify a system browser channel (e.g. msedge, chrome)
if (process.env.ZONIQ_BROWSER_CHANNEL) {
  useOptions.channel = process.env.ZONIQ_BROWSER_CHANNEL;
}

module.exports = defineConfig({
  testDir: './temp',

  // Global timeout per test (Mendix pages can be slow)
  timeout: 120_000,

  // Expect assertions timeout
  expect: {
    timeout: 15_000,
  },

  use: useOptions,

  // Retry once on failure (Mendix timing issues)
  retries: 1,

  // JSON reporter for programmatic parsing + HTML for humans
  reporter: [
    ["json", { outputFile: "results/latest-report.json" }],
    ["html", { open: "never", outputFolder: "results/html-report" }],
  ],
});
