'use strict';
/**
 * 自测：转存窗口——树形展开分享、勾选文件夹/内部文件、选目标目录、只转存勾选项。
 * 运行：DISPLAY=:0 ./node_modules/.bin/electron tools/selftest-savewindow.js --no-sandbox --ozone-platform=x11
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

let savedPayload = null;
const probeDirs = [];

const ROOT = [
  { fid: 'F_DIR', token: 'T_DIR', name: '子目录', size: 0, dir: true },
  { fid: 'F1', token: 'T1', name: 'a.safetensors', size: 1073741824, dir: false },
];
const INNER = [
  { fid: 'F_SUB', token: 'T_SUB', name: '深一层', size: 0, dir: true },
  { fid: 'F3', token: 'T3', name: 'x.safetensors', size: 52428800, dir: false },
  { fid: 'F4', token: 'T4', name: 'y.7z', size: 1048576, dir: false },
];
const DEEP = [{ fid: 'F9', token: 'T9', name: 'deep.bin', size: 4096, dir: false }];

app.whenReady().then(async () => {
  ipcMain.handle('qh:share-probe', async (_e, payload) => {
    const dir = (payload && payload.dir) || '0';
    probeDirs.push(dir);
    const files = dir === 'F_DIR' ? INNER : dir === 'F_SUB' ? DEEP : ROOT;
    return { ok: true, title: '测试分享', dir, total: files.length, truncated: false, files };
  });
  ipcMain.handle('qh:list-folders', async (_e, fid) => ({
    pdirFid: fid || '0',
    dirs: fid === '0' ? [{ fid: 'DIR_A', name: '模型' }, { fid: 'DIR_B', name: '工具' }] : [],
  }));
  ipcMain.handle('qh:get-theme-sync', () => 'dark');
  ipcMain.handle('qh:share-save', async (_e, payload) => {
    savedPayload = payload;
    return { ok: true, count: (payload.items || payload.fids || []).length };
  });

  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 760,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'save-window-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'save-window.html'));
  await new Promise((r) => setTimeout(r, 900));

  const js = (code) => win.webContents.executeJavaScript(code, true);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const row = (name) =>
    `Array.from(document.querySelectorAll('#files .tree-row')).find((r) => r.querySelector('.name').textContent === ${JSON.stringify(name)})`;
  const check = (name) => js(`(${row(name)}).querySelector('input').click(); true`);

  // 解析
  await js(`document.getElementById('url').value = 'https://pan.quark.cn/s/30666e9bdcc9';
            document.getElementById('probeBtn').click(); true`);
  await sleep(600);
  const afterProbe = await js(`(() => ({
    rows: document.querySelectorAll('#files .tree-row').length,
    folderTags: document.querySelectorAll('#files .tree-row .tag').length,
    count: document.getElementById('count').textContent,
    selAll: document.getElementById('selAll').checked,
    selAllIndeterminate: document.getElementById('selAll').indeterminate,
    saveEnabled: !document.getElementById('saveBtn').disabled,
    names: Array.from(document.querySelectorAll('#files .tree-row .name')).map((n) => n.textContent),
  }))()`);
  console.log('解析后:', afterProbe);

  // 展开分享里的文件夹（点 ▸）
  await js(`document.querySelector('#files .tree-row button.caret').click(); true`);
  await sleep(600);
  const expanded = await js(`(() => {
    const rows = Array.from(document.querySelectorAll('#files .tree-row'));
    const pad = (n) => Number((rows.find((r) => r.querySelector('.name').textContent === n).style.paddingLeft).replace('px', ''));
    return {
      rows: rows.length,
      names: rows.map((r) => r.querySelector('.name').textContent),
      innerIndented: pad('x.safetensors') > pad('子目录'),
      caret: document.querySelector('#files .tree-row button.caret').textContent,
    };
  })()`);
  console.log('展开后:', expanded);

  // 勾选一个内部文件
  await check('x.safetensors');
  await sleep(150);
  const innerPicked = await js(`(() => ({
    count: document.getElementById('count').textContent,
    saveEnabled: !document.getElementById('saveBtn').disabled,
    folderIndeterminate: (${row('子目录')}).querySelector('input').indeterminate,
  }))()`);
  console.log('勾选内部文件后:', innerPicked);

  // 再勾选根层文件
  await check('a.safetensors');
  await sleep(150);

  // 展开第三层（文件夹里还有文件夹），并勾选最里面的文件
  await js(`(${row('深一层')}).querySelector('button.caret').click(); true`);
  await sleep(600);
  const deepExpanded = await js(`(() => ({
    rows: document.querySelectorAll('#files .tree-row').length,
    hasDeep: !!(${row('deep.bin')}),
  }))()`);
  await check('deep.bin');
  await sleep(150);
  const deepPicked = await js(`(() => ({
    count: document.getElementById('count').textContent,
    subIndeterminate: (${row('深一层')}).querySelector('input').indeterminate,
    folderIndeterminate: (${row('子目录')}).querySelector('input').indeterminate,
  }))()`);
  console.log('展开/勾选深层后:', deepExpanded, deepPicked);

  // 勾选整个文件夹：应把已单独勾选的子孙收进整包（不重复转存）
  await check('子目录');
  await sleep(150);
  const folderPicked = await js(`(() => ({
    count: document.getElementById('count').textContent,
    childDisabled: (${row('x.safetensors')}).querySelector('input').disabled,
    childChecked: (${row('x.safetensors')}).querySelector('input').checked,
    childCovered: (${row('x.safetensors')}).classList.contains('covered'),
    deepDisabled: (${row('deep.bin')}).querySelector('input').disabled,
    deepChecked: (${row('deep.bin')}).querySelector('input').checked,
  }))()`);
  console.log('勾选整个文件夹后:', folderPicked);

  // 取消整个文件夹：子项（含深层）恢复可单独挑
  await check('子目录');
  await sleep(150);
  const folderUnchecked = await js(`(() => ({
    count: document.getElementById('count').textContent,
    childDisabled: (${row('x.safetensors')}).querySelector('input').disabled,
    childChecked: (${row('x.safetensors')}).querySelector('input').checked,
    deepDisabled: (${row('deep.bin')}).querySelector('input').disabled,
    deepChecked: (${row('deep.bin')}).querySelector('input').checked,
  }))()`);
  console.log('取消整个文件夹后:', folderUnchecked);

  // 重新勾内部文件（最终只转这两项 + 根层文件）
  await check('x.safetensors');
  await sleep(150);
  const finalPicked = await js(`document.getElementById('count').textContent`);
  console.log('最终勾选:', finalPicked);

  // 选择目标目录
  await js(`document.querySelectorAll('#folders .folder')[0].click(); true`);
  await sleep(400);
  const crumb = await js(`document.getElementById('crumb').textContent`);
  console.log('目标目录:', crumb);

  // 转存
  await js(`document.getElementById('saveBtn').click(); true`);
  await sleep(500);
  const msg = await js(`document.getElementById('msg').textContent`);
  console.log('结果消息:', msg);
  console.log('提交内容:', savedPayload && { fids: savedPayload.fids, items: savedPayload.items });

  const items = (savedPayload && savedPayload.items) || [];
  const res = {
    解析出根层: afterProbe.rows === 2 && afterProbe.folderTags === 1,
    默认不预选: /共选 0 项/.test(afterProbe.count) && afterProbe.selAll === false && afterProbe.saveEnabled === false,
    可展开文件夹: expanded.rows === 5 && expanded.names.join(',') === '子目录,深一层,x.safetensors,y.7z,a.safetensors',
    子项有缩进: expanded.innerIndented === true && expanded.caret === '▾',
    probe带上了目录: probeDirs.join(',') === '0,F_DIR,F_SUB',
    可勾选内部文件: /共选 1 项/.test(innerPicked.count) && innerPicked.saveEnabled === true,
    上级变半选: innerPicked.folderIndeterminate === true,
    三层可展开: deepExpanded.rows === 6 && deepExpanded.hasDeep === true,
    深层半选传导: /共选 3 项/.test(deepPicked.count) &&
      deepPicked.subIndeterminate === true && deepPicked.folderIndeterminate === true,
    勾文件夹收拢子项: /共选 2 项/.test(folderPicked.count),
    子项显示已包含: folderPicked.childDisabled === true && folderPicked.childChecked === true && folderPicked.childCovered === true,
    深层也显示已包含: folderPicked.deepDisabled === true && folderPicked.deepChecked === true,
    取消文件夹后子项可挑: folderUnchecked.childDisabled === false && folderUnchecked.childChecked === false && /共选 1 项/.test(folderUnchecked.count),
    取消文件夹后深层可挑: folderUnchecked.deepDisabled === false && folderUnchecked.deepChecked === false,
    最终勾选正确: /共选 2 项/.test(finalPicked),
    可选择目标目录: crumb === '根目录 / 模型',
    只转存勾选项: !!savedPayload && JSON.stringify(savedPayload.fids) === '["F1","F3"]',
    内部文件token带上: items.length === 2 && items[1].fid === 'F3' && items[1].token === 'T3',
    带上所在目录: items.length === 2 && items[0].parentFid === '0' && items[1].parentFid === 'F_DIR',
    目标目录传对: !!savedPayload && savedPayload.toPdirFid === 'DIR_A',
    成功提示: /已转存 2 项/.test(msg),
  };
  console.log('结果:', res);
  const ok = Object.values(res).every(Boolean);
  console.log(ok ? 'PASS：树形展开分享，可勾文件夹或内部文件，只转存勾选项' : 'FAIL');
  app.exit(ok ? 0 : 1);
});
