/**
 * healer-agent.js — Self-healing agent for failing Playwright tests
 *
 * Analyzes a failing test by comparing its errors with the current DOM state,
 * then produces a patched script that fixes the failure.
 *
 * Key behavior: replays the successful portion of the test so the browser
 * is at the POINT OF FAILURE when the LLM analyzes the page state.
 */

const fs = require("fs");
const path = require("path");
const { AgentOrchestrator } = require("./orchestrator");
const { BrowserContext } = require("./browser-context");

const SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, "prompts", "healer-system.md"),
  "utf-8"
);

const mx = require(path.resolve(__dirname, "..", "helpers", "mendix-helpers"));

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
   * Heal a failing test.
   *
   * @param {object} params
   * @param {string} params.script — The original test script
   * @param {Array}  [params.steps] — Structured steps (if step-based scenario)
   * @param {Array}  params.errors — Error objects from the failed run [{ test, message, snippet }]
   * @param {string} params.targetUrl — The app URL
   * @param {object} [params.credentials] — { username, password }
   * @param {function} [params.onProgress] — Progress callback
   * @returns {{ healedScript: string, changes: Array, analysis: string, confidence: string }}
   */
  async heal({ script, steps, errors, targetUrl, credentials, onProgress }) {
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

      // Navigate to the app
      if (onProgress) onProgress({ status: "navigating", message: `Navigating to ${targetUrl}...` });
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
      await mx.waitForMendix(page);

      // Login if credentials provided
      if (credentials?.username) {
        if (onProgress) onProgress({ status: "logging_in", message: "Logging in..." });
        await mx.login(page, targetUrl, credentials.username, credentials.password);
      }

      if (this._cancelled) throw new Error("Cancelled");

      // ── Replay successful steps to reach the failure point ──
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
          // If a "successful" step fails during replay, stop here — this is close enough
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

    // ── Script-based scenario: parse and replay executable lines ──
    if (script) {
      const commands = this._parseScriptCommands(script);
      const failingLine = this._findFailingLine(errors);

      // Determine how many commands to replay
      let replayCount = commands.length; // replay all by default
      if (failingLine) {
        // Find the command index that matches the failing line
        for (let i = 0; i < commands.length; i++) {
          if (commands[i].code.includes(failingLine) || failingLine.includes(commands[i].code.trim())) {
            replayCount = i; // stop BEFORE the failing command
            break;
          }
        }
      }

      if (replayCount > 0) {
        if (onProgress) onProgress({
          status: "replaying",
          message: `Replaying ${replayCount} command(s) from script to reach failure point...`,
        });

        for (let i = 0; i < replayCount; i++) {
          const cmd = commands[i];
          if (this._cancelled) throw new Error("Cancelled");

          if (onProgress) onProgress({ status: "replaying", message: `Replaying: ${cmd.description}` });

          try {
            await this._executeScriptCommand(page, cmd, targetUrl, credentials);
            replayLog.push({ step: i, action: cmd.description, status: "ok" });
          } catch (err) {
            replayLog.push({ step: i, action: cmd.description, status: "replay_failed", error: err.message });
            if (onProgress) onProgress({
              status: "replaying",
              message: `Replay stopped at command ${i + 1} (${err.message}) — analyzing from here`,
            });
            break;
          }
        }
      }

      return { method: "script", replayCount, replayLog };
    }

    return { method: "none", replayLog };
  }

  /**
   * Find which step index failed based on error messages.
   */
  _findFailedStepIndex(steps, errors) {
    if (!errors?.length) return steps.length;

    // Look for ZONIQ_STEP markers in error messages
    for (const err of errors) {
      const msg = (err.message || "") + (err.snippet || "");
      const match = msg.match(/ZONIQ_STEP:FAIL:(\d+)/);
      if (match) return parseInt(match[1], 10);
    }

    // Try to match error content against step selectors/values
    for (const err of errors) {
      const msg = (err.message || "").toLowerCase();
      for (let i = steps.length - 1; i >= 0; i--) {
        const step = steps[i];
        const sel = (step.selector || "").replace(/^mx:/, "").toLowerCase();
        if (sel && msg.includes(sel)) return i;
        if (step.value && msg.includes(step.value.toLowerCase())) return i;
      }
    }

    // Default: replay all but the last step
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
          await page.click(step.selector, { timeout: 15000 });
        }
        await mx.waitForMendix(page, { timeout: 5000 }).catch(() => {});
        break;
      case "Fill":
        if (step.selector?.startsWith("mx:")) {
          await mx.fillWidget(page, widget(step.selector), step.value || "");
        } else {
          await page.fill(step.selector, step.value || "", { timeout: 15000 });
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
        // Skip assertions and screenshots during replay — they don't navigate
        break;
      default:
        break;
    }
  }

  /**
   * Parse a Playwright script into individual executable commands.
   * Extracts lines that look like `await page.xxx()` or `await mx.xxx()`.
   */
  _parseScriptCommands(script) {
    const commands = [];
    const lines = script.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      // Match: await page.goto(...), await page.click(...), await mx.xxx(...)
      const match = trimmed.match(/^await\s+(page\.\w+|mx\.\w+)\s*\(/);
      if (!match) continue;

      // Skip lines inside test() wrapper, imports, variable declarations
      if (trimmed.startsWith("const ") || trimmed.startsWith("import ") || trimmed.startsWith("test(")) continue;

      const fn = match[1];
      let description = fn;

      // Extract a readable description
      if (fn === "page.goto") {
        const urlMatch = trimmed.match(/page\.goto\s*\(\s*['"]([^'"]+)['"]/);
        description = urlMatch ? `Navigate to ${urlMatch[1]}` : "Navigate";
      } else if (fn === "page.click") {
        const selMatch = trimmed.match(/page\.click\s*\(\s*['"]([^'"]+)['"]/);
        description = selMatch ? `Click ${selMatch[1]}` : "Click";
      } else if (fn === "page.fill") {
        const fillMatch = trimmed.match(/page\.fill\s*\(\s*['"]([^'"]+)['"]/);
        description = fillMatch ? `Fill ${fillMatch[1]}` : "Fill";
      } else if (fn.startsWith("mx.")) {
        description = fn.replace("mx.", "Mendix: ");
        const argMatch = trimmed.match(/\(\s*page\s*,\s*['"]([^'"]+)['"]/);
        if (argMatch) description += ` ${argMatch[1]}`;
      }

      commands.push({ code: trimmed, fn, description });
    }

    return commands;
  }

  /**
   * Try to identify the failing line/command from error messages.
   */
  _findFailingLine(errors) {
    if (!errors?.length) return null;

    for (const err of errors) {
      // The snippet often contains the failing line with a pointer
      if (err.snippet) {
        // Look for the line with ">" marker in Playwright error snippets
        const lines = err.snippet.split("\n");
        for (const line of lines) {
          const match = line.match(/>\s*\d+\s*\|\s*(.*)/);
          if (match) return match[1].trim();
        }
      }

      // Try to extract selector/widget name from error message
      const msg = err.message || "";
      const selectorMatch = msg.match(/locator\s*\(\s*['"]([^'"]+)['"]\)/);
      if (selectorMatch) return selectorMatch[1];
    }

    return null;
  }

  /**
   * Execute a parsed script command on the page.
   */
  async _executeScriptCommand(page, cmd, targetUrl, credentials) {
    const { fn, code } = cmd;

    // page.goto
    if (fn === "page.goto") {
      const urlMatch = code.match(/page\.goto\s*\(\s*['"]([^'"]+)['"]/);
      // Handle TARGET_URL variable reference
      const urlRefMatch = code.match(/page\.goto\s*\(\s*TARGET_URL/);
      const url = urlMatch ? urlMatch[1] : (urlRefMatch ? targetUrl : targetUrl);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await mx.waitForMendix(page);
      return;
    }

    // page.click
    if (fn === "page.click") {
      const selMatch = code.match(/page\.click\s*\(\s*['"]([^'"]+)['"]/);
      if (selMatch) {
        await page.click(selMatch[1], { timeout: 15000 });
        await mx.waitForMendix(page, { timeout: 5000 }).catch(() => {});
      }
      return;
    }

    // page.fill
    if (fn === "page.fill") {
      const fillMatch = code.match(/page\.fill\s*\(\s*['"]([^'"]+)['"],\s*['"]([^'"]*)['"]/);
      if (fillMatch) {
        await page.fill(fillMatch[1], fillMatch[2], { timeout: 15000 });
      }
      return;
    }

    // mx.login
    if (fn === "mx.login") {
      await mx.login(page, targetUrl, credentials?.username, credentials?.password);
      return;
    }

    // mx.clickWidget
    if (fn === "mx.clickWidget") {
      const argMatch = code.match(/mx\.clickWidget\s*\(\s*page\s*,\s*['"]([^'"]+)['"]/);
      if (argMatch) {
        await mx.clickWidget(page, argMatch[1]);
        await mx.waitForMendix(page, { timeout: 5000 }).catch(() => {});
      }
      return;
    }

    // mx.fillWidget
    if (fn === "mx.fillWidget") {
      const argMatch = code.match(/mx\.fillWidget\s*\(\s*page\s*,\s*['"]([^'"]+)['"],\s*['"]([^'"]*)['"]/);
      if (argMatch) {
        await mx.fillWidget(page, argMatch[1], argMatch[2]);
      }
      return;
    }

    // mx.selectDropdown
    if (fn === "mx.selectDropdown") {
      const argMatch = code.match(/mx\.selectDropdown\s*\(\s*page\s*,\s*['"]([^'"]+)['"],\s*['"]([^'"]*)['"]/);
      if (argMatch) {
        await mx.selectDropdown(page, argMatch[1], argMatch[2]);
      }
      return;
    }

    // mx.waitForMendix
    if (fn === "mx.waitForMendix") {
      await mx.waitForMendix(page);
      return;
    }

    // mx.waitForPopup
    if (fn === "mx.waitForPopup") {
      await mx.waitForPopup(page);
      return;
    }

    // mx.closePopup
    if (fn === "mx.closePopup") {
      await mx.closePopup(page);
      return;
    }

    // mx.waitForMicroflow
    if (fn === "mx.waitForMicroflow") {
      await mx.waitForMicroflow(page);
      return;
    }

    // page.waitForTimeout
    if (fn === "page.waitForTimeout") {
      const msMatch = code.match(/waitForTimeout\s*\(\s*(\d+)/);
      if (msMatch) await page.waitForTimeout(Math.min(parseInt(msMatch[1]), 10000));
      return;
    }

    // Skip assertions, screenshots, expects — they don't navigate
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

    // Add replay context so the LLM knows what page it's looking at
    if (replayResult?.replayLog?.length) {
      lines.push("## Replay Status");
      lines.push("I replayed the successful steps of the test to reach the failure point.");
      lines.push("The browser is now showing the page where the test FAILED.\n");
      for (const entry of replayResult.replayLog) {
        const icon = entry.status === "ok" ? "PASS" : "STOP";
        lines.push(`- [${icon}] Step ${entry.step + 1}: ${entry.action}${entry.error ? " — " + entry.error : ""}`);
      }
      if (replayResult.failedStepIndex != null) {
        lines.push(`\nThe test failed at step ${replayResult.failedStepIndex + 1}. The page state below reflects the app at that point.`);
      }
      lines.push("");
    }

    lines.push("Please analyze the errors, compare with the current page state below, and produce a healed script.");

    return lines.join("\n");
  }

  _parseHealerResponse(response) {
    // Try to extract JSON from the response
    const jsonMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
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

    // Fallback: try to find a script in the response
    const scriptMatch = response.match(/```(?:javascript|js)?\s*\n?([\s\S]*?)```/);
    if (scriptMatch) {
      return {
        healedScript: scriptMatch[1].trim(),
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
