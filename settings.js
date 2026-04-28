/**
 * settings.js — Persistent settings for Zoniq Test Runner
 *
 * Stores LLM configuration and agent preferences in the user data directory.
 */

const path = require("path");
const fs = require("fs");
const { getDataDir } = require("./lib/paths");

function getSettingsPath() {
  return path.join(getDataDir(), "settings.json");
}

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
    viewportAuto: true,           // Auto-detect viewport from display resolution
    viewportWidth: 1920,          // Browser viewport width (used when viewportAuto is false)
    viewportHeight: 1080,         // Browser viewport height (used when viewportAuto is false)
  },
  cloud: {
    serverUrl: "",                // Cloud server URL (e.g., https://server-production-25a0.up.railway.app)
    apiKey: "",                   // API key or JWT token for authentication
    username: "",                 // Username for JWT login (if no static API key)
    password: "",                 // Password for JWT login
    syncEnabled: false,           // Enable cloud sync
  },
};

function loadSettings() {
  if (_settingsCache) return _settingsCache;
  try {
    if (fs.existsSync(getSettingsPath())) {
      const data = JSON.parse(fs.readFileSync(getSettingsPath(), "utf-8"));
      _settingsCache = { ...DEFAULT_SETTINGS, ...data, llm: { ...DEFAULT_SETTINGS.llm, ...data.llm }, agent: { ...DEFAULT_SETTINGS.agent, ...data.agent }, recorder: { ...DEFAULT_SETTINGS.recorder, ...data.recorder }, testExecution: { ...DEFAULT_SETTINGS.testExecution, ...data.testExecution }, cloud: { ...DEFAULT_SETTINGS.cloud, ...data.cloud } };
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
    cloud: { ...DEFAULT_SETTINGS.cloud, ...settings.cloud },
  };
  fs.writeFileSync(getSettingsPath(), JSON.stringify(merged, null, 2));
  _settingsCache = merged;
  return merged;
}

function getDefaultModel(provider) {
  if (provider === "openai") return "gpt-4o";
  return "claude-sonnet-4-20250514";
}

module.exports = { loadSettings, saveSettings, getDefaultModel, DEFAULT_SETTINGS };
