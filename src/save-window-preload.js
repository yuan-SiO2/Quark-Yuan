'use strict';
/**
 * 转存窗口的 preload：只暴露最小 API，业务都在主进程。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qh', {
  probe: (url, pwd) => ipcRenderer.invoke('qh:share-probe', { url, pwd }),
  folders: (pdirFid) => ipcRenderer.invoke('qh:list-folders', pdirFid),
  save: (payload) => ipcRenderer.invoke('qh:share-save', payload),
  theme: () => ipcRenderer.invoke('qh:get-theme-sync'),
  close: () => ipcRenderer.send('qh:win-close'),
  onPrefill: (cb) => ipcRenderer.on('qh:save-prefill', (_e, data) => cb(data)),
});
