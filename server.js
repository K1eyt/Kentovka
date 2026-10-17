// Кентовка — свой мини-дискорд. Голос, демка и файлы идут напрямую между участниками (P2P).
// Сервер только знакомит участников, пересылает текстовый чат и ведёт учёт,
// у кого какие куски файлов. Сами файлы через сервер НЕ идут и у хоста не хранятся.
// Запускается либо из приложения (галочка «я хост»), либо отдельно: node server.js
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const dgram = require('dgram');
const { WebSocketServer } = require('ws');
const selfsigned = require('selfsigned');

const HISTORY_MAX = 300;          // сообщений на канал
const CHANNELS_MAX = 40;
const FILE_MAX = 2 * 1024 * 1024 * 1024;   // 2 ГБ
const CHUNK_MIN = 64 * 1024, CHUNK_MAX = 4 * 1024 * 1024;
const MANIFEST_TTL = 3 * 60 * 60 * 1000;   // учёт файла без раздающих живёт 3 часа
const MIME = { '.gif': 'image/gif', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.wasm': 'application/wasm' };
const PUBLIC = path.join(__dirname, 'public');
// файлы шумодава (RNNoise / GTCRN) раздаём сами — ничего не грузится из интернета
const NS_DIR = path.join(__dirname, 'node_modules', '@sapphi-red', 'web-noise-suppressor', 'dist');
// шумодав DeepFilterNet3 (уровень Krisp): модель зашита в wasm, тоже раздаём сами
const DF_DIR = path.join(__dirname, 'node_modules', '@lofcz', 'deepfilternet-web', 'dist');

// HTTPS-сертификат (браузер даёт микрофон только по https)
function getCert(dir) {
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }
  const pems = selfsigned.generate([{ name: 'commonName', value: 'kentovka' }], {
    days: 3650, keySize: 2048, algorithm: 'sha256',
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);
  return { key: pems.private, cert: pems.cert };
}

function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const net = netKind(name, a.address);
      out.push({ name, address: a.address, net, label: NET_LABEL[net], radmin: net === 'radmin' });
    }
  }
  const order = ['radmin', 'zerotier', 'tailscale', 'hamachi', 'lan', 'other'];
  return out.sort((a, b) => order.indexOf(a.net) - order.indexOf(b.net));
}
// какая это сеть: Radmin, ZeroTier, Tailscale, Hamachi или домашняя
const NET_LABEL = { radmin: 'Локальная сеть', zerotier: 'Локальная сеть', tailscale: 'Локальная сеть', hamachi: 'Локальная сеть', lan: 'Локальная сеть', other: 'Другая сеть' };
function netKind(name, ip) {
  const n = String(name || '');
  if (/radmin/i.test(n) || ip.startsWith('26.')) return 'radmin';
  if (/zerotier|^zt/i.test(n)) return 'zerotier';
  if (/tailscale/i.test(n)) return 'tailscale';
  const [a, b] = ip.split('.').map(Number);
  if (a === 100 && b >= 64 && b <= 127) return 'tailscale';
  if (/hamachi/i.test(n) || a === 25) return 'hamachi';
  if (a === 192 && b === 168) return 'lan';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31)) return /zerotier/i.test(n) ? 'zerotier' : 'lan';
  return 'other';
}

// --- свой STUN-сервер: отвечает кенту его внешним адресом (RFC 5389, Binding) ---
// Нужен для прямого соединения через интернет без локальной сети. Голос через него НЕ идёт.
function startStun(port) {
  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg, r) => {
    if (msg.length < 20 || msg.readUInt16BE(0) !== 0x0001 || msg.readUInt32BE(4) !== 0x2112a442) return;
    const tid = msg.subarray(8, 20);
    const ip = r.address.split('.').map(Number);
    const attr = Buffer.alloc(12);
    attr.writeUInt16BE(0x0020, 0);           // XOR-MAPPED-ADDRESS
    attr.writeUInt16BE(8, 2);
    attr.writeUInt8(0, 4); attr.writeUInt8(0x01, 5); // IPv4
    attr.writeUInt16BE(r.port ^ 0x2112, 6);
    const cookie = [0x21, 0x12, 0xa4, 0x42];
    for (let i = 0; i < 4; i++) attr.writeUInt8(ip[i] ^ cookie[i], 8 + i);
    const head = Buffer.alloc(20);
    head.writeUInt16BE(0x0101, 0);           // Binding Success
    head.writeUInt16BE(attr.length, 2);
    head.writeUInt32BE(0x2112a442, 4);
    tid.copy(head, 8);
    sock.send(Buffer.concat([head, attr]), r.port, r.address);
  });
  return new Promise((resolve) => {
    sock.once('error', (e) => { console.error('STUN не запустился:', e.message); resolve(null); });
    sock.bind(port, '0.0.0.0', () => resolve(sock));
  });
}

// эмодзи для реакций; на телефоне (node без полного ICU) — запасная проверка по диапазонам
let EMOJI_RE; try { EMOJI_RE = new RegExp('^\\p{Extended_Pictographic}', 'u'); } catch { EMOJI_RE = /^(?:[\u00a9\u00ae\u203c-\u3299]|\ud83c[\udc00-\udfff]|\ud83d[\udc00-\udfff]|\ud83e[\udc00-\udfff])/; }
const cleanName = (s) => String(s || 'файл').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'файл';
const snippet = (m) => (m.file ? 'файл ' + m.file.name : String(m.text || '')).slice(0, 90);

// noHost/seed/allow/upstream — временный сервер у кента, когда хост вышел: без прав хоста, с каналами и чатом,
// которые были у кентов, только для тех, кто был на сервере (если вход не «для всех»), и с проверкой, не вернулся ли хост
function startServer({ port = 8443, dataDir = __dirname, direct = null, access = 'open', isFriend = () => false, hostAppId = null,
  noHost = false, seed = null, allow = null, upstream = null, tempFor = null, extraHosts = [] } = {}) {
  // кто может зайти: open — все, у кого есть адрес; approve — хост пускает сам (как зал ожидания в Zoom); friends — только друзья хоста
  if (!['open', 'approve', 'friends'].includes(access)) access = 'open';
  const approved = new Set(); // кого хост уже пустил (до перезапуска сервера)
  // прямое соединение через интернет:
  //   direct = { publicHost: 'белый.ip' }  — свой STUN на этом компе (нужен белый IP и проброс UDP 3478)
  //   direct = { stunUrl: 'stun:хост:порт' } — любой внешний STUN (по нему только узнают свой адрес)
  const stunPort = (direct && Number(direct.stunPort)) || 3478;
  const publicHost = direct && String(direct.publicHost || '').trim().replace(/^stun:/, '').replace(/:\d+$/, '');
  // можно несколько через запятую — браузер спросит все и возьмёт ответ любого
  const stunUrls = String((direct && direct.stunUrl) || '').split(/[\s,;]+/).filter(Boolean).slice(0, 5)
    .map((u) => (/^stuns?:/.test(u) ? u : 'stun:' + u));
  let ice = publicHost ? { stun: `stun:${publicHost}:${stunPort}` } : stunUrls.length ? { stun: stunUrls } : null;
  let stunSock = null;
  if (publicHost) startStun(stunPort).then((s) => { stunSock = s; });
  if (seed && seed.ice) ice = seed.ice;
  // мосты на VPS: их адреса раздаём кентам (запасной путь), а TURN на них — для голоса, если напрямую не выходит
  let bridges = []; // [{ addr: 'ip:порт', turn: { host, port, secret } | null }]
  function iceFor(me) {
    const turns = bridges.filter((b) => b.turn && b.turn.secret && b.turn.port);
    if (!turns.length) return ice;
    const stun = [].concat((ice && ice.stun) || []);
    const turn = turns.map((b) => {
      const username = `${Math.floor(Date.now() / 1000) + 24 * 3600}:${String(me.name || 'k').replace(/[^\w-]/g, '').slice(0, 16) || 'k'}`;
      const credential = crypto.createHmac('sha1', b.turn.secret).update(username).digest('base64');
      stun.push(`stun:${b.turn.host}:${b.turn.port}`);
      return { urls: [`turn:${b.turn.host}:${b.turn.port}?transport=udp`, `turn:${b.turn.host}:${b.turn.port}?transport=tcp`], username, credential };
    });
    return { stun, turn };
  }
  const altsFor = () => [...lanAddresses().map((a) => ({ addr: a.address + ':' + port, net: a.net, label: a.label })), ...bridges.map((b) => ({ addr: b.addr, net: 'bridge', label: 'Мост ' + b.addr.split(':')[0], own: !!b.own }))];
  // --- история чата. Файлы в ней — только название, размер и хэши кусков; сами данные у хоста не хранятся,
  //     их раздают те, у кого они в кеше ---
  const historyFile = path.join(dataDir, 'chat-history.json');
  // аватарки: ник -> маленькая картинка (data:image/webp;base64,…, до ~60 КБ)
  const avatarFile = path.join(dataDir, 'avatars.json');
  let avatars = {};
  try { avatars = JSON.parse(fs.readFileSync(avatarFile, 'utf8')) || {}; } catch {}
  let avatarTimer = null;
  const saveAvatars = () => { clearTimeout(avatarTimer); avatarTimer = setTimeout(() => fs.writeFile(avatarFile, JSON.stringify(avatars), () => {}), 1000); };
  const AVATAR_MAX = 60 * 1024;
  // профили: «о себе» и цвет шапки мини-профиля (ник -> { bio, color })
  const profileFile = path.join(dataDir, 'profiles.json');
  let profiles = {};
  try { profiles = JSON.parse(fs.readFileSync(profileFile, 'utf8')) || {}; } catch {}
  let profileTimer = null;
  const saveProfiles = () => { clearTimeout(profileTimer); profileTimer = setTimeout(() => fs.writeFile(profileFile, JSON.stringify(profiles), () => {}), 1000); };
  const cleanBio = (t) => String(t || '').replace(/[\u0000-\u0009\u000b-\u001f]/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 190);
  const cleanColor = (c) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : null);
  // картинка/гифка в шапке мини-профиля: лежит файлом у хоста (до 1.5 МБ), раздаётся по /banner/…
  const bannerDir = path.join(dataDir, 'banners');
  const BANNER_MAX = 1.5 * 1024 * 1024;
  function dropUnusedBanners() {
    const used = new Set(Object.values(profiles).map((p) => p && p.banner).filter(Boolean).map((b) => path.basename(b)));
    fs.readdir(bannerDir, (err, list) => { if (!err) for (const f of list) if (!used.has(f)) fs.unlink(path.join(bannerDir, f), () => {}); });
  }
  const setProfile = (name, m) => {
    const p = profiles[name] || {};
    if ('bio' in m) p.bio = cleanBio(m.bio);
    if ('color' in m) p.color = cleanColor(m.color);
    if ('color2' in m) p.color2 = cleanColor(m.color2);
    if ('banner' in m && m.banner === null) { delete p.banner; setTimeout(dropUnusedBanners, 500); }
    profiles[name] = p; saveProfiles();
    broadcast({ type: 'profile-info', name, info: p });
  };
  // ---------- аккаунты: id приложения подтверждается подписью ключом; ник принадлежит аккаунту ----------
  const accFile = path.join(dataDir, 'accounts.json');
  let accounts = { keys: {}, names: {} }; // keys: appId -> публичный ключ; names: ник (в нижнем регистре) -> appId
  try { accounts = Object.assign(accounts, JSON.parse(fs.readFileSync(accFile, 'utf8'))); } catch {}
  let accT = null;
  const saveAccounts = () => { clearTimeout(accT); accT = setTimeout(() => fs.writeFile(accFile, JSON.stringify(accounts), () => {}), 500); };
  const myHosts = () => {
    const out = new Set(['localhost:' + port, '127.0.0.1:' + port, '[::1]:' + port]);
    for (const a of lanAddresses()) out.add(a.address + ':' + port);
    for (const h of extraHosts || []) out.add(String(h));
    for (const b of bridges) out.add(String(b.addr)); // зашли через мост — подпись выдана на адрес моста
    return out;
  };
  function verifyAccount(m, nonce) {
    const id = /^[0-9a-f]{32}$/.test(m.appId || '') ? m.appId : null;
    if (!id || !m.pub || !m.sig || !m.host || !nonce) return null;
    if (!myHosts().has(String(m.host))) return null; // подпись выдана для другого сервера — не наша
    try {
      const key = crypto.createPublicKey({ key: Buffer.from(String(m.pub), 'base64'), format: 'der', type: 'spki' });
      if (!crypto.verify(null, Buffer.from(`kentovka:${nonce}:${id}:${m.host}`), key, Buffer.from(String(m.sig), 'base64'))) return null;
    } catch { return null; }
    if (accounts.keys[id] && accounts.keys[id] !== m.pub) return null; // этот id уже закреплён за другим ключом
    if (!accounts.keys[id]) { accounts.keys[id] = String(m.pub); saveAccounts(); }
    return id;
  }
  const nameOwner = (n) => accounts.names[String(n).toLowerCase()] || null;
  function claimName(n, id, old) {
    if (!id) return;
    if (old && accounts.names[String(old).toLowerCase()] === id) delete accounts.names[String(old).toLowerCase()];
    accounts.names[String(n).toLowerCase()] = id; saveAccounts();
  }
  const cleanAvatar = (a) => (typeof a === 'string' && a.length <= AVATAR_MAX && /^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(a) ? a : null);
  // --- каналы: текстовые и голосовые. У каждого голосового — свой чат (как в Discord) ---
  const channelFile = path.join(dataDir, 'channels.json');
  let channels = null;
  try { channels = JSON.parse(fs.readFileSync(channelFile, 'utf8')); } catch {}
  if (!Array.isArray(channels) || !channels.length) channels = [
    { id: 'general', type: 'text', name: 'общий' },
    { id: 'voice', type: 'voice', name: 'Общий' },
  ];
  const saveChannels = () => fs.writeFile(channelFile, JSON.stringify(channels), () => {});
  const chanOk = (ch) => channels.some((c) => c.id === ch);
  const cleanChanName = (s, type) => {
    let n = String(s || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 32);
    if (type === 'text') n = n.toLowerCase().replace(/\s+/g, '-');
    return n;
  };
  let history = [];
  try { history = JSON.parse(fs.readFileSync(historyFile, 'utf8')); } catch {}
  if (seed) {
    // временный сервер: начинаем с того, что видели кенты
    if (Array.isArray(seed.channels) && seed.channels.length) channels = seed.channels.filter((c) => c && typeof c.id === 'string' && (c.type === 'text' || c.type === 'voice')).slice(0, 60);
    if (Array.isArray(seed.history)) history = seed.history.filter((h) => h && typeof h === 'object').slice(-3000);
    if (seed.avatars && typeof seed.avatars === 'object') for (const [k, v] of Object.entries(seed.avatars)) { const a = cleanAvatar(v); if (a) avatars[k] = a; }
    if (seed.profiles && typeof seed.profiles === 'object') Object.assign(profiles, seed.profiles);
  }
  for (const m of history) if (!m.ch) m.ch = 'general'; // старая история — в «общий»
  let nextMsgId = 1;
  for (const m of history) { if (!m.mid) m.mid = nextMsgId; nextMsgId = Math.max(nextMsgId, m.mid + 1); }
  let saveTimer = null;
  const saveHistory = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      fs.writeFile(historyFile, JSON.stringify(history), () => {});
      // учёт файлов из истории (без раздающих) — чтобы после перезапуска сервера их снова можно было качать
      const keep = {};
      for (const h of history) if (h.file) for (const fid of [h.file.id, ...(h.file.variants || []).map((v) => v.id)]) if (manifests.has(fid)) { const mf = manifests.get(fid); keep[fid] = { meta: mf.meta, hashes: mf.hashes }; }
      fs.writeFile(manifestFile, JSON.stringify(keep), () => {});
    }, 1000);
  };
  const inHistory = (fid) => history.some((h) => h.file && (h.file.id === fid || (h.file.variants || []).some((v) => v.id === fid)));
  const pushMsg = (msg) => {
    msg.mid = nextMsgId++;
    history.push(msg);
    // в каждом канале храним последние HISTORY_MAX сообщений
    const inCh = history.filter((h) => h.ch === msg.ch);
    if (inCh.length > HISTORY_MAX) { const drop = inCh[0]; history.splice(history.indexOf(drop), 1); }
    saveHistory();
    return msg;
  };

  // --- учёт файлов: у кого какие куски (сами данные сюда не попадают) ---
  const manifests = new Map(); // id -> { meta, hashes, n, holders: Map<clientId, 'all' | Set<idx>>, emptySince }
  const manifestFile = path.join(dataDir, 'files.json');
  try {
    const saved = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) || {};
    for (const [fid, v] of Object.entries(saved)) {
      if (!v || !v.meta || !Array.isArray(v.hashes)) continue;
      manifests.set(fid, { meta: v.meta, hashes: v.hashes, n: v.hashes.length, holders: new Map(), emptySince: Date.now() });
    }
  } catch {}
  // в истории остались сообщения с файлами, про которые сервер забыл (старая версия) — убираем их
  history = history.filter((h) => !h.file || manifests.has(h.file.id));

  // --- статика ---
  const server = https.createServer(getCert(path.join(dataDir, 'cert')), (req, res) => {
    let url;
    try { url = decodeURIComponent((req.url || '/').split('?')[0]); } catch { res.writeHead(400); return res.end(); }
    if (url === '/') url = '/index.html';
    // временный сервер: кенты проверяют, для какого сервера он поднят (хоста нет в сети)
    if (url === '/__temp') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }); return res.end(JSON.stringify({ for: tempFor, temp: !!noHost, clients: [...clients.values()].filter((c) => c.admitted).length })); }
    let base = PUBLIC, longCache = false;
    if (url.startsWith('/ns/')) { base = NS_DIR; url = url.slice(3); longCache = true; }
    else if (url.startsWith('/banner/')) { base = path.join(dataDir, 'banners'); url = url.slice(7); longCache = true; }
    else if (url.startsWith('/df/')) { base = DF_DIR; url = url.slice(3); longCache = true; }
    const file = path.normalize(path.join(base, url));
    if (!file.startsWith(base)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      // шумодавы не меняются — пусть клиенты кешируют, а не тянут 34 МБ при каждом запуске
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': longCache ? 'public, max-age=2592000, immutable' : 'no-cache' });
      res.end(data);
    });
  });

  // --- сигналинг, чат, учёт файлов ---
  const wss = new WebSocketServer({ server, maxPayload: 2.5 * 1024 * 1024 });
  const clients = new Map(); // id -> { ws, name, voice (id голосового канала или null), muted, deaf, sharing }
  let nextId = 1;
  const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
  const broadcast = (msg, exceptId) => { for (const [id, c] of clients) if (id !== exceptId) send(c.ws, msg); };
  const userList = () => [...clients].filter(([, c]) => c.name && c.admitted).map(([id, c]) => ({
    ip: c.ip, appId: c.appId || null, host: !!c.isHost, since: c.since,
    id, name: c.name, inVoice: !!c.voice, voice: c.voice || null, muted: c.muted, deaf: c.deaf, sharing: !!c.voice && c.sharing, idle: !!c.idle,
  }));
  // последние сообщения каждого канала — для нового участника
  const recentHistory = () => { const out = []; for (const c of channels) out.push(...history.filter((h) => h.ch === c.id).slice(-100)); return out.sort((a, b) => a.mid - b.mid); };
  const pushUsers = () => broadcast({ type: 'users', users: userList() });

  function registerFile(ownerId, meta, hashes) {
    const size = Number(meta && meta.size);
    const chunkSize = Number(meta && meta.chunkSize);
    if (!meta || !/^[0-9a-f]{24}$/.test(meta.id)) return 'плохой id';
    if (!(size > 0 && size <= FILE_MAX)) return 'файл больше 2 ГБ';
    if (!(chunkSize >= CHUNK_MIN && chunkSize <= CHUNK_MAX)) return 'плохой размер куска';
    const n = Math.ceil(size / chunkSize);
    if (!Array.isArray(hashes) || hashes.length !== n || !hashes.every((h) => typeof h === 'string' && h.length === 44)) return 'плохие хэши';
    let m = manifests.get(meta.id);
    if (m && JSON.stringify(m.hashes) !== JSON.stringify(hashes)) return 'id занят';
    const clean = { id: meta.id, name: cleanName(meta.name), size, chunkSize, mime: String(meta.mime || '').slice(0, 80) };
    if (!m) { m = { meta: clean, hashes, n, holders: new Map(), emptySince: 0 }; manifests.set(meta.id, m); }
    m.holders.set(ownerId, 'all');
    m.emptySince = 0;
    return m;
  }

  function dropHolder(clientId, fileId) {
    const list = fileId ? [manifests.get(fileId)].filter(Boolean) : manifests.values();
    for (const m of list) {
      if (m.holders.delete(clientId) && !m.holders.size) m.emptySince = Date.now();
    }
  }

  wss.on('connection', (ws, req) => {
    const id = nextId++;
    // хост — тот, кто зашёл с этого же компа: ему можно удалять любые сообщения у всех
    const ra = String((req && req.socket && req.socket.remoteAddress) || '');
    let isHost = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
    if (process.env.KENTOVKA_TEST_HOST || noHost) isHost = false; // для тестов: хост определяется по нику (ниже)
    const nonce = crypto.randomBytes(16).toString('hex');
    send(ws, { type: 'challenge', nonce, v: 1 });
    const me = { since: Date.now(), ws, name: null, voice: null, muted: false, deaf: false, sharing: false, isHost, admitted: isHost, ip: ra.replace(/^::ffff:/, '') };
    clients.set(id, me);
    // впускаем: приветствие, история, список участников
    me.admit = () => {
      const first = !me.welcomed; me.welcomed = true;
      const av = me.helloAvatar;
      if (av && avatars[me.name] !== av) { avatars[me.name] = av; saveAvatars(); broadcast({ type: 'avatar', name: me.name, avatar: av }, id); }
      if (me.helloProfile && ('bio' in me.helloProfile)) {
        const p = profiles[me.name] || {};
        const nb = cleanBio(me.helloProfile.bio), nc = cleanColor(me.helloProfile.color), nc2 = cleanColor(me.helloProfile.color2);
        if (p.bio !== nb || p.color !== nc || p.color2 !== nc2) { profiles[me.name] = { bio: nb, color: nc, color2: nc2 }; saveProfiles(); broadcast({ type: 'profile-info', name: me.name, info: profiles[me.name] }, id); }
      }
      send(ws, { type: 'welcome', id, history: recentHistory(), channels, ice: iceFor(me), alts: altsFor(), avatars, profiles, isHost: me.isHost, access: me.isHost ? access : undefined, mode: access, temp: !!noHost });
      // хосту — кто сейчас ждёт у двери
      if (me.isHost) for (const [kid, c] of clients) if (c.waiting) send(ws, { type: 'knock', kid, name: c.name, avatar: c.helloAvatar });
      pushUsers();
      if (first) broadcast({ type: 'event', ev: 'online', name: me.name }, id);
    };
    const admit = me.admit;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        if (!me.admitted) return;
        // кусок файла транзитом (когда напрямую кенты не соединились): только пересылаем, не храним
        if (raw.length < 8) return;
        const target = clients.get(raw.readUInt32BE(0));
        if (!target || target.ws.readyState !== 1) return;
        raw.writeUInt32BE(id, 0);
        target.ws.send(raw, { binary: true });
        return;
      }
      let m; try { m = JSON.parse(raw); } catch { return; }
      const reply = (obj) => send(ws, { type: 'swarm-reply', rid: m.rid, ...obj });
      // пока хост не пустил — ничего, кроме знакомства
      if (!me.admitted && m.type !== 'hello' && m.type !== 'ping') return;
      switch (m.type) {
        case 'hello': {
          me.name = String(m.name || 'кент').trim().slice(0, 24) || 'кент';
          // id приложения засчитываем, только если подписан ключом аккаунта (иначе — как гость из браузера)
          me.appId = verifyAccount(m, nonce);
          if (m.appId && !me.appId) send(ws, { type: 'notice', text: 'Не получилось подтвердить твой аккаунт на этом сервере — заходишь как гость.' });
          {
            const owner = nameOwner(me.name);
            if (owner && owner !== me.appId) {
              send(ws, { type: 'denied', reason: `Ник «${me.name}» на этом сервере принадлежит другому аккаунту. Смени ник в профиле (или зайди со своего аккаунта).` });
              setTimeout(() => ws.close(), 300); return;
            }
            if (me.appId && !owner) claimName(me.name, me.appId);
          }
          me.helloAvatar = cleanAvatar(m.avatar);
          me.helloProfile = { bio: m.bio, color: m.color, color2: m.color2 };
          if (process.env.KENTOVKA_TEST_HOST && !noHost) { me.isHost = me.name === process.env.KENTOVKA_TEST_HOST; if (me.isHost) me.admitted = true; }
          if (me.appId && hostAppId && me.appId === hostAppId) { me.isHost = true; me.admitted = true; }
          if (!me.admitted && noHost) {
            // временный сервер: хоста нет, пускать некому — заходят те, кто был на сервере (или все, если вход был открыт)
            if (access === 'open' || (allow && me.appId && allow.includes(me.appId))) me.admitted = true;
            else { send(ws, { type: 'denied', reason: 'Хост вышел, сервер сейчас временный — новых не пускаем. Зайди, когда хост вернётся.' }); setTimeout(() => ws.close(), 300); return; }
          }
          if (!me.admitted) {
            const key = me.appId || `${me.name}@${me.ip}`;
            const friend = me.appId && isFriend(me.appId);
            if (access === 'open' || friend || approved.has(key)) me.admitted = true;
            else if (access === 'friends') {
              send(ws, { type: 'denied', reason: 'Этот сервер только для друзей хоста. Попроси хоста добавить тебя в друзья — по твоему адресу в локальной сети.' });
              setTimeout(() => ws.close(), 300); return;
            } else {
              me.waiting = true; me.knockKey = key;
              send(ws, { type: 'waiting' });
              for (const [, c] of clients) if (c.isHost && c.admitted) send(c.ws, { type: 'knock', kid: id, name: me.name, avatar: me.helloAvatar });
              return;
            }
          }
          admit();
          break;
        }
        case 'knock-answer': { // хост решил, пускать ли
          if (!me.isHost) return;
          const t = clients.get(Number(m.kid));
          if (!t || !t.waiting) return;
          t.waiting = false;
          for (const [, c] of clients) if (c.isHost && c.admitted && c !== me) send(c.ws, { type: 'knock-done', kid: Number(m.kid) });
          if (m.yes) { approved.add(t.knockKey); t.admitted = true; t.admit(); }
          else { send(t.ws, { type: 'denied', reason: 'Хост не пустил на сервер.' }); setTimeout(() => t.ws.close(), 300); }
          break;
        }
        case 'banner': { // своя картинка или гифка в шапку мини-профиля
          if (!me.name) return;
          const mm = /^data:image\/(gif|png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(m.data || ''));
          if (!mm) return send(ws, { type: 'notice', text: 'Подходят картинки и гифки (gif, png, jpg, webp).' });
          const buf = Buffer.from(mm[2], 'base64');
          if (buf.length > BANNER_MAX) return send(ws, { type: 'notice', text: 'Картинка для шапки — до 1.5 МБ.' });
          const fname = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20) + '.' + (mm[1] === 'jpeg' ? 'jpg' : mm[1]);
          fs.mkdirSync(bannerDir, { recursive: true });
          fs.writeFile(path.join(bannerDir, fname), buf, (err) => {
            if (err) return send(ws, { type: 'notice', text: 'Не получилось сохранить картинку.' });
            const p = profiles[me.name] || {};
            p.banner = '/banner/' + fname; profiles[me.name] = p; saveProfiles();
            broadcast({ type: 'profile-info', name: me.name, info: p });
            setTimeout(dropUnusedBanners, 500);
          });
          break;
        }
        case 'set-access': // хост меняет, кто может заходить
          if (!me.isHost || !['open', 'approve', 'friends'].includes(m.access)) return;
          access = m.access;
          for (const [, c] of clients) if (c.isHost) send(c.ws, { type: 'access', access });
          break;
        case 'profile': {
          // смена ника и/или аватарки
          if (!me.name) return;
          const newName = String(m.name || '').trim().slice(0, 24);
          if (newName && newName !== me.name) {
            // ник занят кем-то, кто сейчас в сети — не даём (иначе сообщения двух людей склеятся)
            const owner = nameOwner(newName);
            if ((owner && owner !== me.appId) || [...clients.values()].some((c) => c !== me && c.admitted && c.name === newName)) {
              send(ws, { type: 'notice', text: owner && owner !== me.appId ? `Ник «${newName}» на этом сервере принадлежит другому аккаунту.` : `Ник «${newName}» уже занят — кто-то с ним сейчас в сети.` });
              send(ws, { type: 'rename-denied', name: me.name });
              return;
            }
            const old = me.name; me.name = newName;
            if (me.appId) claimName(newName, me.appId, old);
            if (avatars[old] && !avatars[newName]) { avatars[newName] = avatars[old]; delete avatars[old]; saveAvatars(); }
            if (profiles[old]) { profiles[newName] = profiles[old]; delete profiles[old]; saveProfiles(); }
            // старые сообщения — под новым ником
            for (const h of history) {
              if (h.from === old) h.from = newName; if (h.reply && h.reply.from === old) h.reply.from = newName;
              if (h.reactions) for (const k of Object.keys(h.reactions)) h.reactions[k] = h.reactions[k].map((n) => (n === old ? newName : n));
            }
            for (const c of channels) if (c.by === old) c.by = newName;
            saveHistory(); saveChannels();
            broadcast({ type: 'event', ev: 'rename', from: old, name: newName });
          }
          if ('bio' in m || 'color' in m || 'color2' in m || 'banner' in m) setProfile(me.name, m);
          if ('avatar' in m) {
            const av = m.avatar === null ? null : cleanAvatar(m.avatar);
            if (av) avatars[me.name] = av; else delete avatars[me.name];
            saveAvatars();
            broadcast({ type: 'avatar', name: me.name, avatar: av });
          } else if (avatars[me.name]) broadcast({ type: 'avatar', name: me.name, avatar: avatars[me.name] });
          pushUsers();
          break;
        }
        case 'delete': { // удалить сообщение у всех: своё — любой, чужое — только хост
          if (!me.name) return;
          const i = history.findIndex((h) => h.mid === m.mid);
          if (i < 0) return send(ws, { type: 'delete', mid: m.mid }); // уже удалено
          const h = history[i];
          if (h.from !== me.name && !me.isHost) return send(ws, { type: 'notice', text: 'Чужие сообщения у всех может удалять только хост.' });
          history.splice(i, 1);
          saveHistory();
          broadcast({ type: 'delete', mid: h.mid, file: h.file ? h.file.id : null, by: me.name });
          break;
        }
        case 'react': { // реакция на сообщение: нажал ещё раз — убрал
          if (!me.name) return;
          const h = history.find((x) => x.mid === m.mid);
          const e = String(m.emoji || '');
          if (!h || !e || e.length > 16 || !EMOJI_RE.test(e)) return;
          h.reactions = h.reactions || {};
          const list = h.reactions[e] || [];
          const i = list.indexOf(me.name);
          if (i >= 0) list.splice(i, 1);
          else { if (!h.reactions[e] && Object.keys(h.reactions).length >= 20) return; list.push(me.name); }
          if (list.length) h.reactions[e] = list; else delete h.reactions[e];
          if (!Object.keys(h.reactions).length) delete h.reactions;
          saveHistory();
          broadcast({ type: 'reactions', mid: h.mid, reactions: h.reactions || {} });
          break;
        }
        case 'chat': {
          const text = String(m.text || '').slice(0, 2000).trim();
          if (!text || !me.name) return;
          const ch = chanOk(m.ch) ? m.ch : 'general';
          const msg = { type: 'chat', ch, from: me.name, fromId: id, text, ts: Date.now() };
          if (noHost) msg.offline = true; // написано, пока хоста не было — вернётся к хосту, когда он придёт
          const orig = m.replyTo && history.find((h) => h.mid === m.replyTo);
          if (orig) msg.reply = { mid: orig.mid, from: orig.from, text: snippet(orig) };
          broadcast(pushMsg(msg));
          break;
        }
        case 'import': { // хост вернулся: кенты приносят то, что писали без него (на временном сервере)
          if (!me.name || noHost || !Array.isArray(m.msgs)) return;
          const now = Date.now(); let added = 0;
          for (const x of m.msgs.slice(0, 300)) {
            if (!x || typeof x.text !== 'string') continue;
            const text = x.text.slice(0, 2000).trim(), from = String(x.from || '').slice(0, 24).trim(), ts = Number(x.ts);
            if (!text || !from || !(ts > now - 7 * 864e5 && ts <= now + 60000)) continue;
            if (history.some((h) => h.ts === ts && h.from === from && h.text === text)) continue; // уже принёс кто-то другой
            const ch = chanOk(x.ch) ? x.ch : 'general';
            broadcast(pushMsg({ type: 'chat', ch, from, fromId: null, text, ts, imported: true }));
            if (++added >= 300) break;
          }
          break;
        }
        case 'file-offer': {
          if (!me.name) return;
          const r = registerFile(id, m.file, m.hashes);
          if (typeof r === 'string') return reply({ error: r });
          if (m.variantOf) {
            // лёгкая версия видео (720p/480p), которую сделал отправитель, — прикрепляем к его сообщению, без нового сообщения
            const h = history.find((x) => x.file && x.file.id === m.variantOf && x.from === me.name);
            const height = Math.round(Number(m.height));
            if (!h || !(height >= 144 && height <= 2160)) return reply({ error: 'нет такого видео' });
            h.file.variants = (h.file.variants || []).filter((v) => v.height !== height).concat({ ...r.meta, height }).sort((a, b) => b.height - a.height).slice(0, 4);
            saveHistory();
            reply({ ok: true });
            broadcast({ type: 'variants', fid: h.file.id, mid: h.mid, variants: h.file.variants });
            break;
          }
          const caption = String(m.text || '').slice(0, 2000).trim();
          const ch = chanOk(m.ch) ? m.ch : 'general';
          const msg = { type: 'chat', ch, from: me.name, fromId: id, text: caption, file: { ...r.meta }, ts: Date.now() };
          const orig = m.replyTo && history.find((h) => h.mid === m.replyTo);
          if (orig) msg.reply = { mid: orig.mid, from: orig.from, text: snippet(orig) };
          reply({ ok: true });
          broadcast(pushMsg(msg));
          break;
        }
        case 'file-reoffer': // после переподключения отправитель снова раздаёт свой файл
          if (manifests.has(m.id)) registerFile(id, m.file, m.hashes);
          break;
        case 'manifest': {
          const f = manifests.get(m.id);
          reply(f ? { hashes: f.hashes } : { error: 'gone' });
          break;
        }
        case 'holders': {
          const f = manifests.get(m.id);
          const holders = {};
          if (f) for (const [cid, h] of f.holders) holders[cid] = h === 'all' ? 'all' : [...h];
          reply({ holders });
          break;
        }
        case 'have': {
          const f = manifests.get(m.id);
          if (!f) return;
          if (m.all) { f.holders.set(id, 'all'); f.emptySince = 0; return; }
          const i = Number(m.i);
          if (!Number.isInteger(i) || i < 0 || i >= f.n) return;
          let h = f.holders.get(id);
          if (h === 'all') return;
          if (!h) { h = new Set(); f.holders.set(id, h); f.emptySince = 0; }
          h.add(i);
          if (h.size === f.n) f.holders.set(id, 'all');
          break;
        }
        case 'drop': dropHolder(id, m.id); break;
        case 'join-voice': {
          const ch = channels.some((c) => c.id === m.ch && c.type === 'voice') ? m.ch : (channels.find((c) => c.type === 'voice') || {}).id;
          if (!ch) return;
          if (me.voice && me.voice !== ch) { me.sharing = false; broadcast({ type: 'peer-left', id }, id); }
          me.voice = ch;
          // новичок сам звонит всем, кто уже в этом голосовом канале
          send(ws, { type: 'voice-peers', ch, peers: userList().filter((u) => u.voice === ch && u.id !== id).map((u) => u.id) });
          pushUsers();
          break;
        }
        case 'leave-voice':
          me.voice = null; me.sharing = false;
          broadcast({ type: 'peer-left', id }, id);
          pushUsers();
          break;
        // --- каналы: создать может любой, переименовать и удалить — создатель или хост ---
        case 'channel-create': {
          if (!me.name || channels.length >= CHANNELS_MAX) return;
          const type = m.kind === 'voice' ? 'voice' : 'text';
          const name = cleanChanName(m.name, type);
          if (!name) return;
          const c = { id: crypto.randomBytes(6).toString('hex'), type, name, by: me.name };
          channels.push(c); saveChannels();
          broadcast({ type: 'channels', channels, created: c.id, by: me.name });
          break;
        }
        case 'channel-rename': {
          const c = channels.find((x) => x.id === m.id);
          if (!c || !me.name) return;
          if (c.by !== me.name && !me.isHost) return send(ws, { type: 'notice', text: 'Переименовать канал может тот, кто его создал, или хост.' });
          const name = cleanChanName(m.name, c.type);
          if (!name) return;
          c.name = name; saveChannels();
          broadcast({ type: 'channels', channels });
          break;
        }
        case 'channel-delete': {
          const c = channels.find((x) => x.id === m.id);
          if (!c || !me.name) return;
          if (c.by !== me.name && !me.isHost) return send(ws, { type: 'notice', text: 'Удалить канал может тот, кто его создал, или хост.' });
          if (channels.filter((x) => x.type === c.type).length <= 1) return send(ws, { type: 'notice', text: c.type === 'voice' ? 'Последний голосовой канал удалить нельзя.' : 'Последний текстовый канал удалить нельзя.' });
          channels = channels.filter((x) => x !== c); saveChannels();
          history = history.filter((h) => h.ch !== c.id); saveHistory();
          // кто сидел в удалённом голосовом — выходят
          for (const [cid, cl] of clients) if (cl.voice === c.id) { cl.voice = null; cl.sharing = false; broadcast({ type: 'peer-left', id: cid }, cid); send(cl.ws, { type: 'kicked-voice' }); }
          broadcast({ type: 'channels', channels, deleted: c.id });
          pushUsers();
          break;
        }
        case 'state':
          me.muted = !!m.muted; me.deaf = !!m.deaf; me.sharing = !!m.sharing;
          pushUsers();
          break;
        case 'idle': // «неактивен» — давно не трогал комп
          if (me.idle !== !!m.on) { me.idle = !!m.on; pushUsers(); }
          break;
        case 'signal':
        case 'dsignal': {
          const target = clients.get(m.to);
          if (target) send(target.ws, { type: m.type, from: id, data: m.data });
          break;
        }
        case 'relay-req': {
          const target = clients.get(m.to);
          if (target) send(target.ws, { type: 'relay-req', from: id, f: String(m.f), i: Number(m.i), rid: Number(m.rid) >>> 0 });
          break;
        }
        case 'ping': send(ws, { type: 'pong', t: m.t }); break;
      }
    });

    ws.on('close', () => {
      clients.delete(id);
      if (me.waiting) for (const [, c] of clients) if (c.isHost) send(c.ws, { type: 'knock-done', kid: id });
      dropHolder(id);
      if (me.voice) broadcast({ type: 'peer-left', id });
      broadcast({ type: 'dpeer-left', id });
      pushUsers();
    });
  });

  // выкидываем зависшие соединения, забываем файлы, которые никто не раздаёт
  const reaper = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false; ws.ping();
    }
    const now = Date.now();
    // файл из истории чата помним, пока сообщение в истории; остальные — пока кто-то раздаёт (+3 часа)
    for (const [fid, f] of manifests) if (f.emptySince && now - f.emptySince > MANIFEST_TTL && !inHistory(fid)) manifests.delete(fid);
  }, 15000);

  // временный сервер: проверяем, не вернулся ли хост, — тогда все переходят обратно к нему
  let upTimer = null;
  if (upstream) {
    const probe = () => {
      const req = https.get(`https://${upstream}/`, { rejectUnauthorized: false, timeout: 3000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) { clearInterval(upTimer); upTimer = null; broadcast({ type: 'host-back', address: upstream }); }
      });
      req.on('error', () => {}); req.on('timeout', () => req.destroy());
    };
    upTimer = setInterval(probe, 5000);
  }
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      resolve({
        port,
        clients: () => [...clients.values()].filter((c) => c.admitted && c.ws.readyState === 1).length,
        setBridges: (list) => {
          bridges = (Array.isArray(list) ? list : []).filter((b) => b && b.addr).slice(0, 6);
          for (const c of clients.values()) if (c.admitted && c.ws.readyState === 1) send(c.ws, { type: 'alts', alts: altsFor(), ice: iceFor(c) });
        },
        setAccess: (a) => { if (['open', 'approve', 'friends'].includes(a)) access = a; },
        addresses: lanAddresses(),
        close: () => new Promise((r) => {
          clearInterval(reaper); clearInterval(upTimer);
          clearTimeout(avatarTimer); clearTimeout(profileTimer); clearTimeout(accT);
          try { fs.writeFileSync(accFile, JSON.stringify(accounts)); } catch {}
          try { fs.writeFileSync(profileFile, JSON.stringify(profiles)); } catch {}
          try { fs.writeFileSync(avatarFile, JSON.stringify(avatars)); } catch {}
          if (stunSock) try { stunSock.close(); } catch {}
          for (const ws of wss.clients) ws.terminate();
          wss.close(); server.close(() => r());
        }),
      });
    });
  });
}

module.exports = { startServer, lanAddresses, getCert };

if (require.main === module) {
  const port = Number(process.env.PORT) || 8443;
  // прямое соединение: set PUBLIC_HOST=твой.внешний.ip (и пробрось UDP 3478)
  // прямое соединение включено по умолчанию (российские публичные STUN); NO_DIRECT=1 — выключить
  const direct = process.env.NO_DIRECT ? null
    : process.env.PUBLIC_HOST ? { publicHost: process.env.PUBLIC_HOST }
    : { stunUrl: process.env.STUN_URL || 'stun:stun.sipnet.ru:3478, stun:stun.fitauto.ru:3478' };
  startServer({ port, direct }).then(({ addresses }) => {
    console.log('\n  Кентовка запущена!\n');
    for (const a of addresses) {
      console.log(`  https://${a.address}:${port}   (${a.name})${a.radmin ? '   <-- локальная сеть, кидай кентам эту' : ''}`);
    }
    console.log(`  https://localhost:${port}   (для себя)\n`);
  }).catch((e) => {
    console.error(e.code === 'EADDRINUSE' ? `Порт ${port} уже занят — Кентовка уже запущена?` : e);
    process.exit(1);
  });
}
