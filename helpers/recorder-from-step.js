/**
 * recorder-from-step.js — Replay prefix statements then launch Playwright recorder.
 *
 * Usage:
 *   node recorder-from-step.js <url> <outputPath> <showHighlights> <prefixJsonPath> [channel]
 *
 * Arguments:
 *   url            - Target URL to navigate to
 *   outputPath     - File path where the recorded script will be written
 *   showHighlights - "true" or "false" to show Playwright recorder overlays
 *   prefixJsonPath - Path to a JSON file containing { statements: string[], credentials: {} }
 *   channel        - Optional browser channel (e.g. "chrome", "msedge")
 *
 * This script:
 * 1. Launches a headed browser
 * 2. Navigates to the target URL
 * 3. Replays all prefix statements using AsyncFunction (same technique as the healer agent)
 * 4. Enables Playwright's built-in code recorder
 * 5. The user records new actions — codegen writes to outputPath
 * 6. On browser close, strips the replayed actions from the codegen output
 *    and returns only the newly recorded code
 */

const fs = require("fs");
const path = require("path");
const playwright = require("playwright-core");

const [, , url, outputPath, showHighlights, prefixJsonPath, channel] = process.argv;

if (!url || !outputPath || !prefixJsonPath) {
  console.error("Usage: node recorder-from-step.js <url> <outputPath> <showHighlights> <prefixJsonPath> [channel]");
  process.exit(1);
}

// Load prefix data
let prefixData;
try {
  prefixData = JSON.parse(fs.readFileSync(prefixJsonPath, "utf-8"));
} catch (err) {
  console.error("[recorder-from-step] Failed to load prefix data:", err.message);
  process.exit(1);
}

const prefixStatements = prefixData.statements || [];
const credentials = prefixData.credentials || {};
const targetUrl = prefixData.targetUrl || url;

function looksLikeGuid(value) {
  if (!value || typeof value !== "string") return false;
  const v = value.trim();
  if (/^\d{10,}$/.test(v)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return true;
  if (/^[0-9a-f]{12,}$/i.test(v)) return true;
  return false;
}

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
        console.log(`[recorder-from-step] GUID resolved: ${guid} → ${label}`);
      }
    }
    if (replaced > 0) {
      fs.writeFileSync(absOutput, script);
      console.log(`[recorder-from-step] Replaced ${replaced} GUID(s) with labels`);
    }
  }
}

(async () => {
  const launchOptions = { headless: false };
  if (channel) {
    launchOptions.channel = channel;
  }

  const browser = await playwright.chromium.launch(launchOptions);

  const contextOptions = {
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: process.platform === "darwin" ? 2 : 1,
  };
  const context = await browser.newContext(contextOptions);

  // ── GUID collection (same as recorder.js) ──────────────
  const guidToLabel = new Map();

  context.on("page", (newPage) => {
    newPage.exposeFunction("__zoniqReportOption", (value, label) => {
      if (label && value && value !== label) {
        guidToLabel.set(value, label);
      }
    }).catch(() => {});
  });

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

    let _scanCount = 0;
    function _deferredScan() {
      if (window.__zoniqReportOption) {
        reportOptions();
      }
      if (++_scanCount < 30) {
        setTimeout(_deferredScan, 200);
      }
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => _deferredScan());
    } else {
      _deferredScan();
    }

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

  // Hide Playwright highlights if not wanted
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

  // ── Phase 1: Navigate and replay prefix statements ─────
  const page = context.pages()[0] || (await context.newPage());

  await page.exposeFunction("__zoniqReportOption", (value, label) => {
    if (looksLikeGuid(value) && label) {
      guidToLabel.set(value, label);
    }
  }).catch(() => {});

  // Navigate to target URL
  if (url) {
    let navUrl = url;
    if (!navUrl.startsWith("http") && !navUrl.startsWith("file://") && !navUrl.startsWith("about:")) {
      navUrl = "http://" + navUrl;
    }
    console.log(`[recorder-from-step] Navigating to ${navUrl}`);
    await page.goto(navUrl).catch((e) => {
      console.error("[recorder-from-step] Navigation error:", e.message);
    });
  }

  // Load mendix-helpers for replay
  const mx = require(path.join(__dirname, "mendix-helpers.js"));

  // Wait for Mendix to be ready before replaying
  try {
    await mx.waitForMendix(page);
  } catch (e) {
    console.log(`[recorder-from-step] waitForMendix skipped: ${e.message}`);
  }

  // Replay prefix statements one by one
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const { expect } = require("@playwright/test");
  const TARGET_URL = targetUrl;
  const CREDENTIALS = credentials;

  console.log(`[recorder-from-step] Replaying ${prefixStatements.length} prefix statement(s)...`);
  console.log(`[ZONIQ_REPLAY_STATUS]{"total":${prefixStatements.length},"status":"started"}`);

  for (let i = 0; i < prefixStatements.length; i++) {
    const stmt = prefixStatements[i];
    const desc = stmt.length > 80 ? stmt.substring(0, 77) + "..." : stmt;
    console.log(`[ZONIQ_REPLAY_STEP]{"index":${i},"total":${prefixStatements.length},"desc":${JSON.stringify(desc)}}`);

    try {
      const fn = new AsyncFunction("page", "mx", "expect", "TARGET_URL", "CREDENTIALS", stmt);
      await fn(page, mx, expect, TARGET_URL, CREDENTIALS);
      console.log(`[recorder-from-step] Step ${i + 1}/${prefixStatements.length} OK: ${desc}`);
    } catch (err) {
      console.error(`[recorder-from-step] Step ${i + 1}/${prefixStatements.length} FAILED: ${err.message}`);
      console.log(`[ZONIQ_REPLAY_STATUS]{"total":${prefixStatements.length},"status":"failed","failedAt":${i},"error":${JSON.stringify(err.message)}}`);
      // Don't exit — let the user see the state and decide whether to continue recording
      break;
    }
  }

  console.log(`[ZONIQ_REPLAY_STATUS]{"total":${prefixStatements.length},"status":"done"}`);
  console.log("[recorder-from-step] Prefix replay complete. Enabling recorder...");

  // ── Phase 2: Enable codegen recorder ───────────────────
  // The user can now interact with the page and record new actions.
  // Codegen will only capture actions from this point forward.
  await context._enableRecorder({
    language: "javascript",
    launchOptions,
    contextOptions,
    mode: "recording",
    outputFile: path.resolve(outputPath),
    handleSIGINT: false,
  });

  console.log("[recorder-from-step] Recorder enabled. User can now record new actions.");

  // ── Capture visible Mendix elements per page for the element DB ──
  const _accumulatedElements = new Map();
  let _captureTimer = null;

  async function captureElementsForCurrentPage() {
    try {
      if (page.isClosed()) return;
      const currentUrl = page.url();
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

      for (const el of elements) {
        if (!_accumulatedElements.has(el.name)) {
          el.pageUrl = currentUrl;
          _accumulatedElements.set(el.name, el);
        }
      }
      if (elements.length) {
        console.log(`[recorder-from-step] Captured ${elements.length} elements on ${currentUrl}`);
      }
    } catch (err) {
      // Silently skip — page may have navigated away during capture
    }
  }

  function scheduleDebouncedCapture() {
    if (_captureTimer) clearTimeout(_captureTimer);
    _captureTimer = setTimeout(() => captureElementsForCurrentPage(), 800);
  }

  async function writeAccumulatedElements() {
    await captureElementsForCurrentPage();
    const allElements = Array.from(_accumulatedElements.values());
    if (allElements.length) {
      const elementsPath = path.resolve(outputPath) + ".elements.json";
      fs.writeFileSync(elementsPath, JSON.stringify(allElements, null, 2));
      console.log(`[recorder-from-step] Wrote ${allElements.length} accumulated elements across pages`);
    }
  }

  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      scheduleDebouncedCapture();
    }
  });

  // ── Detect browser closure (same strategies as recorder.js) ──
  let _shutdownCalled = false;
  async function shutdown() {
    if (_shutdownCalled) return;
    _shutdownCalled = true;
    await writeAccumulatedElements();
    if (guidToLabel.size > 0) {
      console.log(`[ZONIQ_GUID_MAP]${JSON.stringify(Object.fromEntries(guidToLabel))}`);
    }
    replaceGuidsInScript(guidToLabel);
    process.exit(0);
  }

  browser.on("disconnected", () => {
    console.log("[recorder-from-step] Browser disconnected, exiting");
    shutdown();
  });

  page.on("close", () => {
    const remaining = context.pages().length;
    if (remaining === 0) {
      console.log("[recorder-from-step] Main page closed (no pages remain), exiting");
      setTimeout(shutdown, 300);
    }
  });

  context.on("close", () => {
    console.log("[recorder-from-step] Context closed, exiting");
    setTimeout(shutdown, 300);
  });

  let consecutiveFailures = 0;
  const MAX_POLL_FAILURES = 3;
  const pollInterval = setInterval(async () => {
    try {
      const pages = context.pages();
      if (pages.length === 0) {
        console.log("[recorder-from-step] No pages remain (poll), exiting");
        clearInterval(pollInterval);
        shutdown();
        return;
      }
      await pages[0].evaluate("1").catch(() => {
        throw new Error("evaluate failed");
      });
      consecutiveFailures = 0;
    } catch {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_POLL_FAILURES) {
        console.log("[recorder-from-step] Browser connection lost (poll), exiting");
        clearInterval(pollInterval);
        shutdown();
      }
    }
  }, 1000);

  context.on("page", (newPage) => {
    newPage.exposeFunction("__zoniqReportOption", (value, label) => {
      if (looksLikeGuid(value) && label) {
        guidToLabel.set(value, label);
      }
    }).catch(() => {});

    newPage.on("close", () => {
      const remaining = context.pages().length;
      if (remaining === 0) {
        console.log("[recorder-from-step] All pages closed, exiting");
        setTimeout(shutdown, 300);
      }
    });
  });

  // Keep the process alive
  await new Promise(() => {});
})().catch((err) => {
  console.error("[recorder-from-step] Fatal error:", err);
  process.exit(1);
});
