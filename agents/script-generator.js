/**
 * script-generator.js — AI-powered test script generator
 *
 * Generates Playwright test scripts from natural language descriptions
 * using the app's element database for context.
 */

const fs = require("fs");
const path = require("path");
const ElementDB = require("../lib/element-db");

const SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, "prompts", "generator-system.md"),
  "utf-8"
);

class ScriptGenerator {
  constructor(llmClient) {
    this.llm = llmClient;
  }

  /**
   * Generate a Playwright test script from a natural language description.
   *
   * @param {object} params
   * @param {string} params.appName — Name of the target app
   * @param {string} params.baseUrl — Base URL of the app
   * @param {object} params.elementDB — Element database for the app
   * @param {string[]} params.existingScripts — Example scripts from the same app
   * @param {string} params.description — Natural language test description
   * @param {object} [params.credentials] — { username, password }
   * @returns {{ script: string, explanation: string }}
   */
  async generate({ appName, baseUrl, elementDB, existingScripts, description, credentials }) {
    const userMessage = this._buildUserMessage({
      appName, baseUrl, elementDB, existingScripts, description, credentials,
    });

    const response = await this.llm.chat(
      [{ role: "user", content: userMessage }],
      { system: SYSTEM_PROMPT }
    );

    return this._parseResponse(response.content, description);
  }

  _buildUserMessage({ appName, baseUrl, elementDB, existingScripts, description, credentials }) {
    const lines = [];

    lines.push(`# Generate a Test Script\n`);
    lines.push(`**Application:** ${appName}`);
    lines.push(`**URL:** ${baseUrl}`);
    if (credentials?.username) {
      lines.push(`**Credentials available:** username="${credentials.username}"\n`);
    }
    lines.push('');

    // Element database
    const elementText = ElementDB.formatElementDBForLLM(elementDB);
    lines.push(elementText);
    lines.push('');

    // Example scripts for style reference
    if (existingScripts?.length) {
      lines.push(`## Example Scripts from This App\n`);
      lines.push(`Use these as style references for how tests are written for this app:\n`);
      for (let i = 0; i < Math.min(existingScripts.length, 2); i++) {
        const script = existingScripts[i];
        // Truncate long scripts
        const trimmed = script.length > 2000 ? script.substring(0, 2000) + '\n// ... (truncated)' : script;
        lines.push(`### Example ${i + 1}\n\`\`\`javascript`);
        lines.push(trimmed);
        lines.push('```\n');
      }
    }

    // The request
    lines.push(`## Test Description\n`);
    lines.push(description);
    lines.push('');
    lines.push('Generate the test body code. Use the known widget names from the element database above.');

    return lines.join('\n');
  }

  _parseResponse(content, description) {
    // Extract JavaScript code block
    const jsMatch = content.match(/```(?:javascript|js)?\s*\n?([\s\S]*?)```/);
    const script = jsMatch ? jsMatch[1].trim() : content.trim();

    // Extract explanation (text before the code block)
    let explanation = '';
    const codeStart = content.indexOf('```');
    if (codeStart > 0) {
      explanation = content.substring(0, codeStart).trim();
    }

    // If no explanation found, try text after the code block
    if (!explanation) {
      const codeEnd = content.lastIndexOf('```');
      if (codeEnd > 0 && codeEnd + 3 < content.length) {
        explanation = content.substring(codeEnd + 3).trim();
      }
    }

    return {
      script,
      explanation: explanation || `Generated test for: ${description}`,
    };
  }
}

module.exports = { ScriptGenerator };
