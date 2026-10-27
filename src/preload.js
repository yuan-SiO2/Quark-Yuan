'use strict';
const { ipcRenderer, webFrame } = require('electron');
const { hooksSource } = require('./hooks');

/* ------------------------------------------------------------------ *
 * 1. 把钩子注入页面主世界（main world），必须在页面脚本之前
 * ------------------------------------------------------------------ */
let panelCfg = {};
try {
  panelCfg = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'config.json'), 'utf8'));
} catch (e) {}

let installed = false;
function installHooks() {
  if (installed) return;
  installed = true;
  try {
    const p = webFrame.executeJavaScript(hooksSource({ hideLimitDialog: !!panelCfg.hideLimitDialog, blockPreviewAll: !!panelCfg.previewBlockAll }), true);
    if (p && typeof p.catch === 'function') {
      p.then((r) => console.log('[qh] hooks:', r)).catch((e) => console.warn('[qh] hooks 注入失败:', e));
    }
  } catch (e) {
    console.warn('[qh] 注入异常:', e && e.message);
  }
}
installHooks();

/* ------------------------------------------------------------------ *
 * 2. 转发页面主世界的消息给主进程
 * ------------------------------------------------------------------ */
window.addEventListener('message', (ev) => {
  const d = ev && ev.data;
  if (!d || d.__quark_hybrid__ !== true) return;
  ipcRenderer.send('qh:page-event', {
    type: d.type,
    fid: d.fid,
    name: d.name,
    size: d.size,
    entries: d.entries,
    url: d.url,
    href: d.href,
    text: d.text,
    code: d.code,
    status: d.status,
    hasUrl: d.hasUrl,
    body: d.body,
    code: d.code,
    message: d.message,
  });
});

/* ------------------------------------------------------------------ *
 * 3. 右下角进度面板（隔离世界，DOM 与页面共享）
 * ------------------------------------------------------------------ */
const CSS = `
:host {
  all: initial;
  /* 深色：取自 PI-Desktop（--gray-900/800/750/1000、--gray-100/300） */
  --qh-bg: #181818;
  --qh-fg: #ededed;
  --qh-bd: rgba(255,255,255,.10);
  --qh-hd1: #212121;
  --qh-hd2: #181818;
  --qh-btn: rgba(255,255,255,.07);
  --qh-btn-h: rgba(255,255,255,.14);
  --qh-bar: rgba(255,255,255,.12);
  --qh-row: rgba(255,255,255,.08);
  --qh-badge: rgba(255,255,255,.10);
  --qh-shadow: 0 10px 30px rgba(0,0,0,.55);
  --qh-toast-bg: #212121;
}
:host([data-theme="light"]) {
  /* 亮色：同样取自 PI-Desktop 亮色令牌 */
  --qh-bg: #f9f9f9;
  --qh-fg: #1a1c1f;
  --qh-bd: rgba(26,28,31,.12);
  --qh-hd1: #ffffff;
  --qh-hd2: #f9f9f9;
  --qh-btn: rgba(26,28,31,.055);
  --qh-btn-h: rgba(26,28,31,.12);
  --qh-bar: rgba(26,28,31,.12);
  --qh-row: rgba(26,28,31,.08);
  --qh-badge: rgba(26,28,31,.07);
  --qh-shadow: 0 10px 26px rgba(26,28,31,.14);
  --qh-toast-bg: #ffffff;
}
.wrap { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
  font: 12px/1.5 -apple-system,"Noto Sans CJK SC","Source Han Sans SC",sans-serif;
  color: var(--qh-fg); }
.card { width: 340px; background: var(--qh-bg); border: 1px solid var(--qh-bd);
  border-radius: 14px; box-shadow: var(--qh-shadow); overflow: hidden;
  backdrop-filter: blur(10px); }
.hd { display: flex; align-items: center; gap: 8px; padding: 8px 10px; cursor: default;
  background: linear-gradient(180deg, var(--qh-hd1), var(--qh-hd2)); }
.dot { width: 9px; height: 9px; border-radius: 50%; background: #9ca3af; flex: none; box-shadow: 0 0 0 2px rgba(128,128,128,.18); }
.dot.ok { background: #00a240; } .dot.err { background: #e02e2a; }
.title { font-weight: 600; letter-spacing: .3px; white-space: nowrap; }
.grow { flex: 1; min-width: 6px; }
.btn { border: 0; background: var(--qh-btn); color: var(--qh-fg); border-radius: 6px;
  padding: 3px 7px; font-size: 11px; cursor: pointer; line-height: 1.4; }
.btn:hover { background: var(--qh-btn-h); }
.list { max-height: 232px; overflow-y: auto; }
.row { padding: 7px 10px; border-top: 1px solid var(--qh-row); }
.name { display: flex; gap: 6px; align-items: center; }
.name span.t { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar { height: 4px; background: var(--qh-bar); border-radius: 3px; margin: 5px 0 3px; overflow: hidden; }
.bar i { display: block; height: 100%; width: 0%; background: linear-gradient(90deg,#4f4f4f,#ededed); transition: width .3s; }
.meta { display: flex; justify-content: space-between; font-size: 11px; opacity: .68; }
.badge { font-size: 10px; padding: 0 5px; border-radius: 8px; background: var(--qh-badge); }
.badge.done { background: rgba(0,162,64,.18); color: #00a240; }
.badge.error { background: rgba(224,46,42,.18); color: #e02e2a; }
.badge.running { background: rgba(237,237,237,.14); color: var(--qh-fg); }
.toast { position: fixed; right: 16px; bottom: 8px; transform: translateY(120%); transition: transform .25s;
  background: var(--qh-toast-bg); color: var(--qh-fg); border: 1px solid var(--qh-bd); border-radius: 8px;
  padding: 6px 10px; max-width: 340px; font-size: 11px; }
.toast.on { transform: translateY(-4px); }
.hint { padding: 8px 10px; font-size: 11px; opacity: .6; border-top: 1px solid var(--qh-row); }
.trash-dialog { position: fixed; inset: 0; z-index: 2147483000; display: none;
  align-items: center; justify-content: center; background: rgba(0,0,0,.45); backdrop-filter: blur(2px); }
.trash-dialog.on { display: flex; }
.td-card { width: 520px; max-width: 92vw; max-height: 70vh; display: flex; flex-direction: column;
  background: var(--qh-bg); color: var(--qh-fg); border: 1px solid var(--qh-bd);
  border-radius: 14px; box-shadow: var(--qh-shadow); overflow: hidden; }
.td-hd { display: flex; align-items: center; gap: 8px; padding: 10px 12px;
  background: linear-gradient(180deg, var(--qh-hd1), var(--qh-hd2)); }
.td-title { font-weight: 600; }
.td-count { font-size: 11px; opacity: .7; }
.td-list { flex: 1; overflow-y: auto; padding: 4px 12px 10px; }
.td-list .link-row { border-top: 1px solid var(--qh-row); }
.links { display: none; padding: 10px; border-top: 1px solid var(--qh-row); }
.links.on { display: block; }
.links-hd { font-size: 11px; opacity: .72; margin-bottom: 6px; }
.links-list { max-height: 150px; overflow-y: auto; }
.link-row { display: flex; align-items: center; gap: 6px; padding: 4px 0; border-top: 1px solid var(--qh-row); }
.link-row .u { flex: 1; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .9; }
.link-row input { width: 56px; background: var(--qh-btn); color: var(--qh-fg); border: 1px solid var(--qh-bd);
  border-radius: 5px; padding: 2px 4px; font-size: 11px; }
.links-add { display: flex; gap: 6px; margin-top: 8px; }
.links-add input { flex: 1; background: var(--qh-btn); color: var(--qh-fg); border: 1px solid var(--qh-bd);
  border-radius: 6px; padding: 5px 7px; font-size: 11px; outline: none; }
.settings { display: none; padding: 10px; border-top: 1px solid var(--qh-row); }
.settings.on { display: block; }
.settings label { display: block; font-size: 11px; opacity: .7; margin-bottom: 4px; }
.settings input { width: 100%; box-sizing: border-box; background: var(--qh-btn); color: var(--qh-fg);
  border: 1px solid var(--qh-bd); border-radius: 6px; padding: 5px 7px; font-size: 11px; outline: none; }
.settings .row2 { display: flex; gap: 6px; margin-top: 8px; }
.seg.on { background: var(--qh-btn-h); font-weight: 600; }
.tip { font-size: 11px; opacity: .62; margin-top: 6px; word-break: break-all; }
.mini { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; display: none;
  width: 48px; height: 48px; border-radius: 50%; align-items: center; justify-content: center;
  padding: 0; overflow: hidden; cursor: pointer; background: #0d0d0d;
  border: 2px solid #2563eb;                                  /* 无任务：蓝色描边 */
  box-shadow: 0 6px 18px rgba(37,99,235,.45);
  transition: border-color .2s, box-shadow .2s, transform .12s; }
.mini[data-state="active"] {                                  /* 有任务：绿色描边 */
  border-color: #00a240; box-shadow: 0 6px 18px rgba(0,162,64,.5); }
.mini img { width: 100%; height: 100%; object-fit: cover; display: block; border-radius: 50%; }
.mini:hover { transform: translateY(-1px) scale(1.03); }
.mini:active { transform: translateY(0) scale(.99); }
`;

function fmtBytes(n) {
  n = Number(n) || 0;
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + u[i];
}

function mountPanel() {
  if (document.getElementById('qh-panel-host')) return;
  const host = document.createElement('div');
  host.id = 'qh-panel-host';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CSS;
  const wrap = document.createElement('div');
  wrap.className = 'wrap';
  wrap.innerHTML = `
    <div class="card" id="card">
      <div class="hd">
        <div class="dot" id="dot" title="引擎状态"></div>
        <div class="title">下载进度</div>
        <div class="grow"></div>
        <button class="btn" id="linksBtn" title="嗅探到的夸克分享链接">链接</button>
        <button class="btn" id="clear" title="清除已完成 / 失败 / 已取消的任务">清除</button>
        <button class="btn" id="openDir" title="打开下载目录">目录</button>
        <button class="btn" id="settings" title="设置下载路径">设置</button>
        <button class="btn" id="hide" title="最小化">—</button>
      </div>
      <div class="list" id="list"><div class="hint" id="empty">在网页里点「下载」，任务会转交给本地引擎</div></div>
      <div class="links" id="links-pane">
        <div class="links-hd">嗅探到的分享链接 <span id="linksCount">0</span></div>
        <div class="links-list" id="linksList"><div class="tip">在网页里出现 pan.quark.cn/s/… 时会自动出现在这里</div></div>
        <div class="links-add">
          <input id="manualLink" spellcheck="false" placeholder="粘贴分享链接（可带 ?pwd=）">
          <button class="btn" id="manualSave">转存</button>
        </div>
        <div class="tip" id="linksTip"></div>
      </div>
      <div class="settings" id="settings-pane">
        <label>下载目录</label>
        <input id="dirInput" spellcheck="false" placeholder="/home/you/Downloads/quark">
        <div class="row2">
          <button class="btn" id="pickDir">浏览…</button>
          <button class="btn" id="saveDir">保存</button>
          <button class="btn" id="cancelDir">取消</button>
        </div>
        <div class="tip" id="dirTip"></div>
        <div class="row2" style="margin-top:12px;align-items:center">
          <span class="tip" style="margin:0;flex:none">主题</span>
          <button class="btn seg" id="themeDark">深色</button>
          <button class="btn seg" id="themeLight">亮色</button>
        </div>
      </div>
    </div>
    <div class="trash-dialog" id="trash-dialog">
      <div class="td-card">
        <div class="td-hd">
          <span class="td-title">回收站</span>
          <span class="td-count" id="trashCount">-</span>
          <span class="grow"></span>
          <button class="btn" id="trashRefresh">刷新</button>
          <button class="btn" id="trashClose">关闭</button>
        </div>
        <div class="td-list" id="trashList"><div class="tip">读取中…</div></div>
        <div class="tip" id="trashTip"></div>
      </div>
    </div>
    <div class="toast" id="toast"></div>
  `;
  root.append(style, wrap);
  document.documentElement.appendChild(host);

  const $ = (id) => root.getElementById(id);
  $('hide').onclick = () => { $('card').style.display = 'none'; mini.style.display = 'flex'; };
  $('openDir').onclick = () => ipcRenderer.send('qh:open-dir');
  $('clear').onclick = () => ipcRenderer.send('qh:clear-finished');

  // ---- 回收站：独立弹窗（点网页「回收站」时弹出）----
  const trashDialog = $('trash-dialog');
  const trashList = $('trashList');
  const trashCount = $('trashCount');
  const trashTip = $('trashTip');
  $('trashClose').onclick = () => trashDialog.classList.remove('on');
  $('trashRefresh').onclick = () => loadTrash();
  trashDialog.addEventListener('click', (ev) => {
    if (ev.target === trashDialog) trashDialog.classList.remove('on'); // 点遮罩关闭
  });

  function openTrash() {
    trashDialog.classList.add('on');
    loadTrash();
  }

  trashApi = { open: openTrash };
  async function loadTrash() {
    trashTip.textContent = '读取中…';
    try {
      const r = await ipcRenderer.invoke('qh:recycle-list');
      const items = (r && r.list) || [];
      trashCount.textContent = ((r && r.total) || 0) + ' 项';
      if (r && r.error) {
        trashList.innerHTML = '';
        trashTip.textContent = '读取失败：' + r.error;
        return;
      }
      if (!items.length) {
        trashList.innerHTML = '<div class="tip">回收站是空的</div>';
        trashTip.textContent = '';
        return;
      }
      trashList.innerHTML = '';
      for (const it of items) {
        const row = document.createElement('div');
        row.className = 'link-row';
        const mb = it.size ? (it.size / 1024 / 1024).toFixed(1) + 'MB' : '';
        row.innerHTML =
          '<span class="u" title="' + (it.name || '') + '">' + (it.name || '(未命名)') + '</span>' +
          '<span class="tip" style="margin:0;white-space:nowrap">' + mb + '</span>';
        trashList.appendChild(row);
      }
      trashTip.textContent = '只读模式：回收站仅支持查看与刷新';
    } catch (e) {
      trashTip.textContent = '读取失败：' + (e && e.message);
    }
  }

  // ---- 常驻嗅探：分享链接 → 转存 ----
  const linksPane = $('links-pane');
  const linksList = $('linksList');
  const linksCount = $('linksCount');
  const linksTip = $('linksTip');
  let shareLinks = [];

  const renderLinks = () => {
    linksCount.textContent = String(shareLinks.length);
    linksBtnLabel();
    if (!shareLinks.length) {
      linksList.innerHTML = '<div class="tip">在网页里出现 pan.quark.cn/s/… 时会自动出现在这里</div>';
      return;
    }
    linksList.innerHTML = '';
    for (const l of shareLinks) {
      const row = document.createElement('div');
      row.className = 'link-row';
      const short = l.url.replace('https://pan.quark.cn', '');
      row.innerHTML =
        '<span class="u" title="' + l.url + '">' + short + '</span>' +
        '<input class="pwd" placeholder="提取码" value="' + (l.pwd || '') + '">' +
        '<button class="btn save">转存</button>';
      const btn = row.querySelector('.save');
      if (btn) {
        btn.onclick = () => {
          const pwd = (row.querySelector('.pwd').value || '').trim();
          linksTip.textContent = '已打开转存窗口，请勾选要保存的文件';
          ipcRenderer.send('qh:open-save-window', { url: l.url, pwd: pwd });
        };
      }
      linksList.appendChild(row);
    }
  };
  function linksBtnLabel() {
    const b = $('linksBtn');
    if (b) b.textContent = shareLinks.length ? '链接 ' + shareLinks.length : '链接';
  }
  $('linksBtn').onclick = () => {
    linksPane.classList.toggle('on');
    if (linksPane.classList.contains('on')) renderLinks();
  };
  $('manualSave').onclick = () => {
    const v = ($('manualLink').value || '').trim();
    if (!v) { linksTip.textContent = '请输入分享链接'; return; }
    linksTip.textContent = '已打开转存窗口，请勾选要保存的文件';
    ipcRenderer.send('qh:open-save-window', { url: v, pwd: '' });
  };
  linksApi = {
    setLinks(arr) {
      shareLinks = (arr || []).slice(0, 20);
      renderLinks();
    },
  };
  if (pendingLinks.length) linksApi.setLinks(pendingLinks);
  renderLinks();

  // ---- 设置：下载目录 ----
  const dirPane = $('settings-pane');
  const dirInput = $('dirInput');
  $('settings').onclick = () => {
    const on = dirPane.classList.toggle('on');
    if (on) {
      dirInput.value = currentDir;
      $('dirTip').textContent = '当前：' + (currentDir || '(未获取)');
      setTimeout(() => dirInput.focus(), 30);
    }
  };
  $('pickDir').onclick = () => ipcRenderer.send('qh:pick-dir');
  $('saveDir').onclick = () => {
    const v = (dirInput.value || '').trim();
    if (!v) {
      $('dirTip').textContent = '请输入目录';
      return;
    }
    ipcRenderer.send('qh:set-download-dir', v);
    $('dirTip').textContent = '保存中…';
  };
  $('cancelDir').onclick = () => dirPane.classList.remove('on');

  // ---- 主题：与网页主题联动，默认深色，由主进程持久化 ----
  const applyThemeUI = (t) => {
    const mode = t === 'light' ? 'light' : 'dark';
    host.dataset.theme = mode;
    host.dataset.qhTheme = mode;
    const d = $('themeDark');
    const l = $('themeLight');
    if (d) d.classList.toggle('on', mode === 'dark');
    if (l) l.classList.toggle('on', mode === 'light');
  };
  applyThemeUI('dark');
  ipcRenderer.send('qh:get-theme');
  $('themeDark').onclick = () => {
    applyThemeUI('dark');
    ipcRenderer.send('qh:set-theme', 'dark');
  };
  $('themeLight').onclick = () => {
    applyThemeUI('light');
    ipcRenderer.send('qh:set-theme', 'light');
  };

  const mini = document.createElement('button');
  mini.className = 'mini';
  mini.dataset.state = 'idle';
  // 用项目图标做按钮外观；转 data URL 避免页面 CSP 拦截 file:// 资源
  try {
    const fs2 = require('fs');
    const p2 = require('path');
    const iconPath = p2.join(__dirname, '..', 'assets', 'icon-64.png');
    const b64 = fs2.readFileSync(iconPath).toString('base64');
    const img = document.createElement('img');
    img.src = 'data:image/png;base64,' + b64;
    img.alt = '下载进度';
    img.draggable = false;
    mini.appendChild(img);
  } catch (e) {
    mini.textContent = '⬇'; // 读不到图标就退回符号
  }
  mini.title = '展开下载进度';
  mini.onclick = () => { $('card').style.display = 'block'; mini.style.display = 'none'; };
  root.appendChild(mini);

  return { root, wrap };
}

let currentDir = ''; // 当前下载目录（设置面板 & 主进程同步）
let linksApi = null;   // 由 mountPanel 注册：{ setLinks(arr) }
let trashApi = null;   // 由 mountPanel 注册：{ open() }
let pendingLinks = []; // 面板还没挂载时先缓存
let panel = null;
function panelReady() {
  if (!panel && document.documentElement) {
    panel = mountPanel();
    syncPanelVisibility();
  }
  return panel;
}

function toast(msg) {
  if (PREVIEW_ROUTE_RE.test(location.hash || '')) return; // 预览页不打扰
  const p = panelReady();
  if (!p) return;
  const t = p.root.getElementById('toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(t.__timer);
  t.__timer = setTimeout(() => t.classList.remove('on'), 2600);
}

function render(state) {
  const p = panelReady();
  if (!p) return;
  const $ = (id) => p.root.getElementById(id);
  const dot = $('dot');
  const eng = state.engine || {};
  const login = state.login || {};
  const healthy = !!eng.ok && login.ok !== false;
  dot.className = 'dot ' + (healthy ? 'ok' : 'err');
  dot.title = healthy
    ? '引擎就绪 · 登录态正常'
    : '异常：' + (eng.ok ? '登录态' + (login.msg ? ' - ' + login.msg : '异常') : eng.msg || '引擎未就绪');

  if (state.downloadDir) currentDir = state.downloadDir;

  const jobs = state.jobs || [];

  // 折叠后的圆形按钮：无任务蓝色、有任务绿色
  try {
    const mini = p.root.querySelector('.mini');
    if (mini) {
      const hasTasks = jobs.length > 0;
      const running = jobs.filter((j) => j.status === 'running' || j.status === 'queued').length;
      mini.dataset.state = hasTasks ? 'active' : 'idle';
      mini.title = hasTasks
        ? `下载进度：${jobs.length} 个任务${running ? `（${running} 个进行中）` : ''}`
        : '下载进度：暂无任务';
    }
  } catch (e) {}

  const clearBtn = $('clear');
  if (clearBtn) {
    const finished = jobs.filter((j) => j.status === 'done' || j.status === 'error' || j.status === 'cancelled').length;
    clearBtn.disabled = finished === 0;
    clearBtn.style.opacity = finished === 0 ? '.45' : '';
    clearBtn.title = finished ? `清除 ${finished} 个已结束任务` : '暂无可清除的任务';
  }
  const list = $('list');
  if (!jobs.length) {
    list.innerHTML = '<div class="hint">在网页里点「下载」，任务会转交给本地引擎</div>';
    return;
  }
  list.innerHTML = '';
  for (const j of jobs) {
    const pct = j.size ? Math.min(100, (j.received / j.size) * 100) : 0;
    const row = document.createElement('div');
    row.className = 'row';
    const badgeCls = j.status === 'done' ? 'done' : j.status === 'error' ? 'error' : 'running';
    const badgeTxt = { done: '完成', error: '失败', running: '下载中', queued: '排队', cancelled: '已取消' }[j.status] || j.status;
    row.innerHTML = `
      <div class="name"><span class="t"></span>
        <span class="badge ${badgeCls}">${badgeTxt}</span>
        ${j.status === 'running' || j.status === 'queued' ? '<button class="btn cancel">取消</button>' : ''}
      </div>
      <div class="bar"><i></i></div>
      <div class="meta"><span class="sz"></span><span class="sp"></span></div>
      ${j.error ? '<div class="meta"><span class="err" style="color:#fca5a5"></span></div>' : ''}
    `;
    row.querySelector('.t').textContent = j.name || j.fid || '未知文件';
    row.querySelector('.bar i').style.width = pct.toFixed(1) + '%';
    row.querySelector('.sz').textContent = `${fmtBytes(j.received)} / ${j.size ? fmtBytes(j.size) : '?'}${j.size ? ' · ' + pct.toFixed(0) + '%' : ''}`;
    row.querySelector('.sp').textContent = j.status === 'running' && j.speed ? fmtBytes(j.speed) + '/s' : '';
    if (j.error) row.querySelector('.err').textContent = j.error.slice(0, 120);
    const cb = row.querySelector('.cancel');
    if (cb) cb.onclick = () => ipcRenderer.send('qh:cancel', j.id);
    list.appendChild(row);
  }
}

/* ------------------------------------------------------------------ *
 * 面板只在「文件列表」页显示；进入预览页（文档/视频/图片/音频…）自动隐藏
 * ------------------------------------------------------------------ */
const PREVIEW_ROUTE_RE = /#\/(doc|video|image|photo|music|audio|preview|player|viewer)\b/i;

function syncPanelVisibility() {
  try {
    const host = document.getElementById('qh-panel-host');
    if (!host) return;
    const hide = PREVIEW_ROUTE_RE.test(location.hash || '');
    if (hide) {
      if (host.style.display !== 'none') host.style.display = 'none';
    } else if (host.style.display === 'none') {
      host.style.display = '';
    }
  } catch (e) {}
}

try {
  window.addEventListener('hashchange', syncPanelVisibility);
  window.addEventListener('popstate', syncPanelVisibility);
  setInterval(syncPanelVisibility, 700); // 站点有时不触发 hashchange
} catch (e) {}

ipcRenderer.on('qh:state', (_e, state) => {
  try { render(state); } catch (e) { console.warn('[qh] render', e); }
});
ipcRenderer.on('qh:toast', (_e, msg) => toast(String(msg)));
ipcRenderer.on('qh:download-dir', (_e, info) => {
  try {
    currentDir = (info && info.dir) || '';
    const host = document.getElementById('qh-panel-host');
    const root = host && host.shadowRoot;
    if (!root) return;
    const input = root.getElementById('dirInput');
    const tip = root.getElementById('dirTip');
    if (input && !root.getElementById('settings-pane').classList.contains('on')) input.value = currentDir;
    else if (input) input.value = currentDir;
    if (tip) tip.textContent = (info && info.saved ? '已保存：' : '当前：') + currentDir;
  } catch (e) {}
});

ipcRenderer.on('qh:share-links', (_e, links) => {
  try {
    const merged = new Map();
    for (const l of [...pendingLinks, ...(links || [])]) {
      if (l && l.url) merged.set(l.url, l);
    }
    pendingLinks = Array.from(merged.values()).slice(0, 20);
    if (linksApi) {
      linksApi.setLinks(pendingLinks);
    } else {
      // 面板还没好，先更新按钮文案
      const host = document.getElementById('qh-panel-host');
      const btn = host && host.shadowRoot && host.shadowRoot.getElementById('linksBtn');
      if (btn) btn.textContent = pendingLinks.length ? '链接 ' + pendingLinks.length : '链接';
    }
  } catch (e) {}
});

ipcRenderer.on('qh:recycle-route', () => {
  try {
    if (trashApi) trashApi.open();
  } catch (e) {}
});


ipcRenderer.on('qh:theme', (_e, mode) => {
  try {
    const host = document.getElementById('qh-panel-host');
    if (!host) return;
    const m = mode === 'light' ? 'light' : 'dark';
    host.dataset.theme = m;
    host.dataset.qhTheme = m;
    const root = host.shadowRoot;
    if (!root) return;
    const d = root.getElementById('themeDark');
    const l = root.getElementById('themeLight');
    if (d) d.classList.toggle('on', m === 'dark');
    if (l) l.classList.toggle('on', m === 'light');
  } catch (e) {}
});

ipcRenderer.on('qh:preview-meta', (_e, m) => {
  try {
    window.postMessage({ __quark_hybrid__: true, type: 'meta', fid: m.fid, name: m.name, size: m.size }, '*');
  } catch (e) {}
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    panelReady();
    ipcRenderer.send('qh:hello');
  });
} else {
  panelReady();
  ipcRenderer.send('qh:hello');
}
