/**
 * recorder.js — Custom Playwright recorder with GUID-free option recording.
 *
 * Usage:
 *   node recorder.js <url> <outputPath> <showHighlights> [channel]
 *
 * Uses Playwright's programmatic API instead of the codegen CLI so we can:
 * 1. Capture GUID→label mappings from <option> elements without mutating the
 *    DOM, and replace GUIDs in the recorded script after recording finishes.
 * 2. Optionally hide the red highlight boxes during recording.
 */

const fs = require("fs");
const path = require("path");
const playwright = require("playwright-core");

const [, , url, outputPath, showHighlights, channel] = process.argv;

if (!url || !outputPath) {
  console.error("Usage: node recorder.js <url> <outputPath> <showHighlights> [channel]");
  process.exit(1);
}

function looksLikeGuid(value) {
  if (!value || typeof value !== "string") return false;
  const v = value.trim();
  if (/^\d{10,}$/.test(v)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return true;
  if (/^[0-9a-f]{12,}$/i.test(v)) return true;
  return false;
}

/**
 * Post-recording: replace any GUID values in the script with human-readable labels.
 */
function replaceGuidsInScript(guidToLabel) {
  const absOutput = path.resolve(outputPath);
  if (guidToLabel.size > 0 && fs.existsSync(absOutput)) {
    let script = fs.readFileSync(absOutput, "utf-8");
    let replaced = 0;
    for (const [guid, label] of guidToLabel) {
      const escaped = label.replace(/'/g, "\\'");
      const before = script;
      script = script.split(`'${guid}'`).join(`'${escaped}'`);
      script = script.split(`"${guid}"`).join(`"${escaped}"`);
      if (script !== before) {
        replaced++;
        console.log(`[recorder] GUID resolved: ${guid} → ${label}`);
      }
    }
    if (replaced > 0) {
      fs.writeFileSync(absOutput, script);
      console.log(`[recorder] Replaced ${replaced} GUID(s) with labels in recorded script`);
    }
  }
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

  // ── Collect GUID→label mappings from <option> elements ──────────
  // We expose a function that the page can call to report mappings.
  // The addInitScript observes <option> elements and reports their
  // value→textContent pairs WITHOUT mutating the DOM — so Mendix
  // form handling works normally during recording.
  const guidToLabel = new Map();

  // Each page in the context gets the exposed functions
  context.on("page", (newPage) => {
    newPage.exposeFunction("__zoniqReportOption", (value, label) => {
      if (label && value && value !== label) {
        guidToLabel.set(value, label);
      }
    }).catch(() => {}); // Ignore if page is already closed
  });

  // Also expose on any existing pages
  for (const p of context.pages()) {
    await p.exposeFunction("__zoniqReportOption", (value, label) => {
      if (label && value && value !== label) {
        guidToLabel.set(value, label);
      }
    }).catch(() => {});
  }

  await context.addInitScript(() => {
    function reportOptions(root) {
      const container = root || document;
      const selects = container.tagName === "SELECT"
        ? [container]
        : container.querySelectorAll("select");
      for (const sel of selects) {
        for (const opt of sel.options) {
          const label = opt.textContent.trim();
          if (label && opt.value) {
            window.__zoniqReportOption?.(opt.value, label);
          }
        }
      }
    }

    // Deferred scan — polls until __zoniqReportOption is available
    // (exposeFunction's page-level init script runs AFTER context-level
    // init scripts, so the function may not exist on the first tick).
    // Continues periodic scanning to catch late-loaded Mendix options.
    let _scanCount = 0;
    function _deferredScan() {
      if (window.__zoniqReportOption) {
        reportOptions();
      }
      if (++_scanCount < 30) {            // 30 × 200 ms = 6 s
        setTimeout(_deferredScan, 200);
      }
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => _deferredScan());
    } else {
      _deferredScan();
    }

    // Watch for dynamically added/changed <option> elements (Mendix loads these async)
    const observer = new MutationObserver((mutations) => {
      for (const mut of mutations) {
        for (const node of mut.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.tagName === "OPTION" || node.tagName === "SELECT" || node.querySelector?.("option")) {
            reportOptions(node.tagName === "OPTION" ? node.parentElement : node);
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

  // Ensure __zoniqReportOption is bound before the first navigation so
  // the context-level addInitScript can call it on DOMContentLoaded.
  await page.exposeFunction("__zoniqReportOption", (value, label) => {
    if (looksLikeGuid(value) && label) {
      guidToLabel.set(value, label);
    }
  }).catch(() => {}); // Ignore if already exposed by context "page" handler
  _exposeEchoFunctions(page);

  if (url) {
    let targetUrl = url;
    if (!targetUrl.startsWith("http") && !targetUrl.startsWith("file://") && !targetUrl.startsWith("about:")) {
      targetUrl = "http://" + targetUrl;
    }
    await page.goto(targetUrl).catch((e) => {
      console.error("[recorder] Navigation error:", e.message);
    });
  }

  // ── Capture all visible Mendix elements for the element DB ──────
  async function captureElements() {
    try {
      if (page.isClosed()) return;
      const elements = await page.evaluate(() => {
        const widgets = [];
        const els = document.querySelectorAll("[class*='mx-name-']");
        for (const el of els) {
          const classes = Array.from(el.classList);
          const mxClass = classes.find(c => c.startsWith("mx-name-"));
          if (!mxClass) continue;
          const name = mxClass.replace("mx-name-", "");
          const rect = el.getBoundingClientRect();
          const visible = rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== "hidden";
          if (!visible) continue;

          const input = el.querySelector("input, textarea, select");
          const testId = el.getAttribute("data-testid") || el.querySelector("[data-testid]")?.getAttribute("data-testid") || null;

          widgets.push({
            name,
            type: (() => {
              if (classes.some(c => /button|btn/i.test(c)) || el.tagName === "BUTTON") return "button";
              if (el.querySelector("textarea")) return "textarea";
              if (el.querySelector("select")) return "dropdown";
              if (el.querySelector("input[type='checkbox']")) return "checkbox";
              if (el.querySelector("input[type='radio']")) return "radio";
              if (el.querySelector("input[type='date'], input[type='datetime-local']")) return "datepicker";
              if (classes.some(c => /datagrid/i.test(c))) return "datagrid";
              if (classes.some(c => /listview/i.test(c))) return "listview";
              if (el.querySelector("input[type='text'], input:not([type])")) return "textbox";
              if (el.tagName === "A" || el.querySelector("a")) return "link";
              if (el.querySelector("img")) return "image";
              return "container";
            })(),
            selectors: { mx: `mx:${name}`, ...(testId ? { testId: `testid:${testId}` } : {}) },
            text: el.textContent?.trim().substring(0, 100) || "",
            value: input?.value || null,
            enabled: !el.hasAttribute("disabled") && !el.classList.contains("disabled"),
          });
        }
        return widgets;
      });

      if (elements.length) {
        const elementsPath = path.resolve(outputPath) + ".elements.json";
        fs.writeFileSync(elementsPath, JSON.stringify(elements, null, 2));
        console.log(`[recorder] Captured ${elements.length} elements for element DB`);
      }
    } catch (err) {
      console.log(`[recorder] Element capture skipped: ${err.message}`);
    }
  }

  // ── Detect browser/page closure ─────────────────────────────────
  // In Chromium headful mode, closing the last tab does NOT terminate
  // the browser process (known Playwright behaviour), so
  // browser.on("disconnected") may never fire. We use multiple
  // strategies to detect when the user is done recording.

  let _shutdownCalled = false;
  async function shutdown() {
    if (_shutdownCalled) return;
    _shutdownCalled = true;
    await captureElements();

    // Save a copy of the raw codegen output BEFORE any post-processing
    // so we can debug what Playwright actually recorded vs what we modified.
    const absOutputDebug = path.resolve(outputPath);
    if (fs.existsSync(absOutputDebug)) {
      const debugPath = absOutputDebug.replace(/\.js$/, '.raw.js');
      try {
        fs.copyFileSync(absOutputDebug, debugPath);
        console.log(`[recorder] Raw codegen output saved to: ${debugPath}`);
      } catch (e) {
        console.error(`[recorder] Failed to save raw debug copy: ${e.message}`);
      }
    }

    // Output the GUID map so the main process can apply a fallback
    // replacement after the recorder exits (defense in depth).
    if (guidToLabel.size > 0) {
      console.log(`[ZONIQ_GUID_MAP]${JSON.stringify(Object.fromEntries(guidToLabel))}`);
    }
    replaceGuidsInScript(guidToLabel);
    process.exit(0);
  }

  // Strategy 1: browser disconnect (works when browser process dies)
  browser.on("disconnected", () => {
    console.log("[recorder] Browser disconnected, exiting");
    shutdown();
  });

  // Strategy 2: page close event
  page.on("close", () => {
    const remaining = context.pages().length;
    if (remaining === 0) {
      console.log("[recorder] Main page closed (no pages remain), exiting");
      setTimeout(shutdown, 300);
    } else {
      console.log(`[recorder] Main page closed, but ${remaining} page(s) still open — continuing`);
    }
  });

  // Strategy 3: context close event
  context.on("close", () => {
    console.log("[recorder] Context closed, exiting");
    setTimeout(shutdown, 300);
  });

  // Strategy 4: poll — check if the page is still alive every second.
  // Catches cases where events don't fire (e.g. _enableRecorder
  // intercepts them, or the browser process is killed externally).
  // We tolerate transient failures (e.g. during full-page navigations
  // like Mendix login/logout redirects) by requiring multiple consecutive
  // failures before shutting down.
  let consecutiveFailures = 0;
  const MAX_POLL_FAILURES = 3;
  const pollInterval = setInterval(async () => {
    try {
      const pages = context.pages();
      if (pages.length === 0) {
        console.log("[recorder] No pages remain (poll), exiting");
        clearInterval(pollInterval);
        shutdown();
        return;
      }
      // Lightweight CDP call on any live page to verify connection is alive
      await pages[0].evaluate("1").catch(() => {
        throw new Error("evaluate failed");
      });
      consecutiveFailures = 0;
    } catch {
      consecutiveFailures++;
      console.log(`[recorder] Browser poll failure ${consecutiveFailures}/${MAX_POLL_FAILURES}`);
      if (consecutiveFailures >= MAX_POLL_FAILURES) {
        console.log("[recorder] Browser connection lost (poll), exiting");
        clearInterval(pollInterval);
        shutdown();
      }
    }
  }, 1000);

  // Strategy 5: watch all pages — if every page in the context closes
  context.on("page", (newPage) => {
    // Expose GUID and echo reporting on new pages too
    newPage.exposeFunction("__zoniqReportOption", (value, label) => {
      if (looksLikeGuid(value) && label) {
        guidToLabel.set(value, label);
      }
    }).catch(() => {});
    _exposeEchoFunctions(newPage);

    newPage.on("close", () => {
      const remaining = context.pages().length;
      if (remaining === 0) {
        console.log("[recorder] All pages closed, exiting");
        setTimeout(shutdown, 300);
      }
    });
  });

  // Keep the process alive until one of the above fires
  await new Promise(() => {});
})().catch((err) => {
  console.error("[recorder] Fatal error:", err);
  process.exit(1);
});
