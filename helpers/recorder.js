/**
 * recorder.js — Custom Playwright recorder with highlight toggle support.
 *
 * Usage:
 *   node recorder.js <url> <outputPath> <showHighlights> [channel]
 *
 * Uses Playwright's programmatic API instead of the codegen CLI so we can
 * inject CSS that hides the red highlight boxes when showHighlights is "false".
 *
 * NOTE: GUIDs in recorded .selectOption() calls are handled by downstream
 * runtime layers — wrapScript() transforms .selectOption() into
 * mx.smartSelect() which resolves GUIDs to labels at playback time.
 */

const path = require("path");
const playwright = require("playwright-core");

const [, , url, outputPath, showHighlights, channel] = process.argv;

if (!url || !outputPath) {
  console.error("Usage: node recorder.js <url> <outputPath> <showHighlights> [channel]");
  process.exit(1);
}

(async () => {
  const launchOptions = {
    headless: false,
  };
  if (channel) {
    launchOptions.channel = channel;
  }

  const browser = await playwright.chromium.launch(launchOptions);

  const contextOptions = {
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: process.platform === "darwin" ? 2 : 1,
  };
  const context = await browser.newContext(contextOptions);

  // Hide Playwright's recorder highlight overlays when not wanted
  if (showHighlights !== "true") {
    await context.addInitScript(() => {
      const HIDE_CSS = `
        x-pw-highlight, x-pw-action-point, x-pw-tooltip,
        x-pw-glass, x-pw-overlay, x-pw-dialog {
          display: none !important;
          opacity: 0 !important;
          visibility: hidden !important;
          pointer-events: none !important;
        }
      `;
      function injectStyle() {
        if (!document.head && !document.documentElement) return;
        const style = document.createElement("style");
        style.setAttribute("data-recorder-hide", "1");
        style.textContent = HIDE_CSS;
        (document.head || document.documentElement).appendChild(style);
      }
      if (document.head || document.documentElement) {
        injectStyle();
      }
      const observer = new MutationObserver(() => {
        if (!document.querySelector("style[data-recorder-hide]")) {
          injectStyle();
        }
      });
      if (document.documentElement) {
        observer.observe(document.documentElement, { childList: true, subtree: true });
      } else {
        document.addEventListener("DOMContentLoaded", () => {
          injectStyle();
          observer.observe(document.documentElement, { childList: true, subtree: true });
        });
      }
    });
  }

  // Enable Playwright's built-in recorder / code generator
  await context._enableRecorder({
    language: "javascript",
    launchOptions,
    contextOptions,
    mode: "recording",
    outputFile: path.resolve(outputPath),
    handleSIGINT: false,
  });

  // Navigate to the target URL
  const page = context.pages()[0] || (await context.newPage());
  if (url) {
    let targetUrl = url;
    if (!targetUrl.startsWith("http") && !targetUrl.startsWith("file://") && !targetUrl.startsWith("about:")) {
      targetUrl = "http://" + targetUrl;
    }
    await page.goto(targetUrl).catch((e) => {
      console.error("[recorder] Navigation error:", e.message);
    });
  }

  // _enableRecorder keeps the Playwright Inspector alive even after the user
  // closes the browser tab. Event listeners (page "close", browser "disconnected")
  // may not fire reliably because the recorder intercepts page lifecycle.
  // Use multiple strategies to detect shutdown:

  // Strategy 1: page close event
  page.on("close", () => {
    console.log("[recorder] Main page closed, exiting");
    setTimeout(() => process.exit(0), 300);
  });

  // Strategy 2: browser disconnect event
  browser.on("disconnected", () => {
    console.log("[recorder] Browser disconnected, exiting");
    setTimeout(() => process.exit(0), 300);
  });

  // Strategy 3: poll — check if the page is still alive every second.
  // This catches cases where events don't fire (e.g. _enableRecorder
  // intercepts them, or the browser process is killed externally).
  const pollInterval = setInterval(async () => {
    try {
      // page.isClosed() is synchronous and doesn't need CDP
      if (page.isClosed()) {
        console.log("[recorder] Page detected as closed (poll), exiting");
        clearInterval(pollInterval);
        process.exit(0);
      }
      // Also try a lightweight CDP call to verify the connection is alive
      await page.evaluate("1").catch(() => null);
    } catch {
      console.log("[recorder] Browser connection lost (poll), exiting");
      clearInterval(pollInterval);
      process.exit(0);
    }
  }, 1000);

  // Keep the process alive until one of the above fires
  await new Promise(() => {});
})().catch((err) => {
  console.error("[recorder] Fatal error:", err);
  process.exit(1);
});
