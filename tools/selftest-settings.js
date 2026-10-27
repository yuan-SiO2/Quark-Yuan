'use strict';
/**
 * 自测：头部布局顺序、设置面板可改下载目录（IPC 往返）、最小化为圆形按钮。
 * 运行：./node_modules/.bin/electron tools/selftest-settings.js
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

let savedDir = null;

const HEADER = `(() => {
  const host = document.getElementById('qh-panel-host');
  const root = host && host.shadowRoot;
  const hd = root && root.querySelector('.hd');
  const kids = hd ? Array.from(hd.children).map((el) => el.id || el.className) : [];
  return { kids };
})()`;

app.whenReady().then(async () => {
  ipcMain.on('qh:set-download-dir', (_e, dir) => {
    savedDir = dir;
  });

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

  // 头部顺序 + 当前目录
  win.webContents.send('qh:state', {
    engine: { ok: true },
    login: { ok: true },
    downloadDir: '/tmp/qh-dir-A',
    jobs: [],
  });
  await new Promise((r) => setTimeout(r, 300));
  const header = await win.webContents.executeJavaScript(HEADER, true);
  console.log('头部元素顺序:', header.kids);

  // 打开设置
  await win.webContents.executeJavaScript(
    `document.getElementById('qh-panel-host').shadowRoot.getElementById('settings').click(); true`, true);
  await new Promise((r) => setTimeout(r, 250));
  const pane = await win.webContents.executeJavaScript(
    `(() => {
      const root = document.getElementById('qh-panel-host').shadowRoot;
      const pane = root.getElementById('settings-pane');
      return { shown: pane.classList.contains('on'), value: root.getElementById('dirInput').value };
    })()`, true);
  console.log('设置面板:', pane);

  // 改路径并保存
  await win.webContents.executeJavaScript(
    `(() => {
      const root = document.getElementById('qh-panel-host').shadowRoot;
      const i = root.getElementById('dirInput');
      i.value = '/tmp/quark-e2e-target';
      root.getElementById('saveDir').click();
      return true;
    })()`, true);
  await new Promise((r) => setTimeout(r, 300));

  // 最小化 → 圆形按钮
  await win.webContents.executeJavaScript(
    `document.getElementById('qh-panel-host').shadowRoot.getElementById('hide').click(); true`, true);
  await new Promise((r) => setTimeout(r, 250));
  const mini = await win.webContents.executeJavaScript(
    `(() => {
      const root = document.getElementById('qh-panel-host').shadowRoot;
      const m = root.querySelector('.mini');
      if (!m) return { exists: false };
      const cs = getComputedStyle(m);
      const r = m.getBoundingClientRect();
      return {
        exists: true,
        display: cs.display,
        radius: cs.borderRadius,
        square: Math.abs(r.width - r.height) < 1.5 && r.width > 30,
      };
    })()`, true);
  console.log('最小化按钮:', mini);

  const res = {
    圆点在标题前: header.kids[0] === 'dot' && header.kids[1] === 'title',
    按钮顺序正确:
      header.kids.slice(2).join(',') === 'grow,linksBtn,clear,openDir,settings,hide',
    设置显示当前目录: pane.shown === true && pane.value === '/tmp/qh-dir-A',
    保存触发IPC: savedDir === '/tmp/quark-e2e-target',
    最小化为圆形: mini.exists && mini.display === 'flex' && /50%/.test(mini.radius) && mini.square,
    头部无主题按钮: header.kids.indexOf('theme') === -1,
    主题在设置内: await (async () => {
      const r = await win.webContents.executeJavaScript(
        `(() => { const root = document.getElementById('qh-panel-host').shadowRoot;
          return !!(root.getElementById('themeDark') && root.getElementById('themeLight')
            && root.getElementById('settings-pane').contains(root.getElementById('themeDark'))); })()`, true);
      return r === true;
    })(),
  };
  console.log('结果:', res);
  const ok = Object.values(res).every(Boolean);
  console.log(ok ? 'PASS：布局符合要求、设置可改目录、最小化为圆形' : 'FAIL');
  try { srv.close(); } catch (e) {}
  app.exit(ok ? 0 : 1);
});
