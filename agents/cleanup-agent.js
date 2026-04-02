/**
 * cleanup-agent.js — AI-powered script cleanup for recorded Playwright tests
 *
 * Single LLM call (no browser needed) that analyzes a recorded script and
 * removes semantic redundancies that rule-based cleanup can't detect:
 * wrong-then-correct sequences, navigation detours with intervening actions,
 * exploratory interactions, etc.
 */

const fs = require("fs");
const path = require("path");

let _SYSTEM_PROMPT = null;
function getSystemPrompt() {
  if (!_SYSTEM_PROMPT) _SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, "prompts", "cleanup-system.md"), "utf-8");
  return _SYSTEM_PROMPT;
}

class CleanupAgent {
  constructor(llmClient) {
    this.llm = llmClient;
  }

  /**
   * Run AI cleanup on a script.
   *
   * @param {object} params
   * @param {string} params.script — The script to clean (already rule-cleaned)
   * @param {Array}  [params.ruleChanges] — Changes already applied by rule-based cleanup
   * @param {function} [params.onProgress] — Progress callback
   * @returns {{ cleanedScript: string, changes: Array, analysis: string }}
   */
  async cleanup({ script, ruleChanges, onProgress }) {
    if (onProgress) onProgress({ status: "analyzing", message: "Sending script to AI for semantic cleanup..." });

    const userMessage = this._buildMessage(script, ruleChanges);

    const response = await this.llm.chat(
      [{ role: "user", content: userMessage }],
      { system: getSystemPrompt() }
    );

    const result = this._parseResponse(response.content);

    if (onProgress) onProgress({ status: "done", message: "AI cleanup complete" });

    return result;
  }

  _buildMessage(script, ruleChanges) {
    let message = `## Script to Clean\n\n\`\`\`javascript\n${script}\n\`\`\`\n`;

    if (ruleChanges && ruleChanges.length > 0) {
      message += `\n## Already Removed by Rules\n\nThe following redundancies were already removed by rule-based cleanup:\n\n`;
      for (const change of ruleChanges) {
        message += `- **${change.reason}**: \`${change.original.slice(0, 80)}\`\n`;
      }
      message += `\nFocus on semantic issues that rules cannot catch.\n`;
    }

    return message;
  }

  _parseResponse(response) {
    // Try ```json block
    const jsonMatch = response.match(/```json\s*\n?([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1].trim());
        return {
          cleanedScript: parsed.cleaned_script || parsed.cleanedScript || null,
          changes: parsed.changes || [],
          analysis: parsed.analysis || "",
        };
      } catch { /* fall through */ }
    }

    // Fallback: ```javascript block
    const scriptMatch = response.match(/```(?:javascript|js(?!on))\s*\n?([\s\S]*?)```/);
    if (scriptMatch) {
      return {
        cleanedScript: scriptMatch[1].trim(),
        changes: [],
        analysis: response.split("```")[0].trim(),
      };
    }

    // Last resort: bare ``` block
    const bareMatch = response.match(/```\s*\n([\s\S]*?)```/);
    if (bareMatch) {
      const content = bareMatch[1].trim();
      try {
        const parsed = JSON.parse(content);
        return {
          cleanedScript: parsed.cleaned_script || parsed.cleanedScript || null,
          changes: parsed.changes || [],
          analysis: parsed.analysis || "",
        };
      } catch { /* not JSON */ }
      return {
        cleanedScript: content,
        changes: [],
        analysis: response.split("```")[0].trim(),
      };
    }

    return {
      cleanedScript: null,
      changes: [],
      analysis: response,
    };
  }
}

module.exports = { CleanupAgent };
