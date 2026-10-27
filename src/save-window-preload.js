'use strict';
/**
 * 转存窗口的 preload：只暴露最小 API，业务都在主进程。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qh', {
  // dir: 分享内的目录 fid（'0' = 分享根），用于逐层浏览文件夹分享
  probe: (url, pwd, dir) => ipcRenderer.invoke('qh:share-probe', { url, pwd, dir: dir || '0' }),
  folders: (pdirFid) => ipcRenderer.invoke('qh:list-folders', pdirFid),
  save: (payload) => ipcRenderer.invoke('qh:share-save', payload),
  theme: () => ipcRenderer.invoke('qh:get-theme-sync'),
  close: () => ipcRenderer.send('qh:win-close'),
  onPrefill: (cb) => ipcRenderer.on('qh:save-prefill', (_e, data) => cb(data)),
});
