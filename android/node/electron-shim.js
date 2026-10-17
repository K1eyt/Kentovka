// Кентовка на Android: та же программа, что на ПК (app/main.js), только вместо Electron — этот модуль.
// Окна — это WebView приложения (страницы открываются с http://127.0.0.1:18444), IPC — через WebSocket /rpc,
// серверы Кентовки открываются через мостик (TLS до сервера делает node, сертификат проверяется как на ПК).
'use strict';
const http = require('http');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.KENTOVKA_ANDROID_PORT) || 18444;
const DATA = process.env.KENTOVKA_USERDATA;
const APPDIR = process.env.KENTOVKA_APPDIR; // .../nodeproject/app
const ROOT = path.join(APPDIR, '..');
const HOME = `http://127.0.0.1:${PORT}`;

// ---------- события для Java (длинный опрос /java-events) ----------
const javaQueue = [];
let javaWait = null;
function toJava(ev) { javaQueue.push(ev); if (javaWait) { const w = javaWait; javaWait = null; w(); } }

// ---------- страницы: роль main (стартовая/сервер) и friends (друзья во фрейме) ----------
const sockets = { main: new Set(), friends: new Set() }; // и 'tab:<ключ>' — страница сервера во вкладке (фрейм на главной)
const sockSet = (role) => sockets[role] || (sockets[role] = new Set());
const encode = (v) => {
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { __b64: Buffer.from(v).toString('base64') };
  if (v instanceof ArrayBuffer) return { __b64: Buffer.from(v).toString('base64') };
  if (Array.isArray(v)) return v.map(encode);
  if (v && typeof v === 'object' && v.constructor === Object) { const o = {}; for (const k of Object.keys(v)) o[k] = encode(v[k]); return o; }
  return v;
};
const decode = (v) => {
  if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.__b64 === 'string' && Object.keys(v).length === 1) return Buffer.from(v.__b64, 'base64');
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = decode(v[k]); return o; }
  return v;
};
function push(role, ch, args) {
  const msg = JSON.stringify({ ev: ch, args: encode(args) });
  for (const ws of sockSet(role)) if (ws.readyState === 1) ws.send(msg);
}

// ---------- webContents ----------
let wcSeq = 10;
class WebContents extends EventEmitter {
  constructor(role) { super(); this.role = role; this.url = ''; this.id = role === 'main' ? 1 : role === 'friends' ? 2 : ++wcSeq; this.destroyed = false; }
  send(ch, ...args) { push(this.role, ch, args); }
  isDestroyed() { return this.destroyed; }
  close() { if (this.destroyed) return; this.destroyed = true; if (/^tab:/.test(this.role)) { tabWCs.delete(this.role); push('main', 'shell:frame-close', [{ role: this.role }]); } this.emit('destroyed'); }
  getURL() { return this.url; }
  getZoomFactor() { return 1; }
  focus() {}
  setWindowOpenHandler() {}
  executeJavaScript() { return Promise.resolve(); }
  async loadURL(url) { return navigate(this, url); }
  async loadFile(f) { return navigate(this, 'file://' + f); }
  setAudioMuted() {}
  get session() { return session.defaultSession; }
}
const mainWC = new WebContents('main');
const friendsWC = new WebContents('friends');
friendsWC.url = 'kapp://app/friends.html';

// куда показывать страницу: файл приложения — со своего http, сервер Кентовки — через мостик
async function navigate(wc, url) {
  // вкладка сервера: страница во фрейме на главной (голос в ней не рвётся при переходах)
  if (wc.role === 'tabpending' || /^tab:/.test(wc.role)) {
    if (url === 'kapp://app/friends.html') return;
    const u = new URL(url);
    const lp = await proxyFor(u.hostname, Number(u.port) || 443);
    if (wc.role === 'tabpending') { wc.role = 'tab:' + wc.id; tabWCs.set(wc.role, wc); }
    wc.url = url;
    push('main', 'shell:frame', [{ role: wc.role, url: `http://127.0.0.1:${lp}${u.pathname}${u.search}` }]);
    setTimeout(() => wc.emit('did-finish-load'), 300);
    return;
  }
  if (wc.role !== 'main') return;
  mainWC.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url });
  mainWC.url = url;
  let real = url;
  if (url.startsWith('file://')) real = HOME + '/' + path.basename(url.slice(7).split('?')[0]); // страницы приложения лежат в одной папке (/data/data и /data/user/0 — одно и то же)
  else if (/^https:\/\//.test(url)) {
    const u = new URL(url);
    const lp = await proxyFor(u.hostname, Number(u.port) || 443);
    real = `http://127.0.0.1:${lp}${u.pathname}${u.search}`;
  }
  toJava({ t: 'nav', url: real });
  setTimeout(() => mainWC.emit('did-finish-load'), 300);
}

// ---------- мостик к серверу Кентовки: http://127.0.0.1:порт → TLS (проверка сертификата как в приложении на ПК) ----------
const proxies = new Map(); // "host:port" -> { port }
let verifyProc = null;
function fpOf(cert) { // в виде Electron: sha256/<base64>
  try { return 'sha256/' + Buffer.from(String(cert.fingerprint256).replace(/:/g, ''), 'hex').toString('base64'); } catch { return ''; }
}
function proxyFor(host, port) {
  const key = host + ':' + port;
  if (proxies.has(key)) return Promise.resolve(proxies.get(key).port);
  return new Promise((resolve, reject) => {
    const srv = net.createServer((c) => {
      c.setNoDelay(true);
      const up = tls.connect({ host, port, rejectUnauthorized: false, servername: net.isIP(host) ? undefined : host });
      up.setNoDelay(true);
      up.once('secureConnect', () => {
        const cert = up.getPeerCertificate();
        const isOurs = cert && cert.subject && cert.subject.CN === 'kentovka';
        const decide = (r) => {
          if (!isOurs || r !== 0) { up.destroy(); c.destroy(); return; }
          c.pipe(up); up.pipe(c);
        };
        if (verifyProc) verifyProc({ hostname: host, certificate: { subjectName: isOurs ? 'kentovka' : '', fingerprint: fpOf(cert), subject: { commonName: cert && cert.subject && cert.subject.CN } } }, (r) => decide(r === -3 && isOurs ? 0 : r));
        else decide(0);
      });
      up.on('error', () => c.destroy()); c.on('error', () => up.destroy());
      c.on('close', () => up.destroy()); up.on('close', () => c.destroy());
    });
    const base = 20000 + (parseInt(crypto.createHash('md5').update(key).digest('hex').slice(0, 6), 16) % 20000);
    let tries = 0;
    const listen = () => srv.listen(tries < 20 ? base + tries : 0, '127.0.0.1');
    srv.on('error', () => { tries++; if (tries > 21) reject(new Error('нет свободного порта')); else listen(); });
    srv.on('listening', () => { const p = srv.address().port; proxies.set(key, { port: p, srv }); resolve(p); });
    listen();
  });
}
function realHostOf(h) { // 127.0.0.1:порт мостика → настоящий адрес сервера
  for (const [k, v] of proxies) if (h === '127.0.0.1:' + v.port) return k;
  return h;
}

// ---------- ipcMain ----------
const handlers = new Map(), listeners = new Map();
const ipcMain = {
  handle(ch, fn) { handlers.set(ch, fn); },
  on(ch, fn) { if (!listeners.has(ch)) listeners.set(ch, []); listeners.get(ch).push(fn); },
  removeHandler(ch) { handlers.delete(ch); },
};
const tabWCs = new Map(); // 'tab:<id>' -> WebContents
function evFor(role, sync) {
  const wc = role === 'friends' ? friendsWC : tabWCs.get(role) || mainWC;
  const url = role === 'friends' ? 'kapp://app/friends.html' : /^tab:/.test(role) ? wc.url : wc.url;
  const e = { sender: wc, senderFrame: { url }, returnValue: undefined, preventDefault() {} };
  return e;
}
async function invoke(role, ch, args) {
  if (ch === 'account:sign' && args[1]) args[1] = realHostOf(String(args[1]));
  if (ch === 'call:state' && role === 'friends') toJava({ t: 'call', st: args[0] || null }); // звонок в личке: Java держит звук и службу
  if (ch === 'voice:state' && /^tab:/.test(role)) toJava({ t: 'voice', st: args[0] || null }); // голос на сервере: Java держит звук и службу
  const h = handlers.get(ch);
  if (h) return h(evFor(role), ...args);
  const ls = listeners.get(ch);
  if (ls) { const e = evFor(role); for (const f of ls) f(e, ...args); return e.returnValue; }
  return undefined;
}

// ---------- app ----------
class App extends EventEmitter {
  constructor() { super(); this.paths = {}; this.commandLine = { appendSwitch() {}, hasSwitch() { return false; } }; this.isPackaged = true; this._ready = false; }
  getPath(n) {
    if (this.paths[n]) return this.paths[n];
    const m = { userData: DATA, appData: DATA, documents: path.join(DATA, 'docs'), downloads: path.join(DATA, 'downloads'), temp: path.join(DATA, 'tmp'), home: DATA, desktop: path.join(DATA, 'downloads'), exe: path.join(ROOT, 'node') };
    const p = m[n] || DATA; try { fs.mkdirSync(p, { recursive: true }); } catch {}
    return p;
  }
  setPath(n, p) { this.paths[n] = p; }
  getVersion() { try { return require(path.join(ROOT, 'package.json')).version; } catch { return '0'; } }
  getName() { return 'Kentovka'; }
  setAppUserModelId() {}
  requestSingleInstanceLock() { return true; }
  whenReady() { return new Promise((r) => (this._ready ? r() : this.once('ready', r))); }
  quit() { this.emit('before-quit'); this.emit('will-quit'); }
  exit() { toJava({ t: 'exit' }); }
  relaunch() { toJava({ t: 'relaunch' }); }
  focus() {}
}
const app = new App();

class BrowserWindow extends EventEmitter {
  constructor() { super(); this.webContents = mainWC; this.contentView = { addChildView() {}, removeChildView() {}, children: [] }; BrowserWindow._all = [this]; }
  static getAllWindows() { return BrowserWindow._all || []; }
  static fromWebContents() { return (BrowserWindow._all || [])[0] || null; }
  isDestroyed() { return false; }
  loadURL(u) { return navigate(mainWC, u); }
  loadFile(f) { return navigate(mainWC, 'file://' + f); }
  show() {} hide() {} focus() {} restore() {} minimize() {} maximize() {} unmaximize() {} close() {} setTitle() {} removeMenu() {} setOverlayIcon() {} setMenuBarVisibility() {} setFullScreen() {}
  isMinimized() { return false; } isMaximized() { return false; } isFullScreen() { return false; } isFocused() { return appFocused; } isVisible() { return true; }
  getContentSize() { return [400, 800]; } getBounds() { return { x: 0, y: 0, width: 400, height: 800 }; }
}
let appFocused = true;
// первая — друзья (страница во фрейме), остальные — вкладки серверов
let friendsViewMade = false;
class WebContentsView {
  constructor() { if (!friendsViewMade) { friendsViewMade = true; this.webContents = friendsWC; } else this.webContents = new WebContents('tabpending'); }
  setBounds() {} setBackgroundColor() {} setVisible() {}
}

const session = { defaultSession: {
  setCertificateVerifyProc(fn) { verifyProc = fn; },
  setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDisplayMediaRequestHandler() {}, setDevicePermissionHandler() {},
  on() {}, protocol: { handle(scheme, fn) { if (scheme === 'kapp') kappHandler = fn; }, registerFileProtocol() {} },
  webRequest: { onBeforeRequest() {}, onHeadersReceived() {} },
} };
let kappHandler = null;
const protocol = { registerSchemesAsPrivileged() {}, handle(s, fn) { if (s === 'kapp') kappHandler = fn; } };
const dialog = {
  async showSaveDialog(_w, o) { // сохраняем в «Загрузки» приложения; Java потом предложит поделиться/сохранить
    const name = path.basename((o && o.defaultPath) || 'файл');
    const p = path.join(app.getPath('downloads'), name);
    toJava({ t: 'saved', path: p, name });
    return { canceled: false, filePath: p };
  },
  async showOpenDialog() { return pickFromJava(); },
  async showMessageBox() { return { response: 0 }; },
  showErrorBox() {},
};
let pickWait = null;
function pickFromJava() { return new Promise((resolve) => { pickWait = resolve; toJava({ t: 'pick' }); setTimeout(() => { if (pickWait === resolve) { pickWait = null; resolve({ canceled: true, filePaths: [] }); } }, 5 * 60 * 1000); }); }
const shell = { openPath(p) { toJava({ t: 'open', path: p }); return Promise.resolve(''); }, openExternal(u) { toJava({ t: 'url', url: u }); return Promise.resolve(); }, showItemInFolder() {} };
const clipboard = { writeText(t) { toJava({ t: 'copy', text: String(t) }); }, readText() { return ''; } };
class Notification extends EventEmitter {
  constructor(o) { super(); this.o = o || {}; }
  static isSupported() { return true; }
  show() { const id = crypto.randomBytes(4).toString('hex'); notifs.set(id, this); toJava({ t: 'notify', id, title: String(this.o.title || 'Кентовка'), body: String(this.o.body || '') }); }
  close() {}
}
const notifs = new Map();
class Tray extends EventEmitter { setToolTip() {} setContextMenu() {} setImage() {} destroy() {} }
const Menu = { buildFromTemplate() { return {}; }, setApplicationMenu() {} };
const nativeImage = { createFromPath() { return { isEmpty: () => true, resize() { return this; } }; }, createEmpty() { return { isEmpty: () => true }; } };
const globalShortcut = { register() { return false; }, unregister() {}, unregisterAll() {}, isRegistered() { return false; } };
const desktopCapturer = { getSources: async () => [] };
const safeStorage = { isEncryptionAvailable() { return false; }, encryptString(s) { return Buffer.from(s); }, decryptString(b) { return Buffer.from(b).toString(); } };
const powerMonitor = new EventEmitter();
const screen = { getPrimaryDisplay: () => ({ workAreaSize: { width: 400, height: 800 }, scaleFactor: 2 }) };

// ---------- http: страницы приложения, файлы kapp, IPC ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml' };
const SHIM = fs.readFileSync(path.join(__dirname, 'page-shim.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(APPDIR, 'preload.js'), 'utf8');
function inject(html, role) {
  const tag = `<script>window.__kentovkaAndroid = ${JSON.stringify({ role, port: PORT })};</script><script src="/__shim.js?role=${role}"></script>`;
  return html.replace(/<head>/i, '<head>' + tag);
}
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, HOME);
    const p = decodeURIComponent(u.pathname);
    if (p === '/__shim.js') {
      const appId = await invoke(u.searchParams.get('role') || 'main', 'app:id', []).catch(() => '');
      res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store' });
      return res.end(SHIM.replace('__PRELOAD__', JSON.stringify(PRELOAD)).replace('__SYNC__', JSON.stringify({ 'app:id': appId || '', 'backup:port': Number(process.env.KENTOVKA_BACKUP_PORT) || 8449 })));
    }
    if (p === '/java-events') { // Java забирает события: куда перейти, уведомления, «скопировать» и т. п.
      const send = () => { const evs = javaQueue.splice(0); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(evs)); };
      if (javaQueue.length) return send();
      javaWait = send; req.on('close', () => { if (javaWait === send) javaWait = null; });
      setTimeout(() => { if (javaWait === send) { javaWait = null; send(); } }, 25000);
      return;
    }
    if (p === '/ipc' && req.method === 'POST') { // от Java: подпись, адреса сервера, профиль, «назад», голос
      let body = ''; for await (const ch of req) body += ch;
      const m = JSON.parse(body || '{}');
      const r = await invoke(m.role || 'main', String(m.ch), decode(m.args || []));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(encode(r === undefined ? null : r)));
    }
    if (p === '/java') { // от Java: результаты (выбор файла, фокус, клик по уведомлению, адреса сети)
      let body = ''; for await (const ch of req) body += ch;
      const m = JSON.parse(body || '{}');
      if (m.t === 'picked' && pickWait) { const w = pickWait; pickWait = null; w(m.path ? { canceled: false, filePaths: [m.path] } : { canceled: true, filePaths: [] }); }
      if (m.t === 'focus') { appFocused = !!m.on; }
      if (m.t === 'notifyClick') { const n = notifs.get(m.id); if (n) n.emit('click'); }
      if (m.t === 'ifaces' && Array.isArray(m.list)) setIfaces(m.list);
      if (m.t === 'page') { mainWC.url = m.url && m.url.startsWith(HOME) ? 'file://' + path.join(APPDIR, new URL(m.url).pathname) : mainWC.url; }
      res.writeHead(200); return res.end('ok');
    }
    if (p === '/' || p === '/index.html') { res.writeHead(302, { Location: '/launcher.html' }); return res.end(); }
    // страницы приложения
    if (/^\/[\w.-]+\.html$/.test(p)) {
      const f = path.join(APPDIR, p);
      if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      const role = p === '/friends.html' ? 'friends' : 'main';
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
      return res.end(inject(fs.readFileSync(f, 'utf8'), role));
    }
    if (p.startsWith('/public/')) { // страницы приложения берут кое-что из public (kselect.js)
      const f = path.normalize(path.join(ROOT, p)); if (!f.startsWith(path.join(ROOT, 'public'))) { res.writeHead(403); return res.end(); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); return fs.createReadStream(f).on('error', () => res.end()).pipe(res);
    }
    if (/^\/[\w.-]+\.(png|ico|svg)$/.test(p)) { const f = path.join(APPDIR, p); if (fs.existsSync(f)) { res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] }); return fs.createReadStream(f).pipe(res); } }
    // всё остальное — как kapp://app/… на ПК (шумодав, файлы из лички и т. п.)
    if (kappHandler) {
      const headers = {}; if (req.headers.range) headers.range = req.headers.range;
      const r = await kappHandler({ url: 'kapp://app' + u.pathname, headers: { get: (k) => headers[k.toLowerCase()] || null } });
      const h = {}; r.headers.forEach((v, k) => (h[k] = v));
      res.writeHead(r.status, h);
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    res.writeHead(404); res.end();
  } catch (e) { try { res.writeHead(500); res.end(String(e.message)); } catch {} }
});
const wss = new WebSocketServer({ server, path: '/rpc', maxPayload: 64 * 1024 * 1024 });
wss.on('connection', (ws, req) => {
  const q = new URL(req.url, HOME).searchParams.get('role') || '';
  const role = q === 'friends' ? 'friends' : /^tab:\d+$/.test(q) && tabWCs.has(q) ? q : 'main';
  sockSet(role).add(ws);
  ws.on('close', () => sockSet(role).delete(ws));
  ws.on('message', async (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'page' && role === 'main') { mainWC.emit('did-finish-load'); return; }
    let r, err;
    try { r = await invoke(role, String(m.ch), decode(m.args || [])); } catch (e) { err = String(e && e.message || e); }
    if (m.id) ws.send(JSON.stringify({ id: m.id, r: encode(r === undefined ? null : r), err }));
  });
});

// адреса сети: на новых Android node сам их не видит — берём у Java
const os = require('os');
let javaIfaces = null;
const origIfaces = os.networkInterfaces;
os.networkInterfaces = () => {
  if (javaIfaces) return javaIfaces;
  try { return origIfaces.call(os); } catch { return {}; }
};
function setIfaces(list) {
  const o = {};
  for (const x of list) { if (!x || !x.address) continue; (o[x.name || 'wlan0'] = o[x.name || 'wlan0'] || []).push({ address: x.address, netmask: x.netmask || '255.255.255.0', family: 'IPv4', internal: false, mac: '00:00:00:00:00:00', cidr: x.address + '/24' }); }
  javaIfaces = o;
}

// автосохранения аккаунта лежат внутри приложения — Java копирует их в «Документы/Kentovka/Сохранения»,
// чтобы они пережили удаление приложения (как на ПК)
const SAVES = path.join(process.env.KENTOVKA_DOCS || path.join(DATA, 'docs'), 'Kentovka', 'Сохранения');
let savesSig = '';
setInterval(() => {
  let list = [];
  try { list = fs.readdirSync(SAVES).filter((n) => n.endsWith('.knt')).map((n) => { const st = fs.statSync(path.join(SAVES, n)); return { name: n, size: st.size }; }); } catch { return; }
  const sig = JSON.stringify(list);
  if (sig === savesSig) return;
  savesSig = sig;
  toJava({ t: 'mirror', dir: SAVES, files: list });
}, 4000).unref();

server.listen(PORT, '127.0.0.1', () => {
  console.log('Кентовка (Android) слушает', HOME);
  app._ready = true; app.emit('ready');
});

module.exports = {
  app, BrowserWindow, WebContentsView, session, ipcMain, protocol, dialog, shell, clipboard, Notification, Tray, Menu, nativeImage,
  globalShortcut, desktopCapturer, safeStorage, powerMonitor, screen, contextBridge: {}, ipcRenderer: {},
};
