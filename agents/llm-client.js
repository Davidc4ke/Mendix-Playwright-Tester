/**
 * llm-client.js — Unified LLM client for Anthropic and OpenAI
 *
 * Provides a single interface for sending messages to either provider.
 * Message format follows Anthropic conventions internally.
 */

const { getDefaultModel } = require("../settings");

class LLMClient {
  constructor(settings) {
    this.provider = settings.llm.provider || "anthropic";
    this.apiKey = settings.llm.apiKey;
    this.baseUrl = settings.llm.baseUrl || "";
    this.model = settings.llm.model || getDefaultModel(this.provider);
    this.maxTokens = settings.llm.maxTokens || 4096;

    if (!this.apiKey) {
      throw new Error(`No API key configured for ${this.provider}. Go to Settings to add one.`);
    }
  }

  /**
   * Send a chat completion request.
   * @param {Array<{role: string, content: string}>} messages
   * @param {{ system?: string }} options
   * @returns {Promise<{ content: string, usage: object }>}
   */
  async chat(messages, options = {}) {
    if (this.provider === "openai") {
      return this._chatOpenAI(messages, options);
    }
    return this._chatAnthropic(messages, options);
  }

  async _chatAnthropic(messages, options) {
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: this.apiKey });

    const params = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages,
    };
    if (options.system) {
      params.system = options.system;
    }

    const response = await client.messages.create(params);

    const textBlocks = response.content.filter((b) => b.type === "text");
    const content = textBlocks.map((b) => b.text).join("");

    return {
      content,
      usage: response.usage,
      stopReason: response.stop_reason,
    };
  }

  /**
   * Convert Anthropic-style content blocks to OpenAI format.
   * Anthropic uses { type: "image", source: { type: "base64", media_type, data } }
   * OpenAI uses { type: "image_url", image_url: { url: "data:media_type;base64,data" } }
   */
  _toOpenAIContent(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return content;

    return content.map((block) => {
      if (block.type === "image" && block.source?.type === "base64") {
        return {
          type: "image_url",
          image_url: {
            url: `data:${block.source.media_type};base64,${block.source.data}`,
          },
        };
      }
      return block;
    });
  }

  async _chatOpenAI(messages, options) {
    const OpenAI = require("openai");
    const clientOpts = { apiKey: this.apiKey };
    if (this.baseUrl) clientOpts.baseURL = this.baseUrl;
    const client = new OpenAI(clientOpts);

    const openAIMessages = [];
    if (options.system) {
      openAIMessages.push({ role: "system", content: options.system });
    }
    for (const msg of messages) {
      openAIMessages.push({ role: msg.role, content: this._toOpenAIContent(msg.content) });
    }

    const response = await client.chat.completions.create({
      model: this.model,
      max_tokens: this.maxTokens,
      messages: openAIMessages,
    });

    const choice = response.choices[0];
    return {
      content: choice.message.content || "",
      usage: response.usage,
      stopReason: choice.finish_reason,
    };
  }

  /**
   * Quick connectivity test — sends a trivial prompt to verify the API key works.
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  async testConnection() {
    try {
      await this.chat([{ role: "user", content: "Reply with OK" }]);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
}

module.exports = { LLMClient };
