#!/usr/bin/env node
'use strict';

/*
 * Markup — draw feedback on an HTML page, PDF or image and export it in a
 * form an AI coding agent can read (Markdown + screenshots).
 *
 * No npm dependencies. Runs a small local web server and opens the UI in a
 * dedicated Chrome window, which it talks to over the DevTools pipe so it can
 * take pixel-accurate screenshots and learn the real path of dropped files.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const VERSION = '1.0.0';
const APP_DIR = path.join(__dirname, 'app');
const VENDOR_DIR = path.join(__dirname, 'vendor');
const PREFIX = '/__markup__';

const HTML_EXT = new Set(['.html', '.htm', '.xhtml']);
const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp']);
const MIME = {
  '.html': 'text/html', '.htm': 'text/html', '.xhtml': 'application/xhtml+xml',
  '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript',
  '.json': 'application/json', '.map': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/plain', '.xml': 'application/xml', '.csv': 'text/csv',
  '.wasm': 'application/wasm', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.icc': 'application/vnd.iccprofile',
};
const TEXT_TYPES = /^(text\/|application\/(json|javascript|xml|manifest\+json)|image\/svg)/;

// ───────────────────────────────────────────────────────────── utilities

function configDir() {
  if (process.env.MARKUP_CONFIG_DIR) return process.env.MARKUP_CONFIG_DIR;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'html-markup');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || os.homedir(), 'html-markup');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'html-markup');
}

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function kindOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (HTML_EXT.has(ext)) return 'html';
  if (ext === '.pdf') return 'pdf';
  if (IMG_EXT.has(ext)) return 'image';
  return null;
}

function pad2(n) { return String(n).padStart(2, '0'); }

function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

function slug(name) {
  return name.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'page';
}

/**
 * Adds data-mk-line="N" to every element start tag so the UI can tell the
 * agent which source line an annotated element came from. Purely additive:
 * if anything looks off the caller falls back to the untouched source.
 */
function annotateLines(src) {
  const RAW = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noembed', 'noframes', 'plaintext']);
  const SKIP = new Set(['html', 'head', 'meta', 'link', 'base', 'script', 'style', 'title', 'noscript', 'template']);
  const lower = src.toLowerCase();
  const n = src.length;
  let out = '';
  let last = 0;
  let i = 0;
  let line = 1;
  let counted = 0;
  const lineAt = (idx) => {
    for (; counted < idx; counted++) if (src.charCodeAt(counted) === 10) line++;
    return line;
  };
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt === -1) break;
    const c = src.charCodeAt(lt + 1);
    if (c === 33 /* ! */) {
      const end = src.startsWith('<!--', lt) ? src.indexOf('-->', lt + 4) : src.indexOf('>', lt);
      if (end === -1) break;
      i = end + (src.startsWith('<!--', lt) ? 3 : 1);
      continue;
    }
    const isAlpha = (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
    if (!isAlpha) { i = lt + 1; continue; }
    let j = lt + 1;
    while (j < n && !/[\s/>]/.test(src[j])) j++;
    const name = lower.slice(lt + 1, j);
    // Find the end of the start tag; quotes only matter right after "=".
    let k = j;
    let closed = false;
    while (k < n) {
      const ch = src[k];
      if (ch === '>') { closed = true; break; }
      if (ch === '=') {
        k++;
        while (k < n && /\s/.test(src[k])) k++;
        if (src[k] === '"' || src[k] === "'") {
          const e = src.indexOf(src[k], k + 1);
          if (e === -1) { k = n; break; }
          k = e + 1;
        }
        continue;
      }
      k++;
    }
    if (!closed) break;
    if (!SKIP.has(name)) {
      out += src.slice(last, j) + ` data-mk-line="${lineAt(lt)}"`;
      last = j;
    }
    i = k + 1;
    if (RAW.has(name)) {
      const close = lower.indexOf('</' + name, i);
      if (close === -1) break;
      i = close;
    }
  }
  return out + src.slice(last);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Minimal zip writer (deflate for text, store for already-compressed images). */
function makeZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflate = !/\.(png|jpe?g|webp|gif|zip)$/i.test(name);
    const body = deflate ? zlib.deflateRawSync(data) : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, body);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(deflate ? 8 : 0, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

// ───────────────────────────────────────────────────────────── Chrome / CDP

function findChrome() {
  const candidates = [];
  if (process.env.MARKUP_CHROME) candidates.push(process.env.MARKUP_CHROME);
  if (process.platform === 'darwin') {
    for (const base of ['/Applications', path.join(os.homedir(), 'Applications')]) {
      candidates.push(
        `${base}/Google Chrome.app/Contents/MacOS/Google Chrome`,
        `${base}/Chromium.app/Contents/MacOS/Chromium`,
        `${base}/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`,
        `${base}/Brave Browser.app/Contents/MacOS/Brave Browser`,
        `${base}/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary`,
      );
    }
  } else if (process.platform === 'win32') {
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean)) {
      candidates.push(
        path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      );
    }
  } else {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']) {
        candidates.push(path.join(dir, bin));
      }
    }
  }
  return candidates.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } }) || null;
}

/**
 * On Apple Silicon a universal Chrome can end up running under Rosetta, depending on how
 * this process was started (macOS starts script-based .app bundles as Intel, and that
 * preference is inherited). Emulated Chrome is slow enough that the window may never
 * connect, so ask for the native slice explicitly whenever the browser has one.
 */
function nativeLaunch(bin, args) {
  if (process.platform !== 'darwin') return [bin, args];
  try {
    const appleSilicon = require('child_process').execFileSync('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], { encoding: 'utf8' }).trim() === '1';
    if (!appleSilicon || !fs.existsSync('/usr/bin/arch')) return [bin, args];
    const fd = fs.openSync(bin, 'r');
    const head = Buffer.alloc(4096);
    fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);
    const ARM64 = 0x0100000c;
    let hasArm64 = false;
    const magic = head.readUInt32BE(0);
    if (magic === 0xcafebabe || magic === 0xcafebabf) {
      const entry = magic === 0xcafebabe ? 20 : 32;
      const count = Math.min(head.readUInt32BE(4), 16);
      for (let i = 0; i < count; i++) if (head.readUInt32BE(8 + i * entry) === ARM64) hasArm64 = true;
    } else if (head.readUInt32LE(0) === 0xfeedfacf) {
      hasArm64 = head.readUInt32LE(4) === ARM64;
    }
    return hasArm64 ? ['/usr/bin/arch', ['-arm64', bin, ...args]] : [bin, args];
  } catch {
    return [bin, args];
  }
}

/** DevTools protocol over the --remote-debugging-pipe transport (NUL-delimited JSON). */
class CDP {
  constructor(child) {
    this.writer = child.stdio[3];
    this.reader = child.stdio[4];
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    let chunks = [];
    this.reader.on('data', (chunk) => {
      let start = 0;
      for (;;) {
        const nul = chunk.indexOf(0, start);
        if (nul === -1) { chunks.push(start ? chunk.subarray(start) : chunk); break; }
        chunks.push(chunk.subarray(start, nul));
        const text = Buffer.concat(chunks).toString('utf8');
        chunks = [];
        start = nul + 1;
        if (text) this._dispatch(text);
      }
    });
    const fail = () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error('Browser connection closed'));
      this.pending.clear();
    };
    this.reader.on('close', fail);
    this.reader.on('error', fail);
    this.writer.on('error', fail);
  }

  _dispatch(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result);
    } else {
      for (const fn of this.listeners) fn(msg);
    }
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('Browser connection closed'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject, method });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.writer.write(JSON.stringify(msg) + '\0');
    });
  }

  on(fn) { this.listeners.add(fn); }
}

// ───────────────────────────────────────────────────────────── application

async function start(opts = {}) {
  const CONFIG_DIR = configDir();
  const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
  const INSTANCE_FILE = path.join(CONFIG_DIR, 'instance.json');
  const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'html-markup-'));
  const token = crypto.randomBytes(24).toString('hex');
  const log = opts.quiet ? () => {} : (...a) => console.error(...a);

  let settings = Object.assign({ saveTo: 'source', labels: true, recent: [] }, readJSON(SETTINGS_FILE, {}));
  let doc = null;
  let docSeq = 0;
  let lastExport = null;
  let port = 0;
  let cdp = null;
  let sessionId = null;
  let chrome = null;
  let stopping = false;
  let exported = false;
  const waiters = new Set();
  const stopCallbacks = [];

  const saveSettings = () => { try { writeJSON(SETTINGS_FILE, settings); } catch { /* non-fatal */ } };
  const origins = () => [`http://127.0.0.1:${port}`, `http://localhost:${port}`];

  // ── documents

  function guessRoot(file) {
    // Pages that reach for "../assets/x.css" need the server root to sit above them.
    let up = 0;
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(512 * 1024);
      const len = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const re = /(?:src|href|poster|action)\s*=\s*["']?((?:\.\.\/)+)/gi;
      const text = buf.toString('utf8', 0, len);
      let m;
      while ((m = re.exec(text))) up = Math.max(up, m[1].length / 3);
    } catch { /* fall through */ }
    let root = path.dirname(file);
    for (let i = 0; i < Math.min(up, 4); i++) {
      const parent = path.dirname(root);
      if (parent === root || parent === os.homedir() || parent === path.dirname(os.homedir())) break;
      root = parent;
    }
    return root;
  }

  function openDoc(file, { uploadedName } = {}) {
    const abs = path.resolve(file);
    let st;
    try { st = fs.statSync(abs); } catch { throw new Error(`File not found: ${abs}`); }
    if (!st.isFile()) throw new Error(`Not a file: ${abs}`);
    const kind = kindOf(abs);
    if (!kind) throw new Error(`Unsupported file type "${path.extname(abs) || path.basename(abs)}". Open an HTML file, a PDF or an image.`);
    const uploaded = !!uploadedName;
    const root = kind === 'html' && !uploaded ? guessRoot(abs) : path.dirname(abs);
    const rel = path.relative(root, abs).split(path.sep).map(encodeURIComponent).join('/');
    doc = {
      id: ++docSeq,
      kind,
      name: uploadedName || path.basename(abs),
      path: uploaded ? null : abs,
      file: abs,
      root,
      url: kind === 'html' ? '/' + rel : `${PREFIX}/${kind}.html?doc=${docSeq}`,
    };
    if (!uploaded) {
      settings.recent = [abs, ...settings.recent.filter((p) => p !== abs)].slice(0, 8);
      saveSettings();
    }
    lastExport = null;
    return publicDoc();
  }

  function publicDoc() {
    if (!doc) return null;
    return { id: doc.id, kind: doc.kind, name: doc.name, path: doc.path, root: doc.path ? doc.root : null, url: doc.url };
  }

  function publicState() {
    return {
      doc: publicDoc(),
      settings: { saveTo: settings.saveTo, labels: settings.labels },
      recent: settings.recent.filter((p) => fs.existsSync(p)).map((p) => ({ name: path.basename(p), dir: path.dirname(p).replace(os.homedir(), '~') })),
      wait: !!opts.wait || waiters.size > 0,
      platform: process.platform,
      version: VERSION,
    };
  }

  function recentPath(index) {
    return settings.recent.filter((p) => fs.existsSync(p))[index];
  }

  // ── export

  function exportBase(saveTo) {
    if (doc && doc.path && saveTo !== 'downloads') return { base: path.join(path.dirname(doc.path), 'markup-feedback'), where: 'source' };
    return { base: path.join(os.homedir(), 'Downloads', 'markup-feedback'), where: 'downloads' };
  }

  function writeExport(payload, saveTo) {
    const { base, where } = exportBase(saveTo);
    const dir = path.join(base, `${slug(doc.name)}-${payload.stamp}`);
    fs.mkdirSync(dir, { recursive: true });
    if (where === 'source') {
      // Keeps feedback folders out of the user's git history without touching their .gitignore.
      const ignore = path.join(base, '.gitignore');
      if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
    }
    const names = [];
    for (const f of payload.files) {
      const name = path.basename(String(f.name)).replace(/[^\w.-]/g, '_');
      fs.writeFileSync(path.join(dir, name), f.data);
      names.push(name);
    }
    const md = path.join(dir, 'feedback.md');
    const source = doc.path || doc.name;
    const n = payload.points;
    // Naming the count and asking for an answer per point is what makes a skipped one show.
    const prompt = `I've marked up \`${source}\` with visual feedback. Read \`${md}\` — it ${n ? `opens with a checklist of the ${countOf(n)} to act on, then gives` : 'lists'} each numbered annotation with my note, the element it targets and a screenshot. Look at the screenshots it references (same folder) and make the changes. ${reportBack(n, 'me')}`;
    return { dir, md, files: names, where, prompt, points: n, canChooseLocation: !!doc.path };
  }

  function removeExport(exp) {
    try {
      fs.rmSync(exp.dir, { recursive: true, force: true });
      const base = path.dirname(exp.dir);
      const rest = fs.readdirSync(base).filter((n) => n !== '.gitignore' && n !== '.DS_Store');
      if (!rest.length) fs.rmSync(base, { recursive: true, force: true });
    } catch { /* best effort */ }
  }

  // ── http helpers

  function send(res, status, body, headers = {}) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    res.writeHead(status, { 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...headers });
    res.end(buf);
  }

  const json = (res, value, status = 200) => send(res, status, JSON.stringify(value), { 'Content-Type': 'application/json' });

  function readBody(req, limit = 512 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { reject(new Error('Request too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  function serveFile(req, res, file, { inject = false } = {}) {
    let st;
    try { st = fs.statSync(file); } catch { return send(res, 404, 'Not found'); }
    if (st.isDirectory()) return serveFile(req, res, path.join(file, 'index.html'), { inject });
    let type = mimeFor(file);
    if (inject && HTML_EXT.has(path.extname(file).toLowerCase())) {
      const raw = fs.readFileSync(file);
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
        return send(res, 200, annotateLines(text), { 'Content-Type': 'text/html; charset=utf-8' });
      } catch {
        return send(res, 200, raw, { 'Content-Type': 'text/html' });
      }
    }
    if (TEXT_TYPES.test(type)) type += '; charset=utf-8';
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && (range[1] || range[2])) {
      let from = range[1] ? parseInt(range[1], 10) : st.size - parseInt(range[2], 10);
      let to = range[1] && range[2] ? parseInt(range[2], 10) : st.size - 1;
      from = Math.max(0, from);
      to = Math.min(st.size - 1, to);
      if (from > to) return send(res, 416, '', { 'Content-Range': `bytes */${st.size}` });
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${from}-${to}/${st.size}`, 'Content-Length': to - from + 1 });
      return fs.createReadStream(file, { start: from, end: to }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  function safeJoin(root, urlPath) {
    let rel;
    try { rel = decodeURIComponent(urlPath); } catch { return null; }
    if (rel.includes('\0')) return null;
    const segs = rel.split('/').filter(Boolean);
    if (segs.some((s) => s.startsWith('.'))) return null; // no dotfiles, no traversal
    const file = path.join(root, ...segs);
    if (file !== root && !file.startsWith(root + path.sep)) return null;
    return file;
  }

  async function evalInPage(expression) {
    if (!cdp || !sessionId) return undefined;
    try {
      const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      return r.result ? r.result.value : undefined;
    } catch { return undefined; /* window gone */ }
  }

  // ── api

  async function api(req, res, name, url) {
    const isPost = req.method === 'POST';

    // Requests from the command line (a second `markup file.html`) authenticate with the
    // token from the instance file; nothing reachable from a web page accepts a file path.
    if (name === 'cli' && isPost) {
      if (req.headers['x-markup-token'] !== token) return json(res, { error: 'Forbidden' }, 403);
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
      if (cdp && sessionId) cdp.send('Page.bringToFront', {}, sessionId).catch(() => {});
      if (body.path && !(doc && doc.path === path.resolve(body.path))) {
        // Never throw away marks the user has not exported yet without asking them.
        const ok = await evalInPage('window.__mkCanReplace ? window.__mkCanReplace() : true');
        if (ok === false) return json(res, { error: 'The Markup window has unexported feedback on another file, and the user chose to keep working on it.' }, 409);
        try { openDoc(body.path); } catch (e) { return json(res, { error: e.message }, 400); }
        await evalInPage('window.__mkDocChanged && window.__mkDocChanged()');
      }
      if (!body.wait) return json(res, { ok: true });
      const waiter = { res };
      waiters.add(waiter);
      await evalInPage('window.__mkWaitChanged && window.__mkWaitChanged(true)');
      req.on('close', () => waiters.delete(waiter));
      return;
    }

    if (isPost && !origins().includes(req.headers.origin)) return json(res, { error: 'Forbidden' }, 403);

    if (name === 'state') return json(res, publicState());

    if (name === 'settings' && isPost) {
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
      if (body.saveTo === 'source' || body.saveTo === 'downloads') settings.saveTo = body.saveTo;
      if (typeof body.labels === 'boolean') settings.labels = body.labels;
      saveSettings();
      return json(res, { ok: true });
    }

    if (name === 'open-file' && isPost) {
      // The page stashed the File the user picked or dropped; ask Chrome where it lives on
      // disk so relative assets resolve and feedback can reference the real path.
      let filePath = '';
      try {
        const { result } = await cdp.send('Runtime.evaluate', { expression: 'window.__mkPendingFile' }, sessionId);
        if (result && result.objectId) {
          const info = await cdp.send('DOM.getFileInfo', { objectId: result.objectId }, sessionId);
          filePath = info.path || '';
          cdp.send('Runtime.releaseObject', { objectId: result.objectId }, sessionId).catch(() => {});
        }
      } catch { /* fall back to upload */ }
      if (!filePath) return json(res, { needUpload: true });
      try { return json(res, { doc: openDoc(filePath) }); } catch (e) { return json(res, { error: e.message }, 400); }
    }

    if (name === 'upload' && isPost) {
      const original = path.basename(url.searchParams.get('name') || 'page.html').replace(/[^\w. ()-]/g, '_');
      if (!kindOf(original)) return json(res, { error: 'Unsupported file type. Open an HTML file, a PDF or an image.' }, 400);
      const dir = fs.mkdtempSync(path.join(TMP_DIR, 'upload-'));
      const file = path.join(dir, original);
      fs.writeFileSync(file, await readBody(req));
      return json(res, { doc: openDoc(file, { uploadedName: original }) });
    }

    if (name === 'recent' && isPost) {
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
      const p = recentPath(body.index | 0);
      if (!p) return json(res, { error: 'That file is no longer available.' }, 404);
      try { return json(res, { doc: openDoc(p) }); } catch (e) { return json(res, { error: e.message }, 400); }
    }

    if (name === 'capture' && isPost) {
      try {
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, captureBeyondViewport: false }, sessionId);
        return send(res, 200, Buffer.from(shot.data, 'base64'), { 'Content-Type': 'image/png' });
      } catch (e) {
        return json(res, { error: e.message }, 500);
      }
    }

    if (name === 'export' && isPost) {
      if (!doc) return json(res, { error: 'No document open' }, 400);
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const payload = {
        stamp: stamp(),
        points: Number.isInteger(body.points) && body.points > 0 ? body.points : 0,
        files: [
          { name: 'feedback.md', data: Buffer.from(String(body.markdown), 'utf8') },
          ...body.files.map((f) => ({ name: f.name, data: Buffer.from(f.data, 'base64') })),
        ],
      };
      const result = writeExport(payload, settings.saveTo);
      lastExport = { ...result, payload, sent: waiters.size > 0 };
      exported = true;
      log(`Feedback saved: ${result.md}`);
      json(res, publicExport());
      for (const w of waiters) json(w.res, { md: result.md, dir: result.dir, source: doc.path || doc.name, points: result.points });
      waiters.clear();
      if (opts.wait) {
        process.stdout.write(waitMessage(result.md, doc.path || doc.name, result.points));
        setTimeout(() => stop(0), 1500);
      }
      return;
    }

    if (name === 'relocate' && isPost) {
      if (!lastExport) return json(res, { error: 'Nothing exported yet' }, 400);
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
      if (body.saveTo !== 'source' && body.saveTo !== 'downloads') return json(res, { error: 'Bad location' }, 400);
      settings.saveTo = body.saveTo;
      saveSettings();
      const previous = lastExport;
      const result = writeExport(previous.payload, settings.saveTo);
      if (result.dir !== previous.dir) removeExport(previous);
      lastExport = { ...result, payload: previous.payload, sent: false };
      log(`Feedback moved: ${result.md}`);
      return json(res, publicExport());
    }

    if (name === 'reveal' && isPost) {
      if (!lastExport) return json(res, { error: 'Nothing exported yet' }, 400);
      if (process.platform === 'darwin') execFile('open', ['-R', lastExport.md], () => {});
      else if (process.platform === 'win32') execFile('explorer', [lastExport.dir], () => {});
      else execFile('xdg-open', [lastExport.dir], () => {});
      return json(res, { ok: true });
    }

    if (name === 'export.zip') {
      if (!lastExport) return send(res, 404, 'Nothing exported yet');
      const folder = path.basename(lastExport.dir);
      const zip = makeZip(lastExport.payload.files.map((f) => ({ name: `${folder}/${f.name}`, data: f.data })));
      return send(res, 200, zip, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${folder}.zip"` });
    }

    return json(res, { error: 'Unknown endpoint' }, 404);
  }

  function publicExport() {
    const { dir, md, files, where, prompt, points, canChooseLocation, sent } = lastExport;
    return { dir, md, files, where, prompt, points, canChooseLocation, wait: !!opts.wait, sent: !!sent };
  }

  // ── server

  const server = http.createServer(async (req, res) => {
    try {
      // Only answer to our own loopback name, which shuts out DNS-rebinding pages.
      const host = req.headers.host || '';
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, 'Forbidden');
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const p = url.pathname;

      if (p === PREFIX || p.startsWith(PREFIX + '/')) {
        const rest = p.slice(PREFIX.length + 1);
        if (rest.startsWith('api/')) return await api(req, res, rest.slice(4), url);
        if (rest === 'file') {
          if (!doc) return send(res, 404, 'No document open');
          return serveFile(req, res, doc.file);
        }
        if (rest.startsWith('vendor/')) {
          const file = safeJoin(VENDOR_DIR, rest.slice(7));
          return file ? serveFile(req, res, file) : send(res, 404, 'Not found');
        }
        const file = safeJoin(APP_DIR, rest || 'index.html');
        return file ? serveFile(req, res, file) : send(res, 404, 'Not found');
      }

      // Everything else is the document being reviewed, served from its own folder so
      // relative and root-absolute asset URLs both resolve the way they do on a real site.
      if (!doc || doc.kind !== 'html') {
        if (p === '/') { res.writeHead(302, { Location: PREFIX + '/' }); return res.end(); }
        return send(res, 404, 'Not found');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      const file = safeJoin(doc.root, p);
      if (!file) return send(res, 404, 'Not found');
      return serveFile(req, res, file, { inject: true });
    } catch (e) {
      try { json(res, { error: e.message }, 500); } catch { /* headers already sent */ }
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port || 0, '127.0.0.1', resolve);
  });
  port = server.address().port;
  const appUrl = `http://127.0.0.1:${port}${PREFIX}/`;

  if (opts.file) openDoc(opts.file);

  // ── browser

  const bin = findChrome();
  if (!bin) {
    server.close();
    throw new Error('Could not find Google Chrome (or Chromium, Edge, Brave). Install Chrome, or set MARKUP_CHROME to the browser binary.');
  }
  const profile = path.join(CONFIG_DIR, opts.headless ? 'browser-profile-headless' : 'browser-profile');
  fs.mkdirSync(profile, { recursive: true });
  const args = [
    `--user-data-dir=${profile}`,
    '--remote-debugging-pipe',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-extensions',
    '--disable-component-extensions-with-background-pages',
    '--disable-search-engine-choice-screen',
    '--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication',
    '--password-store=basic',
    '--use-mock-keychain',
    `--window-size=${opts.windowSize || '1560,980'}`,
    ...(opts.chromeArgs || []),
  ];
  if (opts.headless) args.push('--headless=new', 'about:blank');
  else args.push(`--app=${appUrl}`);

  const [command, commandArgs] = nativeLaunch(bin, args);
  chrome = spawn(command, commandArgs, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  chrome.on('exit', () => { if (!stopping) stop(exported || !opts.wait ? 0 : 1); });
  cdp = new CDP(chrome);

  let targetId;
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  if (opts.headless) {
    ({ targetId } = await cdp.send('Target.createTarget', { url: appUrl }));
  } else {
    const deadline = Date.now() + 20000;
    while (!targetId && Date.now() < deadline) {
      const { targetInfos } = await cdp.send('Target.getTargets');
      const t = targetInfos.find((info) => info.url.startsWith(appUrl) && info.type !== 'service_worker');
      if (t) targetId = t.targetId;
      else await new Promise((r) => setTimeout(r, 100));
    }
    if (!targetId) { await stop(1); throw new Error('The Markup window did not open.'); }
  }
  ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  await cdp.send('Page.enable', {}, sessionId);
  cdp.on((msg) => {
    if ((msg.method === 'Target.targetDestroyed' || msg.method === 'Target.targetCrashed') && msg.params.targetId === targetId) {
      stop(exported || !opts.wait ? 0 : 1);
    }
  });

  try { writeJSON(INSTANCE_FILE, { port, token, pid: process.pid }); fs.chmodSync(INSTANCE_FILE, 0o600); } catch { /* non-fatal */ }

  async function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    for (const w of waiters) { try { json(w.res, { closed: true }); } catch { /* gone */ } }
    try {
      const mine = readJSON(INSTANCE_FILE, null);
      if (mine && mine.pid === process.pid) fs.rmSync(INSTANCE_FILE, { force: true });
    } catch { /* ignore */ }
    try {
      if (cdp && !cdp.closed) await Promise.race([cdp.send('Browser.close'), new Promise((r) => setTimeout(r, 1500))]);
    } catch { /* already gone */ }
    try { if (chrome && chrome.exitCode === null) chrome.kill(); } catch { /* ignore */ }
    try { server.closeAllConnections(); server.close(); } catch { /* ignore */ }
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    for (const fn of stopCallbacks) fn(code, exported);
  }

  return {
    port,
    appUrl,
    cdp,
    sessionId,
    stop,
    onStop: (fn) => stopCallbacks.push(fn),
    get lastExport() { return lastExport; },
  };
}

// ───────────────────────────────────────────────────────────── command line

const countOf = (n) => `${n} point${n === 1 ? '' : 's'}`;

/** The closing instruction given to the agent: every point gets an answer, so none goes missing quietly. */
function reportBack(points, who) {
  return points > 1
    ? `Act on every point, and when you finish report back on each one by number: done, not done (and why), or a question for ${who}.`
    : `When you finish, report back on what you did: done, not done (and why), or a question for ${who}.`;
}

/** What `markup --wait` prints for the agent that ran it. */
function waitMessage(md, source, points) {
  return `Feedback file: ${md}\nThe user marked up ${source}. Read the feedback file above and the screenshots it references (same folder), then act on the feedback.` +
    `${points ? ` It opens with a checklist of the ${countOf(points)} to act on.` : ''} ${reportBack(points, 'the user')}\n`;
}

const HELP = `Markup ${VERSION} — draw feedback on a page and hand it to your AI agent.

Usage:
  markup [file]            Open the Markup window (optionally with an HTML, PDF or image file)
  markup --wait <file>     Open the file, block until feedback is exported, then print the
                           path of feedback.md and exit. Handy for an agent to run directly.

Options:
  --wait        Exit after the first export and print where the feedback was saved
  --port <n>    Use a fixed port instead of a random free one
  -h, --help    Show this help
  -v, --version Show the version

Feedback is written to a "markup-feedback" folder next to the file you reviewed
(or to ~/Downloads/markup-feedback — you can switch in the export dialog).
`;

function requestJSON(port, pathName, body, headers) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, path: pathName, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = { wait: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { process.stdout.write(HELP); return; }
    if (a === '-v' || a === '--version') { console.log(VERSION); return; }
    if (a === '--wait') opts.wait = true;
    else if (a === '--port') opts.port = parseInt(argv[++i], 10);
    else if (a === '--headless') opts.headless = true;
    else if (a.startsWith('-')) { console.error(`Unknown option: ${a}\n`); process.stdout.write(HELP); process.exit(2); }
    else opts.file = path.resolve(a);
  }

  if (opts.file) {
    if (!fs.existsSync(opts.file)) { console.error(`File not found: ${opts.file}`); process.exit(2); }
    if (!kindOf(opts.file)) { console.error(`Unsupported file type: ${opts.file}\nOpen an HTML file, a PDF or an image.`); process.exit(2); }
  } else if (opts.wait) {
    console.error('--wait needs a file to review, e.g. markup --wait index.html'); process.exit(2);
  }

  // If a Markup window is already running, hand the file to it instead of opening another.
  const instance = readJSON(path.join(configDir(), 'instance.json'), null);
  if (instance && instance.port && !opts.headless) {
    try {
      const r = await requestJSON(instance.port, `${PREFIX}/api/cli`, { path: opts.file || null, wait: opts.wait }, { 'X-Markup-Token': instance.token });
      if (r.status === 200) {
        if (opts.wait) {
          if (r.body.md) {
            process.stdout.write(waitMessage(r.body.md, r.body.source, r.body.points));
            return;
          }
          console.error('The Markup window was closed without exporting feedback.');
          process.exit(1);
        }
        console.error(opts.file ? `Opened ${opts.file} in the running Markup window.` : 'Markup is already running — brought its window to the front.');
        return;
      }
      if (r.body && r.body.error && (r.status === 400 || r.status === 409)) { console.error(r.body.error); process.exit(r.status === 409 ? 1 : 2); }
    } catch { /* stale instance file; start fresh */ }
  }

  let app;
  try {
    app = await start(opts);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  console.error(opts.wait
    ? 'Markup is open. Mark up the page, then click “Send feedback” — this command will finish when you do.'
    : 'Markup is open. Close its window (or press Ctrl+C here) to quit.');
  app.onStop((code, exported) => {
    if (opts.wait && !exported) console.error('The Markup window was closed without exporting feedback.');
    process.exit(code);
  });
  process.on('SIGINT', () => app.stop(opts.wait ? 1 : 0));
  process.on('SIGTERM', () => app.stop(opts.wait ? 1 : 0));
}

module.exports = { start, annotateLines, makeZip, CDP, findChrome, waitMessage };

if (require.main === module) main();
