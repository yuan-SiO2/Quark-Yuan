'use strict';
/**
 * 自测 1/2：页面嗅探（hooks）能否从文本/链接里收集夸克分享链接，并去重、带提取码。
 * 运行：./node_modules/.bin/electron tools/selftest-sniff.js
 */
const { app, BrowserWindow } = require('electron');
const http = require('http');
const { hooksSource } = require('../src/hooks.js');

const HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<p>资源分享：https://pan.quark.cn/s/30666e9bdcc9 提取码：a1b2 需要的自取</p>
<a href="https://pan.quark.cn/s/30666e9bdcc9?pwd=a1b2">点我</a>
<a href="https://example.com/s/notquark">无关链接</a>
<p>重复一次：https://pan.quark.cn/s/aaaabbbbcccc</p>
</body></html>`;

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
  const { srv, port } = await serve();
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, nodeIntegration: false } });
  await win.loadURL(`http://127.0.0.1:${port}/`);
  console.log('注入:', await win.webContents.executeJavaScript(
    hooksSource({ hideLimitDialog: false, blockPreviewAll: false }), true));

  const links = await win.webContents.executeJavaScript(`window.__qhCollectLinks()`, true);
  console.log('嗅探结果:', links);

  const urls = links.map((l) => l.url);
  // 回收站路由上报
  await win.webContents.executeJavaScript(
    `window.__msgs = []; window.addEventListener('message', (e) => { if (e.data && e.data.__quark_hybrid__) window.__msgs.push(e.data); });
     location.hash = '#/list/trash'; window.dispatchEvent(new HashChangeEvent('hashchange')); true`, true);
  await new Promise((r2) => setTimeout(r2, 600));
  const trashMsg = await win.webContents.executeJavaScript(
    `window.__msgs.some((m) => m.type === 'recycle-route')`, true);

  const res = {
    找到两个链接: urls.length === 2,
    去重有效: new Set(urls).size === urls.length,
    包含带码链接: urls.some((u) => u === 'https://pan.quark.cn/s/30666e9bdcc9'),
    提取码识别: links.some((l) => l.pwd === 'a1b2'),
    排除非夸克链接: !urls.some((u) => u.indexOf('example.com') !== -1),
    回收站路由会上报: trashMsg === true,
  };
  console.log('结果:', res);
  const ok = Object.values(res).every(Boolean);
  console.log(ok ? 'PASS：嗅探/去重/提取码/过滤都正确' : 'FAIL');
  try { srv.close(); } catch (e) {}
  app.exit(ok ? 0 : 1);
});
