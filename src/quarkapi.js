'use strict';
/**
 * 夸克 API 薄封装：只保留本项目真正用到的四类调用
 *   1) 分享链接：解析 → 勾选转存（/share/sharepage/*）
 *   2) 目录树：保存位置选择器（/file/sort）
 *   3) 回收站：只读列表（/file/recycle/list）
 *   4) 文件信息：预览路由缺元数据时按 fid 补查（/file/info）
 *
 * 注意：不用「临时分享」取巧下载（会往账号里建分享，且只有 ~1.5MB/s）；
 *      高速下载走 fetcher.js 的会员直链。回收站写入接口已整体移除（只读）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { COOKIE_FILE } = require('./config');

const BASE = 'https://drive-pc.quark.cn/1/clouddrive';
const COMMON = 'pr=ucpro&fr=pc&uc_param_str=';
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * 优先用应用自己同步下来的完整网页 cookie（不依赖引擎，
 * 这样即便本机没装 quark-drive 引擎，会员直链下载也能工作）。
 */
function readCookie() {
  try {
    const c = fs.readFileSync(COOKIE_FILE, 'utf8').trim();
    if (c) return c;
  } catch (e) {}
  try {
    const p = path.join(os.homedir(), '.config', 'quark-drive', 'config.toml');
    const s = fs.readFileSync(p, 'utf8');
    const m = /cookie\s*=\s*"([\s\S]*?)"/.exec(s);
    return m ? m[1] : '';
  } catch (e) {
    return '';
  }
}

function headers() {
  const cookie = readCookie();
  if (!cookie) throw new Error('还没有登录态，请先在网页里登录');
  return {
    cookie,
    'content-type': 'application/json',
    'user-agent': UA,
    origin: 'https://pan.quark.cn',
    referer: 'https://pan.quark.cn/list',
  };
}

async function call(method, pathname, body) {
  const sep = pathname.indexOf('?') === -1 ? '?' : '&';
  const url = `${BASE}${pathname}${sep}${COMMON}`;
  const init = { method, headers: headers() };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetch(url, init);
  let j;
  try {
    j = await r.json();
  } catch (e) {
    throw new Error(`${pathname} 返回非 JSON（HTTP ${r.status}）`);
  }
  if (j.code !== 0 && j.status !== 200) throw new Error(`${pathname}: ${j.message || 'code ' + j.code}`);
  return j;
}

function post(pathname, body) {
  return call('POST', pathname, body || {});
}
function get(pathname) {
  return call('GET', pathname);
}

/* ------------------------------------------------------------------ *
 * 分享链接：解析 + 转存
 * ------------------------------------------------------------------ */

/** 从分享链接里取 pwd_id 与提取码 */
function parseShareUrl(url) {
  const m = /pan\.quark\.cn\/s\/([0-9a-zA-Z]+)/.exec(String(url || ''));
  if (!m) return null;
  const pwdId = m[1];
  let pwd = '';
  try {
    const u = new URL(url);
    pwd = u.searchParams.get('pwd') || u.searchParams.get('passcode') || '';
  } catch (e) {
    const q = /[?&](?:pwd|passcode)=([0-9a-zA-Z]+)/.exec(url);
    if (q) pwd = q[1];
  }
  return { pwdId, pwd };
}

async function shareStoken(pwdId, passcode) {
  const j = await post('/share/sharepage/token', { pwd_id: pwdId, passcode: passcode || '' });
  const st = (j.data || {}).stoken || '';
  if (!st) throw new Error('获取 stoken 失败：' + (j.message || '未知'));
  return st;
}

async function shareDetail(pwdId, stoken, pdirFid, page, size) {
  const q =
    '/share/sharepage/detail?pwd_id=' +
    encodeURIComponent(pwdId) +
    '&stoken=' +
    encodeURIComponent(stoken) +
    '&pdir_fid=' +
    encodeURIComponent(pdirFid || '0') +
    '&force=0&_page=' +
    (page || 1) +
    '&_size=' +
    (size || 100) +
    '&_fetch_banner=0&_fetch_share=0&_fetch_total=1' +
    '&_sort=file_type:asc,updated_at:desc';
  const j = await get(q);
  const d = j.data || {};
  return { list: d.list || [], total: Number(d.total) || 0, title: (d.share || {}).title || '' };
}

/** 分享记录 → 窗口用的结构（token 转存时要用，必须跟着条目一起带走） */
function mapShareItem(it) {
  return {
    fid: it.fid,
    token: it.share_fid_token || it.fid_token || '',
    name: it.file_name || '',
    size: Number(it.size) || 0,
    dir: it.dir === true || it.file_type === 0,
  };
}

const SHARE_PAGE_SIZE = 100;
const SHARE_MAX_PAGES = 20;

/**
 * 列分享里的一层目录：pdirFid='0' 是分享根，其它值是分享内的子目录。
 * 这样文件夹分享也能进去挑单个文件，而不是只能整包转存。
 */
async function listShareDir(url, passcode, pdirFid) {
  const p = parseShareUrl(url);
  if (!p) throw new Error('不是有效的夸克分享链接');
  const st = await shareStoken(p.pwdId, passcode || p.pwd);
  const dir = pdirFid || '0';
  const all = [];
  let title = '';
  let total = 0;
  for (let page = 1; page <= SHARE_MAX_PAGES; page++) {
    const d = await shareDetail(p.pwdId, st, dir, page, SHARE_PAGE_SIZE);
    if (page === 1) {
      title = d.title;
      total = d.total;
    }
    const got = d.list || [];
    all.push(...got);
    if (got.length < SHARE_PAGE_SIZE || all.length >= total) break;
  }
  const files = all.filter((x) => x && x.fid).map(mapShareItem);
  return {
    pwdId: p.pwdId,
    pwd: passcode || p.pwd,
    pdirFid: dir,
    title,
    total: Math.max(total, files.length),
    truncated: total > files.length,
    files,
  };
}

/** 只读取：探测链接是否有效、某一层里有什么（不落盘、不转存） */
async function probeShare(url, passcode, pdirFid) {
  return listShareDir(url, passcode, pdirFid);
}

/** 勾选项按「所在分享目录」分组，顺便去重 */
function groupByParent(items) {
  const groups = new Map(); // parentFid -> Set(fid)
  for (const it of items) {
    const fid = String((it && it.fid) || '');
    if (!fid) continue;
    const parent = String((it && (it.parentFid || it.pdirFid)) || '0') || '0';
    if (!groups.has(parent)) groups.set(parent, new Set());
    groups.get(parent).add(fid);
  }
  return groups;
}

/**
 * 用「本次转存要用的 stoken」现场回查 token。
 * 夸克的 share_fid_token 与发它时用的 stoken 同源，拿旧的 token 配新 stoken
 * 会被服务端判成「token 校验异常」，所以这里不信窗口送来的 token，只信 fid + 所在目录。
 */
async function resolveShareTokens(pwdId, stoken, items) {
  const groups = groupByParent(items);
  const tokens = new Map();
  const noToken = [];
  for (const [parent, want] of groups) {
    let page = 1;
    let total = 0;
    const missing = new Set(want);
    while (page <= SHARE_MAX_PAGES && missing.size) {
      const d = await shareDetail(pwdId, stoken, parent, page, SHARE_PAGE_SIZE);
      const list = d.list || [];
      for (const it of list) {
        if (!it || !it.fid || !missing.has(it.fid)) continue;
        const tok = it.share_fid_token || it.fid_token || '';
        if (!tok) {
          noToken.push(it.fid);
        } else {
          tokens.set(it.fid, tok);
        }
        missing.delete(it.fid);
      }
      if (page === 1) total = d.total;
      if (list.length < SHARE_PAGE_SIZE) break;
      if (total && page * SHARE_PAGE_SIZE >= total) break;
      page++;
    }
    if (missing.size) {
      throw new Error(
        '分享里已经找不到勾选的文件（可能被分享者移除或改动了目录）：' + Array.from(missing).join(', ')
      );
    }
  }
  if (noToken.length) {
    throw new Error('这些文件分享方没给出转存 token，无法转存：' + noToken.join(', '));
  }
  return items.map((it) => ({ fid: String(it.fid), token: tokens.get(String(it.fid)) || '' }));
}

/**
 * 转存到指定目录。items 支持两种写法：
 *   - [{ fid, parentFid }]：转存窗口勾选的结果（parentFid = 它所在的分享目录，'0' 是分享根）
 *   - ['fid'] 或空：旧行为，视作都在分享根
 * token 一律按「本次 stoken + 所在目录」现场重取，避免 token 与 stoken 不同源。
 */
async function saveShareToDrive(url, passcode, toPdirFid, items) {
  const p = parseShareUrl(url);
  if (!p) throw new Error('不是有效的夸克分享链接');
  const arr = Array.isArray(items) ? items : [];
  const objs = arr
    .filter((x) => x && typeof x === 'object' && x.fid)
    .map((x) => ({ fid: String(x.fid), parentFid: String(x.parentFid || x.pdirFid || '0') || '0' }));
  const fidsOnly = arr.filter((x) => typeof x === 'string' && x);
  let wanted = objs.length ? objs : fidsOnly.map((fid) => ({ fid: String(fid), parentFid: '0' }));
  // 去重：同一 fid 可能被重复勾选
  const seen = new Set();
  wanted = wanted.filter((x) => (x.fid && !seen.has(x.fid) ? (seen.add(x.fid), true) : false));
  if (!wanted.length) throw new Error('没有可转存的文件（可能未勾选）');

  let lastErr = null;
  // stoken 会在服务端轮换/过期：token 类失败时换一个新 stoken 再走一遍
  for (let attempt = 0; attempt < 2; attempt++) {
    const st = await shareStoken(p.pwdId, passcode || p.pwd);
    try {
      const chosen = await resolveShareTokens(p.pwdId, st, wanted);
      const j = await post('/share/sharepage/save', {
        fid_list: chosen.map((x) => x.fid),
        fid_token_list: chosen.map((x) => x.token),
        to_pdir_fid: toPdirFid || '0',
        pwd_id: p.pwdId,
        stoken: st,
        scene: 'link',
      });
      const taskId = (j.data || {}).task_id || '';
      return { ok: true, count: chosen.length, taskId, message: j.message || 'ok' };
    } catch (e) {
      lastErr = e;
      if (!/token/i.test(String((e && e.message) || ''))) break;
    }
  }
  throw lastErr || new Error('转存失败');
}

/* ------------------------------------------------------------------ *
 * 目录树：保存位置选择器
 * ------------------------------------------------------------------ */
async function listFolders(pdirFid) {
  const q =
    '/file/sort?pdir_fid=' + encodeURIComponent(pdirFid || '0') + '&_page=1&_size=200&_fetch_total=1&_sort=file_type:asc,file_name:asc';
  const j = await get(q);
  const d = j.data || {};
  const dirs = (d.list || [])
    .filter((it) => it && (it.dir === true || it.file_type === 0))
    .map((it) => ({ fid: it.fid, name: it.file_name || '(未命名)' }));
  return { pdirFid: pdirFid || '0', dirs, total: Number(d.total) || dirs.length };
}

/* ------------------------------------------------------------------ *
 * 回收站：只读
 * 说明：站点把回收站页面写成「请用客户端」，所以自己实现查看窗口。
 *      写入（恢复/彻底删除）接口已移除——真要做需要在主进程显式加回，
 *      并且必须用 select_mode:2 指定记录，绝不能用 1（= 全部）。
 * ------------------------------------------------------------------ */
async function recycleList(page, size) {
  const q = '/file/recycle/list?_page=' + (page || 1) + '&_size=' + (size || 50) + '&_fetch_total=1';
  const j = await get(q);
  const d = j.data || {};
  const list = (d.list || []).map((it) => ({
    fid: it.fid || '',
    recordId: it.record_id || '',
    name: it.file_name || '',
    size: Number(it.size) || 0,
    dir: !!it.dir,
    deletedAt: Number(it.deleted_at || it.created_at || 0),
  }));
  return { total: Number(d.total) || list.length, list };
}

/* ------------------------------------------------------------------ *
 * 文件信息：预览路由缺少元数据时按 fid 补查
 * ------------------------------------------------------------------ */
async function fileInfo(fid) {
  const j = await get('/file/info?fid=' + encodeURIComponent(fid) + '&_fetch_full_path=1&need_profile_tag=');
  const info = (j.data && (j.data.info || j.data)) || {};
  return { fid: fid, name: info.file_name || '', size: Number(info.size) || 0 };
}

module.exports = {
  readCookie,
  probeShare,
  listShareDir,
  saveShareToDrive,
  listFolders,
  recycleList,
  fileInfo,
};
