const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopBootstrap', {
  getState: () => ipcRenderer.invoke('desktop:get-bootstrap-state'),
  continueWithoutImport: () => ipcRenderer.invoke('desktop:continue-without-import'),
  importLegacy: () => ipcRenderer.invoke('desktop:import-legacy'),
  retryLaunch: () => ipcRenderer.invoke('desktop:retry-launch'),
  openLogsDir: () => ipcRenderer.invoke('desktop:open-logs-dir'),
  quit: () => ipcRenderer.invoke('desktop:quit'),
  onState: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('desktop:bootstrap-state', handler);
    return () => ipcRenderer.removeListener('desktop:bootstrap-state', handler);
  },
});
