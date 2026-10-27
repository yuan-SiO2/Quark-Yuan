'use strict';
/**
 * 自测：转存窗口——解析分享、勾选文件（非整包）、选目标目录、只转存勾选项。
 * 运行：./node_modules/.bin/electron tools/selftest-savewindow.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

let savedPayload = null;

app.whenReady().then(async () => {
  ipcMain.handle('qh:share-probe', async () => ({
    ok: true,
    title: '测试分享',
    files: [
      { fid: 'F1', token: 'T1', name: 'a.safetensors', size: 1073741824, dir: false },
      { fid: 'F2', token: 'T2', name: 'b.7z', size: 52428800, dir: false },
    ],
  }));
  ipcMain.handle('qh:list-folders', async (_e, fid) => ({
    pdirFid: fid || '0',
    dirs: fid === '0' ? [{ fid: 'DIR_A', name: '模型' }, { fid: 'DIR_B', name: '工具' }] : [],
  }));
  ipcMain.handle('qh:get-theme-sync', () => 'dark');
  ipcMain.handle('qh:share-save', async (_e, payload) => {
    savedPayload = payload;
    return { ok: true, count: (payload.fids || []).length };
  });

  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 760,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'save-window-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'save-window.html'));
  await new Promise((r) => setTimeout(r, 900));

  // 解析
  await win.webContents.executeJavaScript(
    `document.getElementById('url').value = 'https://pan.quark.cn/s/30666e9bdcc9';
     document.getElementById('probeBtn').click(); true`, true);
  await new Promise((r) => setTimeout(r, 600));
  const afterProbe = await win.webContents.executeJavaScript(
    `(() => ({
      rows: document.querySelectorAll('#files .file').length,
      count: document.getElementById('count').textContent,
      selAll: document.getElementById('selAll').checked,
      saveEnabled: !document.getElementById('saveBtn').disabled,
    }))()`, true);
  console.log('解析后:', afterProbe);

  // 取消勾选第一个文件
  await win.webContents.executeJavaScript(
    `document.querySelectorAll('#files .file input')[0].click(); true`, true);
  await new Promise((r) => setTimeout(r, 200));
  const afterUncheck = await win.webContents.executeJavaScript(
    `(() => ({ count: document.getElementById('count').textContent }))()`, true);
  console.log('取消勾选后:', afterUncheck);

  // 进入「模型」目录
  await win.webContents.executeJavaScript(
    `document.querySelectorAll('#folders .folder')[0].click(); true`, true);
  await new Promise((r) => setTimeout(r, 400));
  const crumb = await win.webContents.executeJavaScript(
    `document.getElementById('crumb').textContent`, true);
  console.log('目标目录:', crumb);

  // 转存
  await win.webContents.executeJavaScript(`document.getElementById('saveBtn').click(); true`, true);
  await new Promise((r) => setTimeout(r, 500));
  const msg = await win.webContents.executeJavaScript(`document.getElementById('msg').textContent`, true);
  console.log('结果消息:', msg);

  const res = {
    解析出两个文件: afterProbe.rows === 2,
    默认全选: /2 \/ 2/.test(afterProbe.count) && afterProbe.selAll === true,
    可取消勾选: /1 \/ 2/.test(afterUncheck.count),
    可选择目标目录: crumb === '根目录 / 模型',
    只转存勾选项: !!savedPayload && JSON.stringify(savedPayload.fids) === '["F2"]',
    目标目录传对: !!savedPayload && savedPayload.toPdirFid === 'DIR_A',
    成功提示: /已转存 1 项/.test(msg),
  };
  console.log('结果:', res);
  const ok = Object.values(res).every(Boolean);
  console.log(ok ? 'PASS：窗口可勾选文件、选目录、只转存选中项' : 'FAIL');
  app.exit(ok ? 0 : 1);
});
