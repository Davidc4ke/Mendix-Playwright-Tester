/**
 * healer-agent.js — Self-healing agent for failing Playwright tests
 *
 * Analyzes a failing test by comparing its errors with the current DOM state,
 * then produces a patched script that fixes the failure.
 *
 * Two healing modes:
 * 1. Static (fast path): Analyzes errors + failure screenshot without launching
 *    a browser. Works for most failures where the error message is sufficient.
 * 2. Replay (fallback): Replays the test to the failure point in a live browser
 *    so the LLM can inspect the actual DOM. Used when static healing has low
 *    confidence or can't produce a fix.
 *
 * For script-based scenarios, replay executes the actual Playwright code directly
 * using the live page object — this supports all locator strategies including
 * getByRole, getByLabel, getByText, locator chains, etc.
 */

const fs = require("fs");
const path = require("path");
const { AgentOrchestrator } = require("./orchestrator");
const { BrowserContext } = require("./browser-context");

const SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, "prompts", "healer-system.md"),
  "utf-8"
);

const STATIC_SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, "prompts", "healer-static-system.md"),
  "utf-8"
);

const mx = require(path.resolve(__dirname, "..", "helpers", "mendix-helpers"));

// AsyncFunction constructor for executing dynamic async code
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

class HealerAgent {
  constructor(llmClient, options = {}) {
    this.llm = llmClient;
    this.maxIterations = options.maxIterations || 10;
    this.headless = options.headless ?? false;
    this.browserChannel = options.browserChannel || null;
    this._cancelled = false;
    this._orchestrator = null;
    this._browser = null;
  }

  cancel() {
    this._cancelled = true;
    if (this._orchestrator) this._orchestrator.cancel();
  }

  /**
   * Heal a failing test. Uses a hybrid approach:
   * 1. First tries static healing (screenshot + errors, no browser) for speed
   * 2. Falls back to replay-based healing if static healing has low confidence
   *
   * @param {object} params
   * @param {string} params.script — The original test script
   * @param {Array}  [params.steps] — Structured steps (if step-based scenario)
   * @param {Array}  params.errors — Error objects from the failed run [{ test, message, snippet }]
   * @param {string} params.targetUrl — The app URL
   * @param {object} [params.credentials] — { username, password }
   * @param {string} [params.runResultsDir] — Path to the run's results directory (for screenshots)
   * @param {Array}  [params.artifacts] — List of artifact filenames from the failed run
   * @param {function} [params.onProgress] — Progress callback
   * @returns {{ healedScript: string, changes: Array, analysis: string, confidence: string }}
   */
  async heal({ script, steps, errors, targetUrl, credentials, runResultsDir, artifacts, onProgress }) {
    // ── Try static healing first (fast path, no browser) ──
    if (runResultsDir) {
      try {
        if (onProgress) onProgress({ status: "analyzing", message: "Analyzing failure from screenshot and errors (no browser needed)..." });

        const staticResult = await this.healStatic({
          script, steps, errors, targetUrl, runResultsDir, artifacts, onProgress,
        });

        if (this._cancelled) throw new Error("Cancelled");

        if (staticResult.healedScript && staticResult.confidence !== "low") {
          if (onProgress) onProgress({ status: "done", message: "Healing complete (from error analysis)" });
          return staticResult;
        }

        // Static healing had low confidence — fall through to replay
        if (onProgress) onProgress({
          status: "replaying",
          message: "Need more context — launching browser to inspect the page...",
        });
      } catch (err) {
        if (err.message === "Cancelled") throw err;
        // Static healing failed — fall through to replay
        if (onProgress) onProgress({
          status: "replaying",
          message: "Falling back to browser-based healing...",
        });
      }
    }

    // ── Replay-based healing (full browser) ──
    return this._healWithReplay({ script, steps, errors, targetUrl, credentials, onProgress });
  }

  /**
   * Static healing: analyze errors + screenshot without launching a browser.
   * Makes a single LLM call with multimodal content (text + image).
   */
  async healStatic({ script, steps, errors, targetUrl, runResultsDir, artifacts, onProgress }) {
    const message = this._buildStaticMessage(script, steps, errors, targetUrl, runResultsDir, artifacts);

    const response = await this.llm.chat(
      [{ role: "user", content: message }],
      { system: STATIC_SYSTEM_PROMPT }
    );

    const result = this._parseHealerResponse(response.content);
    return result;
  }

  /**
   * Replay-based healing: launches a browser, replays the test to the failure
   * point, then uses the LLM orchestration loop with live page state.
   */
  async _healWithReplay({ script, steps, errors, targetUrl, credentials, onProgress }) {
    let browser = null;
    let page = null;

    try {
      // Launch browser
      if (onProgress) onProgress({ status: "launching", message: "Launching browser..." });

      const pw = require("playwright");
      const launchOpts = { headless: this.headless };
      if (this.browserChannel) launchOpts.channel = this.browserChannel;
      browser = await pw.chromium.launch(launchOpts);
      this._browser = browser;
      const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
      page = await context.newPage();

      if (this._cancelled) throw new Error("Cancelled");

      // ── Replay successful portion to reach the failure point ──
      const replayResult = await this._replayToFailurePoint({
        page, steps, script, errors, targetUrl, credentials, onProgress,
      });

      if (this._cancelled) throw new Error("Cancelled");

      // Build browser context and orchestrator
      const browserCtx = new BrowserContext(page);
      this._orchestrator = new AgentOrchestrator(this.llm, browserCtx, {
        maxIterations: this.maxIterations,
      });

      // Forward orchestrator events to the progress callback
      if (onProgress) {
        this._orchestrator.on("step", (data) => {
          onProgress({ status: data.status, message: data.message, iteration: data.iteration });
        });
      }

      // Build the initial message with script + errors + replay context
      const initialMessage = this._buildInitialMessage(script, steps, errors, targetUrl, replayResult);

      // Run the orchestration loop
      if (onProgress) onProgress({ status: "analyzing", message: "Analyzing failure at the point where the test broke..." });
      const { finalResponse } = await this._orchestrator.runLoop(SYSTEM_PROMPT, initialMessage);

      // Parse the healer's response
      const result = this._parseHealerResponse(finalResponse);

      if (!result.healedScript) {
        throw new Error("Healer did not produce a patched script. Analysis: " + (result.analysis || "No analysis provided"));
      }

      if (onProgress) onProgress({ status: "done", message: "Healing complete" });

      return result;
    } finally {
      if (browser) {
        try { await browser.close(); } catch {}
        this._browser = null;
      }
    }
  }

  /**
   * Replay the test up to the point of failure so the browser shows
   * the page where things actually broke.
   */
  async _replayToFailurePoint({ page, steps, script, errors, targetUrl, credentials, onProgress }) {
    const replayLog = [];

    // ── Step-based scenario: replay structured steps ──
    if (steps?.length) {
      const failedStepIndex = this._findFailedStepIndex(steps, errors);
      if (onProgress) onProgress({
        status: "replaying",
        message: `Replaying ${failedStepIndex} successful step(s) to reach failure point...`,
      });

      for (let i = 0; i < failedStepIndex; i++) {
        const step = steps[i];
        if (this._cancelled) throw new Error("Cancelled");

        const desc = `${step.action}${step.selector ? " " + step.selector : ""}${step.value ? " = " + step.value : ""}`;
        if (onProgress) onProgress({ status: "replaying", message: `Replaying step ${i + 1}: ${desc}` });

        try {
          await this._executeStep(page, step, targetUrl, credentials);
          replayLog.push({ step: i, action: desc, status: "ok" });
        } catch (err) {
          replayLog.push({ step: i, action: desc, status: "replay_failed", error: err.message });
          if (onProgress) onProgress({
            status: "replaying",
            message: `Replay stopped at step ${i + 1} (${err.message}) — analyzing from here`,
          });
          break;
        }
      }

      return { method: "steps", failedStepIndex, replayLog };
    }

    // ── Script-based scenario: execute real Playwright code directly ──
    if (script) {
      return await this._replayScriptDirectly({ page, script, errors, targetUrl, credentials, onProgress });
    }

    return { method: "none", replayLog };
  }

  /**
   * Extract the test body from a Playwright script, split into individual
   * `await` lines, and execute them one by one using the real page object.
   * Stops at the line that fails (the failure point).
   */
  async _replayScriptDirectly({ page, script, errors, targetUrl, credentials, onProgress }) {
    const replayLog = [];

    // 1. Extract the test body (strip imports, test.use, test() wrapper)
    const body = this._extractTestBody(script);
    if (!body) {
      if (onProgress) onProgress({ status: "replaying", message: "Could not extract test body from script" });
      return { method: "script_direct", replayLog, failedLine: null };
    }

    // 2. Split into individual executable statements
    const statements = this._splitIntoStatements(body);
    if (!statements.length) {
      if (onProgress) onProgress({ status: "replaying", message: "No executable statements found in script" });
      return { method: "script_direct", replayLog, failedLine: null };
    }

    // 3. Find which line failed from error info
    const failIndex = this._findFailingStatementIndex(statements, errors);

    if (onProgress) onProgress({
      status: "replaying",
      message: `Replaying ${failIndex} of ${statements.length} commands to reach failure point...`,
    });

    // Make script-level constants available for replay
    const { expect } = require("@playwright/test");
    const TARGET_URL = targetUrl;
    const CREDENTIALS = credentials || {};

    // 4. Execute statements one by one, stopping before the failure
    for (let i = 0; i < failIndex; i++) {
      if (this._cancelled) throw new Error("Cancelled");

      const stmt = statements[i];
      const desc = stmt.length > 80 ? stmt.substring(0, 77) + "..." : stmt;

      if (onProgress) onProgress({ status: "replaying", message: `[${i + 1}/${failIndex}] ${desc}` });

      try {
        // Execute the actual Playwright code with the live page object
        const fn = new AsyncFunction("page", "mx", "expect", "TARGET_URL", "CREDENTIALS", stmt);
        await fn(page, mx, expect, TARGET_URL, CREDENTIALS);
        replayLog.push({ step: i, action: desc, status: "ok" });
      } catch (err) {
        replayLog.push({ step: i, action: desc, status: "replay_failed", error: err.message });
        if (onProgress) onProgress({
          status: "replaying",
          message: `Replay stopped at line ${i + 1}: ${err.message.substring(0, 100)}`,
        });
        // This is likely where the original failure was — stop here
        return { method: "script_direct", replayLog, failedLine: stmt, failedAtIndex: i, totalStatements: statements.length };
      }
    }

    return { method: "script_direct", replayLog, failedLine: statements[failIndex] || null, failedAtIndex: failIndex, totalStatements: statements.length };
  }

  /**
   * Extract the body of the test() function from a full Playwright script.
   * Strips imports, test.use(), and the test() wrapper.
   */
  _extractTestBody(script) {
    // Remove import/require lines (all patterns that wrapScript strips)
    let cleaned = script
      .replace(/^import\s+\{[^}]*\}\s+from\s+['"][^'"]*['"];\s*$/gm, "")
      .replace(/^import\s+\*\s+as\s+\w+\s+from\s+['"][^'"]*['"];\s*$/gm, "")
      .replace(/^import\s+\w+\s+from\s+['"][^'"]*['"];\s*$/gm, "")
      .replace(/^const\s+\{[^}]*\}\s*=\s*require\s*\([^)]*\);\s*$/gm, "")
      .replace(/^const\s+\w+\s*=\s*require\s*\([^)]*\);\s*$/gm, "")
      // Strip script-level constants added by wrapScript
      .replace(/^const\s+TARGET_URL\s*=\s*.*;\s*$/gm, "")
      .replace(/^const\s+CREDENTIALS\s*=\s*\{[\s\S]*?\}\s*;\s*$/gm, "")
      .trim();

    // Remove test.use() blocks
    cleaned = cleaned.replace(/test\.use\s*\(\s*\{[\s\S]*?\}\s*\)\s*;/g, "").trim();

    // Extract the body inside test('...', async ({ page }) => { ... });
    const testMatch = cleaned.match(/test\s*\(\s*['"][^'"]*['"]\s*,\s*async\s*\(\s*\{\s*page\s*\}\s*\)\s*=>\s*\{([\s\S]*)\}\s*\)\s*;?\s*$/);
    if (testMatch) {
      return testMatch[1].trim();
    }

    // Fallback: if no test() wrapper, the whole thing might be bare code
    // Check if it has await page.* lines
    if (/await\s+page\./.test(cleaned)) {
      return cleaned;
    }

    return null;
  }

  /**
   * Split a test body into individual executable statements.
   * Handles multi-line statements (e.g. waitForFunction with callbacks).
   */
  _splitIntoStatements(body) {
    const statements = [];
    const lines = body.split("\n");
    let current = "";
    let braceDepth = 0;
    let parenDepth = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

      current += (current ? "\n" : "") + trimmed;

      // Track braces and parentheses to handle multi-line statements
      for (const ch of trimmed) {
        if (ch === "{") braceDepth++;
        else if (ch === "}") braceDepth--;
        else if (ch === "(") parenDepth++;
        else if (ch === ")") parenDepth--;
      }

      // Statement is complete when braces and parens are balanced and line ends with ; or )
      if (braceDepth <= 0 && parenDepth <= 0 && (trimmed.endsWith(";") || trimmed.endsWith(")"))) {
        const stmt = current.trim();
        // Only include executable statements (await, const with await, variable assignments)
        if (stmt.startsWith("await ") || (stmt.startsWith("const ") && stmt.includes("await "))) {
          statements.push(stmt);
        }
        current = "";
        braceDepth = 0;
        parenDepth = 0;
      }
    }

    // Handle any remaining statement
    if (current.trim()) {
      const stmt = current.trim();
      if (stmt.startsWith("await ") || (stmt.startsWith("const ") && stmt.includes("await "))) {
        statements.push(stmt);
      }
    }

    return statements;
  }

  /**
   * Find which statement index failed based on error messages.
   * Returns the index to stop BEFORE (i.e., replay statements 0..index-1).
   */
  _findFailingStatementIndex(statements, errors) {
    if (!errors?.length) return Math.max(0, statements.length - 1);

    for (const err of errors) {
      const msg = err.message || "";
      const snippet = err.snippet || "";
      const combined = msg + "\n" + snippet;

      // Try to match the error to a specific statement
      for (let i = 0; i < statements.length; i++) {
        const stmt = statements[i];

        // Check if the error snippet contains this statement's key parts
        // Extract selectors/role names from the statement
        const roleMatch = stmt.match(/getByRole\s*\(\s*['"](\w+)['"]\s*,\s*\{\s*name:\s*['"]([^'"]+)['"]/);
        const labelMatch = stmt.match(/getByLabel\s*\(\s*['"]([^'"]+)['"]/);
        const textMatch = stmt.match(/getByText\s*\(\s*['"]([^'"]+)['"]/);
        const locatorMatch = stmt.match(/locator\s*\(\s*['"]([^'"]+)['"]/);

        // Check if the error references this locator
        if (roleMatch && combined.includes(roleMatch[2])) {
          // Verify it's the right one by checking if the action also matches
          if (combined.includes(roleMatch[1]) || combined.includes("getByRole")) {
            return i;
          }
        }
        if (labelMatch && combined.includes(labelMatch[1])) return i;
        if (textMatch && combined.includes(textMatch[1])) return i;
        if (locatorMatch && combined.includes(locatorMatch[1])) return i;

        // Check if the error snippet literally contains this statement
        if (snippet && stmt.includes(snippet.trim())) return i;
      }

      // Try matching by line number from the error snippet
      // Playwright errors often show "> 42 |   await page.getByRole..."
      const lineMatch = snippet.match(/>\s*(\d+)\s*\|/);
      if (lineMatch) {
        // We can't map script line numbers to statement indices directly,
        // but the content after the line number should match
        const errorLine = snippet.match(/>\s*\d+\s*\|\s*(.*)/);
        if (errorLine) {
          const errorContent = errorLine[1].trim();
          for (let i = 0; i < statements.length; i++) {
            if (statements[i].includes(errorContent) || errorContent.includes(statements[i].substring(0, 40))) {
              return i;
            }
          }
        }
      }
    }

    // Default: replay all but the last few statements
    return Math.max(0, statements.length - 1);
  }

  /**
   * Find which step index failed based on error messages (for step-based scenarios).
   */
  _findFailedStepIndex(steps, errors) {
    if (!errors?.length) return steps.length;

    for (const err of errors) {
      const msg = (err.message || "") + (err.snippet || "");
      const match = msg.match(/ZONIQ_STEP:FAIL:(\d+)/);
      if (match) return parseInt(match[1], 10);
    }

    for (const err of errors) {
      const msg = (err.message || "").toLowerCase();
      for (let i = steps.length - 1; i >= 0; i--) {
        const step = steps[i];
        const sel = (step.selector || "").replace(/^mx:/, "").toLowerCase();
        if (sel && msg.includes(sel)) return i;
        if (step.value && msg.includes(step.value.toLowerCase())) return i;
      }
    }

    return Math.max(0, steps.length - 1);
  }

  /**
   * Execute a single structured step using mendix-helpers.
   */
  async _executeStep(page, step, targetUrl, credentials) {
    const widget = (sel) => String(sel || "").replace(/^mx:/, "");

    switch (step.action) {
      case "Navigate":
        await page.goto(step.value || targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await mx.waitForMendix(page);
        break;
      case "Login":
        await mx.login(page, targetUrl, credentials?.username, credentials?.password);
        break;
      case "Click":
        if (step.selector?.startsWith("mx:")) {
          await mx.clickWidget(page, widget(step.selector));
        } else {
          await mx.resolveLocator(page, step.selector).click({ timeout: 15000 });
        }
        await mx.waitForMendix(page, { timeout: 5000 }).catch(() => {});
        break;
      case "Fill":
        if (step.selector?.startsWith("mx:")) {
          await mx.fillWidget(page, widget(step.selector), step.value || "");
        } else {
          await mx.resolveLocator(page, step.selector).fill(step.value || "", { timeout: 15000 });
        }
        break;
      case "SelectDropdown":
        await mx.selectDropdown(page, widget(step.selector), step.value || "");
        break;
      case "Wait":
        await page.waitForTimeout(Math.min(parseInt(step.value, 10) || 1000, 10000));
        break;
      case "WaitForMendix":
        await mx.waitForMendix(page);
        break;
      case "WaitForPopup":
        await mx.waitForPopup(page);
        break;
      case "ClosePopup":
        await mx.closePopup(page);
        break;
      case "WaitForMicroflow":
        await mx.waitForMicroflow(page);
        break;
      case "AssertText":
      case "AssertVisible":
      case "Screenshot":
        break;
      default:
        break;
    }
  }

  /**
   * Build a multimodal message for static healing (text + optional screenshot).
   * Returns an Anthropic-style content array that works with both providers.
   */
  _buildStaticMessage(script, steps, errors, targetUrl, runResultsDir, artifacts) {
    const textParts = [];

    textParts.push("# Failing Test — Please Heal (from error analysis)\n");
    textParts.push(`Target URL: ${targetUrl}\n`);

    textParts.push("## Original Script\n```javascript");
    textParts.push(script);
    textParts.push("```\n");

    if (steps?.length) {
      textParts.push("## Test Steps");
      steps.forEach((s, i) => {
        textParts.push(`${i + 1}. ${s.action}${s.selector ? " " + s.selector : ""}${s.value ? " = " + s.value : ""}`);
      });
      textParts.push("");
    }

    textParts.push("## Error Messages from Failed Run\n");
    if (errors?.length) {
      for (const err of errors) {
        textParts.push(`### ${err.test || "Test"}`);
        textParts.push("```");
        textParts.push(err.message || "No error message");
        textParts.push("```");
        if (err.snippet) {
          textParts.push("Code context:");
          textParts.push("```javascript");
          textParts.push(err.snippet);
          textParts.push("```");
        }
        textParts.push("");
      }
    } else {
      textParts.push("No specific error messages available.\n");
    }

    textParts.push("Please analyze the errors and the screenshot (if provided) and produce a healed script.");
    textParts.push("If you cannot confidently determine the fix without seeing the live page, set confidence to \"low\".");

    const content = [];
    content.push({ type: "text", text: textParts.join("\n") });

    // Find and attach the failure screenshot
    if (runResultsDir) {
      const screenshotFile = this._findScreenshot(runResultsDir, artifacts);
      if (screenshotFile) {
        try {
          const imageData = fs.readFileSync(screenshotFile);
          const base64 = imageData.toString("base64");
          const ext = path.extname(screenshotFile).toLowerCase();
          const mediaType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
          content.push({
            type: "image",
            source: { type: "base64", media_type: mediaType, data: base64 },
          });
        } catch {}
      }
    }

    return content;
  }

  /**
   * Find the best failure screenshot in the results directory.
   */
  _findScreenshot(runResultsDir, artifacts) {
    // Prefer screenshots listed in artifacts
    if (artifacts?.length) {
      const screenshotArtifact = artifacts.find((a) => /\.(png|jpg|jpeg)$/i.test(a));
      if (screenshotArtifact) {
        const fullPath = path.join(runResultsDir, screenshotArtifact);
        if (fs.existsSync(fullPath)) return fullPath;
      }
    }

    // Fallback: look for any PNG/JPG in the results dir
    try {
      const files = fs.readdirSync(runResultsDir);
      const screenshot = files.find((f) => /\.(png|jpg|jpeg)$/i.test(f));
      if (screenshot) return path.join(runResultsDir, screenshot);
    } catch {}

    return null;
  }

  _buildInitialMessage(script, steps, errors, targetUrl, replayResult) {
    const lines = [];

    lines.push("# Failing Test — Please Heal\n");
    lines.push(`Target URL: ${targetUrl}\n`);

    lines.push("## Original Script\n```javascript");
    lines.push(script);
    lines.push("```\n");

    if (steps?.length) {
      lines.push("## Test Steps");
      steps.forEach((s, i) => {
        lines.push(`${i + 1}. ${s.action}${s.selector ? " " + s.selector : ""}${s.value ? " = " + s.value : ""}`);
      });
      lines.push("");
    }

    lines.push("## Error Messages from Failed Run\n");
    if (errors?.length) {
      for (const err of errors) {
        lines.push(`### ${err.test || "Test"}`);
        lines.push("```");
        lines.push(err.message || "No error message");
        lines.push("```");
        if (err.snippet) {
          lines.push("Code context:");
          lines.push("```javascript");
          lines.push(err.snippet);
          lines.push("```");
        }
        lines.push("");
      }
    } else {
      lines.push("No specific error messages available. The test failed with an unknown error.\n");
    }

    // Add replay context
    if (replayResult?.replayLog?.length) {
      lines.push("## Replay Status");
      lines.push("I replayed the successful commands of the test to reach the failure point.");
      lines.push("The browser is now showing the page where the test FAILED.\n");
      for (const entry of replayResult.replayLog) {
        const icon = entry.status === "ok" ? "PASS" : "STOP";
        lines.push(`- [${icon}] ${entry.action}${entry.error ? " — " + entry.error : ""}`);
      }
      if (replayResult.failedLine) {
        lines.push(`\n**Failing command:** \`${replayResult.failedLine.substring(0, 200)}\``);
      }
      if (replayResult.failedAtIndex != null && replayResult.totalStatements != null) {
        lines.push(`\nFailed at command ${replayResult.failedAtIndex + 1} of ${replayResult.totalStatements}. The page state below reflects the app at that point.`);
      }
      lines.push("");
    }

    lines.push("Please analyze the errors, compare with the current page state below, and produce a healed script.");

    return lines.join("\n");
  }

  _parseHealerResponse(response) {
    // 1. Try to find a ```json code block specifically
    const jsonMatch = response.match(/```json\s*\n?([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1].trim());
        return {
          healedScript: parsed.healed_script || parsed.healedScript || null,
          changes: parsed.changes || [],
          analysis: parsed.analysis || "",
          confidence: parsed.confidence || "medium",
        };
      } catch {}
    }

    // 2. Fallback: look for a ```javascript or ```js code block (but NOT ```json)
    const scriptMatch = response.match(/```(?:javascript|js(?!on))\s*\n?([\s\S]*?)```/);
    if (scriptMatch) {
      return {
        healedScript: scriptMatch[1].trim(),
        changes: [],
        analysis: response.split("```")[0].trim(),
        confidence: "low",
      };
    }

    // 3. Last resort: bare ``` code block (no language tag)
    const bareMatch = response.match(/```\s*\n([\s\S]*?)```/);
    if (bareMatch) {
      const content = bareMatch[1].trim();
      try {
        const parsed = JSON.parse(content);
        return {
          healedScript: parsed.healed_script || parsed.healedScript || null,
          changes: parsed.changes || [],
          analysis: parsed.analysis || "",
          confidence: parsed.confidence || "medium",
        };
      } catch {}
      return {
        healedScript: content,
        changes: [],
        analysis: response.split("```")[0].trim(),
        confidence: "low",
      };
    }

    return {
      healedScript: null,
      changes: [],
      analysis: response,
      confidence: "low",
    };
  }
}

module.exports = { HealerAgent };
