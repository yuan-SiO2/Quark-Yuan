'use strict';
/**
 * 自测：预览跳转拦截
 *  模式 A（blockPreviewAll=false）：只拦不可预览文件，可预览文件放行
 *  模式 B（blockPreviewAll=true） ：视频/图片/文档一律不跳转
 * 运行：./node_modules/.bin/electron tools/selftest-blockpreview.js
 *
 * 用本地 HTTP 提供页面：data: URL 在「销毁唯一窗口后」再次导航会 ERR_FAILED，
 * 且 http 源的 hash 路由更接近真实站点。
 */
const { app, BrowserWindow } = require('electron');
const http = require('http');
const { hooksSource } = require('../src/hooks.js');

const FID_BIG = 'd16c27f25d6f4cb6983efbb5fc99d214'; // 5GB safetensors
const FID_PDF = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; // 小 pdf
const FID_VID = 'cccccccccccccccccccccccccccccccc'; // 视频

const HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<a id="big" href="#/doc/${FID_BIG}">moss.safetensors</a>
<a id="pdf" href="#/doc/${FID_PDF}">报告.pdf</a>
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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function runCase(win, url, blockPreviewAll) {
  await win.loadURL(url);
  await win.webContents.executeJavaScript(hooksSource({ hideLimitDialog: true, blockPreviewAll }), true);
  await win.webContents.executeJavaScript(
    `window.__msgs = [];
     window.addEventListener('message', (e) => { if (e.data && e.data.__quark_hybrid__) window.__msgs.push(e.data); });
     window.__qhSeedFiles([
       { fid: '${FID_BIG}', name: 'moss.safetensors', size: 5413698958 },
       { fid: '${FID_PDF}', name: '报告.pdf', size: 204800 },
       { fid: '${FID_VID}', name: '电影.mp4', size: 104857600 }
     ]); true`,
    true
  );

  const clickAndCount = async (id) => {
    await win.webContents.executeJavaScript(`window.__msgs = []; true`, true);
    await win.webContents.executeJavaScript(`document.getElementById('${id}').click(); true`, true);
    await wait(150);
    return await win.webContents.executeJavaScript(`window.__msgs.length`, true);
  };

  const blockedBig = (await clickAndCount('big')) > 0;
  await wait(900);
  const blockedPdf = (await clickAndCount('pdf')) > 0;
  await wait(900);

  // 视频/图片路由
  const pushBlocked = async (hash) => {
    await win.webContents.executeJavaScript(`window.__msgs = []; true`, true);
    await win.webContents.executeJavaScript(`history.pushState(null, '', '${hash}'); true`, true);
    await wait(150);
    const n = await win.webContents.executeJavaScript(`window.__msgs.length`, true);
    const h = await win.webContents.executeJavaScript(`location.hash`, true);
    return n > 0 && h === '';
  };
  const videoBlocked = await pushBlocked(`#/video/${FID_VID}`);
  await wait(900);
  const imageBlocked = await pushBlocked(`#/image/${FID_BIG}`);

  return { blockedBig, blockedPdf, videoBlocked, imageBlocked };
}

app.whenReady().then(async () => {
  const { srv, port } = await serve();
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, nodeIntegration: false } });

  const modeA = await runCase(win, `http://127.0.0.1:${port}/a`, false);
  const modeB = await runCase(win, `http://127.0.0.1:${port}/b`, true);

  console.log('模式A(仅不可预览):', modeA);
  console.log('模式B(全部拦截)  :', modeB);
  const okA = modeA.blockedBig && !modeA.blockedPdf;
  const okB = modeB.blockedBig && modeB.blockedPdf && modeB.videoBlocked && modeB.imageBlocked;
  console.log(okA && okB ? 'PASS：两种模式行为都正确' : 'FAIL');
  win.destroy();
  srv.close();
  app.exit(okA && okB ? 0 : 1);
});
