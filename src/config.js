'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * 配置分两层：
 *   - 包内 config.json（只读，随安装包分发，作为默认值）
 *   - ~/.config/quark-yuan/config.json（可写，用户改动的都落在这里）
 * 这样打成 AppImage（squashfs 只读）后「设置」仍然能保存。
 */
const USER_DIR = path.join(os.homedir(), '.config', 'quark-yuan');
const USER_CFG = path.join(USER_DIR, 'config.json');
const BUNDLED_CFG = path.join(__dirname, '..', 'config.json');
/** 网页登录态（完整站点 cookie），引擎缺失时下载器也能用 */
const COOKIE_FILE = path.join(USER_DIR, 'cookie.txt');

const DEFAULTS = {
  startUrl: 'https://pan.quark.cn/list#/list/all',
  userAgent:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  engine: { path: '', autoLogin: true, clientUA: 'quark-cloud-drive/3.14.2 (Windows NT 10.0; Win64; x64)' },
  downloadDir: path.join(os.homedir(), 'Downloads', 'quark'),
  conn: 8,                   // 原生下载并发连接数
  nativeDownload: true,      // 用会员直链多连接下载（关掉则退回 CLI 单连接）
  spoofClientUA: true,       // 让网页的下载接口请求以客户端 UA 发出（否则 23018 超限）
  hideLimitDialog: false,    // 隐藏网页「请使用客户端下载」弹窗
  maxParallelJobs: 1,
  autoCancelBrowserDownload: true,
  appTheme: 'dark',          // 'dark' | 'light'
  previewBlockAll: true,     // true=所有类型都不进预览；false=只拦不可预览类型
  nonPreviewAction: 'block', // 'block'（仅拦掉预览跳转）| 'toast'（提示）| 'download'（直接下载）
};

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return null;
  }
}

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function loadConfig() {
  const bundled = readJson(BUNDLED_CFG);
  if (!bundled) console.warn('[config] 读取包内 config.json 失败，使用内置默认值');
  const own = readJson(USER_CFG);
  // 首次运行：把包内配置落到用户目录，方便直接编辑
  if (!own && bundled) writeJson(USER_CFG, bundled);
  const user = { ...(bundled || {}), ...(own || {}) };

  const cfg = {
    ...DEFAULTS,
    ...user,
    engine: { ...DEFAULTS.engine, ...(user.engine || {}) },
    downloadDir: expandHome(user.downloadDir || DEFAULTS.downloadDir),
  };
  cfg.engine.path = expandHome(cfg.engine.path || '');
  return cfg;
}

function writeJson(p, data) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
    return true;
  } catch (e) {
    console.warn('[config] 写入失败:', p, e.message);
    return false;
  }
}

/** 合并写入用户配置（只写 patch 里的键，其余保留） */
function saveConfig(patch) {
  const cur = readJson(USER_CFG) || readJson(BUNDLED_CFG) || {};
  const next = { ...cur, ...(patch || {}) };
  writeJson(USER_CFG, next);
  return next;
}

function saveCookie(cookie) {
  try {
    fs.mkdirSync(USER_DIR, { recursive: true });
    fs.writeFileSync(COOKIE_FILE, String(cookie || ''), { mode: 0o600 });
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { loadConfig, saveConfig, saveCookie, COOKIE_FILE, USER_CFG };
