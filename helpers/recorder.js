/**
 * recorder.js — Custom Playwright recorder with GUID-free option recording.
 *
 * Usage:
 *   node recorder.js <url> <outputPath> <showHighlights> [channel]
 *
 * Uses Playwright's programmatic API instead of the codegen CLI so we can:
 * 1. Replace <option> value attributes with their visible text BEFORE the user
 *    interacts — so codegen naturally records human-readable labels, not GUIDs.
 * 2. Optionally hide the red highlight boxes during recording.
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

  // ── Replace <option> values with visible text ──────────────
  // Mendix uses internal GUIDs as option values. By swapping them to the
  // human-readable label text BEFORE the user clicks, Playwright's codegen
  // naturally records .selectOption('Label Text') instead of .selectOption('12345-guid').
  // This eliminates the need for any post-recording headless browser resolution.
  await context.addInitScript(() => {
    function looksLikeGuid(value) {
      if (!value || typeof value !== "string") return false;
      const v = value.trim();
      if (/^\d{10,}$/.test(v)) return true;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return true;
      if (/^[0-9a-f]{12,}$/i.test(v)) return true;
      return false;
    }

    function swapOptionValues(root) {
      const container = root || document;
      // If root is a <select>, query its options directly; otherwise search descendants
      const options = container.tagName === "SELECT"
        ? container.querySelectorAll("option")
        : container.querySelectorAll("select option");
      for (const opt of options) {
        const label = opt.textContent.trim();
        if (label && opt.value && looksLikeGuid(opt.value)) {
          opt.value = label;
        }
      }
    }

    // Swap on initial load
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => swapOptionValues());
    } else {
      swapOptionValues();
    }

    // Watch for dynamically added/changed <option> elements (Mendix loads these async)
    const observer = new MutationObserver((mutations) => {
      for (const mut of mutations) {
        for (const node of mut.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.tagName === "OPTION" || node.tagName === "SELECT" || node.querySelector?.("option")) {
            swapOptionValues(node.tagName === "OPTION" ? node.parentElement : node);
          }
        }
      }
    });
    if (document.documentElement) {
      observer.observe(document.documentElement, { childList: true, subtree: true });
    } else {
      document.addEventListener("DOMContentLoaded", () => {
        observer.observe(document.documentElement, { childList: true, subtree: true });
      });
    }
  });

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

  // Wait for the browser to be closed by the user
  await new Promise((resolve) => browser.on("disconnected", resolve));
})().catch((err) => {
  console.error("[recorder] Fatal error:", err);
  process.exit(1);
});
