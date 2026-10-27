'use strict';
/**
 * 原生下载器：直接走「客户端 UA + cookie」的官方直链，多连接 Range 下载。
 *
 * 为什么不用引擎的 download --id：
 *   引擎发的是浏览器 UA（Chrome/126），`/1/clouddrive/file/download` 对浏览器 UA
 *   返回 code 23018 "download file size limit" → 只能退回低速通道（实测 ~100KB/s）。
 *   换成官方客户端 UA（quark-cloud-drive/3.14.2）后接口返回真正的 download_url，
 *   实测单连接 2MB/s、8 连接合计 ≈14MB/s（SUPER_VIP 账号）。
 *
 * 直链要求：必须带 cookie，且必须用 Range 请求（否则 412）。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const API = 'https://drive-pc.quark.cn/1/clouddrive/file/download';
const COMMON = 'pr=ucpro&fr=pc&uc_param_str=';
const DEFAULT_CLIENT_UA = 'quark-cloud-drive/3.14.2 (Windows NT 10.0; Win64; x64)';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class NativeDownloader {
  constructor(cfg, readCookie) {
    this.cfg = cfg;
    this.readCookie = readCookie;
    this.controllers = new Map(); // jobId -> AbortController
  }

  get clientUA() {
    return (this.cfg.engine && this.cfg.engine.clientUA) || DEFAULT_CLIENT_UA;
  }

  /** 取直链：必须用客户端 UA，否则只有 23018 */
  async getDownloadInfo(fid) {
    const cookie = this.readCookie();
    if (!cookie) throw new Error('没有 cookie，请先在网页里登录');
    const r = await fetch(`${API}?${COMMON}`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        'user-agent': this.clientUA,
        origin: 'https://pan.quark.cn',
        referer: 'https://pan.quark.cn/list',
      },
      body: JSON.stringify({ fids: [fid] }),
    });
    const j = await r.json();
    if (j.status !== 200 || j.code !== 0) throw new Error(`取直链失败: ${j.message || 'code ' + j.code}`);
    const it = (j.data || [])[0];
    if (!it || !it.download_url) throw new Error('取直链失败: 响应里没有 download_url');
    return {
      url: it.download_url,
      size: Number(it.size) || 0,
      rangeSize: Number(it.range_size) || 0,
      name: it.file_name || '',
    };
  }

  abort(jobId) {
    const c = this.controllers.get(jobId);
    if (c) {
      c.abort();
      return true;
    }
    return false;
  }

  /**
   * 下载一个文件；onProgress({received,size,speed})
   */
  async download(jobId, { fid, name, outPath }, onProgress) {
    const ac = new AbortController();
    this.controllers.set(jobId, ac);
    try {
      const info = await this.getDownloadInfo(fid);
      const size = info.size;
      if (!size) throw new Error('文件大小未知');
      const chunkSize = Math.max(1024 * 1024, Number(info.rangeSize) || 8 * 1024 * 1024);
      const total = Math.ceil(size / chunkSize);
      const conn = Math.max(1, Math.min(32, Number(this.cfg.conn) || 8));

      // 断点信息
      const statePath = outPath + '.qh.json';
      let done = new Set();
      try {
        const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        if (st && st.size === size && Array.isArray(st.done)) done = new Set(st.done);
      } catch (e) {}

      // 预分配（稀疏），保证 offset 写入
      try {
        const st = await fsp.stat(outPath).catch(() => null);
        if (!st || st.size !== size) {
          const fh = await fsp.open(outPath, 'w');
          await fh.truncate(size);
          await fh.close();
        }
      } catch (e) {
        throw new Error('创建目标文件失败: ' + e.message);
      }

      let received = 0;
      for (const idx of done) {
        received += Math.min(chunkSize, size - idx * chunkSize);
      }
      let lastAt = Date.now();
      let lastBytes = received;
      let speed = 0;

      const report = () => {
        const now = Date.now();
        const dt = (now - lastAt) / 1000;
        if (dt >= 0.4) {
          speed = Math.max(0, Math.round((received - lastBytes) / dt));
          lastAt = now;
          lastBytes = received;
          onProgress && onProgress({ received, size, speed });
        }
      };
      const saveState = () => {
        try {
          fs.writeFileSync(statePath, JSON.stringify({ size, chunkSize, done: [...done] }));
        } catch (e) {}
      };
      report();

      const fh = await fsp.open(outPath, 'r+');
      let next = 0;
      let finished = 0;
      let fatal = null;
      let url = info.url;
      const cookie = this.readCookie();

      const fetchChunk = async (idx) => {
        const start = idx * chunkSize;
        const end = Math.min(start + chunkSize - 1, size - 1);
        let attempt = 0;
        for (;;) {
          if (ac.signal.aborted) throw new Error('cancelled');
          try {
            const res = await fetch(url, {
              headers: {
                'user-agent': this.clientUA,
                cookie,
                referer: 'https://pan.quark.cn/',
                range: `bytes=${start}-${end}`,
              },
              signal: ac.signal,
            });
            if (res.status === 412 || res.status === 403) {
              // 直链过期：重新取一次
              if (attempt === 0) {
                url = (await this.getDownloadInfo(fid)).url;
                attempt++;
                continue;
              }
              throw new Error(`HTTP ${res.status}（直链可能已过期）`);
            }
            if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status}`);
            // 200 说明服务端忽略了 Range，直接把整段丢弃（不走这条路径）
            if (res.status === 200) throw new Error('服务端忽略了 Range 请求');

            let pos = start;
            const reader = res.body.getReader();
            for (;;) {
              const { done: d, value } = await reader.read();
              if (d) break;
              const buf = Buffer.from(value);
              await fh.write(buf, 0, buf.length, pos);
              pos += buf.length;
              received += buf.length;
              report();
            }
            if (pos - 1 !== end) throw new Error(`分片长度不符：期望到 ${end}，实际到 ${pos - 1}`);
            return;
          } catch (e) {
            if (ac.signal.aborted || e.message === 'cancelled') throw e;
            if (attempt >= 3) throw e;
            attempt++;
            await sleep(500 * attempt);
          }
        }
      };

      const worker = async () => {
        for (;;) {
          if (fatal) return;
          const idx = next++;
          if (idx >= total) return;
          if (done.has(idx)) {
            finished++;
            continue;
          }
          try {
            await fetchChunk(idx);
            done.add(idx);
            finished++;
            saveState();
          } catch (e) {
            fatal = e;
            return;
          }
        }
      };

      await Promise.all(Array.from({ length: Math.min(conn, total) }, worker));
      await fh.close();

      if (fatal) {
        saveState();
        if (ac.signal.aborted) throw new Error('cancelled');
        throw fatal;
      }
      // 完整校验
      const st = await fsp.stat(outPath);
      if (st.size !== size) throw new Error(`文件大小不符：${st.size} != ${size}`);
      try {
        fs.unlinkSync(statePath);
      } catch (e) {}
      onProgress && onProgress({ received: size, size, speed: 0 });
      return { ok: true, size };
    } finally {
      this.controllers.delete(jobId);
    }
  }
}

module.exports = { NativeDownloader };
