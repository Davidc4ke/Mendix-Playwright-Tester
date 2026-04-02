/**
 * settings.js — Persistent settings for Zoniq Test Runner
 *
 * Stores LLM configuration and agent preferences in the user data directory.
 */

const path = require("path");
const fs = require("fs");
const { app } = require("electron");

const SETTINGS_PATH = path.join(app.getPath("userData"), "settings.json");

let _settingsCache = null;

const DEFAULT_SETTINGS = {
  llm: {
    provider: "anthropic",    // "anthropic" | "openai"
    apiKey: "",
    baseUrl: "",              // empty = use provider default; set for OpenAI-compatible APIs (e.g. DeepSeek, Qwen)
    model: "",                // empty = use provider default
    maxTokens: 4096,
  },
  agent: {
    maxIterations: 20,
    headless: false,
  },
  recorder: {
    showHighlights: false,
  },
  testExecution: {
    retryOnFailure: false,        // Retry failed tests once
    stepTimeout: 30,              // Seconds before a step times out and fails the test
  },
};

function loadSettings() {
  if (_settingsCache) return _settingsCache;
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const data = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
      _settingsCache = { ...DEFAULT_SETTINGS, ...data, llm: { ...DEFAULT_SETTINGS.llm, ...data.llm }, agent: { ...DEFAULT_SETTINGS.agent, ...data.agent }, recorder: { ...DEFAULT_SETTINGS.recorder, ...data.recorder }, testExecution: { ...DEFAULT_SETTINGS.testExecution, ...data.testExecution } };
      return _settingsCache;
    }
  } catch {}
  _settingsCache = { ...DEFAULT_SETTINGS };
  return _settingsCache;
}

function saveSettings(settings) {
  const merged = {
    llm: { ...DEFAULT_SETTINGS.llm, ...settings.llm },
    agent: { ...DEFAULT_SETTINGS.agent, ...settings.agent },
    recorder: { ...DEFAULT_SETTINGS.recorder, ...settings.recorder },
    testExecution: { ...DEFAULT_SETTINGS.testExecution, ...settings.testExecution },
  };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2));
  _settingsCache = merged;
  return merged;
}

function getDefaultModel(provider) {
  if (provider === "openai") return "gpt-4o";
  return "claude-sonnet-4-20250514";
}

module.exports = { loadSettings, saveSettings, getDefaultModel, DEFAULT_SETTINGS };
