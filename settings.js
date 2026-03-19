/**
 * settings.js — Persistent settings for Zoniq Test Runner
 *
 * Stores LLM configuration and agent preferences in the user data directory.
 */

const path = require("path");
const fs = require("fs");
const { app } = require("electron");

const SETTINGS_PATH = path.join(app.getPath("userData"), "settings.json");

const DEFAULT_SETTINGS = {
  llm: {
    provider: "anthropic",    // "anthropic" | "openai"
    apiKey: "",
    model: "",                // empty = use provider default
    maxTokens: 4096,
  },
  agent: {
    maxIterations: 20,
    headless: false,
  },
};

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const data = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
      return { ...DEFAULT_SETTINGS, ...data, llm: { ...DEFAULT_SETTINGS.llm, ...data.llm }, agent: { ...DEFAULT_SETTINGS.agent, ...data.agent } };
    }
  } catch {}
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(settings) {
  const merged = {
    llm: { ...DEFAULT_SETTINGS.llm, ...settings.llm },
    agent: { ...DEFAULT_SETTINGS.agent, ...settings.agent },
  };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

function getDefaultModel(provider) {
  if (provider === "openai") return "gpt-4o";
  return "claude-sonnet-4-20250514";
}

module.exports = { loadSettings, saveSettings, getDefaultModel, DEFAULT_SETTINGS };
