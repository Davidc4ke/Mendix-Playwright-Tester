const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("zoniq", {
  healthCheck: () => ipcRenderer.invoke("health-check"),
  getScenarios: () => ipcRenderer.invoke("get-scenarios"),
  saveScenario: (s) => ipcRenderer.invoke("save-scenario", s),
  deleteScenario: (id) => ipcRenderer.invoke("delete-scenario", id),
  getRuns: () => ipcRenderer.invoke("get-runs"),
  launchRecorder: (url) => ipcRenderer.invoke("launch-recorder", url),
  importScript: () => ipcRenderer.invoke("import-script"),
  executeScenario: (s) => ipcRenderer.invoke("execute-scenario", s),
  openResultsFolder: (runId) => ipcRenderer.invoke("open-results-folder", runId),

  // Event listeners
  onRunStarted: (cb) => ipcRenderer.on("run-started", (_, data) => cb(data)),
  onRunCompleted: (cb) => ipcRenderer.on("run-completed", (_, data) => cb(data)),
  onRunsUpdated: (cb) => ipcRenderer.on("runs-updated", () => cb()),
});
