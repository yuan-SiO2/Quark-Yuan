'use strict';
/**
 * 自测：屏蔽「下载超限」弹窗 + 独立兄弟遮罩 + body 滚动锁，且不影响正常弹窗。
 * 运行：./node_modules/.bin/electron tools/selftest-suppress.js
 */
const { app, BrowserWindow } = require('electron');
const { hooksSource } = require('../src/hooks.js');

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:sans-serif;overflow:hidden}
.page{padding:20px}
.mask-xyz{position:fixed;inset:0;background:rgba(0,0,0,.5)}
.wrap-a{position:fixed;left:35%;top:35%}
.wrap-b{background:#fff;padding:20px;width:420px}
.dlg h3{margin:0 0 8px}
.other-dialog{position:fixed;left:10px;top:10px;background:#eee;padding:10px}
</style></head><body>
<div class="page">网盘文件列表</div>
<div class="mask-xyz"></div>
<div class="wrap-a"><div class="wrap-b"><div class="dlg" role="dialog">
  <h3>超过网页端文件下载大小限制，请使用客户端下载</h3>
  <p>若未安装夸克网盘，请下载并安装 夸克网盘</p>
</div></div></div>
<div class="other-dialog" role="dialog"><p>这是正常弹窗，不应被隐藏</p></div>
</body></html>`;

const CHECK = `(() => {
  const visible = (el) => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const mask = document.querySelector('.mask-xyz');
  const dlg = document.querySelector('.dlg');
  const other = document.querySelector('.other-dialog');
  return {
    dialogHidden: !visible(dlg),
    maskHidden: !visible(mask),
    bodyUnlocked: getComputedStyle(document.body).overflow !== 'hidden',
    otherVisible: visible(other),
  };
})()`;

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
  await new Promise((r) => setTimeout(r, 700));
  const res = await win.webContents.executeJavaScript(CHECK, true);
  console.log('检查结果:', res);
  const ok = res.dialogHidden && res.maskHidden && res.bodyUnlocked && res.otherVisible;
  console.log(ok ? 'PASS：弹窗+遮罩都清掉、滚动恢复，正常弹窗未受影响' : 'FAIL');
  app.exit(ok ? 0 : 1);
});
