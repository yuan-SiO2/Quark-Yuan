'use strict';
/**
 * 解析夸克客户端协议：
 *   qkclouddrive://download?id=<fid>&user_token=<token>
 * 网页版对大文件不走浏览器下载，而是拉起官方客户端（就是这条 URL）。
 * 我们把 id 当作 fid 交给本地引擎。
 */
const SCHEME_RE = /^qkclouddrive:/i;

function parseClientUrl(url) {
  if (typeof url !== 'string' || !SCHEME_RE.test(url)) return null;
  let fid = '';
  let token = '';
  try {
    const u = new URL(url);
    // URL 里 host 是 'download'，参数在 search 里
    fid = u.searchParams.get('id') || u.searchParams.get('fid') || u.searchParams.get('file_id') || '';
    token = u.searchParams.get('user_token') || '';
  } catch (e) {
    const m = /[?&](?:id|fid|file_id)=([0-9a-zA-Z]+)/.exec(url);
    if (m) fid = m[1];
    const t = /[?&]user_token=([0-9a-zA-Z]+)/.exec(url);
    if (t) token = t[1];
  }
  if (!fid) return null;
  // 有些版本会带逗号分隔的多个 id，主进程只用第一个
  if (fid.indexOf(',') !== -1) fid = fid.split(',').filter(Boolean)[0] || '';
  if (!fid) return null;
  return { fid, token };
}

module.exports = { parseClientUrl };
