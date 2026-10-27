'use strict';
/**
 * 自测：回收站页面上站点自己的「请用客户端」提示卡被隐藏，相关按钮点击被吃掉。
 * 运行：./node_modules/.bin/electron tools/selftest-trashpage.js
 */
const { app, BrowserWindow } = require('electron');
const http = require('http');
const { hooksSource } = require('../src/hooks.js');

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:sans-serif}
.card{padding:40px;text-align:center;background:#fff}
.btn{display:inline-block;padding:6px 12px;border:1px solid #ccc;margin:6px;cursor:pointer}
.other{margin-top:20px;padding:10px;background:#eef}
</style></head><body>
<div class="card" id="trashCard">
  <h3>回收站</h3>
  <p>打开客户端，查看和恢复已删除的文件</p>
  <span class="btn" id="viewTrash">查看回收站</span>
  <span class="btn" id="openClient">打开客户端</span>
  <span class="btn" id="dlClient">下载客户端</span>
  <p class="client-tip">正在打开夸克网盘客户端，请稍候…</p>
</div>
<div class="other" id="normalArea">这是列表区域的正常内容</div>
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
  await win.loadURL(`http://127.0.0.1:${port}/list#/list/trash`);
  await win.webContents.executeJavaScript(
    `window.__msgs = []; window.addEventListener('message', (e) => { if (e.data && e.data.__quark_hybrid__) window.__msgs.push(e.data); }); true`,
    true
  );
  console.log('注入:', await win.webContents.executeJavaScript(hooksSource({}), true));

  await win.webContents.executeJavaScript(`window.__qhHideTrashPrompt(); true`, true);
  await new Promise((r) => setTimeout(r, 400));

  const state = await win.webContents.executeJavaScript(
    `(() => {
      const vis = (el) => getComputedStyle(el).display !== 'none';
      return {
        cardHidden: !vis(document.getElementById('trashCard')),
        normalVisible: vis(document.getElementById('normalArea')),
        hiddenMsg: window.__msgs.some((m) => m.type === 'trash-prompt-hidden'),
      };
    })()`, true);
  // 点击拦截：postMessage 是异步的，点完等一下再统计
  await win.webContents.executeJavaScript(`document.getElementById('dlClient').click(); true`, true);
  await new Promise((r2) => setTimeout(r2, 300));
  const blocked = await win.webContents.executeJavaScript(
    `window.__msgs.filter((m) => m.type === 'trash-client-action-blocked').length > 0`, true);
  const res = { ...state, blocked };
  console.log('检查结果:', res);
  const ok = res.cardHidden && res.normalVisible && res.blocked && res.hiddenMsg;
  console.log(ok ? 'PASS：提示卡已隐藏、客户端按钮点击被拦截、正常区域未受影响' : 'FAIL');
  try { srv.close(); } catch (e) {}
  app.exit(ok ? 0 : 1);
});
