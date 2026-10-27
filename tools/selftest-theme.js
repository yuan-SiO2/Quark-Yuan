'use strict';
/**
 * 自测：主题切换已移入「设置」——深色/亮色分段按钮生效，头部不再有主题按钮。
 * 运行：./node_modules/.bin/electron tools/selftest-theme.js
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

const READ = `(() => {
  const host = document.getElementById('qh-panel-host');
  const root = host && host.shadowRoot;
  if (!root) return { exists: false };
  const seg = (id) => root.getElementById(id);
  return {
    exists: true,
    theme: host.dataset.theme || '',
    bg: getComputedStyle(root.querySelector('.card')).backgroundColor,
    headerHasTheme: !!root.getElementById('theme'),
    darkOn: seg('themeDark') ? seg('themeDark').classList.contains('on') : null,
    lightOn: seg('themeLight') ? seg('themeLight').classList.contains('on') : null,
  };
})()`;

let ipcThemes = [];

app.whenReady().then(async () => {
  ipcMain.on('qh:set-theme', (_e, mode) => ipcThemes.push(mode));

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

  const a = await win.webContents.executeJavaScript(READ, true);
  console.log('初始:', a);

  // 打开设置，点「亮色」
  await win.webContents.executeJavaScript(
    `document.getElementById('qh-panel-host').shadowRoot.getElementById('settings').click(); true`, true);
  await new Promise((r) => setTimeout(r, 200));
  await win.webContents.executeJavaScript(
    `document.getElementById('qh-panel-host').shadowRoot.getElementById('themeLight').click(); true`, true);
  await new Promise((r) => setTimeout(r, 350));
  const b = await win.webContents.executeJavaScript(READ, true);
  console.log('点亮色后:', b);

  // 点回「深色」
  await win.webContents.executeJavaScript(
    `document.getElementById('qh-panel-host').shadowRoot.getElementById('themeDark').click(); true`, true);
  await new Promise((r) => setTimeout(r, 350));
  const c = await win.webContents.executeJavaScript(READ, true);
  console.log('点深色后:', c);

  const res = {
    头部无主题按钮: a.headerHasTheme === false,
    设置内有分段按钮: a.darkOn === true && a.lightOn === false,
    默认深色: a.theme === 'dark' && /24,\s*24,\s*24/.test(a.bg),
    可切到亮色: b.theme === 'light' && /249,\s*249,\s*249/.test(b.bg) && b.lightOn === true,
    可切回深色: c.theme === 'dark' && c.darkOn === true,
    已发主题IPC: ipcThemes.join(',') === 'light,dark',
  };
  console.log('结果:', res, '| IPC:', ipcThemes);
  const ok = Object.values(res).every(Boolean);
  console.log(ok ? 'PASS：主题切换在设置内，深/亮双向生效' : 'FAIL');
  try { srv.close(); } catch (e) {}
  app.exit(ok ? 0 : 1);
});
