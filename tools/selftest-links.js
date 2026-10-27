'use strict';
/**
 * 自测 2/2：面板「链接」页签 —— 显示嗅探结果、可填提取码、点转存发出 IPC。
 * 运行：./node_modules/.bin/electron tools/selftest-links.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const http = require('http');

const HTML = '<!doctype html><html><head><meta charset="utf-8"></head><body><div>列表</div></body></html>';
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

let sent = null;

app.whenReady().then(async () => {
  ipcMain.on('qh:open-save-window', (_e, p) => {
    sent = p; // 现在「转存」是打开转存窗口（勾选后由窗��执行）
  });


  const { srv, port } = await serve();
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  await win.loadURL(`http://127.0.0.1:${port}/list/all`);
  await new Promise((r) => setTimeout(r, 900));

  // 推送嗅探结果
  win.webContents.send('qh:share-links', [
    { url: 'https://pan.quark.cn/s/30666e9bdcc9', pwd: 'a1b2' },
    { url: 'https://pan.quark.cn/s/aaaabbbbcccc', pwd: '' },
  ]);
  await new Promise((r) => setTimeout(r, 300));

  const open = await win.webContents.executeJavaScript(
    `(() => {
      const root = document.getElementById('qh-panel-host').shadowRoot;
      root.getElementById('linksBtn').click();
      const rows = root.querySelectorAll('#linksList .link-row');
      return {
        btnText: root.getElementById('linksBtn').textContent,
        rowCount: rows.length,
        firstUrl: rows[0] ? rows[0].querySelector('.u').textContent : '',
        firstPwd: rows[0] ? rows[0].querySelector('.pwd').value : '',
        paneVisible: root.getElementById('links-pane').classList.contains('on'),
      };
    })()`, true);
  console.log('打开链接页签:', open);


  // 点第一行「转存」
  await win.webContents.executeJavaScript(
    `(() => {
      const root = document.getElementById('qh-panel-host').shadowRoot;
      const rows = root.querySelectorAll('#linksList .link-row');
      rows[0].querySelector('.save').click();
      return true;
    })()`, true);
  await new Promise((r) => setTimeout(r, 400));
  const rowSent = sent;

  // 手动粘贴 + 转存
  await win.webContents.executeJavaScript(
    `(() => {
      const root = document.getElementById('qh-panel-host').shadowRoot;
      root.getElementById('manualLink').value = 'https://pan.quark.cn/s/manual1234';
      root.getElementById('manualSave').click();
      return true;
    })()`, true);
  await new Promise((r) => setTimeout(r, 400));
  const manual = sent;

  const res = {
    按钮显示数量: open.btnText.indexOf('链接') === 0 && open.btnText.indexOf('2') !== -1,
    页签展开: open.paneVisible === true,
    列出两行: open.rowCount === 2,
    显示短链: open.firstUrl === '/s/30666e9bdcc9',
    提取码预填: open.firstPwd === 'a1b2',
    点击转存打开窗口: !!rowSent && rowSent.url === 'https://pan.quark.cn/s/30666e9bdcc9',
    手动链接也能打开窗口: !!manual && manual.url === 'https://pan.quark.cn/s/manual1234',
    手动链接可转存: !!manual && manual.url === 'https://pan.quark.cn/s/manual1234',
  };
  console.log('结果:', res);
  const ok = Object.values(res).every(Boolean);
  console.log(ok ? 'PASS：嗅探结果展示、提取码、转存 IPC 全通' : 'FAIL');
  try { srv.close(); } catch (e) {}
  app.exit(ok ? 0 : 1);
});
