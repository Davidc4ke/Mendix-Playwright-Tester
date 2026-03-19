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
});
