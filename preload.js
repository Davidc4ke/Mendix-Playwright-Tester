const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("zoniq", {
  healthCheck: () => ipcRenderer.invoke("health-check"),
  getScenarios: () => ipcRenderer.invoke("get-scenarios"),
  saveScenario: (s) => ipcRenderer.invoke("save-scenario", s),
  deleteScenario: (id) => ipcRenderer.invoke("delete-scenario", id),
  duplicateScenario: (id) => ipcRenderer.invoke("duplicate-scenario", id),
  getRuns: () => ipcRenderer.invoke("get-runs"),
  getSavedUrls: () => ipcRenderer.invoke("get-saved-urls"),
  launchRecorder: (url, options) => ipcRenderer.invoke("launch-recorder", url, options),
  importScript: () => ipcRenderer.invoke("import-script"),
  executeScenario: (s) => ipcRenderer.invoke("execute-scenario", s),
  openResultsFolder: (runId) => ipcRenderer.invoke("open-results-folder", runId),
  getArtifactPath: (runId, filename) => ipcRenderer.invoke("get-artifact-path", runId, filename),

  // Apps & Element DB
  getApps: () => ipcRenderer.invoke("get-apps"),
  createApp: (app) => ipcRenderer.invoke("create-app", app),
  updateApp: (app) => ipcRenderer.invoke("update-app", app),
  deleteApp: (id) => ipcRenderer.invoke("delete-app", id),
  getElementDB: (appId) => ipcRenderer.invoke("get-element-db", appId),
  scanElements: (appId) => ipcRenderer.invoke("scan-elements", appId),
  generateScript: (opts) => ipcRenderer.invoke("generate-script", opts),

  // Settings
  getSettings: () => ipcRenderer.invoke("get-settings"),
  saveSettings: (s) => ipcRenderer.invoke("save-settings", s),
  testLLMConnection: (s) => ipcRenderer.invoke("test-llm-connection", s),

  // Agent operations
  agentHeal: (opts) => ipcRenderer.invoke("agent-heal", opts),
  agentAnalyze: (opts) => ipcRenderer.invoke("agent-analyze", opts),
  agentPreheal: (opts) => ipcRenderer.invoke("agent-preheal", opts),
  agentHealApply: (opts) => ipcRenderer.invoke("agent-heal-apply", opts),
  agentCancel: () => ipcRenderer.invoke("agent-cancel"),

  // Script cleanup
  cleanupScript: (scenarioId) => ipcRenderer.invoke("cleanup-script", scenarioId),
  cleanupScriptAI: (scenarioId) => ipcRenderer.invoke("cleanup-script-ai", scenarioId),

  // Event listeners — each returns an unsubscribe function to prevent memory leaks
  onRunStarted: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on("run-started", handler);
    return () => ipcRenderer.removeListener("run-started", handler);
  },
  onRunCompleted: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on("run-completed", handler);
    return () => ipcRenderer.removeListener("run-completed", handler);
  },
  onRunsUpdated: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("runs-updated", handler);
    return () => ipcRenderer.removeListener("runs-updated", handler);
  },
  onStepList: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on("step-list", handler);
    return () => ipcRenderer.removeListener("step-list", handler);
  },
  onStepProgress: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on("step-progress", handler);
    return () => ipcRenderer.removeListener("step-progress", handler);
  },
  onAgentProgress: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on("agent-progress", handler);
    return () => ipcRenderer.removeListener("agent-progress", handler);
  },
});
