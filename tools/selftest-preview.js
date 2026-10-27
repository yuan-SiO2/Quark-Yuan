'use strict';
/**
 * 自测：预览错误页屏蔽（真实路径：页面本地没有元数据 → 向主进程要 → 拿到后再屏蔽）
 * 运行：./node_modules/.bin/electron tools/selftest-preview.js
 */
const { app, BrowserWindow } = require('electron');
const { hooksSource } = require('../src/hooks.js');

const FID = 'd16c27f25d6f4cb6983efbb5fc99d214';
const NAME = 'moss_image_base_int8_convrot.safetensors';
const SIZE = 5413698958;

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:sans-serif}
iframe{width:100%;height:70vh;border:0}
</style></head><body>
<div id="app">
  <iframe id="viewer" src="https://office-cn-zhangjiakou.imm.aliyuncs.com/office/w/abc?hidecmb=1"></iframe>
</div>
</body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 760,
    webPreferences: { contextIsolation: false, nodeIntegration: false },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML));
  const injected = await win.webContents.executeJavaScript(hooksSource({ hideLimitDialog: true }), true);
  console.log('注入结果:', injected);

  await win.webContents.executeJavaScript(
    `window.__msgs = []; window.addEventListener('message', (e) => {
       if (e.data && e.data.__quark_hybrid__) window.__msgs.push(e.data);
     }); true`,
    true
  );

  // 阶段 1：进入 doc 路由，但页面没有元数据 → 应该向主进程要
  await win.webContents.executeJavaScript(
    `history.replaceState(null, '', '#/doc/${FID}'); window.__qhPreviewRoute(); true`,
    true
  );
  await new Promise((r) => setTimeout(r, 600));
  const asked = await win.webContents.executeJavaScript(
    `window.__msgs.filter((m) => m.type === 'preview-route' && m.fid === '${FID}').length > 0`,
    true
  );

  // 阶段 2：模拟主进程回推元数据
  await win.webContents.executeJavaScript(
    `window.postMessage({ __quark_hybrid__: true, type: 'meta', fid: '${FID}', name: '${NAME}', size: ${SIZE} }, '*'); true`,
    true
  );
  await new Promise((r) => setTimeout(r, 1600));

  const state = await win.webContents.executeJavaScript(
    `(() => {
      const fr = document.getElementById('viewer');
      const note = document.getElementById('qh-preview-note');
      return {
        iframeHidden: getComputedStyle(fr).visibility === 'hidden',
        noteShown: !!note,
        noteText: note ? note.textContent.slice(0, 50) : '',
        maskedEvent: window.__msgs.some((m) => m.type === 'preview-error-masked'),
      };
    })()`,
    true
  );
  await win.webContents.executeJavaScript(
    `(() => { const b = document.querySelector('#qh-preview-note #qh-preview-dl'); if (b) b.click(); return true; })()`,
    true
  );
  await new Promise((r) => setTimeout(r, 300));
  const intentCount = await win.webContents.executeJavaScript(
    `window.__msgs.filter((m) => m.type === 'intent').length`,
    true
  );

  const res = { askedMeta: asked, ...state, intentOnClick: intentCount > 0 };
  console.log('检查结果:', res);
  const ok = res.askedMeta && res.iframeHidden && res.noteShown && res.maskedEvent && res.intentOnClick;
  console.log(ok ? 'PASS：缺元数据时会要、拿到后屏蔽错误页、下载按钮可用' : 'FAIL');
  app.exit(ok ? 0 : 1);
});
