'use strict';
/**
 * 自测：深色模式下头像/图片不会被双重反色（变负片），且取消深色后恢复。
 * 运行：./node_modules/.bin/electron tools/selftest-avatar.js
 */
const { app, BrowserWindow } = require('electron');
const http = require('http');
const { hooksSource } = require('../src/hooks.js');
const { DARK_CSS } = require('../src/theme');

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body{background:#fff;color:#111;font:14px sans-serif}
.avatar{width:48px;height:48px;border-radius:50%;background-image:url("${PNG}");background-color:#e33}
.wrap{padding:20px}
</style></head><body>
<div class="wrap">
  <!-- 场景1：容器有内联背景图，内部含 img（最容易被双重反色） -->
  <div id="box1" style="background-image:url('${PNG}')"><img id="img1" src="${PNG}" width="40" height="40"></div>
  <!-- 场景2：class 带 avatar 的背景图 div -->
  <div id="ava" class="avatar"></div>
  <!-- 场景3：普通图片 -->
  <img id="img2" src="${PNG}" width="30" height="30">
</div>
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

const CHECK = `(() => {
  const marked = Array.from(document.querySelectorAll('[data-qh-uninvert]'));
  const ids = marked.map((el) => el.id || el.className || el.tagName);
  // 检查是否存在「祖先+后代都被标记」＝双重反色
  let nested = false;
  for (const el of marked) {
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (marked.indexOf(p) !== -1) { nested = true; break; }
    }
    if (nested) break;
  }
  return {
    count: marked.length,
    ids,
    nested,
    img1: getComputedStyle(document.getElementById('img1')).filter,
    ava: getComputedStyle(document.getElementById('ava')).filter,
  };
})()`;

app.whenReady().then(async () => {
  const { srv, port } = await serve();
  const win = new BrowserWindow({ show: false, width: 600, height: 400 });
  await win.loadURL(`http://127.0.0.1:${port}/`);
  await win.webContents.executeJavaScript(hooksSource({ hideLimitDialog: false, blockPreviewAll: false }), true);
  await win.webContents.insertCSS(DARK_CSS);

  await win.webContents.executeJavaScript(`window.__qhThemeFix('dark'); true`, true);
  await new Promise((r) => setTimeout(r, 900));
  const dark = await win.webContents.executeJavaScript(CHECK, true);
  console.log('深色下标记元素:', dark.ids, '| 嵌套双重:', dark.nested);
  console.log('  img1.filter =', dark.img1);
  console.log('  avatar.filter =', dark.ava);

  await win.webContents.executeJavaScript(`window.__qhThemeFix('light'); true`, true);
  await new Promise((r) => setTimeout(r, 500));
  const light = await win.webContents.executeJavaScript(CHECK, true);
  console.log('切回亮色后标记数:', light.count);

  const res = {
    头像被反反色: /invert/.test(dark.ava) && /invert/.test(dark.img1),
    无双重反色: dark.nested === false,
    亮色下清除: light.count === 0,
  };
  console.log('结果:', res);
  const ok = res.头像被反反色 && res.无双重反色 && res.亮色下清除;
  console.log(ok ? 'PASS：头像/图片正确回正，无嵌套负片，切亮色后恢复' : 'FAIL');
  try { srv.close(); } catch (e) {}
  app.exit(ok ? 0 : 1);
});
