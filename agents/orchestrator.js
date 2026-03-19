/**
 * orchestrator.js — Base agent orchestration loop
 *
 * Shared by all agent types (Planner, Generator, Healer).
 * Manages the LLM ↔ Browser conversation loop with progress events.
 */

const EventEmitter = require("events");

class AgentOrchestrator extends EventEmitter {
  constructor(llmClient, browserContext, options = {}) {
    super();
    this.llm = llmClient;
    this.browserCtx = browserContext;
    this.maxIterations = options.maxIterations || 20;
    this.cancelled = false;
  }

  cancel() {
    this.cancelled = true;
  }

  /**
   * Run the orchestration loop.
   *
   * @param {string} systemPrompt — System message for the LLM
   * @param {string} initialMessage — First user message to kick off the loop
   * @returns {{ messages: Array, finalResponse: string }}
   */
  async runLoop(systemPrompt, initialMessage) {
    const messages = [];
    let finalResponse = "";

    // Send initial message with page state
    const pageState = await this.browserCtx.getPageStateText();
    messages.push({
      role: "user",
      content: `${initialMessage}\n\n---\n\n${pageState}`,
    });

    for (let i = 0; i < this.maxIterations; i++) {
      if (this.cancelled) {
        this.emit("step", { iteration: i, status: "cancelled", message: "Agent cancelled by user" });
        break;
      }

      this.emit("step", { iteration: i, status: "thinking", message: "LLM is thinking..." });

      // Ask LLM
      const response = await this.llm.chat(messages, { system: systemPrompt });
      const content = response.content;
      messages.push({ role: "assistant", content });

      // Parse actions from LLM response
      const actions = this._parseActions(content);

      // If no actions found, the LLM is providing a final response
      if (actions.length === 0) {
        finalResponse = content;
        this.emit("step", { iteration: i, status: "done", message: "Agent completed" });
        break;
      }

      // Check for "done" action
      const doneAction = actions.find((a) => a.action === "done");
      if (doneAction) {
        finalResponse = doneAction.summary || content;
        this.emit("step", { iteration: i, status: "done", message: doneAction.summary || "Agent completed" });
        break;
      }

      // Execute each action
      const actionResults = [];
      for (const action of actions) {
        this.emit("step", {
          iteration: i,
          status: "acting",
          message: this._describeAction(action),
          action,
        });

        const result = await this.browserCtx.executeAction(action);
        actionResults.push({ action, result });

        if (!result.success) {
          this.emit("step", {
            iteration: i,
            status: "error",
            message: `Action failed: ${result.error}`,
            action,
          });
        }
      }

      // Get updated page state after actions
      const newPageState = await this.browserCtx.getPageStateText();

      // Build feedback message for LLM
      const feedback = this._buildFeedback(actionResults, newPageState);
      messages.push({ role: "user", content: feedback });
    }

    return { messages, finalResponse };
  }

  /**
   * Parse action JSON blocks from LLM response.
   * LLM should return actions in ```json code blocks or as inline JSON arrays.
   */
  _parseActions(content) {
    const actions = [];

    // Try to find JSON code blocks first
    const codeBlockRegex = /```(?:json)?\s*\n?([\s\S]*?)```/g;
    let match;
    while ((match = codeBlockRegex.exec(content)) !== null) {
      try {
        const parsed = JSON.parse(match[1].trim());
        if (Array.isArray(parsed)) {
          actions.push(...parsed);
        } else if (parsed.action) {
          actions.push(parsed);
        }
      } catch {
        // Not valid JSON — ignore this code block
      }
    }

    // If no code blocks found, try to find inline JSON objects
    if (actions.length === 0) {
      const inlineRegex = /\{[^{}]*"action"\s*:\s*"[^"]+?"[^{}]*\}/g;
      while ((match = inlineRegex.exec(content)) !== null) {
        try {
          actions.push(JSON.parse(match[0]));
        } catch {}
      }
    }

    return actions;
  }

  _buildFeedback(actionResults, pageState) {
    const lines = ["## Action Results\n"];
    for (const { action, result } of actionResults) {
      if (result.success) {
        lines.push(`- ${this._describeAction(action)}: OK`);
      } else {
        lines.push(`- ${this._describeAction(action)}: FAILED — ${result.error}`);
      }
    }
    lines.push(`\n---\n\n${pageState}`);
    return lines.join("\n");
  }

  _describeAction(action) {
    switch (action.action) {
      case "click":
        return `Click ${action.widget || action.selector || "?"}`;
      case "fill":
        return `Fill ${action.widget || action.selector || "?"} with "${(action.value || "").substring(0, 30)}"`;
      case "select":
        return `Select "${action.value}" in ${action.widget || "?"}`;
      case "navigate":
        return `Navigate to ${action.url || action.value || "?"}`;
      case "login":
        return `Login as ${action.username || "?"}`;
      case "waitForMendix":
        return `Wait for Mendix to load`;
      case "scroll":
        return `Scroll ${action.direction || "down"}`;
      case "wait":
        return `Wait ${action.ms || 1000}ms`;
      case "done":
        return `Done`;
      default:
        return `${action.action}`;
    }
  }
}

module.exports = { AgentOrchestrator };
