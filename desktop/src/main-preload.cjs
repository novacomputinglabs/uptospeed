const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopRuntime', {
  getState: () => ipcRenderer.invoke('desktop:get-runtime-state'),
  restart: (options = {}) => ipcRenderer.invoke('desktop:restart-runtime', options),
  getLogs: () => ipcRenderer.invoke('desktop:get-runtime-logs'),
  openLogsDir: () => ipcRenderer.invoke('desktop:open-logs-dir'),
  openRuntimeDir: () => ipcRenderer.invoke('desktop:open-runtime-dir'),
  setProfile: (profileId) => ipcRenderer.invoke('desktop:set-runtime-profile', { profileId }),
  setMigrationPolicy: (policy) => ipcRenderer.invoke('desktop:set-migration-policy', { policy }),
  onState: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('desktop:runtime-state', handler);
    return () => ipcRenderer.removeListener('desktop:runtime-state', handler);
  },
});
