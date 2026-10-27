'use strict';
/**
 * URL 判定工具。
 *
 * 背景：will-download 里我们取消了浏览器下载，并可能把直链交给引擎。
 * 但页面上还有"下载客户端"之类的普通下载（download.quark.cn/...），
 * 若无差别接管，就会把客户端安装包也当成网盘文件下载下来 —— 这是 bug。
 * 只有真正的网盘文件 CDN 才允许接管。
 */
const DRIVE_HOSTS = ['drive.quark.cn', 'pan.quark.cn'];

function isDriveDownloadUrl(url) {
  try {
    const u = new URL(String(url || ''));
    if (!/^https?:$/.test(u.protocol)) return false;
    const host = u.hostname.toLowerCase();
    // 网盘文件直链：dl-xxx.drive.quark.cn / drive.quark.cn / pan.quark.cn
    if (DRIVE_HOSTS.some((h) => host === h || host.endsWith('.' + h))) return true;
    return false;
  } catch (e) {
    return false;
  }
}

module.exports = { isDriveDownloadUrl };
