'use strict';
/**
 * 自测：回收站改为「点网页回收站 → 弹窗显示」，面板里不再有常驻入口。
 * 运行：./node_modules/.bin/electron tools/selftest-trash.js
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

app.whenReady().then(async () => {
  ipcMain.handle('qh:recycle-list', async () => ({
    total: 48,
    list: [
      { fid: 'f1', recordId: 'r1', name: '【第二期】影视二创', size: 71388651520 },
      { fid: 'f2', recordId: 'r2', name: '图吧工具箱.rar', size: 283679948 },
    ],
  }));

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

  // 1) 面板里不应再有回收站入口
  const pre = await win.webContents.executeJavaScript(
    `(() => {
      const root = document.getElementById('qh-panel-host').shadowRoot;
      return { noHeaderBtn: !root.getElementById('trashBtn'), noPane: !root.getElementById('trash-pane') };
    })()`, true);
  console.log('面板已移除回收站入口:', pre);

  // 2) 模拟网页点击回收站（路由事件）
  win.webContents.send('qh:recycle-route', '#/list/trash');
  await new Promise((r) => setTimeout(r, 700));

  const dlg = await win.webContents.executeJavaScript(
    `(() => {
      const root = document.getElementById('qh-panel-host').shadowRoot;
      const d = root.getElementById('trash-dialog');
      const rows = root.querySelectorAll('#trashList .link-row');
      return {
        open: d.classList.contains('on'),
        count: root.getElementById('trashCount').textContent,
        rows: rows.length,
        firstName: rows[0] ? rows[0].querySelector('.u').textContent : '',
        hasWriteBtn: rows[0] ? !!rows[0].querySelector('button') : null,
        tip: root.getElementById('trashTip').textContent,
      };
    })()`, true);
  console.log('弹窗状态:', dlg);

  // 3) 关闭按钮
  await win.webContents.executeJavaScript(
    `document.getElementById('qh-panel-host').shadowRoot.getElementById('trashClose').click(); true`, true);
  await new Promise((r) => setTimeout(r, 250));
  const closed = await win.webContents.executeJavaScript(
    `!document.getElementById('qh-panel-host').shadowRoot.getElementById('trash-dialog').classList.contains('on')`, true);

  const res = {
    面板入口已移除: pre.noHeaderBtn && pre.noPane,
    弹窗已打开: dlg.open === true,
    总数显示: /48/.test(dlg.count),
    列出条目: dlg.rows === 2,
    名称正确: dlg.firstName === '【第二期】影视二创',
    无写入按钮: dlg.hasWriteBtn === false,
    提示只读: /只读|禁用/.test(dlg.tip),
    可关闭: closed === true,
  };
  console.log('结果:', res);
  const ok = Object.values(res).every(Boolean);
  console.log(ok ? 'PASS：点回收站弹窗显示，面板不再常驻入口' : 'FAIL');
  try { srv.close(); } catch (e) {}
  app.exit(ok ? 0 : 1);
});
