'use strict';
const { app, BrowserWindow, session, ipcMain, shell, Menu, dialog, nativeImage, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { loadConfig, saveConfig, saveCookie } = require('./config');
const { Engine } = require('./engine');
const { DARK_CSS } = require('./theme');
const { isDriveDownloadUrl } = require('./urls');

const cfg = loadConfig();
const { parseClientUrl } = require('./protocol');
const engine = new Engine(cfg);
const PARTITION = 'persist:quark';

const NON_PREVIEW_EXT_MAIN = [
  'safetensors', 'ckpt', 'pt', 'pth', 'bin', 'gguf', 'onnx', 'h5', 'pkl',
  '7z', 'zip', 'rar', 'tar', 'gz', 'xz', 'zst', 'iso', 'dmg', 'apk', 'exe', 'msi',
  'psd', 'ai', 'blend', 'fbx', 'obj', 'step', 'stp', 'iges',
];
const COOKIE_SYNC_MS = 20000;

let win = null;
let lastCookieHeader = '';
const fileMap = new Map(); // fid -> {name,size}
const intents = []; // 最近的下载意图 {fid,name,size,at}

function log(...a) {
  console.log('[qh]', ...a);
}
let loggedCookieNames = '';
let lastPick = null; // {fid,name,size,at} —— 用户最近点中的那一行
let lastApiDownload = null; // {name,size,at} —— 最近一次下载接口成功响应对应的文件

/* ------------------------------------------------------------------ *
 * 页面事件
 * ------------------------------------------------------------------ */
function onPageEvent(ev) {
  if (!ev || !ev.type) return;
  if (ev.type === 'trash-prompt-hidden') {
    log('已隐藏回收站「请用客户端」提示:', ev.text || '');
    return;
  }

  if (ev.type === 'trash-client-action-blocked') {
    log('已拦截回收站页面的客户端按钮点击:', ev.label || '');
    return;
  }

  if (ev.type === 'recycle-route') {
    if (win && !win.isDestroyed()) win.webContents.send('qh:recycle-route', ev.hash || '');
    return;
  }

  if (ev.type === 'share-links' && Array.isArray(ev.links)) {
    if (win && !win.isDestroyed()) win.webContents.send('qh:share-links', ev.links);
    return;
  }

  if (ev.type === 'preview-blocked' && ev.fid) {
    const name = ev.name || '';
    log('拦截不可预览文件的预览跳转:', name.slice(0, 50) || ev.fid, '方式=' + ev.how);
    if (cfg.nonPreviewAction === 'download') {
      const r = engine.enqueue({ fid: ev.fid, name, size: Number(ev.size) || 0 });
      toast(r.ok ? `已开始下载：${name || ev.fid.slice(0, 10)}` : `已在队列中：${name}`);
    } else if (cfg.nonPreviewAction === 'toast') {
      toast(`该文件不支持在线预览：${name || ev.fid.slice(0, 10)}`);
    }
    // 'block'：只拦掉预览跳转，不下载、不打扰（点一下=选中）
    return;
  }

  if (ev.type === 'preview-error-masked') {
    log('已屏蔽预览错误页（20065）:', String(ev.name || '').slice(0, 50) || ev.fid);
    return;
  }

  if (ev.type === 'preview-route' && ev.fid) {
    (async () => {
      let meta = fileMap.get(ev.fid);
      if (!meta || !meta.name) {
        try {
          const info = await require('./quarkapi').fileInfo(ev.fid);
          if (info.name) {
            meta = { name: info.name, size: info.size };
            fileMap.set(ev.fid, meta);
            log('按 fid 补查文件信息:', info.name, (info.size / 1024 ** 3).toFixed(2) + 'GB');
          }
        } catch (e) {
          log('按 fid 补查失败:', e && e.message);
        }
      }
      if (meta && meta.name && win && !win.isDestroyed()) {
        win.webContents.send('qh:preview-meta', { fid: ev.fid, name: meta.name, size: meta.size || 0 });
      }
    })();
    return;
  }

  if (ev.type === 'api-error') {
    log('[api-error]', ev.code, String(ev.message || '').slice(0, 120), '←', String(ev.url || '').slice(0, 110));
    return;
  }

  if (ev.type === 'deeplink') {
    log('[deeplink] 响应:', String(ev.body || '').replace(/\s+/g, ' ').slice(0, 500));
    return;
  }

  if (ev.type === 'download-api') {
    if (Number(ev.code) === 0 && ev.hasUrl) {
      lastApiDownload = { fid: '', name: ev.name || '', size: Number(ev.size) || 0, at: Date.now() };
    }
    log(
      `下载接口响应: status=${ev.status} code=${ev.code} 直链=${ev.hasUrl ? '有' : '无'}` +
        (ev.name ? ` 文件=${ev.name}` : '') +
        (ev.size ? ` 大小=${(ev.size / 1024 ** 3).toFixed(2)}GB` : '')
    );
    return;
  }

  if (ev.type === 'limit-dialog-suppressed') {
    log('已屏蔽网页「下载超限」弹窗:', (ev.text || '').slice(0, 40));
    return;
  }

  if (ev.type === 'ready') {
    log('注入就绪，页面主世界已挂钩:', ev.href);
    return;
  }

  if (ev.type === 'client-url' && ev.url) {
    handleCustomUrl(ev.url, 'page-js', ev);
    return;
  }

  if (ev.type === 'row-pick' && ev.fid) {
    lastPick = { fid: ev.fid, name: ev.name || '', size: Number(ev.size) || 0, at: Date.now() };
    return;
  }

  if (ev.type === 'files' && Array.isArray(ev.entries)) {
    for (const e of ev.entries) {
      if (e && e.fid) fileMap.set(e.fid, { name: e.name || '', size: Number(e.size) || 0 });
    }
    return;
  }

  if (ev.type === 'intent' && ev.fid) {
    const meta = fileMap.get(ev.fid) || {};
    const name = ev.name || meta.name || '';
    const size = Number(ev.size) || meta.size || 0;
    intents.push({ fid: ev.fid, name, size, at: Date.now() });
    while (intents.length > 30) intents.shift();
    log('捕获下载意图', ev.fid, name);
    const r = engine.enqueue({ fid: ev.fid, name, size });
    if (r.ok) toast(`已转交引擎：${name || ev.fid}`);
    else if (r.msg) log('入队失败', r.msg);
    return;
  }

  if (ev.type === 'probe') {
    log('未识别到 fid 的下载请求:', ev.url);
  }
}

function toast(msg) {
  if (win && !win.isDestroyed()) win.webContents.send('qh:toast', msg);
}
/* ------------------------------------------------------------------ *
 * 官方客户端协议：qkclouddrive://download?id=<fid>&user_token=<token>
 *   网页版对大文件不走浏览器下载，而是拉起夸克客户端。
 *   这里把 id 当 fid 交给本地引擎（引擎自己用 cookie 换直链）。
 * ------------------------------------------------------------------ */
const FID_RE = /^[0-9a-f]{32}$/i;

function handleCustomUrl(url, source, hint) {
  const p = parseClientUrl(url);
  if (!p) return false;
  hint = hint || {};

  // 协议里的 64 位 id 不是 API 的 fid（实测 download --id 会 404），需要映射：
  //  1) 响应体检到的 fid（同一条响应里既有 qkclouddrive URL 又有 fid 时最可靠）
  //  2) 用户刚点中那一行对应的 fid
  //  3) 兜底：把协议 id 当 fid 试（多半失败，但便于日志定位）
  let fid = '';
  let how = '';
  if (FID_RE.test(hint.fid || '')) {
    fid = hint.fid;
    how = '响应体 fid';
  } else if (fileMap.has(p.fid)) {
    fid = p.fid;
    how = '协议 id 就是 fid';
  } else if (lastApiDownload && lastApiDownload.name && Date.now() - lastApiDownload.at < 30000) {
    // 用「接口刚返回的文件名」在已知文件表里反查 fid，最权威
    for (const [k, v] of fileMap) {
      if (v.name === lastApiDownload.name) {
        fid = k;
        how = '接口响应反查';
        break;
      }
    }
    if (!fid && lastPick && Date.now() - lastPick.at < 15000) {
      fid = lastPick.fid;
      how = '点击行映射';
    }
  } else if (lastPick && Date.now() - lastPick.at < 15000) {
    fid = lastPick.fid;
    how = '点击行映射';
  } else {
    fid = p.fid;
    how = '无映射(兜底)';
  }

  const meta = fileMap.get(fid) || {};
  const name = hint.name || meta.name || (lastPick && lastPick.fid === fid ? lastPick.name : '') || '';
  const size = Number(hint.size) || Number(meta.size) || (lastPick && lastPick.fid === fid ? lastPick.size : 0) || 0;

  log(
    `捕获客户端协议(${source}): 协议id=${p.fid.slice(0, 12)}… token=${p.token ? '有' : '无'} → fid=${fid.slice(0, 12)}…[${how}] 名称=${name || '未知'}`
  );
  intents.push({ fid, name, size, at: Date.now() });
  while (intents.length > 30) intents.shift();

  const r = engine.enqueue({ fid, name, size });
  if (r.ok) toast(`已接管下载：${name || fid.slice(0, 12) + '…'}`);
  else toast(`未入队：${r.msg || '已在队列'}`);
  return true;
}


/* ------------------------------------------------------------------ *
 * 浏览器自身下载拦截（兜底路径）
 * ------------------------------------------------------------------ */
function installDownloadInterceptor(ses) {
  ses.on('will-download', (event, item) => {
    const name = item.getFilename() || '';
    const url = item.getURL();
    log('拦截浏览器下载:', name, url.slice(0, 120));

    if (cfg.autoCancelBrowserDownload) item.cancel();

    // 1) 按文件名匹配刚捕获的 fid 意图
    const now = Date.now();
    let hit = null;
    for (let i = intents.length - 1; i >= 0; i--) {
      const it = intents[i];
      if (now - it.at > 180000) continue;
      if (it.name && name && (it.name === name || it.name.startsWith(name) || name.startsWith(it.name))) {
        hit = it;
        break;
      }
    }
    // 2) 否则取最近 30 秒内任意意图
    if (!hit) {
      for (let i = intents.length - 1; i >= 0; i--) {
        if (now - intents[i].at < 30000) { hit = intents[i]; break; }
      }
    }

    if (hit) {
      const meta = fileMap.get(hit.fid) || {};
      const r = engine.enqueue({ fid: hit.fid, name: hit.name || name, size: hit.size || meta.size || 0 });
      if (r.ok) toast(`已接管下载：${hit.name || name}`);
      return;
    }

    // 3) 完全没有 fid 时，只有「网盘文件直链」才接管；
    //    其它下载（如客户端安装包 download.quark.cn）一律只取消、不下载
    if (!isDriveDownloadUrl(url)) {
      log('非网盘文件下载，已取消且不接管:', String(url).slice(0, 100));
      return;
    }
    if (/^https?:/i.test(url)) {
      const r = engine.enqueue({ url, name: name || 'download.bin', size: 0 });
      if (r.ok) toast(`直链接管：${name || url.slice(0, 40)}`);
    } else {
      toast('未能识别该下载（blob/未知来源），请在列表里右键「下载」重试');
    }
  });
}

/* ------------------------------------------------------------------ *
 * cookie 同步：webview 登录 → 写入 quark-drive 引擎配置
 * ------------------------------------------------------------------ */
async function syncCookies(reason) {
  if (!cfg.engine.autoLogin) return;
  const ses = session.fromPartition(PARTITION);
  let all = [];
  try {
    all = await ses.cookies.get({});
  } catch (e) {
    return;
  }
  const qk = all.filter((c) => /(^|\.)quark\.cn$/i.test(c.domain || ''));
  if (!loggedCookieNames && qk.length) {
    loggedCookieNames = qk.map((c) => c.name).join(',');
    log('quark.cn cookie 名称:', loggedCookieNames);
  }
  if (!qk.length) return;
  const header = qk.map((c) => `${c.name}=${c.value}`).join('; ');
  if (header === lastCookieHeader) return;
  lastCookieHeader = header;
  saveCookie(header); // 供下载器使用（不依赖引擎）
  log('cookie 变化，同步到引擎', reason, `(${qk.length} cookies)`);
  const r = await engine.login(header);
  log('login 同步结果:', r);
  if (r && r.ok) toast('登录态已同步到下载引擎');
}

/* ------------------------------------------------------------------ *
 * 窗口
 * ------------------------------------------------------------------ */

let pageThemeCssKey = null;

function applyPageTheme(mode) {
  try {
    nativeTheme.themeSource = mode === 'light' ? 'light' : 'dark';
  } catch (e) {}
  const wantDark = mode !== 'light';
  if (!win || win.isDestroyed()) return;
  (async () => {
    try {
      if (pageThemeCssKey) {
        await win.webContents.removeInsertedCSS(pageThemeCssKey).catch(() => {});
        pageThemeCssKey = null;
      }
      if (wantDark) {
        pageThemeCssKey = await win.webContents.insertCSS(DARK_CSS);
        log('已应用网页深色主题');
      } else {
        log('已应用网页亮色主题');
      }
      // 同步给页面脚本：处理图片/头像的「反反色」，避免双重反色变负片
      await win.webContents
        .executeJavaScript(`window.__qhThemeFix && window.__qhThemeFix('${wantDark ? 'dark' : 'light'}')`, true)
        .catch(() => {});
    } catch (e) {
      log('应用页面主题失败:', e && e.message);
    }
  })();
}

function saveTheme(mode) {
  saveConfig({ appTheme: mode });
}

let saveWin = null;

/** 打开「转存分享」窗口：可勾选文件、选择目标目录 */
function openSaveWindow(prefill) {
  if (saveWin && !saveWin.isDestroyed()) {
    saveWin.show();
    saveWin.focus();
    if (prefill && prefill.url) saveWin.webContents.send('qh:save-prefill', prefill);
    return saveWin;
  }
  saveWin = new BrowserWindow({
    width: 900,
    height: 760,
    minWidth: 720,
    minHeight: 560,
    title: 'Quark-Yuan · 转存分享',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    backgroundColor: '#181818',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'save-window-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  saveWin.setMenuBarVisibility(false);
  const send = () => {
    if (prefill && prefill.url && saveWin && !saveWin.isDestroyed()) {
      saveWin.webContents.send('qh:save-prefill', prefill);
    }
  };
  saveWin.webContents.on('did-finish-load', () => setTimeout(send, 300));
  saveWin.on('closed', () => {
    saveWin = null;
  });
  saveWin.loadFile(path.join(__dirname, 'save-window.html'));
  return saveWin;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    title: 'Quark-Yuan · 夸克网盘',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    backgroundColor: '#181818',
    autoHideMenuBar: true,
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      spellcheck: false,
    },
  });

  Menu.setApplicationMenu(null);

  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
      win.webContents.toggleDevTools();
      e.preventDefault();
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^qkclouddrive:/i.test(url)) {
      handleCustomUrl(url, 'window.open');
      return { action: 'deny' };
    }
    if (/^https?:\/\/([a-z0-9-]+\.)?quark\.cn\//i.test(url)) {
      const m = new RegExp('#/(?:doc|video|player|image|img|pic|preview)/([0-9a-zA-Z]{16,40})').exec(url);
      if (m) {
        const fid = m[1];
        const meta = fileMap.get(fid);
        const ext = meta && meta.name ? String(meta.name).split('.').pop().toLowerCase() : '';
        const PREVIEWABLE_MAIN = [
          'mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'ts', 'mpg', 'mpeg', 'rmvb',
          'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'heic', 'avif',
          'mp3', 'flac', 'wav', 'aac', 'm4a', 'ogg', 'ape',
          'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'epub',
        ];
        const bad =
          cfg.previewBlockAll ||
          (ext && PREVIEWABLE_MAIN.indexOf(ext) === -1 && NON_PREVIEW_EXT_MAIN.indexOf(ext) !== -1);
        if (bad) {
          log('拦截新窗口预览:', meta && meta.name ? meta.name : fid);
          if (cfg.nonPreviewAction === 'download') {
            const r = engine.enqueue({ fid: fid, name: meta.name, size: Number(meta.size) || 0 });
            toast(r.ok ? `已开始下载：${meta.name}` : '已在队列中');
          } else if (cfg.nonPreviewAction === 'toast') {
            toast(`该文件不支持在线预览：${meta.name}`);
          }
          return { action: 'deny' };
        }
      }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          icon: path.join(__dirname, '..', 'assets', 'icon.png'),
          webPreferences: { partition: PARTITION, preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false },
        },
      };
    }
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
    else log('忽略未知协议外链:', String(url).slice(0, 80));
    return { action: 'deny' };
  });

  // 页面用 location.href / iframe / 表单跳到自定义协议时，Chromium 会尝试交给系统处理
  // （就是那个「无法读取文件」），这里在导航阶段接走
  win.webContents.on('will-navigate', (e, url) => {
    if (/^qkclouddrive:/i.test(url)) {
      e.preventDefault();
      handleCustomUrl(url, 'will-navigate');
    }
  });
  win.webContents.on('will-frame-navigate', (e) => {
    const url = e && e.url;
    if (url && /^qkclouddrive:/i.test(url)) {
      e.preventDefault();
      handleCustomUrl(url, 'subframe');
    }
  });

  win.webContents.on('did-finish-load', () => {
    log('页面加载完成:', win.webContents.getURL());
    applyPageTheme(cfg.appTheme || 'dark');
    syncCookies('did-finish-load');
  });

  win.on('closed', () => {
    win = null;
  });

  win.loadURL(cfg.startUrl);
  if (process.env.QH_DEVTOOLS === '1') win.webContents.openDevTools({ mode: 'detach' });
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png'));
      if (process.platform === 'linux') app.setDesktopName ? app.setDesktopName('quark-yuan.desktop') : null;
      if (!icon.isEmpty()) log('应用图标已载入:', icon.getSize().width + 'x' + icon.getSize().height);
    } catch (e) {
      log('图标载入失败:', e && e.message);
    }
    const ses = session.fromPartition(PARTITION);
    ses.setUserAgent(cfg.userAgent);
    ses.setDownloadPath(cfg.downloadDir);
    installDownloadInterceptor(ses);

    // 让网页自己的下载请求以「客户端」身份发出：
    // 服务端看到客户端 UA 才会返回真正的 download_url（而不是 23018 超限），
    // 页面拿不到 23018 就不会弹「请使用客户端下载」——从源头消除提示。
    if (cfg.spoofClientUA !== false) {
      const spoofUA = (cfg.engine && cfg.engine.clientUA) || 'quark-cloud-drive/3.14.2 (Windows NT 10.0; Win64; x64)';
      try {
        ses.webRequest.onBeforeSendHeaders(
          {
            urls: [
              'https://drive-pc.quark.cn/1/clouddrive/file/download*',
              'https://drive-pc.quark.cn/1/clouddrive/file/download/*',
              'https://drive.quark.cn/1/clouddrive/file/download*',
            ],
          },
          (details, cb) => {
            const h = details.requestHeaders || {};
            if (!global.__qhUASpoofLogged) {
              global.__qhUASpoofLogged = true;
              log('UA 改写命中:', String(details.url).slice(0, 90), '原UA→', String(h['User-Agent'] || h['user-agent'] || '').slice(0, 40));
            }
            h['User-Agent'] = spoofUA;
            h['user-agent'] = spoofUA;
            cb({ requestHeaders: h });
          }
        );
        log('已启用下载接口 UA 伪装:', spoofUA);
      } catch (e) {
        log('UA 伪装注册失败:', e && e.message);
      }
    }

    // 说明：Electron 的 webRequest 过滤器只接受 http(s)/ws(s)/file 等 scheme，
    // 注册 qkclouddrive:// 会直接报 "Wrong scheme type"，所以协议拦截只走
    // JS 层（页面钩子）+ 导航层（will-navigate / will-frame-navigate / window.open）。
    try {
      fs.mkdirSync(cfg.downloadDir, { recursive: true });
    } catch (e) {}

    engine.on('state', (s) => {
      if (win && !win.isDestroyed()) win.webContents.send('qh:state', s);
    });

    ipcMain.on('qh:page-event', (_e, ev) => {
      try {
        onPageEvent(ev);
      } catch (err) {
        log('处理页面事件失败', err && err.message);
      }
    });
    ipcMain.on('qh:hello', () => {
      if (win && !win.isDestroyed()) win.webContents.send('qh:state', engine.snapshot());
    });
    ipcMain.on('qh:set-theme', (_e, mode) => {
      const t = mode === 'light' ? 'light' : 'dark';
      cfg.appTheme = t;
      saveTheme(t);
      applyPageTheme(t);
      if (win && !win.isDestroyed()) win.webContents.send('qh:theme', t);
      log('主题切换:', t);
    });
    ipcMain.on('qh:get-theme', (e) => {
      e.sender.send('qh:theme', cfg.appTheme === 'light' ? 'light' : 'dark');
    });

    ipcMain.on('qh:pick-dir', async () => {
      try {
        const r = await dialog.showOpenDialog(win, {
          title: '选择下载目录',
          defaultPath: cfg.downloadDir,
          properties: ['openDirectory', 'createDirectory'],
        });
        if (!r.canceled && r.filePaths && r.filePaths[0] && win && !win.isDestroyed()) {
          win.webContents.send('qh:download-dir', { dir: r.filePaths[0], saved: false });
        }
      } catch (e) {
        log('选择目录失败:', e && e.message);
      }
    });

    ipcMain.on('qh:set-download-dir', (_e, dir) => {
      try {
        const d = String(dir || '').trim();
        if (!d) return;
        fs.mkdirSync(d, { recursive: true });
        cfg.downloadDir = d;
        if (engine && engine.cfg) engine.cfg.downloadDir = d;
        // 持久化
        saveConfig({ downloadDir: d });
        ses.setDownloadPath(d);
        if (win && !win.isDestroyed()) win.webContents.send('qh:download-dir', { dir: d, saved: true });
        engine.emitState();
        log('下载目录已改为:', d);
      } catch (e) {
        log('设置下载目录失败:', e && e.message);
      }
    });

    // ---- 转存窗口 ----
    ipcMain.handle('qh:share-probe', async (_e, payload) => {
      try {
        const r = await require('./quarkapi').probeShare(
          (payload && payload.url) || '',
          (payload && payload.pwd) || '',
          (payload && payload.dir) || '0'
        );
        return { ok: true, title: r.title, dir: r.pdirFid, total: r.total, truncated: r.truncated, files: r.files };
      } catch (e) {
        return { ok: false, error: e && e.message, files: [] };
      }
    });

    ipcMain.handle('qh:share-save', async (_e, payload) => {
      const url = (payload && payload.url) || '';
      const pwd = (payload && payload.pwd) || '';
      const toPdir = (payload && payload.toPdirFid) || '0';
      // items: 跨层勾选结果 [{fid, parentFid}]（token 由主进程按本次 stoken 现取）
      const items = Array.isArray(payload && payload.items)
        ? payload.items
            .filter((x) => x && typeof x === 'object' && x.fid)
            .map((x) => ({ fid: String(x.fid), parentFid: String(x.parentFid || '0') }))
        : [];
      const fids = (payload && payload.fids) || [];
      const picked = items.length ? items : fids;
      log('转存(窗口):', url, '勾选', picked.length, '项 → 目录', toPdir);
      try {
        const r = await require('./quarkapi').saveShareToDrive(url, pwd, toPdir, picked);
        log('转存成功:', r.count, '项, task=', r.taskId);
        return { ok: true, count: r.count };
      } catch (e) {
        log('转存失败:', e && e.message);
        return { ok: false, message: e && e.message };
      }
    });

    ipcMain.handle('qh:get-theme-sync', () => (cfg.appTheme === 'light' ? 'light' : 'dark'));

    ipcMain.on('qh:win-close', (e) => {
      try {
        const w = BrowserWindow.fromWebContents(e.sender);
        if (w) w.close();
      } catch (err) {}
    });

    ipcMain.on('qh:open-save-window', (_e, payload) => {
      openSaveWindow(payload || {});
    });

    ipcMain.handle('qh:list-folders', async (_e, pdirFid) => {
      try {
        return await require('./quarkapi').listFolders(pdirFid || '0');
      } catch (e) {
        log('列目录失败:', e && e.message);
        return { pdirFid: pdirFid || '0', dirs: [], error: e.message };
      }
    });

    ipcMain.handle('qh:recycle-list', async () => {
      try {
        const r = await require('./quarkapi').recycleList(1, 50);
        log('回收站列表:', r.total, '条（返回', r.list.length, '）');
        return r;
      } catch (e) {
        log('回收站列表失败:', e && e.message);
        return { total: 0, list: [], error: e.message };
      }
    });

    ipcMain.on('qh:clear-finished', () => {
      const n = engine.clearFinished();
      log('清除已结束任务:', n);
    });
    ipcMain.on('qh:open-dir', () => {
      shell.openPath(cfg.downloadDir).catch(() => {});
    });
    ipcMain.on('qh:cancel', (_e, id) => {
      engine.cancel(id);
    });

    await engine.info();
    log('引擎自检:', engine.engineInfo);

    createWindow();

    setInterval(() => syncCookies('interval'), COOKIE_SYNC_MS);
    ses.cookies.on('changed', debounce(() => syncCookies('cookie-changed'), 1500));

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    engine.killAll();
  });
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
