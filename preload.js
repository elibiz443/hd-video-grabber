'use strict';
const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, cb) {
  const listener = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  fetchInfo: (url) => ipcRenderer.invoke('fetch-info', url),
  startDownload: (opts) => ipcRenderer.invoke('start-download', opts),
  cancelDownload: (id) => ipcRenderer.send('cancel-download', id),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (s) => ipcRenderer.invoke('set-settings', s),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  updateEngine: () => ipcRenderer.invoke('update-engine'),
  showInFolder: (p) => ipcRenderer.send('show-in-folder', p),
  openPath: (p) => ipcRenderer.send('open-path', p),
  onDownloadEvent: (cb) => subscribe('download-event', cb),
  onEngineStatus: (cb) => subscribe('engine-status', cb),
});
