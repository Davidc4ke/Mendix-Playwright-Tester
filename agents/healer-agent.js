/**
 * healer-agent.js — Self-healing agent for failing Playwright tests
 *
 * Analyzes a failing test by comparing its errors with the current DOM state,
 * then produces a patched script that fixes the failure.
 */

const fs = require("fs");
const path = require("path");
const { AgentOrchestrator } = require("./orchestrator");
const { BrowserContext } = require("./browser-context");

const SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, "prompts", "healer-system.md"),
  "utf-8"
);

class HealerAgent {
  constructor(llmClient, options = {}) {
    this.llm = llmClient;
    this.maxIterations = options.maxIterations || 10;
    this.headless = options.headless ?? false;
    this.browserChannel = options.browserChannel || null; // e.g. "msedge", "chrome", or null for bundled Chromium
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
   * @param {Array}  params.errors — Error objects from the failed run [{ test, message, snippet }]
   * @param {string} params.targetUrl — The app URL
   * @param {object} [params.credentials] — { username, password }
   * @param {function} [params.onProgress] — Progress callback
   * @returns {{ healedScript: string, changes: Array, analysis: string, confidence: string }}
   */
  async heal({ script, errors, targetUrl, credentials, onProgress }) {
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

      const mx = require(path.resolve(__dirname, "..", "helpers", "mendix-helpers"));
      await mx.waitForMendix(page);

      // Login if credentials provided
      if (credentials?.username) {
        if (onProgress) onProgress({ status: "logging_in", message: "Logging in..." });
        await mx.login(page, targetUrl, credentials.username, credentials.password);
      }

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

      // Build the initial message with script + errors
      const initialMessage = this._buildInitialMessage(script, errors, targetUrl);

      // Run the orchestration loop
      if (onProgress) onProgress({ status: "analyzing", message: "Analyzing failure and current page state..." });
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

  _buildInitialMessage(script, errors, targetUrl) {
    const lines = [];

    lines.push("# Failing Test — Please Heal\n");
    lines.push(`Target URL: ${targetUrl}\n`);

    lines.push("## Original Script\n```javascript");
    lines.push(script);
    lines.push("```\n");

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
