'use strict';
/**
 * 下载调度器。
 *
 * 三条路径，按优先级：
 *
 * 1) native（默认）：自己调官方接口拿「会员高速直链」+ 多连接 Range 下载。
 *    - 关键点：必须用**客户端 UA**（quark-cloud-drive/…）。用浏览器 UA 时
 *      /1/clouddrive/file/download 会返回 code 23018 "download file size limit"，
 *      只能走低速通道（实测 ~100KB/s）。
 *    - 客户端 UA + cookie 换来的直链必须带 cookie、且必须 Range 请求（否则 412）。
 *    - 实测（SUPER_VIP 账号、9.5GB 文件）：8 连接合计 ≈14 MB/s。
 *
 * 2) engine（兜底）：`quark-drive download --id`（单连接）/ `--url`。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const quarkapi = require('./quarkapi');
const { NativeDownloader } = require('./fetcher');

const POLL_MS = 500;
const LOG_TAIL = 4000;
const UNIT = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };

function sanitizeName(name) {
  const base = String(name || 'unknown').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
  return base.replace(/^\.+/, '').slice(0, 200) || 'unknown';
}

function toBytes(num, unit) {
  return Math.round((Number(num) || 0) * (UNIT[unit] || 1));
}

class Engine extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.jobs = [];
    this.queued = [];
    this.running = new Map(); // jobId -> {type:'native'} | {type:'child', proc}
    this.seq = 0;
    this.lastLogin = { cookieHash: '', ok: null, msg: '', at: 0 };
    this.engineInfo = { ok: false, msg: '未检测', raw: '' };
    this.fetcher = new NativeDownloader(cfg, quarkapi.readCookie);
  }

  /** 优先用 config 里配的引擎；没配/不存在则用安装包自带的 resources/engine/quark-drive */
  get bin() {
    const configured = this.cfg.engine.path;
    if (configured && fs.existsSync(configured)) return configured;
    const bundled = this.findBundled('quark-drive');
    return bundled || configured || '';
  }

  findBundled(name) {
    const roots = [];
    if (process.resourcesPath) roots.push(path.join(process.resourcesPath, 'engine'));
    roots.push(path.join(__dirname, '..', '..', 'quark-drive-extract', 'usr', 'bin'));
    for (const r of roots) {
      const p = path.join(r, name);
      if (fs.existsSync(p)) return p;
    }
    return '';
  }

  get libDir() {
    if (process.resourcesPath) {
      const b = path.join(process.resourcesPath, 'engine', 'lib');
      if (fs.existsSync(b)) return b;
    }
    const guess = path.resolve(path.dirname(this.bin), '..', 'lib');
    return fs.existsSync(guess) ? guess : '';
  }

  childEnv() {
    const env = { ...process.env };
    const lib = this.libDir;
    if (lib) env.LD_LIBRARY_PATH = lib + (env.LD_LIBRARY_PATH ? ':' + env.LD_LIBRARY_PATH : '');
    return env;
  }

  snapshot() {
    return {
      engine: this.engineInfo,
      login: this.lastLogin,
      downloadDir: this.cfg.downloadDir,
      bin: this.bin,
      conn: this.cfg.conn,
      native: this.cfg.nativeDownload !== false,
      jobs: this.jobs.slice(0, 60).map((j) => ({
        id: j.id,
        fid: j.fid,
        name: j.name,
        outPath: j.outPath,
        size: j.size,
        received: j.received,
        speed: j.speed,
        percent: j.percent,
        mode: j.mode,
        phase: j.phase,
        status: j.status,
        error: j.error,
      })),
    };
  }

  emitState() {
    this.emit('state', this.snapshot());
  }

  info() {
    return new Promise((resolve) => {
      if (!this.bin || !fs.existsSync(this.bin)) {
        this.engineInfo = { ok: false, msg: `引擎不存在: ${this.bin || '(未配置)'}`, raw: '' };
        this.emitState();
        return resolve(this.engineInfo);
      }
      let out = '';
      const p = spawn(this.bin, ['info'], { env: this.childEnv() });
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
      p.on('error', (e) => {
        this.engineInfo = { ok: false, msg: '启动失败: ' + e.message, raw: out };
        this.emitState();
        resolve(this.engineInfo);
      });
      p.on('exit', (code) => {
        this.engineInfo =
          code === 0
            ? { ok: true, msg: '就绪', raw: out.trim() }
            : { ok: false, msg: `info 退出码 ${code}`, raw: out.trim() };
        this.emitState();
        resolve(this.engineInfo);
      });
    });
  }

  login(cookie) {
    return new Promise((resolve) => {
      if (!cookie) {
        this.lastLogin = { ...this.lastLogin, ok: null, msg: '等待网页登录…' };
        this.emitState();
        return resolve({ ok: false, skipped: true });
      }
      const hash = require('crypto').createHash('sha1').update(cookie).digest('hex').slice(0, 8);
      if (!this.bin || !fs.existsSync(this.bin)) {
        // 没有引擎也能下载：直链走 fetcher，cookie 由主进程写进用户目录
        this.lastLogin = { cookieHash: hash, ok: true, msg: '未安装引擎，直接用网页登录态', at: Date.now() };
        this.emitState();
        return resolve({ ok: true, skipped: true, msg: this.lastLogin.msg });
      }
      if (hash === this.lastLogin.cookieHash) {
        return resolve({ ok: !!this.lastLogin.ok, cached: true, msg: this.lastLogin.msg });
      }
      let out = '';
      const p = spawn(this.bin, ['login', '--cookie', cookie], { env: this.childEnv() });
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
      p.on('error', (e) => {
        this.lastLogin = { cookieHash: '', ok: false, msg: 'login 启动失败: ' + e.message, at: Date.now() };
        this.emitState();
        resolve({ ok: false });
      });
      p.on('exit', (code) => {
        this.lastLogin = {
          cookieHash: hash,
          ok: code === 0,
          msg: (out.trim().split('\n').pop() || (code === 0 ? '登录态已同步' : `login 退出码 ${code}`)).slice(0, 200),
          at: Date.now(),
        };
        this.emitState();
        resolve({ ok: code === 0, msg: this.lastLogin.msg });
      });
    });
  }

  enqueue({ fid, name, size, url }) {
    const dir = this.cfg.downloadDir;
    fs.mkdirSync(dir, { recursive: true });
    const outPath = path.join(dir, sanitizeName(name || (fid ? fid + '.bin' : 'download.bin')));

    const exists = this.jobs.find(
      (j) => j.outPath === outPath && (j.status === 'running' || j.status === 'queued')
    );
    if (exists) return { ok: false, msg: '已在队列中', job: exists.id };

    const job = {
      id: 'j' + ++this.seq,
      fid: fid || '',
      name: name || path.basename(outPath),
      size: Number(size) || 0,
      url: url || '',
      outPath,
      status: 'queued',
      received: 0,
      speed: 0,
      percent: 0,
      mode: '',
      phase: '排队中',
      error: '',
      log: '',
      startedAt: 0,
      timer: null,
      _buf: '',
      _stdoutProgress: false,
      _lastBytes: 0,
      _lastAt: 0,
    };
    this.jobs.unshift(job);
    if (this.jobs.length > 200) this.jobs.length = 200;
    this.queued.push(job);
    this.emitState();
    this.pump();
    return { ok: true, job: job.id, outPath };
  }

  pump() {
    const max = Math.max(1, Number(this.cfg.maxParallelJobs) || 1);
    while (this.running.size < max && this.queued.length) {
      this.start(this.queued.shift());
    }
  }

  async start(job) {
    job.status = 'running';
    job.startedAt = Date.now();
    job._lastAt = Date.now();

    // ---- 路径 1：原生多连接（会员高速通道）----
    if (job.fid && this.cfg.nativeDownload !== false) {
      job.mode = 'native';
      job.phase = '解析会员直链…';
      this.running.set(job.id, { type: 'native' });
      this.emitState();
      try {
        const r = await this.fetcher.download(
          job.id,
          { fid: job.fid, name: job.name, outPath: job.outPath },
          (p) => {
            job.received = p.received;
            if (p.size) job.size = p.size;
            job.percent = p.size ? (p.received / p.size) * 100 : 0;
            job.speed = p.speed || 0;
            job.phase = `下载中（${Math.max(1, Number(this.cfg.conn) || 8)} 连接 · 会员通道）`;
            this.emitState();
          }
        );
        job.status = 'done';
        job.percent = 100;
        if (job.size) job.received = job.size;
        job.speed = 0;
        job.phase = '完成';
        this.running.delete(job.id);
        this.emitState();
        this.pump();
        return r;
      } catch (e) {
        this.running.delete(job.id);
        if (e.message === 'cancelled') {
          job.status = 'cancelled';
          job.phase = '已取消';
          job.speed = 0;
          this.emitState();
          this.pump();
          return { ok: false, cancelled: true };
        }
        this.appendLog(job, `\n[native] 失败: ${e.message}\n`);
        job.status = 'error';
        job.error = '下载失败: ' + e.message;
        job.phase = '失败';
        this.emitState();
        this.pump();
        return { ok: false };
      }
    }

    // ---- 兜底：交给 quark-drive CLI（单连接）----
    job.status = 'running';
    const args = this.buildEngineArgs(job);
    job.phase = '下载中（单连接）';
    this.emitState();

    let p;
    try {
      p = spawn(this.bin, args, { env: this.childEnv() });
    } catch (e) {
      job.status = 'error';
      job.error = 'spawn 失败: ' + e.message;
      job.phase = '失败';
      this.emitState();
      this.pump();
      return { ok: false };
    }
    this.running.set(job.id, { type: 'child', proc: p });
    p.stdout.on('data', (d) => this.appendLog(job, d));
    p.stderr.on('data', (d) => this.appendLog(job, d));
    p.on('error', (e) => {
      job.status = 'error';
      job.error = '启动失败: ' + e.message;
      job.phase = '失败';
      this.running.delete(job.id);
      this.emitState();
      this.pump();
    });
    p.on('exit', (code, sig) => {
      this.running.delete(job.id);
      clearInterval(job.timer);
      job.timer = null;
      if (code === 0) {
        job.status = 'done';
        job.percent = 100;
        if (job.size) job.received = job.size;
        job.phase = '完成';
      } else {
        job.status = sig === 'SIGTERM' ? 'cancelled' : 'error';
        if (job.status === 'error') {
          const tail = job.log.trim().split('\n').slice(-2).join(' | ');
          job.error = `引擎退出码 ${code}${sig ? ' 信号 ' + sig : ''}${tail ? '：' + tail : ''}`;
        }
        job.phase = job.status === 'cancelled' ? '已取消' : '失败';
      }
      job.speed = 0;
      this.emitState();
      this.pump();
    });

    job.timer = setInterval(() => {
      if (!job._stdoutProgress) {
        const now = Date.now();
        const delta = this.measure(job);
        const dt = (now - job._lastAt) / 1000;
        if (dt > 0) job.speed = Math.max(0, Math.round(delta / dt));
        job._lastAt = now;
        if (job.size) job.percent = Math.min(100, (job.received / job.size) * 100);
      }
      this.emitState();
    }, POLL_MS);

    this.emitState();
    return { ok: true };
  }

  buildEngineArgs(job) {
    if (job.fid) {
      job.mode = 'fid';
      return ['download', '--id', job.fid, '-o', job.outPath];
    }
    job.mode = 'url';
    return ['download', '--url', job.url, '-o', job.outPath];
  }

  appendLog(job, buf) {
    const text = buf.toString();
    job.log = (job.log + text).slice(-LOG_TAIL);
    job._buf = (job._buf + text).slice(-400);
    const re = /([\d.]+)\s*(B|KB|MB|GB|TB)\s*\/\s*([\d.]+)\s*(B|KB|MB|GB|TB)\s+([\d.]+)%\s+([\d.]+)\s*(B|KB|MB|GB|TB)\/s/g;
    let m;
    let last = null;
    while ((m = re.exec(job._buf)) !== null) last = m;
    if (last) {
      job._stdoutProgress = true;
      job.received = toBytes(last[1], last[2]);
      job.size = toBytes(last[3], last[4]);
      job.percent = Number(last[5]) || 0;
      const sp = toBytes(last[6], last[7]);
      job.speed = sp > 5 * 1024 ** 3 ? 0 : sp;
    }
  }

  measure(job) {
    const dir = path.dirname(job.outPath);
    const base = path.basename(job.outPath);
    let total = 0;
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name === base || name.startsWith(base + '.')) {
          try {
            const st = fs.statSync(path.join(dir, name));
            if (st.isFile()) total += st.size;
          } catch (_) {}
        }
      }
    } catch (_) {}
    const delta = total - job._lastBytes;
    job.received = total;
    job._lastBytes = total;
    if (job.size && total > job.size) job.size = total;
    return Math.max(0, delta);
  }


  cancel(jobId) {
    const r = this.running.get(jobId);
    if (r) {
      if (r.type === 'native') {
        this.fetcher.abort(jobId);
      } else if (r.proc) {
        r.proc.kill('SIGTERM');
      }
      return true;
    }
    const i = this.queued.findIndex((j) => j.id === jobId);
    if (i >= 0) {
      this.queued[i].status = 'cancelled';
      this.queued.splice(i, 1);
      this.emitState();
      return true;
    }
    return false;
  }

  /** 清除已完成/失败/取消的任务，只保留 running 与 queued */
  clearFinished() {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((j) => j.status === 'running' || j.status === 'queued');
    const removed = before - this.jobs.length;
    if (removed) this.emitState();
    return removed;
  }

  killAll() {
    for (const [id, r] of this.running) {
      try {
        if (r.type === 'native') this.fetcher.abort(id);
        else if (r.proc) r.proc.kill('SIGTERM');
      } catch (e) {}
    }
  }
}

module.exports = { Engine };
