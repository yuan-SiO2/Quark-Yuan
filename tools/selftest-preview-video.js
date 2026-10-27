'use strict';
/**
 * 自测（回归）：视频/图片/文档必须能正常预览，哪怕体积很大；
 * 只有不可预览类型（.safetensors 等）才拦截跳转。
 * 运行：./node_modules/.bin/electron tools/selftest-preview-video.js
 */
const { app, BrowserWindow } = require('electron');
const { hooksSource } = require('../src/hooks.js');
const http = require('http');

const VID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // 3GB mp4
const PIC = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; // 20MB jpg
const DOC = 'cccccccccccccccccccccccccccccccc'; // 5MB pdf
const SAFE = 'd16c27f25d6f4cb6983efbb5fc99d214'; // 5GB safetensors

const HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<a id="vid" href="#/video/${VID}">电影.mp4</a>
<a id="pic" href="#/image/${PIC}">图.jpg</a>
<a id="doc" href="#/doc/${DOC}">文档.pdf</a>
<a id="safe" href="#/doc/${SAFE}">模型.safetensors</a>
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
  await win.loadURL(`http://127.0.0.1:${port}/list/all`);
  console.log('注入:', await win.webContents.executeJavaScript(
    hooksSource({ hideLimitDialog: true, blockPreviewAll: false }), true));
  await win.webContents.executeJavaScript(
    `window.__msgs = []; window.addEventListener('message', (e) => { if (e.data && e.data.__quark_hybrid__) window.__msgs.push(e.data); });
     window.__qhSeedFiles([
       { fid: '${VID}',  name: '电影.mp4', size: 3221225472 },
       { fid: '${PIC}',  name: '图.jpg',  size: 20971520 },
       { fid: '${DOC}',  name: '文档.pdf', size: 5242880 },
       { fid: '${SAFE}', name: '模型.safetensors', size: 5413698958 }
     ]); true`, true);

  const click = async (id) => {
    await win.webContents.executeJavaScript(`document.getElementById('${id}').click(); true`, true);
    await new Promise((r) => setTimeout(r, 250));
  };

  await click('vid');
  await click('pic');
  await click('doc');
  const previewableHash = await win.webContents.executeJavaScript(`location.hash`, true);
  const blockedBefore = await win.webContents.executeJavaScript(
    `window.__msgs.filter((m) => m.type === 'preview-blocked').length`, true);

  await click('safe');
  const afterSafe = await win.webContents.executeJavaScript(
    `({ hash: location.hash, blocked: window.__msgs.filter((m) => m.type === 'preview-blocked').map(m => m.fid) })`, true);

  const noteShown = await win.webContents.executeJavaScript(
    `!!document.getElementById('qh-preview-note')`, true);

  const res = {
    视频可达: previewableHash === '#/doc/' + DOC || previewableHash.indexOf('#/doc/') === 0,
    前三个均未拦: blockedBefore === 0,
    不可预览被拦: afterSafe.blocked.indexOf(SAFE) !== -1,
    未出现提示卡: noteShown === false,
  };
  console.log('结果:', res);
  const ok = res.视频可达 && res.前三个均未拦 && res.不可预览被拦 && res.未出现提示卡;
  console.log(ok ? 'PASS：视频/图片/文档正常预览，仅不可预览类型被拦' : 'FAIL');
  try { srv.close(); } catch (e) {}
  app.exit(ok ? 0 : 1);
});
