'use strict';
/**
 * 注入到页面主世界（main world）的脚本。
 * 目标：
 *   1. 抓取文件列表 API 的响应，建立 fid -> {name, size} 映射
 *   2. 侦测页面自己发起的「下载」API 请求，把 fid 上报给主进程
 *   3. 不阻断、不修改页面任何原有行为（下载由 session 的 will-download 取消）
 * 任何异常都吞掉，绝不影响网页本身。
 */
function hooksSource(opts) {
  const hideLimitDialog = !!(opts && opts.hideLimitDialog);
  const blockPreviewAll = !!(opts && opts.blockPreviewAll);
  return `(() => {
    const HIDE_LIMIT_DIALOG = ${hideLimitDialog};
    const BLOCK_PREVIEW_ALL = ${blockPreviewAll};
  try {
    if (window.__quarkHybridInstalled) return 'already';
    window.__quarkHybridInstalled = true;

    const TAG = '__quark_hybrid__';
    const files = new Map();       // fid -> {fid, name, size, dir}
    const sent = new Set();        // 已上报过的 fid

    const post = (type, payload) => {
      try { window.postMessage(Object.assign({ [TAG]: true, type: type }, payload || {}), '*'); } catch (e) {}
    };

    const isQuarkApi = (u) => typeof u === 'string' && u.indexOf('clouddrive') !== -1;
    const isDownloadApi = (u) => {
      if (typeof u !== 'string') return false;
      if (!/\\/clouddrive\\//.test(u) && !/\\/download/i.test(u)) return false;
      if (/upload|downloads\\/history|task/i.test(u)) return false;
      return /download/i.test(u);
    };
    const isClientScheme = (u) => typeof u === 'string' && /^qkclouddrive:/i.test(u);

    function recordEntry(o) {
      if (!o || typeof o.fid !== 'string') return;
      const name = o.file_name || o.fileName || o.name || '';
      if (!name) return;
      const size = Number(o.size) || Number(o.file_size) || 0;
      const prev = files.get(o.fid);
      if (prev && prev.name === name && prev.size === size) return;
      files.set(o.fid, { fid: o.fid, name: name, size: size, dir: o.pdir_fid || o.dir || '' });
      if (!sent.has(o.fid)) {
        sent.add(o.fid);
        post('files', { entries: [files.get(o.fid)] });
      }
    }

    let apiUrl = '';
    function harvest(root, depth) {
      depth = depth || 0;
      if (root === null || typeof root !== 'object' || depth > 7) return;
      if (Array.isArray(root)) { for (let i = 0; i < root.length; i++) harvest(root[i], depth + 1); return; }
      if (typeof root.fid === 'string' && (root.file_name || root.fileName)) recordEntry(root);
      for (const k in root) {
        try {
          const v = root[k];
          // 扫描响应体里出现的 qkclouddrive:// 客户端协议，连同比邻的 fid/名字一起上报
          if (typeof v === 'string' && isClientScheme(v)) {
            post('client-url', {
              url: v,
              apiUrl: apiUrl,
              fid: typeof root.fid === 'string' ? root.fid : '',
              name: root.file_name || root.fileName || root.name || '',
              size: Number(root.size) || Number(root.file_size) || 0
            });
          } else {
            harvest(v, depth + 1);
          }
        } catch (e) {}
      }
    }

    function extractFids(url, body) {
      const out = new Set();
      const grab = (text) => {
        if (!text || typeof text !== 'string') return;
        try {
          const j = JSON.parse(text);
          harvest(j, 0);
          const cands = [j && j.fids, j && j.fid, j && j.file_ids, j && j.data && j.data.fids];
          for (const c of cands) {
            if (Array.isArray(c)) c.forEach((x) => typeof x === 'string' && out.add(x));
            else if (typeof c === 'string') out.add(c);
          }
        } catch (e) {
          const m = text.match(/[0-9a-f]{32}/g);
          if (m) m.forEach((x) => out.add(x));
        }
      };
      try {
        const q = url.indexOf('?');
        if (q >= 0) {
          const usp = new URLSearchParams(url.slice(q + 1));
          for (const key of ['fid', 'fids', 'file_id', 'file_ids']) {
            const v = usp.get(key);
            if (v) v.split(',').forEach((x) => x && out.add(decodeURIComponent(x).replace(/[\\[\\]"']/g, '')));
          }
        }
      } catch (e) {}
      grab(body);
      return Array.from(out).filter((x) => /^[0-9a-zA-Z]{16,40}$/.test(x));
    }

    function reportIntent(url, body) {
      try {
        if (!isDownloadApi(url)) return;
        const fids = extractFids(url, body);
        if (!fids.length) { post('probe', { url: String(url).slice(0, 200) }); return; }
        for (const fid of fids) {
          const meta = files.get(fid) || {};
          post('intent', { fid: fid, name: meta.name || '', size: meta.size || 0, via: 'api' });
        }
      } catch (e) {}
    }

    // ---- fetch ----
    const of = window.fetch;
    if (of) {
      window.fetch = function (input, init) {
        let url = '';
        let body = '';
        try {
          url = typeof input === 'string' ? input : (input && input.url) || '';
          body = init && typeof init.body === 'string' ? init.body : '';
        } catch (e) {}
        try { reportIntent(url, body); } catch (e) {}
        const p = of.apply(this, arguments);
        if (isQuarkApi(url) && p && p.then) {
          p.then((res) => {
            try {
              const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
              if (ct.indexOf('json') === -1) return;
              res.clone().json().then((j) => {
                apiUrl = url;
                harvest(j, 0);
                if (j && j.code && j.code !== 0) {
                  post('api-error', { url: String(url).slice(0, 150), code: j.code, message: String(j.message || '').slice(0, 200) });
                }
              }).catch(() => {});
            } catch (e) {}
          }).catch(() => {});
        }
        // 抓 deeplink 响应体（唤起客户端的那一下），定位限制提示的真正来源
        if (typeof url === 'string' && url.indexOf('deeplink') !== -1 && p && p.then) {
          p.then((res) => {
            try {
              res.clone().text().then((t) => post('deeplink', { url: url.slice(0, 120), body: String(t).slice(0, 700) })).catch(() => {});
            } catch (e) {}
          }).catch(() => {});
        }

        // 回报下载接口自身的响应码：用来确认服务端是否已把网页当客户端
        if (isDownloadApi(url) && p && p.then) {
          p.then((res) => {
            try {
              res.clone().json().then((j) => {
                const it = (j.data && j.data[0]) || {};
                post('download-api', {
                  code: j.code,
                  status: j.status,
                  hasUrl: !!it.download_url,
                  size: Number(it.size) || 0,
                  name: it.file_name || ''
                });
              }).catch(() => {});
            } catch (e) {}
          }).catch(() => {});
        }
        return p;
      };
    }

    // ---- XHR ----
    const O = XMLHttpRequest.prototype.open;
    const S = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      try { this.__qhUrl = url; } catch (e) {}
      return O.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      try { reportIntent(this.__qhUrl || '', typeof body === 'string' ? body : ''); } catch (e) {}
      try {
        if (isQuarkApi(this.__qhUrl)) {
          this.addEventListener('load', () => {
            try {
              if (this.responseType === '' || this.responseType === 'text') {
                const ct = this.getResponseHeader('content-type') || '';
                if (ct.indexOf('json') !== -1 || (this.responseText || '').trim().startsWith('{')) {
                  apiUrl = this.__qhUrl || '';
                  harvest(JSON.parse(this.responseText), 0);
                }
              }
            } catch (e) {}
          });
        }
      } catch (e) {}
      return S.apply(this, arguments);
    };

    // ---- 点击行上下文：把「用户点的是哪个文件」和 fid 关联起来 ----
    // 页面弹的 qkclouddrive://download?id=<64位> 与 API 的 fid 不是同一个 ID，
    // 所以先记录用户点中的行对应哪个已知 fid，协议 URL 到来时用它兜底。
    document.addEventListener('pointerdown', (ev) => {
      try {
        const t = ev.target;
        if (!t) return;
        let node = t;
        let txt = '';
        for (let i = 0; i < 6 && node; i++) {
          const s = node.textContent || '';
          if (s.length > txt.length) txt = s;
          if (files.size && s.length > 200) break;
          node = node.parentElement;
        }
        if (!txt) return;
        let best = null;
        files.forEach((e) => {
          if (e.name && txt.indexOf(e.name) !== -1) {
            if (!best || e.name.length > best.name.length) best = { fid: e.fid, name: e.name, size: e.size };
          }
        });
        if (best) post('row-pick', best);
      } catch (e) {}
    }, true);

    // ---- 官方客户端协议：qkclouddrive://download?id=<fid>&user_token=... ----
    const reportClientUrl = (u) => {
      try { if (isClientScheme(u)) post('client-url', { url: String(u) }); } catch (e) {}
      burstSuppress();
    };
    // 点击后连打几次：弹窗通常是异步渲染的，多点几次能把它压到"看不见"
    const burstSuppress = () => {
      if (typeof suppressLimitDialog !== 'function') return;
      [0, 60, 150, 300, 600, 1000].forEach((ms) => setTimeout(() => { try { suppressLimitDialog(); } catch (e) {} }, ms));
    };
    // 1) 捕获阶段拦 <a href="qkclouddrive://..."> 的点击
    document.addEventListener('click', (ev) => {
      try {
        const t = ev.target;
        const a = t && t.closest ? t.closest('a[href]') : null;
        const h = a ? a.getAttribute('href') : '';
        if (h && isClientScheme(h)) { ev.preventDefault(); ev.stopImmediatePropagation(); reportClientUrl(h); }
      } catch (e) {}
    }, true);
    // 2) 程序式 a.click()
    const _aClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      try {
        const h = this.getAttribute('href') || '';
        if (isClientScheme(h)) { reportClientUrl(h); return; }
      } catch (e) {}
      return _aClick.apply(this, arguments);
    };
    // 3) window.open
    const _open = window.open;
    window.open = function (u) {
      try { if (isClientScheme(u)) { reportClientUrl(u); return null; } } catch (e) {}
      return _open.apply(this, arguments);
    };
    // 4) 隐藏 iframe 跳转
    try {
      const sd = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src');
      if (sd && sd.set) {
        Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
          configurable: true,
          enumerable: sd.enumerable,
          get: sd.get,
          set(v) { if (isClientScheme(v)) { reportClientUrl(v); return; } return sd.set.call(this, v); }
        });
      }
    } catch (e) {}

    // ---- 5) 屏蔽网页自己的「超出下载大小限制」弹窗 ----
    // 网页拿到 23018 后会渲染一个引导装客户端的弹窗；下载已由本地引擎接管，
    // 这个弹窗纯属噪音，直接隐藏掉（只按文案精确匹配，避免误伤其它弹窗）。
    const LIMIT_HINTS = [
      '超过网页端文件下载大小限制',
      '请使用客户端下载',
      '文件下载超限',
      '下载大小限制',
      '未安装夸克网盘'
    ];
    const MASK_RE = /(mask|modal|dialog|popup|overlay|backdrop|layer)/i;
    const suppressed = new Set();

    // 隐藏全屏遮罩层（往往是弹窗的兄弟节点）+ 解除 body 滚动锁
    function hideOverlays() {
      const vw = window.innerWidth || 1;
      const vh = window.innerHeight || 1;
      try {
        const all = document.body.querySelectorAll('div,section,article');
        for (const el of all) {
          if (el.id === 'qh-panel-host') continue; // 别动我们自己的面板
          try {
            const cs = getComputedStyle(el);
            if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
            if (cs.display === 'none' || cs.visibility === 'hidden') continue;
            const r = el.getBoundingClientRect();
            // 覆盖 ≥90% 视口即认为是遮罩
            if (r.width >= vw * 0.9 && r.height >= vh * 0.9) {
              el.style.setProperty('display', 'none', 'important');
            }
          } catch (e) {}
        }
      } catch (e) {}
      try {
        const b = document.body;
        const de = document.documentElement;
        // 站点常用 CSS 类锁滚动，内联 style 覆盖不掉，这里用 !important 强制解锁
        if (getComputedStyle(b).overflow === 'hidden') b.style.setProperty('overflow', 'visible', 'important');
        if (getComputedStyle(de).overflow === 'hidden') de.style.setProperty('overflow', 'visible', 'important');
      } catch (e) {}
    }

    function suppressLimitDialog() {
      try {
        const nodes = document.body ? document.body.querySelectorAll('*') : [];
        let found = false;
        for (const el of nodes) {
          if (el.children && el.children.length) continue;
          const t = (el.textContent || '').trim();
          if (!t || t.length > 160) continue;
          if (!LIMIT_HINTS.some((h) => t.indexOf(h) !== -1)) continue;

          let box = el;
          let target = null;
          for (let i = 0; i < 8 && box.parentElement; i++) {
            box = box.parentElement;
            const cls = String(box.className || '') + ' ' + String(box.id || '');
            if (MASK_RE.test(cls) || box.getAttribute('role') === 'dialog') {
              target = box;
              break;
            }
          }
          if (!target) target = box;
          target.style.setProperty('display', 'none', 'important');
          found = true;

          const key = t.slice(0, 60);
          if (!suppressed.has(key)) {
            suppressed.add(key);
            post('limit-dialog-suppressed', { text: key });
          }
        }
        if (found) hideOverlays();
      } catch (e) {}
    }

    let suppressTimer = null;
    const scheduleSuppress = () => {
      if (suppressTimer) return;
      suppressTimer = setTimeout(() => {
        suppressTimer = null;
        suppressLimitDialog();
      }, 120);
    };

    if (HIDE_LIMIT_DIALOG) try {
      const mo = new MutationObserver((muts) => {
        // 只在新节点文本命中时才全量扫描，兼顾即时性与开销
        for (const m of muts) {
          if (!m.addedNodes || !m.addedNodes.length) continue;
          for (const n of m.addedNodes) {
            const txt = n && n.textContent;
            if (txt && LIMIT_HINTS.some((h) => txt.indexOf(h) !== -1)) {
              suppressLimitDialog();
              return;
            }
          }
        }
        scheduleSuppress();
      });
      const startObserve = () => {
        if (document.body) mo.observe(document.body, { childList: true, subtree: true });
        scheduleSuppress();
      };
      if (document.body) startObserve();
      else document.addEventListener('DOMContentLoaded', startObserve);
      setInterval(suppressLimitDialog, 2000); // 兜底轮询
    } catch (e) {}


    // ---- 6) 大文件/不可预览文件的「预览错误页」屏蔽 ----
    // 预览由 office-cn-*.aliyuncs.com 的跨域 iframe 渲染，出错时会在里面显示
    // "Error Code: 20065 / Request ID: …"，我们改不了跨域内容，但能隐藏该 iframe，
    // 并在页面里放一条提示 + 下载入口（点按钮才下载，不自动改你的操作）。
    // 明确「网页端能正常预览」的类型：无论多大都不许拦
    const PREVIEWABLE_EXT = [
      'mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'ts', 'mpg', 'mpeg', 'rmvb',
      'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'heic', 'avif',
      'mp3', 'flac', 'wav', 'aac', 'm4a', 'ogg', 'ape',
      'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'epub'
    ];

    // 只按扩展名判定，体积不参与（视频普遍 >1GB，用体积判会误伤）
    function extOf(name) {
      return String(name || '').split('.').pop().toLowerCase();
    }
    function isUnpreviewableExt(name) {
      const ext = extOf(name);
      if (!ext) return false;
      if (PREVIEWABLE_EXT.indexOf(ext) !== -1) return false;
      return NON_PREVIEW_EXT.indexOf(ext) !== -1;
    }

    const NON_PREVIEW_EXT = [
      'safetensors', 'ckpt', 'pt', 'pth', 'bin', 'gguf', 'onnx', 'h5', 'pkl',
      '7z', 'zip', 'rar', 'tar', 'gz', 'xz', 'zst', 'iso', 'dmg', 'apk', 'exe', 'msi',
      'psd', 'ai', 'blend', 'fbx', 'obj', 'step', 'stp', 'iges'
    ];

    function currentDocFid() {
      const m = new RegExp('#/doc/([0-9a-zA-Z]{16,40})').exec(location.hash || '');
      return m ? m[1] : '';
    }

    let pendingPreviewFid = '';

    // 主进程回来的元数据：补进表里，并立刻按需屏蔽
    window.addEventListener('message', (ev) => {
      try {
        const d = ev && ev.data;
        if (!d || d.__quark_hybrid__ !== true || d.type !== 'meta' || !d.fid) return;
        files.set(d.fid, { fid: d.fid, name: d.name || '', size: Number(d.size) || 0 });
        if (d.fid === pendingPreviewFid) {
          pendingPreviewFid = '';
          const bad = isUnpreviewableExt(d.name);
          if (bad) [0, 400, 1000, 2000].forEach((ms) => setTimeout(() => maskPreviewError(d.fid, d.name || '', Number(d.size) || 0), ms));
        }
      } catch (e) {}
    });

    function maskPreviewError(fid, name, size) {
      try {
        // 隐藏预览 iframe（错误页在里面）
        let masked = false;
        for (const f of document.querySelectorAll('iframe')) {
          const src = String(f.getAttribute('src') || '');
          if (/aliyuncs\.com/i.test(src) || /office/i.test(src)) {
            f.style.setProperty('visibility', 'hidden', 'important');
            masked = true;
          }
        }
        if (!masked) return;
        if (document.getElementById('qh-preview-note')) return;

        const box = document.createElement('div');
        box.id = 'qh-preview-note';
        box.style.cssText =
          'position:fixed;left:50%;top:32%;transform:translate(-50%,-50%);z-index:2147483000;' +
          'background:rgba(24,28,38,.97);color:#e8ecf4;border:1px solid rgba(120,140,180,.3);' +
          'border-radius:12px;padding:18px 20px;width:380px;font:13px/1.6 -apple-system,"Noto Sans CJK SC",sans-serif;' +
          'box-shadow:0 12px 36px rgba(0,0,0,.5)';
        const sizeTxt = size ? (size / 1024 ** 3).toFixed(2) + ' GB' : '未知大小';
        box.innerHTML =
          '<div style="font-weight:600;margin-bottom:6px">该文件不支持在线预览</div>' +
          '<div style="opacity:.75;margin-bottom:10px;word-break:break-all"></div>' +
          '<div style="opacity:.6;font-size:12px;margin-bottom:12px">扩展名/体积超出预览服务限制（' + sizeTxt + '），下载不受影响。</div>' +
          '<button id="qh-preview-dl" style="border:0;background:#2f6fed;color:#fff;border-radius:8px;padding:7px 14px;font-size:13px;cursor:pointer">用会员通道下载</button>' +
          '<button id="qh-preview-close" style="border:0;background:rgba(255,255,255,.1);color:#dfe6f3;border-radius:8px;padding:7px 12px;font-size:13px;margin-left:8px;cursor:pointer">关闭</button>';
        box.querySelector('div:nth-child(2)').textContent = name || fid;
        document.body.appendChild(box);
        box.querySelector('#qh-preview-dl').onclick = () => {
          post('intent', { fid: fid, name: name, size: size, via: 'preview-note' });
          box.remove();
        };
        box.querySelector('#qh-preview-close').onclick = () => box.remove();
        post('preview-error-masked', { fid: fid, name: name });
      } catch (e) {}
    }

    // 回收站页面是前端写死"请用客户端"的，这里通知主进程弹自己的查看面板
    let lastTrashNotify = 0;
    function notifyTrashRoute() {
      try {
        if (location.hash.indexOf('/trash') === -1) return;
        const now = Date.now();
        if (now - lastTrashNotify < 3000) return;
        lastTrashNotify = now;
        post('recycle-route', { hash: location.hash });
      } catch (e) {}
    }

    let previewTimer = null;
    function handlePreviewRoute() {
      notifyTrashRoute();
      const fid = currentDocFid();
      const old = document.getElementById('qh-preview-note');
      if (old) old.remove();
      if (!fid) return;
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => {
        const meta = files.get(fid) || {};
        const name = meta.name || '';
        const size = Number(meta.size) || 0;
        if (!name) {
          // 本地没有这个 fid 的元数据，向主进程要（主进程会兜底查 /file/info）
          pendingPreviewFid = fid;
          post('preview-route', { fid: fid });
          return;
        }
        if (!isUnpreviewableExt(name)) return; // 视频/图片/文档等一律放行
        // 预览区是异步渲染的，多点几次更稳
        [0, 500, 1200, 2500].forEach((ms) => setTimeout(() => maskPreviewError(fid, name, size), ms));
      }, 400);
    }

    try {
      window.addEventListener('hashchange', () => { notifyTrashRoute(); handlePreviewRoute(); });
      if (document.readyState === 'complete') handlePreviewRoute();
      else window.addEventListener('load', () => setTimeout(handlePreviewRoute, 800));
    } catch (e) {}
    window.__qhPreviewRoute = handlePreviewRoute;
    window.__qhSeedFiles = (arr) => { (arr || []).forEach((e) => e && e.fid && files.set(e.fid, e)); };


    // ---- 7) 不可预览文件：拦掉预览跳转（不是事后遮挡）----
    // 判定依据：扩展名在 NON_PREVIEW_EXT 内（体积不参与判定，视频普遍 >1GB 会误伤）
    // 已知 fid 直接拦；未知 fid 放行（由第 6 节的错误页屏蔽兜底）。
    function isNonPreviewable(fid) {
      if (BLOCK_PREVIEW_ALL) return true; // 所有类型都不进预览
      const meta = files.get(fid);
      if (!meta || !meta.name) return false; // 未知 → 不拦
      return isUnpreviewableExt(meta.name);
    }

    let lastBlockAt = {};
    function blockPreview(fid, how) {
      const now = Date.now();
      if (lastBlockAt[fid] && now - lastBlockAt[fid] < 800) return true; // 800ms 内同一文件只报一次
      lastBlockAt[fid] = now;
      const meta = files.get(fid) || {};
      post('preview-blocked', { fid: fid, name: meta.name || '', size: Number(meta.size) || 0, how: how });
      return true;
    }

    const PREVIEW_ROUTE_RE = new RegExp('#/(?:doc|video|player|image|img|pic|preview)/([0-9a-zA-Z]{16,40})');
    function fidFromUrl(u) {
      try {
        const m = PREVIEW_ROUTE_RE.exec(String(u || ''));
        return m ? m[1] : '';
      } catch (e) {
        return '';
      }
    }

    // 7.1 拦 SPA 路由（pushState / replaceState）
    try {
      ['pushState', 'replaceState'].forEach((fn) => {
        const orig = history[fn];
        history[fn] = function (state, title, url) {
          try {
            const fid = fidFromUrl(url);
            if (fid && isNonPreviewable(fid)) {
              blockPreview(fid, fn);
              return; // 不跳转
            }
          } catch (e) {}
          return orig.apply(this, arguments);
        };
      });
    } catch (e) {}

    // 7.2 拦 <a href="#/doc/..."> 点击（捕获阶段，先于站点路由）
    document.addEventListener('click', (ev) => {
      try {
        const t = ev.target;
        const a = t && t.closest ? t.closest('a[href]') : null;
        const href = a ? a.getAttribute('href') : '';
        const fid = fidFromUrl(href);
        if (fid && isNonPreviewable(fid)) {
          // 只阻止默认跳转；不要 stopImmediatePropagation，
          // 否则站点自己的"选中该行"逻辑也被吞掉
          ev.preventDefault();
          blockPreview(fid, 'anchor');
        }
      } catch (e) {}
    }, true);


    // ---- 8) 深色模式下的媒体「反反色」----
    // 整页 invert 后需要把图片/视频/头像等再反回来；但若父子元素都匹配，
    // 会变成双重反色（负片）。所以按 DOM 顺序处理，并在祖先已处理时跳过后代。
    const UNINVERT_SEL = 'img, video, canvas, svg, iframe, [style*="background-image"], [style*="background:"]';
    const AVATAR_SEL = '[class*="avatar" i], [class*="portrait" i], [id*="avatar" i], [class*="head-img" i], [class*="userIcon" i], [class*="user-icon" i]';

    function clearUninvert() {
      try {
        document.querySelectorAll('[data-qh-uninvert]').forEach((el) => {
          el.style.removeProperty('filter');
          el.removeAttribute('data-qh-uninvert');
        });
      } catch (e) {}
    }

    function applyUninvert() {
      try {
        const dark = document.documentElement.dataset.qhTheme === 'dark';
        if (!dark) return clearUninvert();

        const done = new Set();
        const mark = (el) => {
          // 祖先已反色则跳过，避免双重反色
          for (let p = el.parentElement; p; p = p.parentElement) {
            if (done.has(p)) return;
          }
          el.style.setProperty('filter', 'invert(1) hue-rotate(180deg)', 'important');
          el.setAttribute('data-qh-uninvert', '1');
          done.add(el);
        };

        document.querySelectorAll(UNINVERT_SEL + ', ' + AVATAR_SEL).forEach((el) => {
          try {
            if (el.closest && el.closest('#qh-panel-host')) return;
            const cs = getComputedStyle(el);
            // 只处理真正有图像的元素：img/video/canvas/svg 或带 url() 的背景
            const isMedia = /^(IMG|VIDEO|CANVAS|SVG|IFRAME)$/.test(el.tagName);
            const hasUrlBg = (cs.backgroundImage || '').indexOf('url(') !== -1 && el.children.length === 0;
            const isAvatar = el.matches && el.matches(AVATAR_SEL);
            if (!isMedia && !hasUrlBg && !isAvatar) return;
            mark(el);
          } catch (e) {}
        });
      } catch (e) {}
    }

    window.__qhThemeFix = (mode) => {
      try {
        document.documentElement.dataset.qhTheme = mode === 'light' ? 'light' : 'dark';
        applyUninvert();
        let n = 0;
        const t = setInterval(() => {
          applyUninvert();
          if (++n > 6) clearInterval(t);
        }, 500);
      } catch (e) {}
    };

    try {
      // 页面持续渲染，定期补一次（头像常在异步渲染后出现）
      setInterval(() => {
        if (document.documentElement.dataset.qhTheme === 'dark') applyUninvert();
      }, 2500);
    } catch (e) {}


    // ---- 9) 常驻嗅探：夸克分享链接 ----
    const lastLinksJson = { v: '' };
    const SHARE_URL_SRC = 'https?://pan\\\\.quark\\\\.cn/s/[0-9A-Za-z]{4,}';
    function collectShareLinks() {
      const out = new Map();
      // 注意：add() 里不能用 /g 正则做 match——会重置外层扫描的 lastIndex 导致死循环
      const add = (u, hintText) => {
        const m = new RegExp(SHARE_URL_SRC).exec(String(u || ''));
        if (!m) return;
        const url = m[0];
        if (out.has(url)) return;
        let pwd = '';
        const q = /[?&](?:pwd|passcode)=([0-9A-Za-z]{4})/.exec(String(u));
        if (q) pwd = q[1];
        if (!pwd && hintText) {
          const p2 = /(?:提取码|密码|pwd)[^0-9A-Za-z]{0,3}([0-9A-Za-z]{4})/i.exec(String(hintText).slice(0, 120));
          if (p2) pwd = p2[1];
        }
        out.set(url, { url: url, pwd: pwd });
      };
      try {
        document.querySelectorAll('a[href]').forEach((a) => {
          const href = a.getAttribute('href') || '';
          if (href.indexOf('pan.quark.cn/s/') !== -1) add(href, a.parentElement ? a.parentElement.textContent : '');
        });
        const txt = document.body ? document.body.innerText || '' : '';
        const scan = new RegExp(SHARE_URL_SRC, 'g');
        let m;
        let guard = 0;
        while ((m = scan.exec(txt)) !== null && guard++ < 200) {
          add(m[0], txt.slice(m.index, m.index + 120));
        }
        if (location.href.indexOf('pan.quark.cn/s/') !== -1) add(location.href, txt.slice(0, 200));
      } catch (e) {}
      return Array.from(out.values()).slice(0, 20);
    }

    function reportShareLinks() {
      try {
        const links = collectShareLinks();
        const json = JSON.stringify(links);
        if (json === lastLinksJson.v) return;
        lastLinksJson.v = json;
        if (links.length) post('share-links', { links: links });
      } catch (e) {}
    }

    try {
      if (document.readyState === 'complete') setTimeout(reportShareLinks, 800);
      else window.addEventListener('load', () => setTimeout(reportShareLinks, 800));
      let t = null;
      const mo2 = new MutationObserver(() => {
        if (t) return;
        t = setTimeout(() => { t = null; reportShareLinks(); }, 800);
      });
      if (document.body) mo2.observe(document.body, { childList: true, subtree: true });
      setInterval(reportShareLinks, 4000);
      window.__qhCollectLinks = collectShareLinks;
    } catch (e) {}


    // ---- 10) 回收站页面：屏蔽站点自己的「请用客户端」提示卡与按钮 ----
    // 站点在 #/list/trash 写死了：打开客户端，查看和恢复已删除的文件 / [查看回收站][打开客户端][下载客户端]
    const TRASH_HIDE_HINTS = [
      '打开客户端，查看和恢复已删除的文件',
      '正在打开夸克网盘客户端',
      '下载客户端',
      '打开客户端'
    ];
    const TRASH_ACTION_LABELS = ['打开客户端', '下载客户端', '查看回收站'];
    const hiddenTrash = new WeakSet();

    // 找到包含该文案的「卡片级」容器：往上爬，直到祖先里出现 >=2 个提示文案，
    // 或类名像卡片/空状态，就认为到顶了
    function findCardBox(el) {
      let box = el;
      let best = null;
      for (let i = 0; i < 6 && box.parentElement && box !== document.body; i++) {
        box = box.parentElement;
        const txt = box.textContent || '';
        const hits = TRASH_HIDE_HINTS.filter((h) => txt.indexOf(h) !== -1).length;
        const cls = String(box.className || '') + ' ' + String(box.id || '');
        if (hits >= 2 || /card|empty|placeholder|guide|tip|client|download|desc|panel|box|mask/i.test(cls)) {
          best = box;
          if (hits >= 2) break;
        }
      }
      return best || el.parentElement || el;
    }

    // 卡片被隐藏后留一块空白，这里补一句提示，把用户引到右下角面板
    function showTrashNote() {
      try {
        if (document.getElementById('qh-trash-note')) return;
        const note = document.createElement('div');
        note.id = 'qh-trash-note';
        note.textContent = '已为你打开回收站窗口（可查看、刷新；恢复/删除默认禁用）';
        note.style.cssText =
          'margin:48px auto;max-width:420px;padding:14px 18px;border-radius:12px;text-align:center;' +
          'font:13px/1.6 -apple-system,"Noto Sans CJK SC",sans-serif;color:#ededed;background:#181818;' +
          'border:1px solid rgba(255,255,255,.12)';
        const host = document.querySelector('#app') || document.body;
        host.appendChild(note);
      } catch (e) {}
    }

    function hideTrashPrompt() {
      try {
        if (location.hash.indexOf('/trash') === -1) return;
        const leaves = document.body ? document.body.querySelectorAll('span,div,p,button,a') : [];
        for (const el of leaves) {
          if (el.children && el.children.length) continue;
          const t = (el.textContent || '').trim();
          if (!t || t.length > 40) continue;
          if (!TRASH_HIDE_HINTS.some((h) => t.indexOf(h) !== -1)) continue;
          const box = findCardBox(el);
          if (hiddenTrash.has(box)) continue;
          hiddenTrash.add(box);
          box.style.setProperty('display', 'none', 'important');
          showTrashNote();
          post('trash-prompt-hidden', { text: t.slice(0, 30) });
        }
      } catch (e) {}
    }

    // 回收站路由下，这些按钮点了会拉客户端（协议跳转 / 安装包），直接吃掉点击
    document.addEventListener('click', (ev) => {
      try {
        if (location.hash.indexOf('/trash') === -1) return;
        let node = ev.target;
        for (let i = 0; i < 5 && node && node !== document.body; i++) {
          const label = (node.textContent || '').trim();
          if (label && label.length <= 12 && TRASH_ACTION_LABELS.some((l) => label === l)) {
            ev.preventDefault();
            ev.stopImmediatePropagation();
            post('trash-client-action-blocked', { label: label });
            return;
          }
          node = node.parentElement;
        }
      } catch (e) {}
    }, true);

    try {
      let trashTimer = null;
      const moTrash = new MutationObserver(() => {
        if (trashTimer) return;
        trashTimer = setTimeout(() => { trashTimer = null; hideTrashPrompt(); }, 250);
      });
      if (document.body) moTrash.observe(document.body, { childList: true, subtree: true });
      setInterval(hideTrashPrompt, 1500);
      window.__qhHideTrashPrompt = hideTrashPrompt;
    } catch (e) {}

    post('ready', { href: location.href });
    return 'installed';
  } catch (e) {
    return 'error: ' + (e && e.message);
  }
})();`;
}


module.exports = { hooksSource };
