'use strict';
/**
 * 自测：面板只在文件列表页显示，进入预览页（video/image/doc/…）自动隐藏。
 * 直接加载真实的 src/preload.js，验证实际代码路径。
 * 运行：./node_modules/.bin/electron tools/selftest-panel.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const http = require('http');

const HTML =
  '<!doctype html><html><head><meta charset="utf-8"></head><body><div>文件列表</div></body></html>';

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

const panelState = `(() => {
  const host = document.getElementById('qh-panel-host');
  if (!host) return { exists: false };
  return { exists: true, display: host.style.display || '', hidden: host.style.display === 'none' };
})()`;

app.whenReady().then(async () => {
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
  const { srv, port } = await serve();
  await win.loadURL(`http://127.0.0.1:${port}/list/all`);
  await new Promise((r) => setTimeout(r, 900));

  const onList = await win.webContents.executeJavaScript(panelState, true);

  // 进入视频预览路由
  await win.webContents.executeJavaScript(`location.hash = '#/video/abc123'; true`, true);
  await new Promise((r) => setTimeout(r, 1200));
  const onVideo = await win.webContents.executeJavaScript(panelState, true);

  // 文档预览路由
  await win.webContents.executeJavaScript(`location.hash = '#/doc/d16c27f25d6f4cb6983efbb5fc99d214'; true`, true);
  await new Promise((r) => setTimeout(r, 1200));
  const onDoc = await win.webContents.executeJavaScript(panelState, true);

  // 回到列表
  await win.webContents.executeJavaScript(`location.hash = '#/list/all'; true`, true);
  await new Promise((r) => setTimeout(r, 1200));
  const back = await win.webContents.executeJavaScript(panelState, true);

  const res = {
    列表页: onList.hidden ? '隐藏' : '显示',
    视频预览: onVideo.hidden ? '隐藏' : '显示',
    文档预览: onDoc.hidden ? '隐藏' : '显示',
    回到列表: back.hidden ? '隐藏' : '显示',
  };
  console.log('结果:', res);
  const ok = onList.exists && onList.hidden === false && onVideo.hidden && onDoc.hidden && back.hidden === false;
  console.log(ok ? 'PASS：列表页显示，预览页隐藏，返回后恢复' : 'FAIL');
  try { srv.close(); } catch (e) {}
  app.exit(ok ? 0 : 1);
});
