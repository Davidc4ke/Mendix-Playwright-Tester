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
 * Convert a CSS selector into a valid JS variable name.
 * ".mx-name-txtTicketId" → "txtTicketId"
 */
function selectorToVarName(selector, usedNames) {
  let name;
  const mxMatch = selector.match(/\.mx-name-(\w+)/);
  if (mxMatch) {
    name = mxMatch[1];
  } else {
    const words = selector.replace(/[^a-zA-Z0-9]/g, ' ').trim().split(/\s+/).filter(Boolean);
    name = 'captured' + words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  }
  // Avoid collisions
  let final = name;
  let suffix = 2;
  while (usedNames.has(final)) { final = name + suffix++; }
  usedNames.add(final);
  return final;
}

/**
 * Post-recording: insert capture statements and replace hardcoded values
 * for any "value echoes" (values the user typed that were previously seen on the page).
 */
function applyValueEchoes(echoes) {
  if (!echoes.length) return;
  const absOutput = path.resolve(outputPath);
  if (!fs.existsSync(absOutput)) return;
  let script = fs.readFileSync(absOutput, "utf-8");

  // Deduplicate echoes by value (keep first occurrence)
  const seen = new Set();
  const unique = echoes.filter(e => {
    if (seen.has(e.value)) return false;
    seen.add(e.value);
    return true;
  });

  const usedVarNames = new Set();
  let applied = 0;

  for (const echo of unique) {
    // Check if this value actually appears in the script as a string literal
    if (!script.includes(`'${echo.value}'`) && !script.includes(`"${echo.value}"`)) continue;

    const varName = selectorToVarName(echo.sourceSelector, usedVarNames);

    // Find the FIRST fill/type/selectOption line containing this value
    const lines = script.split('\n');
    let firstUsageLine = -1;
    const escapedValue = echo.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const usageRe = new RegExp(`\\.(?:fill|type|selectOption)\\s*\\(\\s*['"]${escapedValue}['"]`);

    for (let i = 0; i < lines.length; i++) {
      if (usageRe.test(lines[i])) { firstUsageLine = i; break; }
    }
    if (firstUsageLine === -1) continue;

    // Walk backward from first usage to find the best insertion point:
    // After a click/waitForMendix/goto — but BEFORE any logout/login that would lose the source element
    let insertAt = firstUsageLine;
    for (let i = firstUsageLine - 1; i >= 0; i--) {
      const line = lines[i].trim();
      // Stop at logout/login boundary — capture must be before user switches
      if (/\.goto\s*\(.*logout/i.test(line) || /mx\.login/.test(line)) {
        insertAt = i;
        break;
      }
      // Good insertion points: after a click, waitForMendix, or navigation
      if (/\.click\s*\(/.test(line) || /waitForMendix/.test(line) || /\.goto\s*\(/.test(line)) {
        insertAt = i + 1;
        break;
      }
    }

    // Build and insert the capture statement
    const indent = lines[insertAt]?.match(/^(\s*)/)?.[1] || '  ';
    const captureCode = `${indent}const ${varName} = (await page.locator('${echo.sourceSelector}').textContent()).trim();`;
    lines.splice(insertAt, 0, captureCode);

    // Rejoin and replace the hardcoded value ONLY inside fill/type/selectOption
    // call arguments — not everywhere in the script. Blind global replacement
    // can corrupt selectors, comments, or other unrelated code.
    script = lines.join('\n');
    const actionRe = new RegExp(
      `(\\.(fill|type|selectOption)\\s*\\()\\s*['"]${escapedValue}['"]`,
      'g'
    );
    script = script.replace(actionRe, `$1${varName}`);

    applied++;
    console.log(`[recorder] Auto-captured: "${echo.value}" → ${varName} (from ${echo.sourceSelector})`);
  }

  if (applied > 0) {
    fs.writeFileSync(absOutput, script);
    console.log(`[recorder] Applied ${applied} value echo(es) to script`);
  }
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
  const valueEchoes = [];          // [{ value, sourceSelector, type }]
  const clipboardCopies = [];      // [{ value, sourceSelector }]

  function _exposeEchoFunctions(p) {
    p.exposeFunction("__zoniqReportEcho", (value, sourceSelector) => {
      if (value && sourceSelector) {
        // Avoid duplicate echoes for the same value
        if (!valueEchoes.some(e => e.value === value)) {
          valueEchoes.push({ value, sourceSelector, type: 'input' });
          console.log(`[recorder] Value echo detected: "${value}" from ${sourceSelector}`);
        }
      }
    }).catch(() => {});

    p.exposeFunction("__zoniqReportClipboard", (action, value, selector) => {
      if (action === 'copy' && value && selector) {
        clipboardCopies.push({ value, sourceSelector: selector });
      }
      if (action === 'paste' && value) {
        const copy = clipboardCopies.find(c => c.value === value);
        if (copy && !valueEchoes.some(e => e.value === value)) {
          valueEchoes.push({ value, sourceSelector: copy.sourceSelector, type: 'clipboard' });
          console.log(`[recorder] Clipboard echo detected: "${value}" from ${copy.sourceSelector}`);
        }
      }
    }).catch(() => {});
  }

  // Each page in the context gets the exposed functions
  context.on("page", (newPage) => {
    newPage.exposeFunction("__zoniqReportOption", (value, label) => {
      if (label && value && value !== label) {
        guidToLabel.set(value, label);
      }
    }).catch(() => {}); // Ignore if page is already closed
    _exposeEchoFunctions(newPage);
  });

  // Also expose on any existing pages
  for (const p of context.pages()) {
    await p.exposeFunction("__zoniqReportOption", (value, label) => {
      if (label && value && value !== label) {
        guidToLabel.set(value, label);
      }
    }).catch(() => {});
    _exposeEchoFunctions(p);
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

  // ── Value Observatory — detect "value echoes" for auto-capture ──
  // Tracks interesting text values appearing on the page (ticket IDs, reference
  // numbers, etc). When the user types/pastes a value that was previously seen
  // on-screen, reports it as an "echo" — indicating a dynamic value being reused.
  await context.addInitScript(() => {
    const __zoniqValueBank = new Map(); // value → selector

    const BLOCKLIST = new Set([
      'yes','no','ok','cancel','submit','save','delete','edit','close','open',
      'back','next','previous','search','filter','login','logout','loading',
      'username','password','email','name','true','false','null','undefined',
      'home','settings','help','new','add','remove','update','create','view',
      'select','none','all','other','details','description','title','status',
      'error','success','warning','info','confirm','apply','reset','clear',
    ]);

    function isInterestingValue(text) {
      if (!text || text.length < 3 || text.length > 200) return false;
      const lower = text.toLowerCase().trim();
      if (BLOCKLIST.has(lower)) return false;
      // Reject pure alphabetic short phrases (common UI labels)
      if (/^[A-Za-z\s]{1,25}$/.test(text) && text.split(/\s+/).length <= 3) return false;
      // Accept: contains digits, has separators like dashes/dots, looks structured
      return true;
    }

    function getBestSelector(el) {
      if (!el) return null;
      // Walk up to find nearest .mx-name-* ancestor
      let node = el;
      while (node && node !== document.body) {
        if (node.classList) {
          for (const cls of node.classList) {
            if (cls.startsWith('mx-name-')) return '.' + cls;
          }
        }
        node = node.parentElement;
      }
      // Fallback: data-testid
      const testId = el.closest('[data-testid]');
      if (testId) return `[data-testid="${testId.getAttribute('data-testid')}"]`;
      // Fallback: tag + class
      if (el.id) return '#' + el.id;
      return null;
    }

    function scanElement(el) {
      if (!el || el.nodeType !== 1) return;
      // Scan .mx-name-* elements for their text content
      const widgets = el.classList?.contains('mx-name-') || Array.from(el.classList || []).some(c => c.startsWith('mx-name-'))
        ? [el]
        : el.querySelectorAll?.("[class*='mx-name-']") || [];

      for (const w of widgets) {
        const text = w.textContent?.trim();
        if (text && isInterestingValue(text)) {
          // Don't overwrite if we already have this value with a better selector
          if (!__zoniqValueBank.has(text)) {
            const selector = getBestSelector(w);
            if (selector) __zoniqValueBank.set(text, selector);
          }
        }
        // Also check input values
        const input = w.querySelector('input, textarea');
        if (input?.value) {
          const val = input.value.trim();
          if (val && isInterestingValue(val) && !__zoniqValueBank.has(val)) {
            const selector = getBestSelector(w);
            if (selector) __zoniqValueBank.set(val, selector);
          }
        }
      }

      // Also scan data-testid elements, table cells, alerts
      const extras = el.querySelectorAll?.('[data-testid], td, .alert, .mx-dataview-content') || [];
      for (const e of extras) {
        const text = e.textContent?.trim();
        if (text && isInterestingValue(text) && !__zoniqValueBank.has(text)) {
          const selector = getBestSelector(e);
          if (selector) __zoniqValueBank.set(text, selector);
        }
      }
    }

    // Initial scan
    function fullScan() { scanElement(document.body); }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => setTimeout(fullScan, 500));
    } else {
      setTimeout(fullScan, 500);
    }

    // Watch for new content (debounced)
    let _scanTimer = null;
    const valueObserver = new MutationObserver((mutations) => {
      if (_scanTimer) return; // debounce
      _scanTimer = setTimeout(() => {
        _scanTimer = null;
        for (const mut of mutations) {
          for (const node of mut.addedNodes) {
            if (node.nodeType === 1) scanElement(node);
          }
        }
      }, 200);
    });
    if (document.documentElement) {
      valueObserver.observe(document.documentElement, { childList: true, subtree: true });
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        valueObserver.observe(document.documentElement, { childList: true, subtree: true });
      });
    }

    // ── Echo detection: input events ──
    let _echoTimer = null;
    document.addEventListener('input', (e) => {
      // Debounce — check after 300ms of no typing
      clearTimeout(_echoTimer);
      _echoTimer = setTimeout(() => {
        const val = e.target?.value?.trim();
        if (val && val.length >= 3 && __zoniqValueBank.has(val)) {
          window.__zoniqReportEcho?.(val, __zoniqValueBank.get(val));
        }
      }, 300);
    }, true);

    // ── Echo detection: clipboard events ──
    document.addEventListener('copy', () => {
      setTimeout(() => {
        const sel = window.getSelection()?.toString().trim();
        if (sel && sel.length >= 3) {
          const anchor = window.getSelection()?.anchorNode?.parentElement;
          const selector = getBestSelector(anchor);
          if (selector) {
            // Also add to value bank if not already there
            if (!__zoniqValueBank.has(sel)) __zoniqValueBank.set(sel, selector);
            window.__zoniqReportClipboard?.('copy', sel, selector);
          }
        }
      }, 0);
    }, true);

    document.addEventListener('paste', (e) => {
      const pasted = e.clipboardData?.getData('text')?.trim();
      if (pasted && pasted.length >= 3) {
        window.__zoniqReportClipboard?.('paste', pasted, '');
        // Also check the value bank for non-clipboard echoes
        if (__zoniqValueBank.has(pasted)) {
          window.__zoniqReportEcho?.(pasted, __zoniqValueBank.get(pasted));
        }
      }
    }, true);
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
    applyValueEchoes(valueEchoes);
    if (valueEchoes.length > 0) {
      console.log(`[ZONIQ_VALUE_ECHOES]${JSON.stringify(valueEchoes)}`);
    }
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
