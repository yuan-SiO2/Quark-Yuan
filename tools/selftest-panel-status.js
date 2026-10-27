'use strict';
/**
 * 自测：面板状态圆点（绿=正常/红=异常）、去掉「引擎就绪」字样、圆点在「目录」左边、清除按钮逻辑。
 * 运行：./node_modules/.bin/electron tools/selftest-panel-status.js
 */
const { app, BrowserWindow } = require('electron');
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

const READ = `(() => { try {
  const host = document.getElementById('qh-panel-host');
  if (!host || !host.shadowRoot) return { exists: false };
  const root = host.shadowRoot;
  const dot = root.getElementById('dot');
  const openDir = root.getElementById('openDir');
  const clear = root.getElementById('clear');
  const card = root.querySelector('.card');
  return {
    exists: true,
    dotClass: dot ? dot.className : '',
    dotColor: dot ? getComputedStyle(dot).backgroundColor : '',
    dotFirst: !!(dot && dot.parentElement && dot.parentElement.firstElementChild === dot),
    hasEngineText: /引擎就绪/.test(card ? card.textContent : ''),
    clearDisabled: clear ? !!clear.disabled : null,
    miniState: (() => { const m = root.querySelector('.mini'); return m ? (m.dataset.state || '') : ''; })(),
    miniBorder: (() => { const m = root.querySelector('.mini'); return m ? getComputedStyle(m).borderTopColor : ''; })(),
    miniHasImg: (() => {
      const m = root.querySelector('.mini');
      const i = m && m.querySelector('img');
      return !!(i && String(i.getAttribute('src') || '').indexOf('data:image/png') === 0);
    })(),
  };
  } catch (e) { return { exists: false, err: e && e.message }; }
})()`;

app.whenReady().then(async () => {
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
  win.webContents.on('console-message', (e) => {
    if (e && e.message) console.log('[renderer]', e.message);
  });
  win.webContents.on('preload-error', (_e, f, err) => console.log('[preload-error]', err && err.message));
  await win.loadURL(`http://127.0.0.1:${port}/list/all`);
  await new Promise((r) => setTimeout(r, 900));

  // 正常状态
  win.webContents.send('qh:state', {
    engine: { ok: true, msg: '就绪' },
    login: { ok: true, msg: '登录态已同步' },
    jobs: [{ id: 'j1', name: 'a.bin', status: 'done', received: 10, size: 10, speed: 0 }],
  });
  await new Promise((r) => setTimeout(r, 300));
  const okState = await win.webContents.executeJavaScript(READ, true);
  console.log('正常:', okState);

  // 空任务状态（用于蓝色判定）
  win.webContents.send('qh:state', { engine: { ok: true }, login: { ok: true }, downloadDir: '/tmp/qh', jobs: [] });
  await new Promise((r) => setTimeout(r, 300));
  const emptyState = await win.webContents.executeJavaScript(READ, true);
  console.log('空任务:', emptyState);

  // 异常状态（引擎不可用 + 有失败任务）
  win.webContents.send('qh:state', {
    engine: { ok: false, msg: '引擎不存在' },
    login: { ok: true },
    jobs: [
      { id: 'j2', name: 'b.bin', status: 'error', received: 1, size: 10, speed: 0, error: 'x' },
      { id: 'j3', name: 'c.bin', status: 'cancelled', received: 1, size: 10, speed: 0 },
    ],
  });
  await new Promise((r) => setTimeout(r, 300));
  const badState = await win.webContents.executeJavaScript(READ, true);
  console.log('异常:', badState);

  // 只有进行中任务时，清除按钮应置灰
  win.webContents.send('qh:state', {
    engine: { ok: true },
    login: { ok: true },
    jobs: [{ id: 'j4', name: 'd.bin', status: 'running', received: 5, size: 10, speed: 1024 }],
  });
  await new Promise((r) => setTimeout(r, 300));
  const running = await win.webContents.executeJavaScript(READ, true);
  console.log('仅进行中:', running);

  const res = {
    正常显示绿色: okState.dotClass.indexOf('ok') !== -1 && /0,\s*162,\s*64/.test(okState.dotColor),
    异常显示红色: badState.dotClass.indexOf('err') !== -1 && /224,\s*46,\s*42/.test(badState.dotColor),
    圆点在最左侧: okState.dotFirst === true,
    已去掉引擎就绪字样: okState.hasEngineText === false && badState.hasEngineText === false,
    有已结束任务时清除可用: okState.clearDisabled === false && badState.clearDisabled === false,
    仅进行中时清除置灰: running.clearDisabled === true,
    无任务描边为蓝色: emptyState.miniState === 'idle' && /37,\s*99,\s*235/.test(emptyState.miniBorder),
    有任务描边为绿色: okState.miniState === 'active' && /0,\s*162,\s*64/.test(okState.miniBorder),
    圆形按钮显示项目图标: emptyState.miniHasImg === true && okState.miniHasImg === true,
  };
  console.log('结果:', res);
  const ok = Object.values(res).every(Boolean);
  console.log(ok ? 'PASS：圆点绿/红正确、无文字状态、清除按钮逻辑正确' : 'FAIL');
  try { srv.close(); } catch (e) {}
  app.exit(ok ? 0 : 1);
});
