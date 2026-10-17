// Кентовка — десктопное приложение (Electron).
// Стартовый экран: подключиться к хосту или самому стать хостом (сервер крутится прямо в приложении).
const {
  app, BrowserWindow, session, ipcMain, desktopCapturer, globalShortcut,
  Tray, Menu, nativeImage, clipboard, Notification, protocol, WebContentsView, dialog, safeStorage, shell, screen, powerMonitor,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { startServer, lanAddresses, getCert } = require('../server');
const { createFriends } = require('./friends');
const { createAccount } = require('./account');
const { createDiscovery, friendCode } = require('./discovery');
const { parseLink, connectBridge, findOnBridge } = require('./bridge');
let discovery = null;
let account = null;

app.setAppUserModelId('ru.kentovka.app');
// голос и демка не должны тормозить, когда окно свёрнуто или игра на переднем плане
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// не прятать свой адрес за «.local» — иначе прямые соединения для файлов через локальную сеть не находят друг друга
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');

// для тестов: две Кентовки на одном компе, у каждой своя папка
if (process.env.KENTOVKA_USERDATA) app.setPath('userData', process.env.KENTOVKA_USERDATA);
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

// kvid://<id файла>/ — видео из чата прямо из раздачи кентов: плеер просит кусок,
// окно достаёт его у кентов и отдаёт. Можно смотреть и перематывать, не скачивая файл целиком.
protocol.registerSchemesAsPrivileged([
  { scheme: 'kvid', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true } },
  // kapp://app/… — свои страницы приложения (друзья, звонки) с шумодавами: микрофону и звуковым модулям нужен «безопасный» адрес
  { scheme: 'kapp', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);
const KAPP_MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.css': 'text/css' };
function setupKapp(ses) {
  const ROOT = path.join(__dirname, '..');
  const MAP = [
    ['/ns/', path.join(ROOT, 'node_modules', '@sapphi-red', 'web-noise-suppressor', 'dist')],
    ['/df/', path.join(ROOT, 'node_modules', '@lofcz', 'deepfilternet-web', 'dist')],
    ['/voice-fx.js', path.join(ROOT, 'public', 'voice-fx.js')],
    ['/df-shim.js', path.join(ROOT, 'public', 'df-shim.js')],
    ['/ns-async.js', path.join(ROOT, 'public', 'ns-async.js')],
    ['/ksound.js', path.join(ROOT, 'public', 'ksound.js')],
    ['/df-worker.js', path.join(ROOT, 'public', 'df-worker.js')],
    ['/kselect.js', path.join(ROOT, 'public', 'kselect.js')],
    ['/', __dirname],
  ];
  ses.protocol.handle('kapp', async (req) => {
    try {
      const u = new URL(req.url);
      if (u.hostname !== 'app') return new Response('нет', { status: 404 });
      const p = decodeURIComponent(u.pathname);
      // файлы из лички и групп (уже скачанные)
      const fm = /^\/dmfile\/([0-9a-f]{16,32})$/.exec(p);
      if (fm) {
        const fp = friends && friends.filePath(fm[1]), fi = friends && friends.fileInfo(fm[1]);
        if (!fp || !fi) return new Response('нет', { status: 404 });
        const st = await fs.promises.stat(fp);
        const range = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
        const mime = /^[\w.+-]+\/[\w.+-]+$/.test(fi.mime || '') ? fi.mime : 'application/octet-stream';
        if (range) {
          const a = range[1] ? Number(range[1]) : 0, b = range[2] ? Math.min(Number(range[2]), st.size - 1) : Math.min(st.size - 1, a + 4 * 1024 * 1024);
          const fh = await fs.promises.open(fp, 'r'); const buf = Buffer.alloc(Math.max(0, b - a + 1)); await fh.read(buf, 0, buf.length, a); await fh.close();
          return new Response(buf, { status: 206, headers: { 'Content-Type': mime, 'Content-Range': `bytes ${a}-${b}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': String(buf.length) } });
        }
        return new Response(await fs.promises.readFile(fp), { headers: { 'Content-Type': mime, 'Accept-Ranges': 'bytes' } });
      }
      const [pre, base] = MAP.find(([k]) => p === k || (k.endsWith('/') && p.startsWith(k)));
      const file = base.endsWith('.js') ? base : path.normalize(path.join(base, p.slice(pre.length)));
      if (!base.endsWith('.js') && !file.startsWith(base)) return new Response('нет', { status: 403 });
      if (base === __dirname && !/\.(html|png|ico)$/.test(file)) return new Response('нет', { status: 404 }); // из папки приложения — только страницы и картинки
      const data = await fs.promises.readFile(file);
      return new Response(data, { headers: { 'Content-Type': KAPP_MIME[path.extname(file)] || 'application/octet-stream' } });
    } catch { return new Response('нет', { status: 404 }); }
  });
}
const KVID_PIECE = 1024 * 1024; // плеер читает поток — мы достаём у кентов по 1 МБ, только когда он просит дальше
let kvidSeq = 0;
const kvidWait = new Map();
ipcMain.on('kvid:res', (e, { rid, data, size, mime, error }) => {
  const w = kvidWait.get(rid);
  if (!w) return;
  kvidWait.delete(rid);
  w({ data, size, mime, error });
});
function kvidAsk(id, start, end) {
  const rid = ++kvidSeq;
  return new Promise((resolve) => {
    kvidWait.set(rid, resolve);
    const w = tabWC(shellTab) || tabWC(lastTab); if (!w) return resolve({ error: 'closed' });
    w.send('kvid:req', { rid, id, start, end });
    setTimeout(() => { if (kvidWait.delete(rid)) resolve({ error: 'timeout' }); }, 60000);
  });
}
function setupKvid(ses) {
  ses.protocol.handle('kvid', async (req) => {
    try {
      const id = new URL(req.url).hostname;
      if (!/^[0-9a-f]{24}$/.test(id)) return new Response('нет', { status: 404 });
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.get('range') || '');
      const start = m ? Number(m[1]) : 0;
      if (process.env.KENTOVKA_DEBUG) console.log('[kvid]', req.headers.get('range'));
      // первый кусок — заодно узнаём размер файла
      const first = await kvidAsk(id, start, start + KVID_PIECE - 1);
      if (first.error || !first.data) return new Response(first.error || 'нет', { status: first.error === 'range' ? 416 : 404 });
      const size = first.size;
      const end = m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      let pos = start + first.data.byteLength;
      let firstSent = false;
      const body = new ReadableStream({
        async pull(ctrl) {
          if (!firstSent) { firstSent = true; ctrl.enqueue(new Uint8Array(first.data)); if (pos > end) ctrl.close(); return; }
          if (pos > end) { ctrl.close(); return; }
          const r = await kvidAsk(id, pos, Math.min(end, pos + KVID_PIECE - 1));
          if (r.error || !r.data || !r.data.byteLength) { ctrl.error(new Error(r.error || 'нет данных')); return; }
          pos += r.data.byteLength;
          ctrl.enqueue(new Uint8Array(r.data));
        },
      }, { highWaterMark: 0 }); // ничего не тянем заранее — только когда плеер читает
      return new Response(body, {
        status: m ? 206 : 200,
        headers: {
          'Content-Type': first.mime || 'video/mp4',
          'Content-Length': String(end - start + 1),
          ...(m ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
        },
      });
    } catch (err) {
      return new Response(String((err && err.message) || err), { status: 500 });
    }
  });
}

const ICON = path.join(__dirname, 'icon.png');
const CONFIG_FILE = () => path.join(app.getPath('userData'), 'config.json');
const DEFAULT_PORT = 8443;
const DEFAULT_HOTKEYS = { mute: 'CommandOrControl+Shift+M', deaf: 'CommandOrControl+Shift+D' };
const HOTKEYS = { ...DEFAULT_HOTKEYS }; // свои сочетания — из настроек (config.hotkeys)
// одна клавиша, сочетание или боковая кнопка мыши (Mouse4/Mouse5)
const ACCEL_RE = /^((CommandOrControl|Ctrl|Alt|Shift|Super)\+){0,3}([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|Num[0-9]|Space|Tab|Insert|Delete|Home|End|PageUp|PageDown|Up|Down|Left|Right|CapsLock|Plus|-|=|\[|\]|;|'|,|\.|\/|\\|`|Mouse[345])$/;
// Горячие клавиши слушаем через системный «хук» клавиатуры (как Discord): клавиша не отнимается
// у других программ — поэтому не бывает «занято другим приложением», и можно поставить одну клавишу.
// Если хук не загрузился — запасной путь через globalShortcut.
let hook = null, hookOk = false, hotkeysPaused = false;
const parseAccel = (a) => {
  const parts = String(a || '').split('+').filter((x, i, arr) => x || i === arr.length - 1);
  const key = parts.pop() || '';
  return { key, ctrl: parts.some((p) => p === 'CommandOrControl' || p === 'Ctrl'), alt: parts.includes('Alt'), shift: parts.includes('Shift') };
};
function hookKeycode(name) {
  if (!hook) return null;
  const K = hook.UiohookKey;
  const map = { Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight', '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight',
    ';': 'Semicolon', "'": 'Quote', ',': 'Comma', '.': 'Period', '/': 'Slash', '\\': 'Backslash', '`': 'Backquote', Plus: 'Equal' };
  if (/^Num\d$/.test(name)) return K['Numpad' + name.slice(3)];
  return K[map[name] || name] ?? null;
}
function startHook() {
  try {
    hook = require('uiohook-napi');
    const down = new Set();
    const fire = (keycode, mouse, e) => {
      if (hotkeysPaused) return;
      for (const action of Object.keys(HOTKEYS)) {
        const a = parseAccel(HOTKEYS[action]);
        if (!a.key) continue;
        const hit = mouse ? a.key === 'Mouse' + mouse : hookKeycode(a.key) === keycode;
        if (hit && !!e.ctrlKey === a.ctrl && !!e.altKey === a.alt && !!e.shiftKey === a.shift) sendHotkey(action);
      }
    };
    hook.uIOhook.on('keydown', (e) => { if (down.has(e.keycode)) return; down.add(e.keycode); fire(e.keycode, 0, e); });
    hook.uIOhook.on('keyup', (e) => down.delete(e.keycode));
    hook.uIOhook.on('mousedown', (e) => { if (e.button >= 3 && e.button <= 5) fire(0, e.button, e); }); // 3 — колесо, 4/5 — боковые
    hook.uIOhook.start();
    hookOk = true;
  } catch (err) { console.error('хук клавиатуры не запустился, работаем через globalShortcut:', err.message); hook = null; hookOk = false; }
}
function registerHotkeys() {
  if (hookOk) return [];
  globalShortcut.unregisterAll();
  for (const action of Object.keys(HOTKEYS)) {
    const accel = HOTKEYS[action];
    if (!accel || /^Mouse/.test(parseAccel(accel).key)) continue;
    try { globalShortcut.register(accel, () => sendHotkey(action)); } catch {}
  }
  return [];
}

let win = null;
// ---------- вкладки серверов: каждый сервер — своя страница внутри окна, переключение не рвёт голос ----------
const tabs = new Map(); // ключ («host», «host:8450», «26.1.2.3:8443») → { key, view, url, realKey, name, host, port, hs, tempNote, viaAlt, at }
let shellTab = null;     // какая вкладка видна: null — главная (друзья)
let lastTab = null;      // последняя открытая вкладка сервера (для приглашений с главной)
let shellCover = false;  // на главной открыт диалог или меню — страницы прячем, чтобы не перекрывали
let voiceTabKey = null;  // на каком сервере я в голосовом канале
const shellPayload = () => ({ tab: shellTab, url: shellTab && tabs.get(shellTab) ? tabs.get(shellTab).url : null, open: [...tabs.keys()], voice: voiceTabKey, roles: Object.fromEntries([...tabs].map(([k, t]) => [k, (t.view && t.view.webContents.role) || ''])) }); // roles — на телефоне: какой фрейм чей
const tabOf = (wc) => { if (!wc) return null; for (const t of tabs.values()) if (!t.view.webContents.isDestroyed() && t.view.webContents === wc) return t; return null; };
const tabWC = (key) => { const t = key && tabs.get(key); return t && !t.view.webContents.isDestroyed() ? t.view.webContents : null; };
const allTabWC = () => [...tabs.values()].map((t) => t.view.webContents).filter((w) => !w.isDestroyed());
function toPages(ch, ...args) { for (const w of [win && !win.isDestroyed() && win.webContents, fv(), ...allTabWC()]) if (w) { try { w.send(ch, ...args); } catch {} } }
// горячие клавиши — странице сервера, где я в голосе (или открытой), и странице друзей (звонок из лички)
function sendHotkey(action) { const w = tabWC(voiceTabKey) || tabWC(shellTab); if (w) w.send('hotkey', action); if (fv()) fv().send('hotkey', action); }
let tray = null;
let hostServer = null; // свой сервер, на котором я сейчас (или null)
// свои серверы: можно держать несколько, каждый на своём порту и со своими каналами и чатом
const hostServers = new Map(); // порт -> запущенный сервер
// первый (старый) свой сервер живёт в папке приложения, остальные — в servers/<порт>
const mainHostPort = () => { const c = loadConfig(); return Number(c.mainHostPort) || Number(c.port) || DEFAULT_PORT; };
const hostKey = (port) => (port === mainHostPort() ? 'host' : `host:${port}`);
const hostPortOf = (sv) => (sv.address === 'host' ? mainHostPort() : Number(String(sv.address).split(':')[1]) || DEFAULT_PORT);
const hostDataDir = (port) => (port === mainHostPort() ? app.getPath('userData') : path.join(app.getPath('userData'), 'servers', String(port)));
let connected = false;
// чем я занят — показываем друзьям («Активные контакты»)
let presenceSince = Date.now(), presenceKey = '';
function presenceNow() {
  const p = { server: connected ? currentServerName || null : null, voice: (typeof voiceState !== 'undefined' && voiceState && voiceState.ch) || null, call: !!(typeof dmCall !== 'undefined' && dmCall && dmCall.state === 'live'), idle: idleNow };
  const k = JSON.stringify(p); if (k !== presenceKey) { presenceKey = k; presenceSince = Date.now(); }
  return { ...p, since: presenceSince };
}
// «неактивен» (как луна в Discord): 10 минут не трогал комп (на телефоне — 5 минут приложение в фоне)
let idleNow = false, unfocusedSince = 0;
setInterval(() => {
  let idle = false;
  try {
    if (typeof powerMonitor !== 'undefined' && powerMonitor.getSystemIdleTime) idle = powerMonitor.getSystemIdleTime() >= 600;
    else { const f = win && !win.isDestroyed() && win.isFocused(); if (f) unfocusedSince = 0; else if (!unfocusedSince) unfocusedSince = Date.now(); idle = !!unfocusedSince && Date.now() - unfocusedSince > 5 * 60000; }
  } catch {}
  if ((typeof voiceState !== 'undefined' && voiceState) || (typeof dmCall !== 'undefined' && dmCall)) idle = false; // в голосе и в звонке — не «неактивен»
  if (idle !== idleNow) { idleNow = idle; presenceChanged(); for (const w of allTabWC()) w.send('app:idle', idle); }
}, 20000).unref?.();
ipcMain.handle('app:idle', () => idleNow);
let presenceT = null;
function presenceChanged() { clearTimeout(presenceT); presenceT = setTimeout(() => { if (friends && friends.sendPresence) { presenceNow(); friends.sendPresence(); } }, 400); }
let quitting = false;
let trayHintShown = false;

function loadConfig() {
  try { return Object.assign({ address: '', host: false, port: DEFAULT_PORT }, JSON.parse(fs.readFileSync(CONFIG_FILE(), 'utf8'))); }
  catch { return { address: '', host: false, port: DEFAULT_PORT }; }
}
function saveConfig(c, quiet) {
  if (!quiet && typeof scheduleAutoSave === 'function' && account) { try { scheduleAutoSave(); } catch {} }
  try { fs.mkdirSync(path.dirname(CONFIG_FILE()), { recursive: true }); fs.writeFileSync(CONFIG_FILE(), JSON.stringify(c, null, 2)); } catch {}
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200, height: 780, minWidth: 420, minHeight: 500,
    backgroundColor: '#0a0b14', icon: ICON, autoHideMenuBar: true, title: 'Кентовка', show: false,
    frame: false, // своя неоновая рамка (рисуется в окне, см. preload.js); края и «прилипание» Windows остаются
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false,
    },
  });
  // без меню окна: иначе Alt (в т.ч. Alt+Shift — смена языка) открывает скрытое меню
  // и уводит фокус из поля ввода — чат «перестаёт печатать»
  win.removeMenu();
  win.once('ready-to-show', () => win.show());
  const sendState = () => { if (win && !win.isDestroyed()) win.webContents.send('win:state', winState()); };
  for (const ev of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur', 'restore']) win.on(ev, sendState);
  for (const ev of ['resize', 'enter-full-screen', 'leave-full-screen', 'maximize', 'unmaximize']) win.on(ev, () => setTimeout(layoutFriends, 0));
  // звонок из лички живёт в странице друзей — создаём её сразу, чтобы входящие звонки доходили
  win.webContents.once('did-finish-load', () => ensureFriendsView());
  win.loadFile(path.join(__dirname, 'launcher.html'));
  // ссылки из чата открываем в обычном браузере
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    // внутри окна разрешаем только наш стартовый экран и сервер Кентовки
    if (!url.startsWith('file:')) e.preventDefault();
  });
  // закрытие во время разговора — сворачиваемся в трей, чтобы голос не обрывался
  win.on('close', (e) => {
    if (quitting || !tabs.size) return;
    e.preventDefault();
    win.hide();
    if (!trayHintShown && Notification.isSupported()) {
      trayHintShown = true;
      new Notification({ title: 'Кентовка работает в трее', body: 'Голос не отключился. Выйти полностью — правый клик по значку в трее.', icon: ICON }).show();
    }
  });
}

const winState = () => (win && !win.isDestroyed() ? { max: win.isMaximized(), full: win.isFullScreen(), focused: win.isFocused() } : null);
ipcMain.handle('win:state', () => winState());
ipcMain.on('win:ctl', (e, what) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  if (what === 'min') w.minimize();
  else if (what === 'max') { if (w.isFullScreen()) w.setFullScreen(false); else if (w.isMaximized()) w.unmaximize(); else w.maximize(); }
  else if (what === 'full') w.setFullScreen(!w.isFullScreen());
  else if (what === 'close') w.close();
});

// ---------- друзья и личные сообщения ----------
let friends = null;
// друзья открываются ВНУТРИ главного окна (как в Discord): отдельная страница поверх области справа от полосы серверов.
// Страница сервера под ней продолжает работать — голосовой канал не обрывается.
let friendsView = null, friendsShown = false, friendsArea = null;
const friendsUrl = 'kapp://app/friends.html';
function ensureFriendsView() {
  if (friendsView && !friendsView.webContents.isDestroyed()) return friendsView;
  friendsView = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  friendsView.setBackgroundColor('#0a0b14');
  friendsView.webContents.loadURL(friendsUrl);
  friendsView.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) require('electron').shell.openExternal(url); return { action: 'deny' }; });
  friendsView.webContents.on('will-navigate', (e) => e.preventDefault());
  friendsView.webContents.on('render-process-gone', () => { friendsView = null; if (friendsShown) { friendsShown = false; tellShown(); } });
  return friendsView;
}
function contentRect() {
  const [W, H] = win.getContentSize();
  const z = win.webContents.getZoomFactor ? win.webContents.getZoomFactor() : 1;
  const tb = win.isFullScreen() ? 0 : 32;
  const a = friendsArea || { x: 0, y: tb, w: W, h: H - tb };
  const r = { x: Math.round(a.x * z), y: Math.round(a.y * z), width: Math.max(1, Math.round(a.w * z)), height: Math.max(1, Math.round(a.h * z)) };
  r.width = Math.min(r.width, W - r.x); r.height = Math.min(r.height, H - r.y);
  return r;
}
// какая страница видна в области справа от полосы серверов: друзья (главная) или вкладка сервера
function layoutFriends() {
  if (!win || win.isDestroyed()) return;
  const r = contentRect();
  const wantFriends = shellTab === null && !shellCover;
  if (wantFriends) {
    const v = ensureFriendsView();
    if (!friendsShown) { win.contentView.addChildView(v); friendsShown = true; tellShown(); }
    v.setBounds(r);
  } else if (friendsShown) { friendsShown = false; try { win.contentView.removeChildView(friendsView); } catch {} tellShown(); }
  for (const t of tabs.values()) {
    const on = t.key === shellTab && !shellCover;
    if (on) { if (!t.shown) { win.contentView.addChildView(t.view); t.shown = true; } t.view.setBounds(r); }
    else if (t.shown) { t.shown = false; try { win.contentView.removeChildView(t.view); } catch {} }
  }
}
function tellShown() {
  if (win && !win.isDestroyed()) win.webContents.send('friends:shown', friendsShown);
  if (friendsView && !friendsView.webContents.isDestroyed()) friendsView.webContents.send('friends:shown', friendsShown);
}
function showTab(key) {
  if (key && !tabs.has(key)) key = null;
  shellTab = key;
  if (key) { const t = tabs.get(key); t.at = Date.now(); lastTab = key; useTab(t); }
  layoutFriends();
  if (win && !win.isDestroyed()) win.webContents.send('shell:tab', shellPayload());
  const w = key ? tabWC(key) : fv(); if (w && !shellCover) w.focus();
  presenceChanged();
}
// «текущий сервер» для приглашений, мостов и подписи — последняя открытая вкладка
function useTab(t) {
  currentServerUrl = t.url; currentServerName = t.name; currentServerKey = t.realKey; hostServer = t.hs || null; tempNote = t.tempNote || null; viaAlt = t.viaAlt || null; connected = true;
}
function closeTab(key) {
  const t = tabs.get(key); if (!t) return;
  tabs.delete(key);
  try { if (t.shown) win.contentView.removeChildView(t.view); } catch {}
  try { t.view.webContents.close(); } catch {}
  if (voiceTabKey === key) { voiceTabKey = null; voiceState = null; if (fv()) fv().send('voice:state', null); }
  if (lastTab === key) { const next = [...tabs.values()].sort((a, b) => b.at - a.at)[0]; lastTab = next ? next.key : null; if (next) useTab(next); else { connected = false; currentServerUrl = null; hostServer = null; } }
  if (shellTab === key) showTab(null); else showTab(shellTab);
  setTimeout(friendsChanged, 0);
}
function openFriends(focusId) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
  ensureFriendsView();
  showTab(null);
  const v = fv(); if (v) { v.focus(); if (focusId) v.send('friends:focus', focusId); }
}
function closeFriends() { if (shellTab === null && lastTab && tabs.has(lastTab)) showTab(lastTab); }
ipcMain.on('shell:cover', (e, on) => { if (!win || e.sender !== win.webContents) return; shellCover = !!on; layoutFriends(); });
ipcMain.handle('shell:show', (e, key) => { if (!win || e.sender !== win.webContents) return; showTab(key || null); return true; });
ipcMain.handle('shell:close', (e, key) => { if (!win || e.sender !== win.webContents) return; if (voiceTabKey === key) return { error: 'voice' }; closeTab(String(key)); return true; });
ipcMain.handle('shell:state', () => (shellPayload()));
ipcMain.on('app:is-tab', (e) => { e.returnValue = !!tabOf(e.sender); });
ipcMain.on('friends:area', (e, a) => {
  if (!win || e.sender !== win.webContents || !a) return;
  const n = (v) => (Number.isFinite(+v) ? +v : 0);
  friendsArea = { x: n(a.x), y: n(a.y), w: n(a.w), h: n(a.h) };
  layoutFriends();
});
ipcMain.on('friends:close', () => closeFriends());
ipcMain.handle('friends:is-shown', () => friendsShown);
// главная страница приложения (не сервер): друзья там — основная часть окна
const atHome = () => shellTab === null;
ipcMain.handle('friends:is-home', () => atHome());
const fv = () => (friendsView && !friendsView.webContents.isDestroyed() ? friendsView.webContents : null);
function friendsChanged() {
  if (account) { try { scheduleAutoSave(); } catch {} }
  const n = friends ? friends.unreadTotal() : 0;
  if (win && !win.isDestroyed()) win.webContents.send('friends:badge', n);
  for (const w of allTabWC()) w.send('friends:badge', n);
  if (fv()) fv().send('friends:changed');
  if (process.platform === 'win32' && win && !win.isDestroyed()) win.setOverlayIcon(n ? nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }) : null, n ? `${n} новых` : '');
}
// ---------- всплывашки в углу экрана (как в Discord): кто звонит — «Принять / Отклонить», кто написал ----------
// показываем, только когда Кентовка не перед глазами и сейчас не игра/видео во весь экран
let popWin = null, popReady = false; const pops = new Map(), popQueue = [];
function popSend(m) { if (popWin && !popWin.isDestroyed() && popReady) popWin.webContents.send('popup:msg', m); else popQueue.push(m); }
function popLayout() {
  if (!popWin || popWin.isDestroyed()) return;
  const n = pops.size; if (!n) { popWin.hide(); return; }
  const wa = screen.getPrimaryDisplay().workArea, w = 372, h = 12 + n * 70 + (n - 1) * 8;
  popWin.setBounds({ x: wa.x + wa.width - w - 12, y: wa.y + wa.height - h - 12, width: w, height: h });
  if (!popWin.isVisible()) popWin.showInactive();
}
function ensurePop() {
  if (popWin && !popWin.isDestroyed()) return popWin;
  popReady = false;
  popWin = new BrowserWindow({ width: 372, height: 90, frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false, skipTaskbar: true, alwaysOnTop: true, focusable: false, show: false, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true } });
  popWin.setAlwaysOnTop(true, 'screen-saver');
  popWin.loadURL('kapp://app/popup.html');
  popWin.on('closed', () => { popWin = null; popReady = false; });
  return popWin;
}
ipcMain.on('popup:ready', (e) => { if (!popWin || e.sender !== popWin.webContents) return; popReady = true; for (const m of popQueue.splice(0)) popWin.webContents.send('popup:msg', m); });
const kentovkaInFront = () => !!(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused());
// игра или видео во весь экран (Windows: «не беспокоить»)
let fsProc = null, fsWait = [];
function fullscreenBusy() {
  if (process.platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      if (!fsProc) {
        const ps = 'Add-Type -TypeDefinition \'using System;using System.Runtime.InteropServices;public class KQ{[DllImport("shell32.dll")]public static extern int SHQueryUserNotificationState(out int s);}\'; while(($l=[Console]::In.ReadLine()) -ne $null){$s=0;[void][KQ]::SHQueryUserNotificationState([ref]$s);[Console]::Out.WriteLine($s)}';
        fsProc = require('child_process').spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
        let buf = '';
        fsProc.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const v = Number(buf.slice(0, i).trim()); buf = buf.slice(i + 1); const w = fsWait.shift(); if (w) w([2, 3, 4].includes(v)); } });
        fsProc.on('exit', () => { fsProc = null; for (const w of fsWait.splice(0)) w(false); });
      }
      const t = setTimeout(() => { const i = fsWait.indexOf(done); if (i >= 0) fsWait.splice(i, 1); resolve(false); }, 2500);
      const done = (v) => { clearTimeout(t); resolve(v); };
      fsWait.push(done); fsProc.stdin.write('q\n');
    } catch { resolve(false); }
  });
}
const isAndroid = !!process.env.KENTOVKA_ANDROID_PORT;
async function popShow(p) {
  if (kentovkaInFront()) return false;
  if (isAndroid) { // телефон: уведомление с кнопками «Отклонить / Принять»
    const old = pops.get(p.id); if (old && old.n) { try { old.n.close(); } catch {} }
    const n = new Notification({ title: p.name, body: p.text, tag: p.id, call: p.type === 'call', actions: p.type === 'call' ? [{ type: 'button', text: 'Отклонить' }, { type: 'button', text: p.gid ? 'Присоединиться' : 'Принять' }] : [] });
    p.n = n; pops.set(p.id, p);
    n.on('action', (_e, i) => { pops.delete(p.id); popAction(p, i === 1 ? 'accept' : 'decline'); });
    n.on('click', () => { pops.delete(p.id); popAction(p, p.type === 'call' ? 'show' : 'open'); });
    n.show(); return true;
  }
  if (await fullscreenBusy()) return false;
  const th = (loadConfig().theme || {}); const hex = th.accent || '#22e1ff';
  const n = parseInt(hex.slice(1), 16);
  p.theme = { accent: th.accent, accent2: th.accent2, rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255].join(',') };
  const old = pops.get(p.id); if (old && old.timer) clearTimeout(old.timer);
  if (p.type !== 'call') p.timer = setTimeout(() => popHide(p.id), 7000);
  pops.set(p.id, p); ensurePop(); popSend({ show: { ...p, timer: undefined } }); popLayout();
  return true;
}
function popHide(id) { const p = pops.get(id); if (!p) return; if (p.timer) clearTimeout(p.timer); pops.delete(id); if (p.n) { try { p.n.close(); } catch {} return; } popSend({ hide: id }); setTimeout(popLayout, 50); }
ipcMain.on('popup:act', (e, id, act) => {
  if (!popWin || e.sender !== popWin.webContents) return;
  const p = pops.get(id); if (!p) return;
  popHide(id);
  popAction(p, act);
});
function popAction(p, act) {
  if (act === 'close') return;
  if (act === 'show') { openFriends(p.focus || p.gid); return; }
  if (p.type === 'call' && p.gid) { if (act === 'accept') { openFriends(p.gid); setTimeout(() => fv() && fv().send('call:cmd', 'gjoin:' + p.gid), 300); } return; }
  if (p.type === 'call') { if (act === 'accept') { openFriends(p.focus); setTimeout(() => fv() && fv().send('call:cmd', 'accept'), 200); } else if (act === 'decline' && fv()) fv().send('call:cmd', 'decline'); return; }
  if (act === 'open') openFriends(p.focus);
}
function friendNotify(title, body, focusId, avatar) {
  if (friendsShown && win && !win.isDestroyed() && win.isFocused()) return;
  popShow({ id: 'm:' + (focusId || title), type: 'msg', name: title, text: body, focus: focusId, avatar: avatar || null }).then((shown) => { if (!shown) sysNotify(title, body, focusId); });
}
function sysNotify(title, body, focusId) {
  if (kentovkaInFront()) return;
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: ICON, silent: false });
  n.on('click', () => openFriends(focusId));
  n.show();
}

// ---------- звонок 1 на 1 в личке ----------
// звук идёт напрямую между окнами друзей (WebRTC), здесь — только передача сигналов и связь со страницей сервера
let dmCall = null; // { id, name, state } — что показывает страница друзей
ipcMain.handle('call:send', (e, id, msg) => (friends && fv() && e.sender === fv() ? friends.call(id, msg) : false));
ipcMain.on('call:state', (e, st) => {
  if (!fv() || e.sender !== fv()) return;
  dmCall = st && st.state ? { id: String(st.id || ''), name: String(st.name || '').slice(0, 40), state: String(st.state), group: !!st.group } : null;
  if (!dmCall || dmCall.state !== 'ringing') for (const id of [...pops.keys()]) if (id.startsWith('c:')) popHide(id);
  presenceChanged();
  if (win && !win.isDestroyed()) win.webContents.send('call:state', dmCall);
  for (const w of allTabWC()) w.send('call:state', dmCall);
});
ipcMain.handle('call:get', () => dmCall);
// со страницы сервера: принять / отклонить входящий, сбросить (зашёл в голосовой канал)
ipcMain.on('call:cmd', (e, cmd) => {
  if (!tabOf(e.sender) || !fv()) return;
  if (!['accept', 'decline', 'hangup', 'open'].includes(cmd)) return;
  if (cmd === 'open' || cmd === 'accept') openFriends(dmCall && dmCall.id);
  fv().send('call:cmd', cmd);
});
// состояние голосового канала со страницы сервера → страница друзей (панель «Голос подключён» внизу)
let voiceState = null;
ipcMain.on('voice:state', (e, st) => {
  const t = tabOf(e.sender); if (!t) return;
  if (st && st.inVoice) { voiceTabKey = t.key; voiceState = { inVoice: true, ch: String(st.ch || '').slice(0, 60), server: t.name, muted: !!st.muted, deaf: !!st.deaf }; }
  else if (voiceTabKey === t.key) { voiceTabKey = null; voiceState = null; }
  else return;
  presenceChanged();
  if (fv()) fv().send('voice:state', voiceState);
  if (win && !win.isDestroyed()) win.webContents.send('shell:tab', shellPayload());
});
// заходишь в голосовой на другом сервере: спросить, а потом выйти из старого
ipcMain.handle('voice:claim', (e) => {
  const t = tabOf(e.sender); if (!t) return { ok: true };
  if (voiceTabKey && voiceTabKey !== t.key && tabs.has(voiceTabKey)) return { busy: tabs.get(voiceTabKey).name || 'другом сервере', ch: voiceState && voiceState.ch };
  return { ok: true };
});
ipcMain.handle('voice:take', (e) => {
  const t = tabOf(e.sender); if (!t) return;
  const w = voiceTabKey && voiceTabKey !== t.key ? tabWC(voiceTabKey) : null;
  if (w) w.send('voice:cmd', 'leave');
  return true;
});
ipcMain.handle('voice:get', () => voiceState);
ipcMain.on('voice:cmd', (e, cmd) => {
  if (!fv() || e.sender !== fv() || !['mute', 'deaf', 'leave', 'open'].includes(cmd)) return;
  const w = tabWC(voiceTabKey); if (!w) return;
  if (cmd === 'open') { showTab(voiceTabKey); w.send('voice:cmd', 'open'); return; }
  w.send(cmd === 'leave' ? 'voice:cmd' : 'hotkey', cmd);
});
// общие настройки голоса (шумодав, громкость, эхо) — одни и те же на всех серверах и в звонках из лички
ipcMain.handle('voice:settings-get', () => loadConfig().voice || null);
ipcMain.on('voice:settings-set', (e, v) => {
  if (!v || typeof v !== 'object') return;
  const pick = {};
  for (const k of ['micLabel', 'outLabel', 'nsMode', 'nsStrength', 'gate', 'gateDb', 'ec', 'agc', 'micGain', 'masterVol', 'muted', 'deaf']) if (k in v && ['string', 'number', 'boolean'].includes(typeof v[k])) pick[k] = typeof v[k] === 'string' ? v[k].slice(0, 120) : v[k];
  const c = loadConfig(); c.voice = Object.assign(c.voice || {}, pick); saveConfig(c);
});
const myAddrs = () => lanAddresses().filter((a) => a.radmin).map((a) => a.address);
ipcMain.handle('friends:open', (e, id) => openFriends(id));
ipcMain.handle('friends:toggle', () => (shellTab === null ? closeFriends() : openFriends()));
ipcMain.handle('friends:badge', () => (friends ? friends.unreadTotal() : 0));
ipcMain.handle('friends:me', () => ({ id: friends && friends.myId, code: friends && friendCode(friends.myId), addresses: myAddrs(), all: lanAddresses().map((a) => a.address), port: friends && friends.port,
  profile: loadConfig().profile || null, server: connected ? { name: currentServerName, address: currentInviteAddress() } : null }));
ipcMain.handle('friends:status', (e, appId) => {
  if (!friends || !appId) return null;
  if (appId === friends.myId) return 'me';
  const f = friends.list().find((x) => x.id === appId);
  return f ? f.status : null;
});
ipcMain.handle('friends:list', () => (friends ? friends.list() : []));
// группы в личке
ipcMain.handle('groups:list', () => (friends ? friends.groups() : []));
ipcMain.handle('groups:create', (e, name, ids) => (friends ? friends.groupCreate(String(name || ''), Array.isArray(ids) ? ids.map(String) : []) : { error: 'не готово' }));
ipcMain.handle('groups:update', (e, gid, o) => (friends ? friends.groupUpdate(String(gid), o || {}) : null));
ipcMain.handle('groups:leave', (e, gid) => friends && friends.groupLeave(String(gid)));
ipcMain.handle('groups:messages', (e, gid) => (friends ? friends.groupMessages(String(gid)) : []));
ipcMain.handle('groups:read', (e, gid) => friends && friends.groupRead(String(gid)));
ipcMain.handle('groups:send', (e, gid, text, reply) => friends && friends.groupSend(String(gid), String(text || ''), reply));
ipcMain.handle('groups:call', (e, gid, msg) => (friends && fv() && e.sender === fv() ? friends.groupCall(String(gid), msg) : false));
ipcMain.handle('friends:add', async (e, ip) => {
  if (!friends) return { error: 'не готово' };
  ip = String(ip || '').trim();
  if (/^KNT-?[0-9a-f]{6}$/i.test(ip)) { // код Кентовки: ищем в общей сети
    const code = 'KNT-' + ip.replace(/^KNT-?/i, '').toUpperCase();
    if (code === friendCode(friends.myId)) return { error: 'Это твой собственный код.' };
    let p = discovery && discovery.byCode(code);
    if (!p && discovery) { discovery.scan(); for (let i = 0; i < 6 && !p; i++) { await new Promise((r) => setTimeout(r, 500)); p = discovery.byCode(code); } }
    if (!p) { // нет в общей сети — спросим у своих мостов
      for (const b of loadConfig().bridges || []) { const r = await findOnBridge(b.link, code); if (r) return friends.add(r.host + ':' + r.port); }
    }
    if (!p) return { error: `Не нашёл ${code} ни в общей сети, ни на мостах. Друг должен быть в той же локальной сети с открытой Кентовкой — или впиши его адрес.` };
    return friends.add(p.ip + ':' + p.fport);
  }
  return friends.add(ip);
});
ipcMain.handle('lan:list', () => ({ servers: discovery ? discovery.servers() : [], peers: discovery ? discovery.peers().map(({ id, code, name, ip }) => ({ id, code, name, ip })) : [] }));
ipcMain.handle('lan:scan', () => { if (discovery) discovery.scan(); });
// файлы и скрины в личке и группах
ipcMain.handle('friends:send-file', (e, target, src, caption) => {
  if (!friends || !target || !src) return { error: 'не готово' };
  const s2 = { name: String(src.name || '').slice(0, 200), mime: String(src.mime || '').slice(0, 80) };
  if (src.path && typeof src.path === 'string') { try { if (!fs.statSync(src.path).isFile()) return { error: 'это не файл' }; } catch { return { error: 'файл не найден' }; } s2.path = src.path; }
  else if (src.bytes) { if (src.bytes.byteLength > 200 * 1024 * 1024) return { error: 'больше 200 МБ — перетащи файл с диска' }; s2.bytes = Buffer.from(src.bytes); }
  return friends.sendFile({ id: target.id ? String(target.id) : undefined, gid: target.gid ? String(target.gid) : undefined }, s2, caption);
});
ipcMain.handle('friends:file-info', (e, fid) => (friends ? friends.fileInfo(String(fid)) : null));
ipcMain.handle('friends:file-fetch', (e, fid) => (friends ? friends.fetchFile(String(fid)) : null));
ipcMain.handle('friends:file-save', async (e, fid) => {
  const fp = friends && friends.filePath(String(fid)), fi = friends && friends.fileInfo(String(fid));
  if (!fp || !fi) return { error: 'файл ещё не скачан' };
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), fi.name) });
  if (r.canceled || !r.filePath) return { canceled: true };
  try { await fs.promises.copyFile(fp, r.filePath); return { ok: true, path: r.filePath }; } catch (err) { return { error: String(err.message) }; }
});
ipcMain.handle('friends:file-open', (e, fid) => { const fp = friends && friends.filePath(String(fid)); if (fp) shell.openPath(fp); return !!fp; });
ipcMain.handle('friends:respond', (e, id, yes) => friends && friends.respond(id, !!yes));
ipcMain.handle('friends:remove', (e, id) => friends && friends.remove(id));
ipcMain.handle('friends:messages', (e, id) => (friends ? friends.messages(id) : []));
ipcMain.handle('friends:read', (e, id) => friends && friends.read(id));
ipcMain.handle('friends:send', (e, id, text, reply) => friends && friends.send(id, text, reply));
ipcMain.handle('friends:delete', (e, target, mid, forAll) => friends && friends.deleteMsg(target && typeof target === 'object' ? { id: target.id ? String(target.id) : undefined, gid: target.gid ? String(target.gid) : undefined } : null, String(mid || ''), !!forAll));
ipcMain.handle('friends:react', (e, target, mid, emoji) => friends && friends.react(target && typeof target === 'object' ? { id: target.id ? String(target.id) : undefined, gid: target.gid ? String(target.gid) : undefined } : null, String(mid || ''), String(emoji || '')));
// «Позвать на сервер»: список серверов, где ты состоишь
function inviteTargets() {
  const c = loadConfig(), out = [];
  const lan = myAddrs()[0] || (lanAddresses()[0] || {}).address;
  const cur = currentInviteAddress();
  for (const x of Array.isArray(c.servers) ? c.servers : []) {
    if (!x || !x.address) continue;
    if (x.host) {
      const port = hostPortOf(x), on = hostServers.has(port);
      out.push({ key: x.address, name: x.name || 'Мой сервер', address: on && lan ? `${lan}:${port}` : null, mine: true, note: on ? '' : 'не запущен' });
    } else out.push({ key: x.address, name: x.name || x.address, address: x.address, mine: false, note: '' });
  }
  if (cur && !out.some((x) => x.address === cur)) out.unshift({ key: cur, name: currentServerName || cur, address: cur, mine: false, note: '' });
  for (const x of out) x.current = !!cur && x.address === cur;
  return out;
}
ipcMain.handle('friends:invite-list', () => inviteTargets());
ipcMain.handle('friends:invite', (e, id, key) => {
  if (!friends) return { error: 'Друзья ещё не готовы' };
  const t = key ? inviteTargets().find((x) => x.key === key) : inviteTargets().find((x) => x.current);
  if (!t || !t.address) return { error: key ? 'Этот сервер сейчас не запущен — включи его, тогда позовёшь' : 'Сначала зайди на сервер или создай свой' };
  friends.invite(id, t.address, t.name); return { ok: true, name: t.name };
});
ipcMain.handle('friends:join', async (e, address, name) => {
  if (win.isMinimized()) win.restore(); win.show(); win.focus();
  return connectTo({ address, host: false, name });
});
// адрес, по которому друг зайдёт на сервер, где я сейчас
function currentInviteAddress() {
  if (!connected || !currentServerUrl) return null;
  const u = new URL(currentServerUrl);
  if (hostServer && /^(localhost|127\.0\.0\.1)$/.test(u.hostname)) { const a = myAddrs()[0] || (lanAddresses()[0] || {}).address; return a ? `${a}:${u.port || hostServer.port}` : null; }
  return u.host;
}
ipcMain.handle('app:set-access', (e, a) => {
  if (!ACCESS.includes(a)) return;
  const tb = tabOf(e.sender); const hostServer = tb ? tb.hs : null;
  const c = loadConfig(); c.access = a;
  if (hostServer) { const x = (c.servers || []).find((v) => v && v.address === hostKey(hostServer.port)); if (x) x.access = a; }
  saveConfig(c);
  if (hostServer && hostServer.setAccess) hostServer.setAccess(a);
});
// полоса серверов в приложении: список и переход
ipcMain.handle('app:servers', (e) => {
  const tb = tabOf(e.sender);
  if (tb) { const c = loadConfig(); const list = (Array.isArray(c.servers) ? c.servers : []).map((x) => ({ ...x, port: x.host ? hostPortOf(x) : undefined, running: !!(x.host && hostServers.has(hostPortOf(x))) })); return { list, current: tb.key }; }
  const c = loadConfig();
  const list = (Array.isArray(c.servers) ? c.servers : []).map((x) => ({ ...x, port: x.host ? hostPortOf(x) : undefined, running: !!(x.host && hostServers.has(hostPortOf(x))) }));
  let current = null;
  if (currentServerUrl) { const u = new URL(tempNote ? 'https://' + currentServerKey : currentServerUrl); current = u.hostname === 'localhost' && hostServer ? hostKey(hostServer.port) : (list.find((x) => x.address === u.host || x.address === u.hostname) || {}).address || u.host; }
  return { list, current };
});
ipcMain.handle('app:go-server', (e, opts) => {
  opts = opts || {};
  const port = DEFAULT_PORT;
  if (opts.host) {
    const p = Number(opts.port) || mainHostPort();
    const sv = (loadConfig().servers || []).find((x) => x && x.address === hostKey(p));
    return connectTo({ host: true, port: p, name: opts.name, access: opts.access || (sv && sv.access) });
  }
  return connectTo({ address: String(opts.address || ''), host: false, name: opts.name, port });
});
ipcMain.on('app:id', (e) => { e.returnValue = friends ? friends.myId : ''; });
// хост: кто-то стучится на сервер (режим «с подтверждением») — уведомление, если окно не перед глазами
ipcMain.on('host:knock', (e, name) => {
  if (win && !win.isDestroyed() && win.isFocused()) return;
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: 'Кто-то хочет зайти', body: `${name} стучится на твой сервер`, icon: ICON });
  n.on('click', () => { win.show(); win.focus(); });
  n.show();
});

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('Кентовка');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть', click: () => { win.show(); win.focus(); } },
    { label: 'Друзья', click: () => openFriends() },
    { label: 'Микрофон вкл/выкл', click: () => sendHotkey('mute') },
    { label: 'Звук вкл/выкл', click: () => sendHotkey('deaf') },
    { type: 'separator' },
    { label: 'Выйти', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => { win.show(); win.focus(); });
}

let currentServerUrl = null;

// ---------- самоподписанный сертификат нашего сервера ----------
function trustKentovkaCerts(ses) {
  ses.setCertificateVerifyProc((req, cb) => {
    const c = req.certificate;
    const isOurs = c && (c.subjectName === 'kentovka' || (c.subject && c.subject.commonName === 'kentovka'));
    if (isOurs && c.fingerprint) certSeen.set(req.hostname, c.fingerprint);
    if (isOurs) { const pins = bridgePins(req.hostname); if (pins && pins.size && !pins.has(c.fingerprint)) return cb(-2); } // через мост — только тот же сервер, что и по общей сети
    cb(isOurs ? 0 : -3); // 0 = доверять, -3 = обычная проверка Chromium
  });
}

// ---------- микрофон и демка ----------
let pickerResolve = null;
let pickerSources = [];
let sysAudioWindow = null;
function setupMedia(ses) {
  const allowed = new Set(['media', 'display-capture', 'fullscreen', 'clipboard-sanitized-write', 'notifications', 'speaker-selection']);
  ses.setPermissionRequestHandler((wc, perm, cb) => cb(allowed.has(perm)));
  ses.setPermissionCheckHandler((wc, perm) => allowed.has(perm));

  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
      pickerSources = sources;
      const choice = await openPicker(sources);
      if (!choice) return callback({});
      const src = sources.find((s) => s.id === choice.id);
      if (!src) return callback({});
      sysAudioWanted = false;
      // окно — берём звук только этой программы (игра/браузер), экран — весь звук компа кроме Кентовки
      const m = /^window:(\d+):/.exec(src.id);
      sysAudioWindow = m ? m[1] : null;
      if (choice.audio && SYSAUDIO_EXE) {
        // звук берём своим помощником — без голосов из Кентовки
        sysAudioWanted = true;
        callback({ video: src });
      } else {
        callback(choice.audio ? { video: src, audio: 'loopback' } : { video: src });
      }
    } catch (e) {
      console.error(e);
      callback({});
    }
  });
}

function openPicker(sources) {
  return new Promise((resolve) => {
    const picker = new BrowserWindow({
      parent: win, modal: true, width: 760, height: 560, resizable: true, minimizable: false,
      backgroundColor: '#1a1b1e', autoHideMenuBar: true, title: 'Что показать?', icon: ICON,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
    });
    let done = false;
    pickerResolve = (choice) => {
      if (done) return;
      done = true; pickerResolve = null;
      resolve(choice);
      if (!picker.isDestroyed()) picker.close();
    };
    picker.on('closed', () => pickerResolve && pickerResolve(null));
    picker.loadFile(path.join(__dirname, 'picker.html'));
  });
}

// ---------- звук демки без голосов (Windows Process Loopback) ----------
const SYSAUDIO_EXE = (() => {
  if (process.env.KENTOVKA_TEST_SYSAUDIO) return process.env.KENTOVKA_TEST_SYSAUDIO; // только для тестов
  if (process.platform !== 'win32') return null;
  const p = path.join(__dirname, 'native', 'kentovka-audio.exe').replace('app.asar', 'app.asar.unpacked');
  return fs.existsSync(p) ? p : null;
})();
let sysAudioWanted = false;
let sysAudioProc = null;

function stopSysAudio() {
  if (sysAudioProc) { try { sysAudioProc.kill(); } catch {} sysAudioProc = null; }
}

ipcMain.handle('sysaudio:take', () => { const w = sysAudioWanted; sysAudioWanted = false; return w; });
ipcMain.handle('sysaudio:stop', () => stopSysAudio());
ipcMain.handle('sysaudio:start', (e) => {
  stopSysAudio();
  if (!SYSAUDIO_EXE) return { error: 'нет помощника' };
  const wc = e.sender;
  const args = [String(process.pid)];
  if (sysAudioWindow) args.push('window', sysAudioWindow);
  const proc = require('child_process').spawn(SYSAUDIO_EXE, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  sysAudioProc = proc;
  let rest = Buffer.alloc(0);
  proc.stdout.on('data', (chunk) => {
    // отдаём целыми кадрами (4 байта: 2 канала × 16 бит)
    const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
    const whole = buf.length - (buf.length % 4);
    rest = buf.subarray(whole);
    if (whole && !wc.isDestroyed()) wc.send('sysaudio:data', buf.subarray(0, whole));
  });
  let errText = '';
  proc.stderr.on('data', (d) => { errText += d; });
  proc.on('exit', (code) => {
    if (sysAudioProc === proc) sysAudioProc = null;
    if (!wc.isDestroyed()) wc.send('sysaudio:end', { code, error: errText.trim().split('\n').pop() });
  });
  proc.on('error', (err) => { if (!wc.isDestroyed()) wc.send('sysaudio:end', { code: -1, error: String(err.message) }); });
  return { ok: true };
});

// ---------- IPC ----------
const fromFile = (e) => e.senderFrame && e.senderFrame.url.startsWith('file:');

let currentServerName = '';
ipcMain.handle('app:server-name', (e) => { const t = tabOf(e.sender); return t ? t.name : currentServerName; });
// «Мои серверы»: переименовать / убрать из списка
ipcMain.handle('launcher:server-edit', (e, { address, name, remove }) => {
  if (!fromFile(e)) return null;
  const c = loadConfig();
  c.servers = (Array.isArray(c.servers) ? c.servers : []).filter((x) => x && (!remove || x.address !== address));
  if (!remove) { const x = c.servers.find((s) => s.address === address); if (x) x.name = String(name || '').trim().slice(0, 40); }
  saveConfig(c);
  return c.servers;
});
ipcMain.handle('launcher:get', (e) => {
  if (!fromFile(e)) return null;
  return { config: loadConfig(), addresses: lanAddresses(), hostRunning: hostServers.size > 0, running: [...hostServers.keys()], mainHostPort: mainHostPort(), hotkeys: { ...HOTKEYS } };
});
// остановить свой сервер (кенты с него выйдут)
ipcMain.handle('launcher:server-stop', async (e, port) => {
  if (!fromFile(e)) return null;
  port = Number(port);
  const s = hostServers.get(port); if (!s) return [...hostServers.keys()];
  { const t = tabs.get(hostKey(port)); if (t) { if (voiceTabKey === t.key) return { error: 'Ты в голосовом канале на этом сервере — сначала выйди из него' }; closeTab(t.key); } }
  hostServers.delete(port); if (hostServer === s) hostServer = null;
  try { await s.close(); } catch {}
  return [...hostServers.keys()];
});

// удалить свой сервер: остановить и стереть историю, каналы, профили (сертификат и аккаунт остаются)
ipcMain.handle('launcher:server-delete', async (e, port) => {
  if (!fromFile(e)) return null;
  port = Number(port);
  const s = hostServers.get(port);
  { const t = tabs.get(hostKey(port)); if (t) { if (voiceTabKey === t.key) return { error: 'Ты в голосовом канале на этом сервере — сначала выйди из него' }; closeTab(t.key); } }
  if (s) { hostServers.delete(port); if (hostServer === s) hostServer = null; try { await s.close(); } catch {} }
  const dir = hostDataDir(port);
  for (const f of ['chat-history.json', 'avatars.json', 'profiles.json', 'accounts.json', 'channels.json', 'files.json']) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
  try { fs.rmSync(path.join(dir, 'banners'), { recursive: true, force: true }); } catch {}
  if (dir !== app.getPath('userData')) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  const c = loadConfig();
  c.servers = (Array.isArray(c.servers) ? c.servers : []).filter((x) => !(x && x.host && hostPortOf(x) === port));
  if (c.mainHostPort === port) delete c.mainHostPort;
  saveConfig(c);
  try { discovery && discovery.announce(); } catch {}
  return { ok: true, servers: c.servers, running: [...hostServers.keys()] };
});
ipcMain.handle('launcher:connect', async (e, opts) => {
  if (!fromFile(e)) return { error: 'нельзя' };
  return connectTo(opts || {});
});
// кто может зайти на мой сервер: open — все, у кого есть адрес; approve — с моего подтверждения; friends — только друзья
const ACCESS = ['open', 'approve', 'friends'];
async function connectTo({ address, host, port, direct, name, access }) {
  port = Number(port) || DEFAULT_PORT;
  // зашли не со стартового экрана (например, по приглашению друга) — настройки прямого соединения не трогаем
  if (!direct) direct = loadConfig().direct || { enabled: true, stunMode: 'public', stunUrl: 'stun:stun.sipnet.ru:3478, stun:stun.fitauto.ru:3478' };
  access = ACCESS.includes(access) ? access : (ACCESS.includes(loadConfig().access) ? loadConfig().access : 'open');
  const d = direct || {};
  direct = {
    enabled: !!d.enabled,
    chosen: true, // выбор сделан в новом меню (раньше по умолчанию было выключено)
    stunMode: d.stunMode === 'own' ? 'own' : 'public',
    publicHost: String(d.publicHost || '').trim().slice(0, 200),
    stunUrl: String(d.stunUrl || '').trim().slice(0, 200),
  };
  const directOpt = !direct.enabled ? null
    : direct.stunMode === 'own' ? { publicHost: direct.publicHost } : { stunUrl: direct.stunUrl };
  const directKey = JSON.stringify(directOpt);
  try {
    if (host) {
      { const c = loadConfig(); if (!c.mainHostPort) { c.mainHostPort = (c.servers || []).some((x) => x && x.address === 'host') ? (Number(c.port) || DEFAULT_PORT) : port; saveConfig(c); } }
      let s = hostServers.get(port);
      if (s && s.directKey !== directKey) { hostServers.delete(port); await s.close(); s = null; }
      if (!s) {
        const dataDir = hostDataDir(port);
        fs.mkdirSync(dataDir, { recursive: true });
        s = await startServer({ port, dataDir, direct: directOpt, access,
          isFriend: (id) => !!(friends && friends.isFriend(id)), hostAppId: friends && friends.myId });
        s.directKey = directKey;
        hostServers.set(port, s); setTimeout(() => { try { discovery && discovery.announce(); } catch {} }, 300);
      } else if (s.setAccess) s.setAccess(access);
      hostServer = s;
    } else hostServer = null; // свои серверы продолжают работать — друзья на них остаются
  } catch (err) {
    hostServer = null;
    return { error: err.code === 'EADDRINUSE' ? `Порт ${port} занят. Может, Кентовка уже запущена (start.bat)? Закрой её или поменяй порт.` : String(err.message || err) };
  }
  let target = host ? 'localhost' : String(address || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!target) return { error: 'Впиши адрес хоста' };
  // сервер уже открыт во вкладке — просто показываем его (голос не рвётся)
  const tabKey = host ? hostKey(port) : target; // тот же ключ, что в «Мои серверы»
  if (tabs.has(tabKey) && !tabs.get(tabKey).view.webContents.isDestroyed()) { if (host && hostServer) tabs.get(tabKey).hs = hostServer; showTab(tabKey); return { ok: true }; }
  let url = `https://${target}`;
  if (!/:\d+$/.test(target)) url += `:${port}`;
  { const c = loadConfig(); saveConfig(Object.assign(c, { address: host ? c.address : target, host: !!host, port: host ? port : c.port || port, direct }, host ? { access } : {})); }
  const tab = { key: tabKey, url, realKey: null, name: '', host: !!host, port, hs: host ? hostServer : null, tempNote: null, viaAlt: null, at: Date.now(), view: null };
  let prevServers;
  try {
    {
      const old = (loadConfig().servers || []).find((x) => x && x.address === (host ? hostKey(port) : target));
      tab.name = String(name || '').trim() || (old && old.name) || (host ? 'Мой сервер' : target);
    }
    // запоминаем сервер в «Мои серверы» ещё до загрузки — страница сразу покажет его в полосе слева;
    // если не достучались — вернём список как был
    prevServers = loadConfig().servers;
    {
      const c = loadConfig();
      const key = host ? hostKey(port) : target;
      const list = (Array.isArray(c.servers) ? c.servers : []).filter((x) => x && x.address !== key);
      const old = (Array.isArray(c.servers) ? c.servers : []).find((x) => x && x.address === key);
      const nm = String(name || '').trim().slice(0, 40) || (old && old.name) || (host ? 'Мой сервер' : '');
      list.unshift(Object.assign({}, old && { alts: old.alts, fps: old.fps }, { address: key, name: nm, last: Date.now(), host: !!host }, host ? { access } : {}));
      c.servers = list.slice(0, 30); saveConfig(c);
    }
    tab.realKey = new URL(url).host;
    tab.view = makeTabView(tab);
    tabs.set(tabKey, tab); // заранее: подпись для входа и проверка сертификата знают, куда мы идём
    // хоста нет в сети — не сдаёмся: временный сервер у кентов или у себя (голос и чат работают, прав хоста ни у кого нет)
    // общая сеть не пускает — пробуем запасные адреса сервера: свой мост → мост сервера → остальные
    if (!host && !(await reachable(url))) {
      for (const alt of altOrder(tab.realKey)) {
        if (alt === tab.realKey) continue;
        if (await reachable('https://' + alt)) { url = 'https://' + alt; tab.url = url; tab.viaAlt = alt; break; }
      }
    }
    if (!host && !(await reachable(url))) {
      const t = await tempFallback(tab.realKey);
      if (t) { tab.url = t.url; tab.tempNote = { owner: t.owner, host: tab.realKey }; await tab.view.webContents.loadURL(t.url + '/'); }
      else throw new Error('unreachable');
    } else await tab.view.webContents.loadURL(url + '/');
    // лишние вкладки (больше 6) закрываем — кроме той, где голос
    const extra = [...tabs.values()].filter((x) => x.key !== tabKey && x.key !== voiceTabKey).sort((a, b) => a.at - b.at);
    while (tabs.size > 6 && extra.length) closeTab(extra.shift().key);
    showTab(tabKey);
    friendsChanged(); // окно друзей: теперь можно звать на этот сервер
    return { ok: true };
  } catch (err) {
    if (tabs.get(tabKey) === tab) { tabs.delete(tabKey); try { tab.view && tab.view.webContents.close(); } catch {} }
    { const c = loadConfig(); c.servers = prevServers; saveConfig(c); }
    if (win && !win.isDestroyed()) win.webContents.send('shell:tab', shellPayload());
    return { error: `Не достучался до ${url}. Хост запустил Кентовку? Вы в одной локальной сети? Если хоста нет — зайди хотя бы раз, пока он в сети: тогда в следующий раз Кентовка сможет держать сервер без него.` };
  }
}

function makeTabView(tab) {
  const v = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  v.setBackgroundColor('#0a0b14');
  const wc = v.webContents;
  wc.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) require('electron').shell.openExternal(url); return { action: 'deny' }; });
  wc.on('will-navigate', (e, url) => { if (!url.startsWith(tab.url)) e.preventDefault(); });
  wc.on('render-process-gone', () => { if (tabs.get(tab.key) === tab) closeTab(tab.key); });
  wc.on('before-input-event', (e, inp) => { if (inp.type === 'keyDown' && inp.key === 'F11') { e.preventDefault(); win.setFullScreen(!win.isFullScreen()); } });
  return v;
}
// со страницы сервера «на главную»: вкладка остаётся (голос не рвётся)
ipcMain.handle('app:back', async (e) => { showTab(null); });
// выйти с сервера совсем (закрыть вкладку)
ipcMain.handle('app:leave', async (e) => { const t = tabOf(e.sender); if (t) closeTab(t.key); });

// ---------- временный сервер: хост вышел посреди звонка, сервером становлюсь я (без прав хоста) ----------
const BACKUP_PORT = Number(process.env.KENTOVKA_BACKUP_PORT) || 8449;
let backupServer = null, backupIdle = null;
ipcMain.on('backup:port', (e) => { e.returnValue = BACKUP_PORT; });
ipcMain.handle('backup:start', async (e, o) => {
  if (!tabOf(e.sender) || !o) return { error: 'нельзя' };
  return startBackup(o);
});
async function startBackup(o) {
  if (backupServer) return { port: BACKUP_PORT };
  const dir = path.join(app.getPath('userData'), 'backup-server');
  try { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); } catch {}
  const up = /^[\w.\-]+:\d+$/.test(String(o.upstream || '')) ? String(o.upstream) : null;
  try {
    backupServer = await startServer({ port: BACKUP_PORT, dataDir: dir, noHost: true, access: ACCESS.includes(o.access) ? o.access : 'open',
      seed: o.seed || null, allow: Array.isArray(o.allow) ? o.allow.filter((x) => /^[0-9a-f]{32}$/.test(x)).slice(0, 100) : null,
      upstream: up, tempFor: up });
  } catch (err) { backupServer = null; return { error: String(err.code || err.message) }; }
  // все разошлись (вернулись к хосту) — выключаем
  let empty = 0;
  clearInterval(backupIdle);
  backupIdle = setInterval(() => {
    if (!backupServer) return clearInterval(backupIdle);
    empty = backupServer.clients() ? 0 : empty + 1;
    if (empty >= 4) { const s = backupServer; backupServer = null; clearInterval(backupIdle); s.close(); }
  }, 15000);
  return { port: BACKUP_PORT };
}

// ---------- хоста нет в сети: заходим на временный сервер у кентов или поднимаем его у себя ----------
// Страница сервера время от времени отдаёт снимок: каналы, последние сообщения, аватарки, кто был на сервере (их адреса).
const cacheDir = () => path.join(app.getPath('userData'), 'server-cache');
const cacheFile = (key) => path.join(cacheDir(), String(key).replace(/[^\w.\-]/g, '_') + '.json');
let currentServerKey = null; // адрес настоящего хоста (ip:порт), даже если сейчас мы на временном сервере
ipcMain.on('server:cache', (e, snap) => {
  const tb = tabOf(e.sender); if (!tb || !snap || !tb.realKey) return;
  const currentServerKey = tb.realKey;
  try {
    const safe = {
      channels: Array.isArray(snap.channels) ? snap.channels.slice(0, 60) : [],
      history: Array.isArray(snap.history) ? snap.history.slice(-1500) : [],
      avatars: snap.avatars && typeof snap.avatars === 'object' ? snap.avatars : {},
      profiles: snap.profiles && typeof snap.profiles === 'object' ? snap.profiles : {},
      members: Array.isArray(snap.members) ? snap.members.filter((m) => m && typeof m.ip === 'string').slice(0, 100).map((m) => ({ ip: String(m.ip).slice(0, 60), appId: /^[0-9a-f]{32}$/.test(m.appId || '') ? m.appId : null, name: String(m.name || '').slice(0, 24) })) : [],
      mode: ACCESS.includes(snap.mode) ? snap.mode : 'open', ice: snap.ice || null, at: Date.now(),
    };
    // кто когда-либо был на сервере — копим (чтобы потом найти временный сервер у кого-то из них)
    let old = null; try { old = JSON.parse(fs.readFileSync(cacheFile(currentServerKey), 'utf8')); } catch {}
    if (old && Array.isArray(old.members)) for (const m of old.members) if (!safe.members.some((x) => x.ip === m.ip)) safe.members.push(m);
    safe.members = safe.members.slice(0, 100);
    fs.mkdirSync(cacheDir(), { recursive: true });
    fs.writeFile(cacheFile(currentServerKey), JSON.stringify(safe), () => {});
  } catch {}
});
function probeTemp(ip, key, keys) {
  return new Promise((resolve) => {
    const req = require('https').get({ host: ip, port: BACKUP_PORT, path: '/__temp', rejectUnauthorized: false, timeout: 1500 }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; if (b.length > 4096) req.destroy(); });
      res.on('end', () => { try { const j = JSON.parse(b); resolve(j.temp && (j.for === key || (keys && keys.has(j.for))) ? ip : null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
function reachable(url) {
  return new Promise((resolve) => {
    const req = require('https').get(url + '/__temp', { rejectUnauthorized: false, timeout: 2500 }, (res) => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
let tempNote = null; // для страницы: { owner: 'me' | ip }
ipcMain.handle('app:temp-note', (e) => { const t = tabOf(e.sender); return t ? t.tempNote || null : tempNote; });
async function tempFallback(key) {
  let cache = null; try { cache = JSON.parse(fs.readFileSync(cacheFile(key), 'utf8')); } catch {}
  const mine = new Set(lanAddresses().map((a) => a.address));
  // где искать временный сервер: кто был на этом сервере, друзья и все Кентовки рядом в локальной сети
  const cand = new Set(cache ? cache.members.map((m) => m.ip) : []);
  try { for (const f of (friends && friends.db().friends) || []) if (f.ip) cand.add(String(f.ip).replace(/^::ffff:/, '').split(':')[0]); } catch {}
  try { for (const p of (discovery ? discovery.peers() : [])) if (p.ip) cand.add(p.ip); } catch {}
  const ips = [...cand].filter((ip) => ip && !mine.has(ip) && !/^127\./.test(ip) && /^[\d.]+$/.test(ip)).slice(0, 60);
  // один и тот же хост кенты знают по разным адресам (общая сеть, мост) — подходят все
  const keys = new Set([key]); try { const sv = (loadConfig().servers || []).find((x) => x.address === key); for (const a of (sv && sv.alts) || []) keys.add(a.addr); } catch {}
  if (process.env.KENTOVKA_TEST_PROBE) ips.push(...process.env.KENTOVKA_TEST_PROBE.split(','));
  // 1) у кого-то из кентов уже поднят временный сервер?
  const found = (await Promise.all(ips.map((ip) => probeTemp(ip, key, keys)))).find(Boolean);
  if (found) return { url: `https://${found}:${BACKUP_PORT}`, owner: found };
  // 2) нет — поднимаем у себя. Не были на сервере раньше — просто с общими каналами (истории нет, но общаться можно)
  if (backupServer) return { url: `https://127.0.0.1:${BACKUP_PORT}`, owner: 'me' };
  const seed = cache || { channels: [{ id: 'general', name: 'общий', type: 'text' }, { id: 'voice', name: 'Общий', type: 'voice' }], history: [], avatars: {}, profiles: {}, members: [] };
  const r = await startBackup({ seed, allow: cache ? cache.members.map((m) => m.appId).filter(Boolean) : null, access: cache ? cache.mode : 'open', upstream: key });
  if (r.error) return null;
  return { url: `https://127.0.0.1:${BACKUP_PORT}`, owner: 'me' };
}
ipcMain.handle('app:host-info', (e) => { const t = tabOf(e.sender); const hs = t ? t.hs : hostServer; return hs ? { port: hs.port, addresses: lanAddresses() } : null; });
ipcMain.handle('app:copy', (e, text) => { clipboard.writeText(String(text).slice(0, 500)); });
ipcMain.handle('app:hotkeys', () => ({ ...HOTKEYS }));
// пока в настройках ждём новое сочетание — клавиши не срабатывают
ipcMain.on('hotkeys:pause', (e, on) => { hotkeysPaused = !!on; });
ipcMain.handle('app:set-hotkey', (e, action, accel) => {
  if (!(action in DEFAULT_HOTKEYS)) return { error: 'нет такого действия' };
  if (accel === null) accel = DEFAULT_HOTKEYS[action];            // «по умолчанию»
  accel = String(accel || '');
  if (accel && !ACCEL_RE.test(accel)) return { error: 'Такое сочетание не подходит' };
  const other = Object.keys(HOTKEYS).find((a) => a !== action && HOTKEYS[a] === accel);
  if (accel && other) return { error: 'Это сочетание уже занято другим действием' };
  HOTKEYS[action] = accel;
  registerHotkeys();
  const c = loadConfig(); c.hotkeys = { ...HOTKEYS }; saveConfig(c);
  return { ok: true, hotkeys: { ...HOTKEYS } };
});
// звуки: громкость, вкл/выкл и свои файлы на события — общие для всех серверов и друзей
const SOUND_EVENTS = ['message', 'dm', 'join', 'leave', 'mute', 'unmute', 'deaf', 'undeaf', 'stream', 'online', 'ringIn', 'ringOut', 'callStart', 'callEnd'];
const soundsOf = (c) => { const s = c.sounds || {}; return { vol: Number.isFinite(+s.vol) ? Math.max(0, Math.min(2, +s.vol)) : 1, on: s.on !== false, custom: s.custom && typeof s.custom === 'object' ? s.custom : {} }; };
ipcMain.handle('app:sounds-get', () => soundsOf(loadConfig()));
ipcMain.handle('app:sounds-set', (e, o) => {
  if (!o || typeof o !== 'object') return { error: 'нет данных' };
  const c = loadConfig(); const s = soundsOf(c);
  if ('vol' in o) s.vol = Math.max(0, Math.min(2, Number(o.vol) || 0));
  if ('on' in o) s.on = !!o.on;
  if (o.name) {
    if (!SOUND_EVENTS.includes(o.name)) return { error: 'нет такого события' };
    if (o.data == null) delete s.custom[o.name];
    else if (typeof o.data === 'string' && o.data.length < 1.5 * 1024 * 1024 && /^data:(audio|video|application)\/[\w.+-]+;base64,/.test(o.data)) s.custom[o.name] = o.data;
    else return { error: 'это не звуковой файл или он больше 1 МБ' };
  }
  c.sounds = s; saveConfig(c, true);
  for (const wc of [win && !win.isDestroyed() && win.webContents, fv(), ...allTabWC()]) if (wc && wc !== e.sender) wc.send('sounds:changed', s);
  return { ok: true };
});
ipcMain.handle('app:profile-get', () => loadConfig().profile || null);
ipcMain.handle('app:profile-set', (e, p) => {
  if (!p || typeof p !== 'object') return;
  const name = String(p.name || '').trim().slice(0, 24);
  const avatar = typeof p.avatar === 'string' && p.avatar.length < 60000 && p.avatar.startsWith('data:image/') ? p.avatar : null;
  const col = (x) => (/^#[0-9a-f]{6}$/i.test(x || '') ? x : null);
  const c = loadConfig(); c.profile = { name, avatar, bio: String(p.bio || '').slice(0, 190), color: col(p.color), color2: col(p.color2) }; c.profileAt = Date.now(); saveConfig(c); try { if (friends) friends.syncSiblings(); } catch {}
  if (friends) friends.announce();
});
// тема из настроек Кентовки — чтобы стартовый экран был в тех же цветах
ipcMain.handle('app:set-theme', (e, theme) => {
  if (!theme || typeof theme !== 'object') return;
  const c = loadConfig();
  const hex = (x, d) => (/^#[0-9a-f]{6}$/i.test(x || '') ? x : d);
  // вид общий для всех серверов (раньше у каждого сервера был свой — при смене сервера «слетал»)
  c.theme = { accent: hex(theme.accent, '#22e1ff'), accent2: hex(theme.accent2, '#ff3ec8'), glow: Math.max(0, Math.min(1, Number(theme.glow) || 0)), motion: !!theme.motion,
    bg: ['calm', 'aurora', 'grid', 'off', 'custom', 'stars', 'waves'].includes(theme.bg) ? theme.bg : (typeof theme.bg === 'string' ? theme.bg.slice(0, 20) : 'calm'),
    bgDim: Math.max(0, Math.min(0.95, Number(theme.bgDim) || 0)), bgBlur: Math.max(0, Math.min(40, Number(theme.bgBlur) || 0)), at: Date.now() };
  saveConfig(c);
  for (const wc of [win && !win.isDestroyed() && win.webContents, fv(), ...allTabWC()]) if (wc && wc !== e.sender) wc.send('theme:changed', c.theme);
});
ipcMain.handle('app:get-theme', () => loadConfig().theme || null);
// свой фон всего приложения — один на все серверы, лежит файлом в папке приложения
const BG_FILE = () => path.join(app.getPath('userData'), 'ui-background.bin');
ipcMain.handle('app:bg-get', async () => {
  try { const meta = loadConfig().bgMeta; if (!meta) return null; const data = await fs.promises.readFile(BG_FILE()); return { data, mime: meta.mime }; } catch { return null; }
});
ipcMain.handle('app:bg-set', async (e, data, mime) => {
  const c = loadConfig();
  if (!data) { try { fs.unlinkSync(BG_FILE()); } catch {} delete c.bgMeta; saveConfig(c); }
  else {
    const buf = Buffer.from(data);
    if (buf.length > 25 * 1024 * 1024 || !/^image\/(png|jpeg|gif|webp)$/.test(String(mime))) return { error: 'Фон — картинка или гифка до 25 МБ' };
    await fs.promises.writeFile(BG_FILE(), buf); c.bgMeta = { mime: String(mime), at: Date.now() }; saveConfig(c);
  }
  for (const wc of [win && !win.isDestroyed() && win.webContents, fv(), ...allTabWC()]) if (wc && wc !== e.sender) wc.send('bg:changed');
  return { ok: true };
});

ipcMain.handle('picker:sources', () => pickerSources.map((s) => ({
  id: s.id, name: s.name, screen: s.id.startsWith('screen:'), thumb: s.thumbnail.toDataURL(),
})));
ipcMain.handle('picker:choose', (e, choice) => { if (pickerResolve) pickerResolve(choice); });

// ---------- мосты на VPS: свой (ссылка KNTB1…) и запасные адреса серверов ----------
let viaAlt = null; // зашли не по общей сети, а через мост
const bridgeConns = new Map(); // ссылка -> подключение
function bridgeServices() {
  const out = {};
  for (const port of hostServers.keys()) out['srv-' + port] = port;
  if (friends) out.fr = friends.port;
  return out;
}
function bridgeSvcKey() { return Object.keys(bridgeServices()).sort().join(','); }
let lastSvcKey = '';
function syncBridges() {
  const c = loadConfig();
  const links = (c.bridges || []).map((b) => b.link);
  for (const [link, bc] of bridgeConns) if (!links.includes(link)) { bc.close(); bridgeConns.delete(link); }
  for (const link of links) {
    if (bridgeConns.has(link) || !parseLink(link) || !friends) continue;
    try { bridgeConns.set(link, connectBridge({ link, id: friends.myId, name: () => (loadConfig().profile || {}).name || '', services: bridgeServices, onState: () => bridgeChanged() })); } catch (e) { console.error('мост', e.message); }
  }
  const k = bridgeSvcKey();
  if (k !== lastSvcKey) { lastSvcKey = k; for (const bc of bridgeConns.values()) bc.reconnect(); }
  bridgeChanged();
}
function bridgeChanged() {
  // каждому своему серверу — его адреса на мостах и TURN для голоса
  for (const [port, s] of hostServers) {
    if (!s.setBridges) continue;
    const list = [];
    for (const bc of bridgeConns.values()) {
      const addr = bc.address('srv-' + port); if (!addr) continue;
      const st = bc.state(), b = bc.info;
      list.push({ addr, own: true, turn: b.turnSecret && st.turnPort ? { host: b.host, port: st.turnPort, secret: b.turnSecret } : null });
    }
    const key = JSON.stringify(list);
    if (s._bridgeKey !== key) { s._bridgeKey = key; s.setBridges(list); }
  }
  if (win && !win.isDestroyed()) win.webContents.send('bridges:changed');
}
// TURN своих мостов — для звонков в личке и группах, когда напрямую не выходит
ipcMain.handle('friends:ice', () => {
  const { turnCreds } = require('./bridge'); const out = [];
  for (const bc of bridgeConns.values()) { const st = bc.state(), b = bc.info; if (st.state !== 'up' || !b.turnSecret || !st.turnPort) continue;
    const c = turnCreds(b.turnSecret, 'dm'); out.push({ urls: [`turn:${b.host}:${st.turnPort}?transport=udp`, `turn:${b.host}:${st.turnPort}?transport=tcp`], ...c }); }
  return out;
});
const myFriendAlts = () => [...bridgeConns.values()].map((bc) => bc.address('fr')).filter(Boolean);
setInterval(() => { try { syncBridges(); } catch {} }, 5000);
ipcMain.handle('bridges:list', () => {
  const c = loadConfig();
  return (c.bridges || []).map((b) => { const bc = bridgeConns.get(b.link); const st = bc ? bc.state() : { state: 'down' }; return { link: b.link, host: (parseLink(b.link) || {}).host, state: st.state, error: st.error, ports: st.ports || {}, turn: !!(bc && bc.info.turnSecret && st.turnPort) }; });
});
ipcMain.handle('bridges:add', async (e, link) => {
  const b = parseLink(link); if (!b) return { error: 'Это не ссылка на мост. Она начинается с KNTB1. — её печатает установщик моста на VPS.' };
  const c = loadConfig(); c.bridges = (c.bridges || []).filter((x) => x.link !== b.link); c.bridges.push({ link: b.link, at: Date.now() }); saveConfig(c);
  syncBridges();
  for (let i = 0; i < 16; i++) { await new Promise((r) => setTimeout(r, 250)); const bc = bridgeConns.get(b.link); const st = bc && bc.state(); if (st && (st.state === 'up' || st.state === 'error')) return { ok: st.state === 'up', error: st.error }; }
  return { ok: false, error: (bridgeConns.get(b.link) && bridgeConns.get(b.link).state().error) || 'мост пока не ответил — Кентовка будет пробовать сама' };
});
ipcMain.handle('bridges:remove', (e, link) => { const c = loadConfig(); c.bridges = (c.bridges || []).filter((x) => x.link !== link); saveConfig(c); syncBridges(); return true; });
// сервер прислал свои адреса во всех сетях и на мостах — запоминаем порядок для следующего входа
const certSeen = new Map(); // имя хоста -> отпечаток сертификата
ipcMain.on('server:alts', (e, alts) => {
  const tb = tabOf(e.sender); if (!tb || !tb.realKey || !Array.isArray(alts)) return;
  const currentServerKey = tb.realKey, currentServerUrl = tb.url, viaAlt = tb.viaAlt;
  const c = loadConfig(); const sv = (c.servers || []).find((x) => x.address === currentServerKey); if (!sv) return;
  sv.alts = alts.filter((a) => a && typeof a.addr === 'string' && /^[\w.-]{1,200}:\d{2,5}$/.test(a.addr)).slice(0, 12).map((a) => ({ addr: a.addr, net: String(a.net || '').slice(0, 12), own: !!a.own }));
  // отпечаток сертификата сервера, увиденный по общей сети: через мост пустим только к нему же (мост не подменит сервер)
  if (!viaAlt && currentServerUrl) { const fp = certSeen.get(new URL(currentServerUrl).hostname); if (fp) sv.fps = [...new Set([fp, ...(sv.fps || [])])].slice(0, 4); }
  saveConfig(c, true);
});
function altOrder(key) {
  const c = loadConfig(); const sv = (c.servers || []).find((x) => x.address === key); if (!sv || !sv.alts) return [];
  const myNets = new Set(lanAddresses().map((a) => a.net));
  const myBridgeHosts = new Set((c.bridges || []).map((b) => (parseLink(b.link) || {}).host));
  const rank = (a) => (a.net !== 'bridge' ? (myNets.has(a.net) ? 0 : 4) : myBridgeHosts.has(a.addr.split(':')[0]) ? 1 : a.own ? 2 : 3);
  return sv.alts.slice().sort((a, b) => rank(a) - rank(b)).map((a) => a.addr);
}
function bridgePins(hostname) { // какие сертификаты можно принять от этого моста
  const out = new Set(); let any = false;
  for (const sv of loadConfig().servers || []) for (const a of sv.alts || []) if (a.net === 'bridge' && a.addr.split(':')[0] === hostname) { any = true; for (const f of sv.fps || []) out.add(f); }
  return any ? out : null;
}

// ---------- аккаунт: подпись для серверов, сохранения, привязка устройств ----------
let autoSaveT = null, autoSaveDirty = false;
function scheduleAutoSave(delay = 2 * 60 * 1000) {
  autoSaveDirty = true; clearTimeout(autoSaveT);
  autoSaveT = setTimeout(() => { try { if (account) { const r = account.autoSave(); if (r && r.ok) autoSaveDirty = false; } } catch (e) { console.error('автосохранение', e); } }, delay);
}
ipcMain.handle('account:sign', (e, nonce, host) => {
  if (!account || !/^[0-9a-f]{16,64}$/.test(String(nonce || ''))) return null;
  host = String(host || '');
  // подписываем только для того сервера, куда мы правда подключались (чтобы чужой сервер не выпросил подпись для другого)
  const ok = new Set([currentServerUrl && new URL(currentServerUrl).host, currentServerKey].filter(Boolean));
  for (const t of tabs.values()) { try { ok.add(new URL(t.url).host); } catch {} if (t.realKey) ok.add(t.realKey); }
  if (!ok.has(host) && !new RegExp(':' + BACKUP_PORT + '$').test(host)) return null;
  const r = account.sign(`kentovka:${nonce}:${account.id}:${host}`);
  return { ...r, host };
});
ipcMain.handle('account:info', () => {
  if (!account) return null;
  const c = loadConfig();
  return { id: account.id, mode: (c.backup && c.backup.mode) || null, lastAutoSave: c.lastAutoSave || 0, saveDir: account.saveDir(), saves: account.listSaves().slice(0, 10),
    siblings: (c.siblings || []).length, fresh: account.isNew && !((friends && friends.db().friends) || []).length, siblingsOnline: friends ? friends.siblingsOnline() : 0, name: (c.profile || {}).name || '' };
});
ipcMain.handle('account:set-password', (e, pw) => { if (!account) return; account.setBackupPassword(pw === null ? null : String(pw)); scheduleAutoSave(0); return { ok: true }; });
ipcMain.handle('account:save-now', () => { if (!account) return null; try { return account.autoSave(); } catch (err) { return { error: String(err.message) }; } });
ipcMain.handle('account:save-as', async (e, pw) => {
  if (!account) return null;
  const name = ((loadConfig().profile || {}).name || 'аккаунт').replace(/[\\/:*?"<>|]/g, '');
  const r = await dialog.showSaveDialog(win, { title: 'Сохранить аккаунт Кентовки', defaultPath: path.join(app.getPath('documents'), `Кентовка-${name}.knt`), filters: [{ name: 'Сохранение Кентовки', extensions: ['knt'] }] });
  if (r.canceled || !r.filePath) return { canceled: true };
  try { return account.saveTo(r.filePath, pw ? String(pw) : null); } catch (err) { return { error: String(err.message) }; }
});
ipcMain.handle('account:open-folder', () => { if (account) { fs.mkdirSync(account.saveDir(), { recursive: true }); shell.openPath(account.saveDir()); } });
ipcMain.handle('account:pick-file', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Восстановить аккаунт из сохранения', filters: [{ name: 'Сохранение Кентовки', extensions: ['knt'] }], properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return null;
  try { const j = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')); if (j.magic !== 'kentovka-account') return { error: 'Это не сохранение Кентовки' }; return { file: r.filePaths[0], name: j.name, at: j.at, enc: !!j.enc }; }
  catch { return { error: 'Файл не читается' }; }
});
// восстановление: из файла (после переустановки — сам находит в «Документы\Kentovka\Сохранения»)
ipcMain.handle('account:restore', async (e, file, pw) => {
  if (!account) return { error: 'не готово' };
  let b; try { b = account.readSave(String(file), pw || null); } catch (err) { return { error: String(err.message) }; }
  await applyBundle(b, null, pw || null);
  return { ok: true };
});
async function applyBundle(b, sibling, pw) {
  if (!b || !b.account || !b.friends) throw new Error('Пустое сохранение');
  try { if (friends) friends.close(); } catch {}
  const ud = app.getPath('userData');
  fs.writeFileSync(path.join(ud, 'friends.json'), JSON.stringify(b.friends));
  fs.writeFileSync(path.join(ud, 'account.json'), JSON.stringify(b.account));
  const c = loadConfig();
  for (const k of ['profile', 'theme', 'voice', 'hotkeys', 'direct', 'access']) if (b.config && b.config[k]) c[k] = b.config[k];
  const srv = Array.isArray(c.servers) ? c.servers : [];
  for (const x of (b.config && b.config.servers) || []) if (x && !srv.some((y) => y.address === x.address)) srv.push(x);
  c.servers = srv.slice(0, 30);
  if (sibling) { c.siblings = (c.siblings || []).filter((x) => JSON.stringify(x.ips) !== JSON.stringify(sibling.ips)).concat(sibling); }
  saveConfig(c);
  if (pw) { try { account.setBackupPassword(pw); } catch {} }
  setTimeout(() => { if (!process.env.KENTOVKA_TEST_NORELAUNCH) app.relaunch(); app.exit(0); }, 400);
}
// ----- привязка нового устройства кодом со старого -----
let pendingLink = null; // { secret, expires }
ipcMain.handle('account:link-code', async () => {
  if (!account || !friends) return null;
  const secret = require('crypto').randomBytes(9).toString('base64url');
  pendingLink = { secret, expires: Date.now() + 5 * 60 * 1000 };
  const ips = lanAddresses().map((a) => a.address).slice(0, 4);
  const code = 'KNT1.' + Buffer.from(JSON.stringify({ a: ips, p: friends.port, s: secret })).toString('base64url');
  let qr = null; try { qr = await require('qrcode').toDataURL(code, { margin: 1, width: 220, color: { dark: '#0a0b14', light: '#ffffff' } }); } catch {}
  return { code, qr, expires: pendingLink.expires, ips };
});
const linkKey = (secret) => require('crypto').scryptSync(String(secret), 'kentovka-link', 32, { N: 1 << 14, r: 8, p: 1 });
function onLinkMessage(m, send, ws) {
  if (m.t === 'link') { // старое устройство: новое просит аккаунт
    const crypto = require('crypto');
    if (!pendingLink || Date.now() > pendingLink.expires || m.h !== crypto.createHash('sha256').update(pendingLink.secret).digest('hex')) { send({ t: 'link-no', reason: 'Код устарел или неверный — покажи новый.' }); return; }
    const b = account.bundle();
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', linkKey(pendingLink.secret), iv);
    const data = Buffer.concat([c.update(Buffer.from(JSON.stringify(b))), c.final()]);
    send({ t: 'link-ok', iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64'), from: lanAddresses().map((a) => a.address).slice(0, 4), port: friends.port });
    // запоминаем новое устройство, чтобы потом синхронизироваться
    const ip = String((ws._socket && ws._socket.remoteAddress) || '').replace(/^::ffff:/, '');
    const cfg = loadConfig(); cfg.siblings = (cfg.siblings || []).filter((x) => !(x.ips || []).includes(ip)).concat({ ips: [ip], port: Number(m.port) || 8444, at: Date.now() }); saveConfig(cfg);
    pendingLink = null;
    if (win && !win.isDestroyed()) win.webContents.send('account:linked');
    return;
  }
}
ipcMain.handle('account:link-join', async (e, code) => {
  if (!account || !friends) return { error: 'не готово' };
  let j; try { j = JSON.parse(Buffer.from(String(code).trim().replace(/^KNT1\./, ''), 'base64url').toString('utf8')); } catch { return { error: 'Код не похож на код Кентовки' }; }
  if (!Array.isArray(j.a) || !j.s) return { error: 'Код не похож на код Кентовки' };
  const crypto = require('crypto');
  for (const ip of j.a) {
    const ws = await friends.dialRaw(ip, j.p);
    if (!ws) continue;
    const res = await new Promise((resolve) => {
      const t = setTimeout(() => resolve({ error: 'Старое устройство не ответило' }), 15000);
      ws.on('message', (raw) => {
        let m; try { m = JSON.parse(raw); } catch { return; }
        if (m.t === 'link-no') { clearTimeout(t); resolve({ error: m.reason || 'Отказано' }); }
        if (m.t === 'link-ok') {
          clearTimeout(t);
          try {
            const d = crypto.createDecipheriv('aes-256-gcm', linkKey(j.s), Buffer.from(m.iv, 'base64')); d.setAuthTag(Buffer.from(m.tag, 'base64'));
            resolve({ bundle: JSON.parse(Buffer.concat([d.update(Buffer.from(m.data, 'base64')), d.final()]).toString('utf8')), from: m.from, port: m.port });
          } catch { resolve({ error: 'Не получилось расшифровать — код неверный' }); }
        }
      });
      ws.send(JSON.stringify({ t: 'link', h: crypto.createHash('sha256').update(j.s).digest('hex'), port: friends.port }));
    });
    try { ws.close(); } catch {}
    if (res.error) return res;
    await applyBundle(res.bundle, { ips: res.from || [ip], port: res.port || j.p, at: Date.now() });
    return { ok: true, name: (res.bundle.config.profile || {}).name };
  }
  return { error: 'Не достучался до старого устройства. Они должны быть в одной локальной сети.' };
});
// с моего второго устройства пришли настройки — берём более свежие
function mergeSyncConfig(cfg) {
  if (!cfg) return;
  const c = loadConfig(); let ch = false;
  if (cfg.profile && (cfg.profileAt || 0) > (c.profileAt || 0)) { c.profile = cfg.profile; c.profileAt = cfg.profileAt; ch = true; }
  if (cfg.theme && (cfg.theme.at || 0) > ((c.theme || {}).at || 0)) { c.theme = cfg.theme; ch = true; }
  if (cfg.voice && (cfg.voice.at || 0) > ((c.voice || {}).at || 0)) { c.voice = cfg.voice; ch = true; }
  const srv = Array.isArray(c.servers) ? c.servers : [];
  for (const x of cfg.servers || []) if (x && x.address && !x.host && !srv.some((y) => y.address === x.address)) { srv.push(x); ch = true; }
  c.servers = srv.slice(0, 30);
  if (ch) saveConfig(c);
}

// ---------- старт ----------
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  trustKentovkaCerts(session.defaultSession);
  setupKvid(session.defaultSession);
  setupKapp(session.defaultSession);
  // «Сохранить на компьютер» из чата — обычный диалог сохранения, по умолчанию в «Загрузки»
  session.defaultSession.on('will-download', (_e, item) => {
    item.setSaveDialogOptions({ title: 'Сохранить файл', defaultPath: path.join(app.getPath('downloads'), item.getFilename()) });
  });
  setupMedia(session.defaultSession);
  try {
    friends = createFriends({
      dataDir: app.getPath('userData'), cert: getCert(path.join(app.getPath('userData'), 'cert')),
      getProfile: () => loadConfig().profile,
      getPresence: () => presenceNow(),
      getAlts: () => myFriendAlts(),
      // мои другие устройства (тот же аккаунт): узнают друг друга по секрету из ключа аккаунта
      sibSecret: () => (account ? account.secret : ''),
      getSiblings: () => loadConfig().siblings || [],
      getSyncConfig: () => { const c = loadConfig(); return { profile: c.profile || null, profileAt: c.profileAt || 0, voice: c.voice || null, hotkeys: c.hotkeys || null, theme: c.theme || null, servers: c.servers || [] }; },
      onSyncConfig: (cfg) => mergeSyncConfig(cfg),
      onLink: (m, send, ws) => onLinkMessage(m, send, ws),
      onChange: friendsChanged,
      onMessage: (m) => {
        if (m.kind === 'dm') { const f = friends && friends.db().friends.find((x) => x.id === m.id); friendNotify(m.name, m.text.slice(0, 140), m.id, f && f.avatar); }
        if (m.kind === 'request') friendNotify('Заявка в друзья', `${m.name} хочет добавить тебя в друзья`);
        if (m.kind === 'accepted') friendNotify('Теперь вы друзья', `${m.name} принял заявку`);
        if (m.kind === 'group') friendNotify('Новая группа', `${m.by || 'Друг'} добавил тебя в «${m.name || 'группу'}»`, m.id);
        if (m.kind === 'gmsg') friendNotify(m.name, m.text, m.id);
      },
      onInvite: (m) => friendNotify(`${m.name} зовёт на сервер`, m.server ? `«${m.server}» — нажми, чтобы открыть` : m.address, m.id),
      onGroupCall: (m) => {
        if (fv()) fv().send('gcall:in', m);
        if (m.k === 'start') {
          const g = friends && (friends.db().groups || {})[m.gid];
          const who = g && (g.members || []).find((x) => x.id === m.from);
          popShow({ id: 'g:' + m.gid, type: 'call', gid: m.gid, name: (g && g.name) || 'Звонок в группе', text: (who ? who.name + ' начал звонок' : 'начался звонок') + ' — присоединишься?', avatar: who && who.avatar }).then((ok) => {
            if (!ok && Notification.isSupported() && !kentovkaInFront()) { const n = new Notification({ title: 'Звонок в группе', body: 'Начался звонок — нажми, чтобы присоединиться', icon: ICON }); n.on('click', () => openFriends(m.gid)); n.show(); }
          });
          setTimeout(() => popHide('g:' + m.gid), 30000);
        }
      },
      onCall: (m) => {
        if (fv()) fv().send('call:in', m);
        if (['end', 'gone', 'busy', 'decline'].includes(m.k)) popHide('c:' + m.id);
        if (m.k === 'ring') {
          // входящий звонок: страница сервера покажет «Принять / Отклонить», а если окно свёрнуто — уведомление
          { const w = tabWC(shellTab); if (w) w.send('call:ring', { id: m.id, name: m.name, avatar: m.avatar }); }
          popShow({ id: 'c:' + m.id, type: 'call', name: m.name, text: 'звонит тебе', avatar: m.avatar, focus: m.id }).then((ok) => {
            if (!ok && Notification.isSupported() && !kentovkaInFront()) { const n = new Notification({ title: 'Звонок', body: `${m.name} звонит тебе`, icon: ICON }); n.on('click', () => openFriends(m.id)); n.show(); }
          });
        }
      },
    });
  } catch (err) { console.error('друзья не запустились', err); }
  try {
    account = createAccount({ dataDir: app.getPath('userData'), documentsDir: process.env.KENTOVKA_DOCS || (process.env.KENTOVKA_USERDATA ? path.join(process.env.KENTOVKA_USERDATA, 'docs') : app.getPath('documents')), getId: () => friends.myId,
      getConfig: loadConfig, setConfig: (c) => saveConfig(c, true), getFriendsDb: () => friends.db(), safeStorage });
    setInterval(() => scheduleAutoSave(0), 24 * 3600 * 1000);
    setTimeout(() => scheduleAutoSave(0), 60 * 1000);
  } catch (err) { console.error('аккаунт не запустился', err); }
  try {
    discovery = createDiscovery({
      getAnnounce: () => {
        const c = loadConfig(); if (c.hideInLan || !friends) return null;
        const servers = [...hostServers.keys()].map((port) => { const sv = (c.servers || []).find((x) => x.host && hostPortOf(x) === port) || {}; return { port, name: sv.name || 'Сервер ' + ((c.profile || {}).name || ''), access: sv.access || c.access || 'open' }; });
        return { id: friends.myId, name: (c.profile || {}).name || '', fport: friends.port, servers };
      },
      onUpdate: () => { if (win && !win.isDestroyed()) win.webContents.send('lan:changed'); if (fv()) fv().send('lan:changed'); },
    });
  } catch (err) { console.error('поиск в сети не запустился', err); }
  createWindow();
  createTray();
  // глобальные горячие клавиши — работают даже из игры; свои сочетания из настроек
  const saved = loadConfig().hotkeys || {};
  for (const a of Object.keys(DEFAULT_HOTKEYS)) if (typeof saved[a] === 'string' && (saved[a] === '' || ACCEL_RE.test(saved[a]))) HOTKEYS[a] = saved[a];
  startHook();
  registerHotkeys();
});

app.on('second-instance', () => { if (win) { win.show(); if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => { try { if (account && autoSaveDirty) account.autoSave(); } catch {} globalShortcut.unregisterAll(); try { if (hookOk) hook.uIOhook.stop(); } catch {} stopSysAudio(); for (const s of hostServers.values()) s.close(); try { if (discovery) discovery.close(); } catch {} if (backupServer) backupServer.close(); if (friends) friends.close(); });
app.on('window-all-closed', () => app.quit());
