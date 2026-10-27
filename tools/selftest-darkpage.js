'use strict';
/**
 * 自测：强制深色 CSS 是否真的把亮色页面变暗（用截图平均亮度衡量）
 * 运行：./node_modules/.bin/electron tools/selftest-darkpage.js
 */
const { app, BrowserWindow } = require('electron');
const http = require('http');
const { DARK_CSS } = require('../src/theme');

const RED_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#ffffff;color:#111;font:16px sans-serif}
.box{padding:40px}
.card{background:#f5f7fb;border:1px solid #dde3ee;padding:20px;margin-top:10px}
img{width:120px;height:60px;background:#e33;display:block;margin-top:10px}
</style></head><body>
<div class="box">
  <h1>文件列表（模拟亮色页面）</h1>
  <div class="card">这是一行内容，用来测量反色前后的亮度变化。</div>
  <div class="card">第二行内容</div>
  <img src="${RED_PNG}">
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

function meanLuma(img) {
  const bmp = img.toBitmap(); // BGRA
  let sum = 0;
  let n = 0;
  for (let i = 0; i < bmp.length; i += 4) {
    sum += 0.114 * bmp[i] + 0.587 * bmp[i + 1] + 0.299 * bmp[i + 2];
    n++;
  }
  return sum / n;
}

app.whenReady().then(async () => {
  const { srv, port } = await serve();
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: { offscreen: true }, // 离屏渲染，隐藏窗口也能截图
  });
  await win.loadURL(`http://127.0.0.1:${port}/`);
  await new Promise((r) => setTimeout(r, 600));

  const grab = async () => {
    // 等一帧，离屏渲染需要 paint 事件
    await new Promise((r) => setTimeout(r, 300));
    const img = await win.webContents.capturePage();
    return img;
  };
  const before = meanLuma(await grab());
  const key = await win.webContents.insertCSS(DARK_CSS);
  await new Promise((r) => setTimeout(r, 500));
  const after = meanLuma(await grab());

  console.log(`平均亮度 反色前=${before.toFixed(1)} 反色后=${after.toFixed(1)} 关键key=${!!key}`);
  const ok = after < before * 0.6;
  console.log(ok ? 'PASS：整页被压暗（强制深色生效）' : 'FAIL：页面亮度没有明显下降');
  try { srv.close(); } catch (e) {}
  app.exit(ok ? 0 : 1);
});
