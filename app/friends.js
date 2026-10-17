// Друзья и личные сообщения. Работает в главном процессе приложения, без хоста и без серверов в интернете:
// каждая Кентовка слушает порт 8444, друзья соединяются друг с другом напрямую по адресам в локальной сети.
// Заявка в друзья → друг принимает → вы обмениваетесь ключом; дальше личка ходит только между вами.
// Не доставленные сообщения ждут и уходят, как только друг появится в сети.
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.KENTOVKA_FRIEND_PORT) || 8444;
const DM_MAX = 500;
const rid = () => crypto.randomBytes(8).toString('hex');
const cleanIp = (a) => String(a || '').replace(/^::ffff:/, '');
const short = (s, n) => String(s || '').slice(0, n);

function createFriends({ dataDir, cert, getProfile, getPresence, getAlts, onChange, onMessage, onInvite, onCall, onGroupCall, onLink, sibSecret, getSiblings, getSyncConfig, onSyncConfig, port = PORT }) {
  const file = path.join(dataDir, 'friends.json');
  let db = { me: null, friends: [], dms: {}, groups: {}, gm: {} };
  try { db = Object.assign(db, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch {}
  if (!db.me) db.me = { id: rid() + rid() };
  db.groups = db.groups || {}; db.gm = db.gm || {}; db.files = db.files || {};
  // ---------- файлы и скрины в личке и группах: лежат у отправителя, получатель забирает напрямую кусками ----------
  const FDIR = path.join(dataDir, 'dmfiles');
  try { fs.mkdirSync(FDIR, { recursive: true }); } catch {}
  const fpath = (id) => path.join(FDIR, id);
  const cleanFname = (n) => String(n || 'файл').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'файл';
  const cleanFile = (f) => (f && typeof f === 'object' && /^[0-9a-f]{16,32}$/.test(f.id || '')
    ? { id: f.id, name: cleanFname(f.name), size: Math.max(0, Math.min(Number(f.size) || 0, 4e9)), mime: short(f.mime, 80) } : null);
  const FCHUNK = 128 * 1024, FWIN = 6;
  const downloads = new Map(); // id файла -> { fd, got, next, src, ws, t }
  function knowFile(f, extra) {
    if (!f) return;
    const had = db.files[f.id];
    db.files[f.id] = Object.assign({ name: f.name, size: f.size, mime: f.mime, done: false }, had || {}, extra || {}, had && had.done ? { done: true } : {});
    // картинки до 15 МБ скачиваем сразу — чтобы видно было в чате
    if (!had && /^image\//.test(f.mime) && f.size <= 15 * 1024 * 1024) setTimeout(() => fetchFile(f.id), 50);
  }
  let saveT = null;
  const save = () => { clearTimeout(saveT); saveT = setTimeout(() => fs.writeFile(file, JSON.stringify(db), () => {}), 300); try { sibSoon(); } catch {} };
  save();
  const conns = new Map(); // id друга -> ws (живое соединение)
  const presence = new Map(); // id друга -> чем занят сейчас
  const allConns = new Map(); // id друга -> все его живые связи (несколько устройств)
  // ---------- мои устройства (один аккаунт на ПК и телефоне): обмен перепиской, друзьями, группами ----------
  const siblings = new Set();
  const sibSec = () => { try { return String((typeof sibSecret === 'function' ? sibSecret() : sibSecret) || ''); } catch { return ''; } };
  const sibProof = () => crypto.createHmac('sha256', sibSec()).update('kentovka-sibling:' + db.me.id).digest('hex');
  function sibPayload() {
    return { t: 'sib-sync', friends: db.friends.map(({ dialing, ...f }) => f), dms: db.dms, groups: db.groups, gm: db.gm, cfg: getSyncConfig ? getSyncConfig() : null };
  }
  function sibSend(ws) { try { ws.send(JSON.stringify(sibPayload())); } catch {} }
  let sibT = null;
  function sibSoon() { if (!siblings.size) return; clearTimeout(sibT); sibT = setTimeout(() => { for (const w of siblings) if (w.readyState === 1) sibSend(w); }, 1500); }
  function mergeSib(m) {
    let ch = false;
    for (const f of Array.isArray(m.friends) ? m.friends : []) {
      if (!f || !/^[0-9a-f]{32}$/.test(f.id)) continue;
      const mine = byId(f.id);
      if (!mine) { db.friends.push({ ...f, unread: f.unread || 0 }); ch = true; }
      else if (f.status === 'friend' && mine.status !== 'friend') { Object.assign(mine, f); ch = true; }
      else if (f.key && !mine.key) { mine.key = f.key; ch = true; }
    }
    for (const [id, list] of Object.entries(m.dms || {})) {
      if (!Array.isArray(list)) continue;
      const mineL = (db.dms[id] = db.dms[id] || []);
      for (const x of list) if (x && x.mid && !mineL.some((y) => y.mid === x.mid)) { mineL.push(x); ch = true; }
      mineL.sort((a, b) => a.ts - b.ts); if (mineL.length > DM_MAX) mineL.splice(0, mineL.length - DM_MAX);
    }
    for (const [gid, g] of Object.entries(m.groups || {})) { const mine = db.groups[gid]; if (!mine || (g.v || 0) > (mine.v || 0)) { db.groups[gid] = g; ch = true; } }
    for (const [gid, list] of Object.entries(m.gm || {})) {
      if (!db.groups[gid] || !Array.isArray(list)) continue;
      const mineL = (db.gm[gid] = db.gm[gid] || []);
      for (const x of list) if (x && x.mid && !mineL.some((y) => y.mid === x.mid)) { mineL.push(x); ch = true; }
      mineL.sort((a, b) => a.ts - b.ts);
    }
    if (m.cfg && onSyncConfig) onSyncConfig(m.cfg);
    if (ch) { save(); changed(); }
  }
  // группы: участники могут не дружить между собой — тогда связь «по группе» (общий ключ группы)
  const gconns = new Map(); // id участника -> ws
  const linkTo = (id) => { const w = conns.get(id) || gconns.get(id); return w && w.readyState === 1 ? w : null; };
  const G_MAX = 2000;
  // профиль и «чем занят» из приветствия друга
  function takeInfo(f, ws) {
    const i = ws.peerInfo; if (!i) return;
    f.name = i.name; f.avatar = i.avatar; f.port = i.port; f.bio = i.bio; f.color = i.color; f.color2 = i.color2;
    presence.set(f.id, i.presence);
  }
  function cleanPresence(p) {
    if (!p || typeof p !== 'object') return null;
    return { server: short(p.server, 40) || null, voice: short(p.voice, 40) || null, call: !!p.call, since: Number(p.since) || null };
  }
  const byId = (id) => db.friends.find((f) => f.id === id);
  // через мост адрес соединения — это мост или 127.0.0.1, а не адрес друга: такой не запоминаем
  const ipOk = (ws, ip) => {
    if (ws.viaAlt) return false;
    if (/^127\.|^::1$|^::ffff:127\./.test(String(ip || ''))) { try { return !require('./bridge').isBridged(ws._socket && ws._socket.remotePort); } catch { return true; } }
    return true;
  };
  const changed = () => onChange && onChange();

  function hello(ws) {
    const p = getProfile() || {};
    // профиль для мини-карточки (о себе, цвета шапки) и чем сейчас занят (сервер, голосовой канал, звонок)
    ws.send(JSON.stringify({ t: 'hi', id: db.me.id, name: short(p.name, 24) || 'кент', avatar: p.avatar && p.avatar.length < 60000 ? p.avatar : null, port,
      bio: short(p.bio, 190), color: p.color || null, color2: p.color2 || null, presence: getPresence ? getPresence() : null,
      alts: getAlts ? (getAlts() || []).slice(0, 6) : [] })); // запасные адреса: через мост на VPS
  }
  function attach(ws, ip, outgoing) {
    let peer = null; // id после «hi»
    let authed = false;
    const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      // привязка нового устройства кодом со старого (до знакомства)
      if (m.t === 'link' || m.t === 'link-ok' || m.t === 'link-no') { if (onLink) onLink(m, send, ws); return; }
      if (m.t === 'hi') {
        if (m.id === db.me.id && sibSec()) { ws.sibPending = true; peer = null; send({ t: 'sib', proof: sibProof() }); if (ws.onHi) ws.onHi({ sibling: true }); return; } // моё же второе устройство
        if (!/^[0-9a-f]{32}$/.test(m.id) || m.id === db.me.id) return ws.close();
        peer = m.id;
        const col = (c) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : null);
        ws.peerAlts = (Array.isArray(m.alts) ? m.alts : []).filter((a) => typeof a === 'string' && /^[\w.-]{1,200}:\d{2,5}$/.test(a)).slice(0, 6);
        ws.peerInfo = { id: m.id, name: short(m.name, 24), avatar: m.avatar && String(m.avatar).length < 60000 ? m.avatar : null, ip, port: Number(m.port) || PORT,
          bio: short(m.bio, 190), color: col(m.color), color2: col(m.color2), presence: cleanPresence(m.presence) };
        if (ws.onHi) ws.onHi(ws.peerInfo);
        const f = byId(peer);
        if (f && f.status === 'friend') send({ t: 'auth', key: f.key });
        if (f && f.status !== 'friend') { f.name = ws.peerInfo.name; f.avatar = ws.peerInfo.avatar; if (ipOk(ws, ip)) f.ip = ip; if (ws.peerAlts) f.alts = ws.peerAlts; save(); changed(); }
        return;
      }
      if (m.t === 'sib' && ws.sibPending) { // второе устройство доказало, что это тот же аккаунт
        if (m.proof === sibProof()) { ws.sibling = true; ws.sibPending = false; siblings.add(ws); sibSend(ws); }
        else ws.close();
        return;
      }
      if (m.t === 'sib-sync' && ws.sibling) { mergeSib(m); return; }
      if (!peer) return;
      const f = byId(peer);
      if (m.t && m.t.startsWith('g-')) return onGroupMsg(ws, peer, authed, m, send);
      switch (m.t) {
        case 'auth': // друг доказал, что это он (ключ из момента дружбы)
          if (f && f.status === 'friend' && m.key === f.key) {
            authed = true;
            // у друга может быть два устройства (ПК и телефон) — обе связи живут, пишем в последнюю
            (allConns.get(peer) || allConns.set(peer, new Set()).get(peer)).add(ws);
            conns.set(peer, ws);
            takeInfo(f, ws); if (ipOk(ws, ip)) f.ip = ip; if (ws.peerAlts) f.alts = ws.peerAlts; f.seen = Date.now();
            save(); flush(peer); groupSync(peer, ws); changed();
          }
          break;
        case 'req': // заявка в друзья
          if (f && f.status === 'friend') { send({ t: 'accept', key: f.key }); break; }
          if (f && f.status === 'outgoing') { acceptWith(f, ws); break; } // встречные заявки — сразу дружим
          if (!f) db.friends.push({ id: peer, name: ws.peerInfo.name, avatar: ws.peerInfo.avatar, ip: ipOk(ws, ip) ? ip : null, port: ws.peerInfo.port, alts: ws.peerAlts || [], status: 'incoming', since: Date.now() });
          save(); changed();
          onMessage && onMessage({ kind: 'request', name: ws.peerInfo.name });
          ws.pendingReq = true;
          break;
        case 'accept':
          if (f && (f.status === 'outgoing' || f.status === 'friend') && /^[0-9a-f]{32}$/.test(m.key)) {
            f.status = 'friend'; f.key = m.key; if (ipOk(ws, ip)) f.ip = ip; if (ws.peerAlts) f.alts = ws.peerAlts; takeInfo(f, ws); save();
            send({ t: 'auth', key: f.key }); authed = true; conns.set(peer, ws); flush(peer); changed();
            onMessage && onMessage({ kind: 'accepted', name: f.name });
          }
          break;
        case 'decline':
          if (f && f.status === 'outgoing') { db.friends = db.friends.filter((x) => x !== f); save(); changed(); }
          break;
        case 'unfriend':
          if (authed && f) { db.friends = db.friends.filter((x) => x !== f); save(); changed(); }
          break;
        case 'dm': {
          if (!authed || !f) return;
          const text = short(m.text, 4000).trim();
          const dfile = cleanFile(m.file);
          if ((!text && !dfile) || typeof m.mid !== 'string') return;
          const list = (db.dms[peer] = db.dms[peer] || []);
          if (!list.some((x) => x.mid === m.mid)) {
            if (dfile) knowFile(dfile, { from: peer, peer });
            list.push(Object.assign({ mid: short(m.mid, 32), from: 'them', text, ts: Number(m.ts) || Date.now() }, dfile ? { file: dfile } : {}));
            if (list.length > DM_MAX) list.splice(0, list.length - DM_MAX);
            f.unread = (f.unread || 0) + 1;
            save(); changed();
            onMessage && onMessage({ kind: 'dm', id: peer, name: f.name, text: text || ('📎 ' + (dfile ? dfile.name : 'файл')) });
          }
          send({ t: 'ack', mid: m.mid });
          break;
        }
        case 'invite': // друг зовёт на свой сервер
          if (!authed || !f) return;
          {
            const address = short(m.address, 80).trim();
            if (!/^[\w.\-:]+$/.test(address)) return;
            const list = (db.dms[peer] = db.dms[peer] || []);
            const mid = short(m.mid, 32) || rid();
            if (!list.some((x) => x.mid === mid)) {
              list.push({ mid, from: 'them', invite: { address, name: short(m.name, 40) }, ts: Date.now() });
              f.unread = (f.unread || 0) + 1; save(); changed();
              onInvite && onInvite({ id: peer, name: f.name, address, server: short(m.name, 40) });
            }
            send({ t: 'ack', mid });
          }
          break;
        case 'call': // звонок 1 на 1: вызов, ответ, сброс и обмен данными WebRTC — только между друзьями
          if (!authed || !f) return;
          if (!['ring', 'accept', 'decline', 'end', 'busy', 'signal', 'state'].includes(m.k) || typeof m.cid !== 'string') return;
          onCall && onCall({ id: peer, name: f.name, avatar: f.avatar, k: m.k, cid: short(m.cid, 32), data: m.data || null });
          break;
        case 'presence': // друг зашёл на сервер / в голос / в звонок
          if (!authed || !f) return;
          presence.set(peer, cleanPresence(m.p)); f.seen = Date.now(); changed();
          break;
        case 'f-get': { // друг или участник группы просит кусок файла
          const fi = db.files[String(m.fid || '')];
          const allowed = fi && fi.done && (fi.peer === peer || (fi.to && fi.to === peer) || (fi.gid && db.groups[fi.gid] && isMember(db.groups[fi.gid], peer)));
          if (!allowed || !(authed || (fi.gid && ws.groups && ws.groups.has(fi.gid)))) { send({ t: 'f-none', fid: m.fid }); break; }
          const off = Math.max(0, Number(m.off) || 0);
          fs.open(fpath(m.fid), 'r', (err, fd) => {
            if (err) return send({ t: 'f-none', fid: m.fid });
            const buf = Buffer.alloc(Math.min(FCHUNK, Math.max(0, fi.size - off)));
            fs.read(fd, buf, 0, buf.length, off, (e2, n) => { fs.close(fd, () => {}); if (e2) return send({ t: 'f-none', fid: m.fid }); send({ t: 'f-part', fid: m.fid, off, data: buf.slice(0, n).toString('base64') }); });
          });
          break;
        }
        case 'f-part': onPart(ws, m); break;
        case 'f-none': { const d = downloads.get(String(m.fid || '')); if (d && d.ws === ws) { d.ws = null; nextSource(String(m.fid)); } break; }
        case 'ack': {
          const list = db.dms[peer] || [];
          const x = list.find((y) => y.mid === m.mid && y.from === 'me');
          if (x && !x.delivered) { x.delivered = true; save(); changed(); }
          break;
        }
      }
    });
    ws.on('close', () => { siblings.delete(ws); if (peer && gconns.get(peer) === ws) { gconns.delete(peer); changed(); }
      if (peer && allConns.get(peer)) allConns.get(peer).delete(ws);
      const alt = peer && allConns.get(peer) && [...allConns.get(peer)].find((x) => x.readyState === 1);
      if (peer && conns.get(peer) === ws && alt) { conns.set(peer, alt); changed(); }
      else if (peer && conns.get(peer) === ws) { conns.delete(peer); presence.delete(peer); const ff = byId(peer); if (ff) { ff.seen = Date.now(); save(); } changed(); onCall && onCall({ id: peer, k: 'gone' }); } });
    ws.on('error', () => {});
    hello(ws);
  }
  // ---------- группы ----------
  const isMember = (g, id) => g && g.members.some((x) => x.id === id);
  const cleanGroup = (g) => {
    if (!g || typeof g !== 'object' || !/^[0-9a-f]{16,32}$/.test(g.id || '') || !/^[0-9a-f]{32}$/.test(g.key || '')) return null;
    const members = (Array.isArray(g.members) ? g.members : []).filter((x) => x && /^[0-9a-f]{32}$/.test(x.id)).slice(0, 10)
      .map((x) => ({ id: x.id, name: short(x.name, 24) || 'кент', avatar: x.avatar && String(x.avatar).length < 60000 ? x.avatar : null, ip: short(x.ip, 60), port: Number(x.port) || PORT }));
    return { id: g.id, key: g.key, name: short(g.name, 40), owner: /^[0-9a-f]{32}$/.test(g.owner || '') ? g.owner : null, members, v: Number(g.v) || 1, at: Number(g.at) || Date.now() };
  };
  const meAsMember = () => { const p = getProfile() || {}; return { id: db.me.id, name: short(p.name, 24) || 'кент', avatar: p.avatar && p.avatar.length < 60000 ? p.avatar : null, ip: '', port }; };
  function gsendAll(g, obj, except) {
    for (const mb of g.members) if (mb.id !== db.me.id && mb.id !== except) { const w = linkTo(mb.id); if (w) w.send(JSON.stringify(obj)); }
  }
  // при связи с участником — обмениваемся пропущенными сообщениями групп
  function groupSync(peerId, ws) {
    for (const g of Object.values(db.groups)) {
      if (!isMember(g, peerId)) continue;
      const last = ((db.gm[g.id] || []).slice(-1)[0] || {}).ts || 0;
      ws.send(JSON.stringify({ t: 'g-sync', gid: g.id, since: last, meta: g }));
    }
  }
  function storeGroupMsg(g, m) {
    const list = (db.gm[g.id] = db.gm[g.id] || []);
    if (list.some((x) => x.mid === m.mid)) return false;
    const x = { mid: short(m.mid, 32), from: m.from, name: short(m.name, 24), text: short(m.text, 4000), ts: Number(m.ts) || Date.now() };
    const gf = cleanFile(m.file); if (gf) x.file = gf;
    if ((!x.text && !gf) || !/^[0-9a-f]{32}$/.test(x.from)) return false;
    if (gf && x.from !== db.me.id) knowFile(gf, { from: x.from, gid: g.id });
    list.push(x); list.sort((a, b) => a.ts - b.ts);
    if (list.length > G_MAX) list.splice(0, list.length - G_MAX);
    if (x.from !== db.me.id) g.unread = (g.unread || 0) + 1;
    return true;
  }
  function onGroupMsg(ws, peerId, authed, m, send) {
    const gid = String(m.gid || (m.group && m.group.id) || '');
    let g = db.groups[gid];
    if (m.t === 'g-hi') { // связь по группе: доказываем, что мы участники (ключ группы)
      if (g && m.key === g.key && isMember(g, peerId)) {
        ws.groups = ws.groups || new Set(); ws.groups.add(gid);
        if (!conns.has(peerId)) { const old = gconns.get(peerId); if (old && old !== ws && old.readyState === 1) { try { old.close(); } catch {} } gconns.set(peerId, ws); }
        const mb = g.members.find((x) => x.id === peerId); if (mb && ws.peerInfo) { mb.name = ws.peerInfo.name; mb.avatar = ws.peerInfo.avatar; mb.ip = ws.peerInfo.ip || mb.ip; mb.port = ws.peerInfo.port; }
        if (!ws.gsynced) { ws.gsynced = true; send({ t: 'g-hi', gid, key: g.key }); }
        groupSync(peerId, ws); save(); changed();
      }
      return;
    }
    const ok = authed || (ws.groups && ws.groups.has(gid));
    if (m.t === 'g-invite') { // друг добавил меня в группу
      if (!authed) return;
      const ng = cleanGroup(m.group); if (!ng || !isMember(ng, db.me.id) || !isMember(ng, peerId)) return;
      const had = !!db.groups[ng.id];
      if (!had || (db.groups[ng.id].v || 0) < ng.v) { db.groups[ng.id] = Object.assign(db.groups[ng.id] || {}, ng); save(); changed(); }
      if (!had) { onMessage && onMessage({ kind: 'group', id: ng.id, name: ng.name, by: (byId(peerId) || {}).name }); dialGroup(db.groups[ng.id]); }
      return;
    }
    if (!g || !ok || !isMember(g, peerId)) return;
    switch (m.t) {
      case 'g-meta': { // переименовали, добавили или убрали участника
        const ng = cleanGroup(m.group); if (!ng || ng.id !== gid || ng.key !== g.key || ng.v <= (g.v || 0)) return;
        if (!isMember(ng, db.me.id)) { delete db.groups[gid]; delete db.gm[gid]; save(); changed(); return; } // меня убрали
        db.groups[gid] = Object.assign(g, ng); save(); changed();
        gsendAll(g, { t: 'g-meta', gid, group: ng }, peerId);
        dialGroup(g);
        break;
      }
      case 'g-msg': {
        if (storeGroupMsg(g, m)) {
          save(); changed();
          onMessage && onMessage({ kind: 'gmsg', id: gid, name: `${m.name} · ${g.name || 'группа'}`, text: short(m.text, 140) });
          gsendAll(g, { t: 'g-msg', gid, mid: m.mid, from: m.from, name: m.name, text: m.text, ts: m.ts, file: m.file || undefined }, peerId); // передаём дальше тем, кто не на прямой связи с автором
        }
        break;
      }
      case 'g-sync': { // участник просит то, что пропустил
        if (m.meta) { const ng = cleanGroup(m.meta); if (ng && ng.key === g.key && ng.v > (g.v || 0)) { db.groups[gid] = Object.assign(g, ng); save(); changed(); } }
        const since = Number(m.since) || 0;
        for (const x of (db.gm[gid] || []).filter((y) => y.ts > since).slice(-500)) send({ t: 'g-msg', gid, mid: x.mid, from: x.from, name: x.name, text: x.text, ts: x.ts, file: x.file || undefined });
        break;
      }
      case 'g-call': // звонок в группе: сигналы, кому адресовано — тому и отдаём
        if (typeof m.cid !== 'string' || m.cid.length > 40) return;
        if (m.to && m.to !== db.me.id) { const w = linkTo(m.to); if (w) w.send(JSON.stringify({ ...m, via: peerId })); return; }
        onGroupCall && onGroupCall({ gid, from: m.from || peerId, k: m.k, cid: m.cid, data: m.data && typeof m.data === 'object' ? m.data : null });
        break;
    }
  }
  // связи с участниками групп, кто мне не друг
  function dialGroup(g) {
    for (const mb of g.members) {
      if (mb.id === db.me.id || linkTo(mb.id) || !mb.ip || mb.dialing) continue;
      mb.dialing = true;
      dial(mb.ip, mb.port).then((r) => { if (r && r.ws && r.ws.readyState === 1) r.ws.send(JSON.stringify({ t: 'g-hi', gid: g.id, key: g.key })); }).finally(() => { mb.dialing = false; });
    }
  }
  function acceptWith(f, ws) {
    if (ws && ws.peerInfo) takeInfo(f, ws);
    f.status = 'friend'; f.key = f.key || crypto.randomBytes(16).toString('hex'); save();
    const send = (o) => ws && ws.readyState === 1 && ws.send(JSON.stringify(o));
    send({ t: 'accept', key: f.key });
    if (ws && ws.readyState === 1) { conns.set(f.id, ws); flush(f.id); }
    changed();
  }

  // --- наш порт: сюда стучатся друзья ---
  const server = https.createServer(cert, (req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Кентовка: друзья'); });
  const wss = new WebSocketServer({ server, maxPayload: 512 * 1024 });
  wss.on('connection', (ws, req) => attach(ws, cleanIp(req.socket.remoteAddress), false));
  let listening = false;
  server.on('error', (e) => { console.error('друзья: порт', port, e.code || e.message); });
  server.listen(port, '0.0.0.0', () => { listening = true; });

  // сначала напрямую (общая сеть), потом запасные адреса друга (мосты)
  async function dialAny(f) {
    if (f.ip) { const r = await dial(f.ip, f.port); if (r) return r; }
    for (const a of f.alts || []) { const i = a.lastIndexOf(':'); const r = await dial(a.slice(0, i), Number(a.slice(i + 1)), true); if (r) return r; }
    return null;
  }
  function dial(ip, p = PORT, viaAlt = false) {
    return new Promise((resolve) => {
      const ws = new WebSocket(`wss://${ip}:${p}`, { rejectUnauthorized: false, handshakeTimeout: 4000 });
      ws.viaAlt = viaAlt;
      let done = false;
      const fin = (v) => { if (!done) { done = true; resolve(v); } };
      ws.onHi = (info) => fin({ ws, info });
      ws.on('open', () => attach(ws, ip, true));
      ws.on('error', () => fin(null));
      ws.on('close', () => fin(null));
      setTimeout(() => { if (!done) { try { ws.terminate(); } catch {} fin(null); } }, 6000);
    });
  }
  // кто из друзей не на связи — периодически пробуем достучаться
  async function reconnect() {
    if (closed) return;
    for (const g of Object.values(db.groups)) dialGroup(g);
    // картинки, которые не докачались (отправителя не было в сети), — пробуем снова
    for (const [fid, fi] of Object.entries(db.files)) if (!fi.done && fi.offline && /^image\//.test(fi.mime || '') && fi.size <= 15 * 1024 * 1024 && Date.now() - fi.offline > 15000) { delete fi.offline; fetchFile(fid); }
    // мои другие устройства
    if (getSiblings && ![...siblings].some((w) => w.readyState === 1)) for (const sb of getSiblings() || []) for (const ip of sb.ips || []) dial(ip, sb.port || PORT).catch(() => {});
    for (const f of db.friends) {
      if (f.status !== 'friend' || (!f.ip && !(f.alts || []).length) || conns.has(f.id)) continue;
      if (f.dialing) continue;
      f.dialing = true;
      dialAny(f).finally(() => { f.dialing = false; });
    }
  }
  let closed = false;
  const timer = setInterval(reconnect, 20000);
  const first = setTimeout(reconnect, 1500);

  function flush(id) {
    const ws = conns.get(id);
    if (!ws || ws.readyState !== 1) return;
    for (const x of db.dms[id] || []) {
      if (x.from !== 'me' || x.delivered) continue;
      ws.send(JSON.stringify(x.invite ? { t: 'invite', mid: x.mid, address: x.invite.address, name: x.invite.name } : { t: 'dm', mid: x.mid, text: x.text, ts: x.ts, file: x.file || undefined }));
    }
  }

  // ---------- скачивание файла кусками (по 4 куска за раз) ----------
  function sourcesOf(fi) {
    const out = [];
    if (fi.from && fi.from !== db.me.id) out.push(fi.from);
    if (fi.gid && db.groups[fi.gid]) for (const mb of db.groups[fi.gid].members) if (mb.id !== db.me.id && !out.includes(mb.id)) out.push(mb.id);
    return out;
  }
  function fetchFile(fid) {
    const fi = db.files[fid]; if (!fi || fi.done || downloads.has(fid)) return fi ? { ok: true } : { error: 'нет файла' };
    let fd; try { fd = fs.openSync(fpath(fid) + '.part', 'w'); } catch { return { error: 'не записать файл' }; }
    downloads.set(fid, { fd, got: 0, next: 0, inflight: new Set(), tried: new Set(), ws: null, t: 0 });
    nextSource(fid);
    return { ok: true };
  }
  function nextSource(fid) {
    const d = downloads.get(fid), fi = db.files[fid]; if (!d || !fi) return;
    for (const id of sourcesOf(fi)) {
      if (d.tried.has(id)) continue;
      const ws = conns.get(id) || linkTo(id); d.tried.add(id);
      if (!ws || ws.readyState !== 1) continue;
      d.ws = ws; d.inflight.clear(); d.next = d.got;
      for (let i = 0; i < FWIN; i++) askPart(fid);
      return;
    }
    // никого с файлом нет в сети — попробуем позже
    try { fs.closeSync(d.fd); } catch {}
    downloads.delete(fid); fi.offline = Date.now(); changed();
  }
  function askPart(fid) {
    const d = downloads.get(fid), fi = db.files[fid]; if (!d || !d.ws || d.next >= fi.size) return;
    const off = d.next; d.next += FCHUNK; d.inflight.add(off);
    try { d.ws.send(JSON.stringify({ t: 'f-get', fid, off })); } catch {}
  }
  function onPart(ws, m) {
    const fid = String(m.fid || ''), d = downloads.get(fid), fi = db.files[fid];
    if (!d || !fi || d.ws !== ws || !d.inflight.has(Number(m.off))) return;
    const buf = Buffer.from(String(m.data || ''), 'base64');
    try { fs.writeSync(d.fd, buf, 0, buf.length, Number(m.off)); } catch { return; }
    d.inflight.delete(Number(m.off)); d.got += buf.length;
    if (d.got >= fi.size || (!buf.length && !d.inflight.size)) {
      try { fs.closeSync(d.fd); fs.renameSync(fpath(fid) + '.part', fpath(fid)); } catch {}
      downloads.delete(fid); fi.done = true; delete fi.offline; save(); changed();
      return;
    }
    askPart(fid);
    if (Date.now() - d.t > 400) { d.t = Date.now(); changed(); }
  }

  return {
    get myId() { return db.me.id; },
    // файлы
    sendFile(target, src, caption) {
      const fid = rid() + rid();
      let size = 0;
      try {
        if (src.path) { fs.copyFileSync(src.path, fpath(fid)); size = fs.statSync(fpath(fid)).size; }
        else if (src.bytes) { fs.writeFileSync(fpath(fid), Buffer.from(src.bytes)); size = src.bytes.byteLength || src.bytes.length; }
        else return { error: 'нет файла' };
      } catch (e) { return { error: 'Файл не прочитать: ' + e.message }; }
      const file = { id: fid, name: cleanFname(src.name || (src.path && path.basename(src.path))), size, mime: short(src.mime, 80) };
      if (target.gid) {
        const g = db.groups[target.gid]; if (!g) return { error: 'нет группы' };
        db.files[fid] = { ...file, done: true, mine: true, gid: g.id, from: db.me.id };
        const p = getProfile() || {};
        const m = { mid: rid(), from: db.me.id, name: short(p.name, 24) || 'кент', text: short(caption, 4000).trim(), ts: Date.now(), file };
        storeGroupMsg(g, m); save(); gsendAll(g, { t: 'g-msg', gid: g.id, ...m }); changed();
        return { ok: true, fid };
      }
      const f = byId(target.id); if (!f || f.status !== 'friend') return { error: 'не друг' };
      db.files[fid] = { ...file, done: true, mine: true, to: f.id, peer: f.id, from: db.me.id };
      const x = { mid: rid(), from: 'me', text: short(caption, 4000).trim(), ts: Date.now(), file };
      (db.dms[f.id] = db.dms[f.id] || []).push(x); save(); flush(f.id); changed();
      return { ok: true, fid };
    },
    fileInfo(fid) {
      const fi = db.files[fid]; if (!fi) return null;
      const d = downloads.get(fid);
      return { name: fi.name, size: fi.size, mime: fi.mime, done: !!fi.done, mine: !!fi.mine, progress: fi.done ? 1 : d ? d.got / Math.max(1, fi.size) : 0, loading: !!d, offline: !!fi.offline };
    },
    fetchFile(fid) { const fi = db.files[fid]; if (fi) delete fi.offline; return fetchFile(fid); },
    filePath(fid) { const fi = db.files[fid]; return fi && fi.done ? fpath(fid) : null; },
    port,
    listening: () => listening,
    list() {
      return db.friends.map((f) => ({ id: f.id, name: f.name, avatar: f.avatar, ip: f.ip, status: f.status, online: conns.has(f.id), unread: f.unread || 0, seen: f.seen || 0,
        bio: f.bio || '', color: f.color || null, color2: f.color2 || null, presence: conns.has(f.id) ? presence.get(f.id) || null : null,
        last: ((db.dms[f.id] || []).slice(-1)[0] || {}).ts || 0 }));
    },
    isFriend: (id) => !!(id && db.friends.some((f) => f.id === id && f.status === 'friend')),
    unreadTotal: () => db.friends.reduce((s, f) => s + (f.status === 'friend' ? f.unread || 0 : 0), 0) + db.friends.filter((f) => f.status === 'incoming').length + Object.values(db.groups).reduce((s, g) => s + (g.unread || 0), 0),
    async add(ip) {
      ip = String(ip || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      let p = PORT;
      const mm = /^(.*):(\d+)$/.exec(ip); if (mm) { ip = mm[1]; p = Number(mm[2]); }
      if (!/^[\w.\-]+$/.test(ip)) return { error: 'Впиши адрес друга в локальной сети, например 26.12.34.56' };
      const r = await dial(ip, p);
      if (!r) return { error: 'Друг не отвечает. У него должна быть запущена Кентовка (версия 1.6 или новее), и вы оба в одной локальной сети.' };
      const { ws, info } = r;
      // постучались через мост (порт моста, а не друга) — это запасной адрес, а не его адрес в сети
      if (!ws.viaAlt && (p !== info.port || (ws.peerAlts || []).includes(ip + ':' + p))) { ws.viaAlt = true; ws.peerAlts = [...new Set([ip + ':' + p, ...(ws.peerAlts || [])])]; }
      let f = byId(info.id);
      if (f && f.status === 'friend') return { ok: true, already: true };
      if (f && f.status === 'incoming') { if (ipOk(ws, ip)) f.ip = ip; if (ws.peerAlts) f.alts = ws.peerAlts; acceptWith(f, ws); return { ok: true, accepted: true }; }
      if (!f) { f = { id: info.id, name: info.name, avatar: info.avatar, ip: ws.viaAlt ? null : ip, port: ws.viaAlt ? info.port : p, alts: ws.peerAlts || [], status: 'outgoing', since: Date.now() }; db.friends.push(f); }
      save(); changed();
      ws.send(JSON.stringify({ t: 'req' }));
      return { ok: true, name: info.name };
    },
    async respond(id, yes) {
      const f = byId(id);
      if (!f || f.status !== 'incoming') return;
      // ищем живое соединение от него (он висит на связи, пока ждёт), иначе стучимся сами
      let ws = [...wss.clients].find((c) => c.peerInfo && c.peerInfo.id === id && c.readyState === 1);
      if (!ws && (f.ip || (f.alts || []).length)) { const r = await dialAny(f); ws = r && r.ws; }
      if (yes) acceptWith(f, ws);
      else { if (ws) ws.send(JSON.stringify({ t: 'decline' })); db.friends = db.friends.filter((x) => x !== f); save(); changed(); }
    },
    remove(id) {
      const f = byId(id); if (!f) return;
      const ws = conns.get(id); if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'unfriend' }));
      db.friends = db.friends.filter((x) => x !== f); delete db.dms[id]; save(); changed();
    },
    // звонок: только если друг сейчас на связи
    call(id, msg) {
      const ws = conns.get(id);
      if (!ws || ws.readyState !== 1) return false;
      ws.send(JSON.stringify({ t: 'call', k: msg.k, cid: msg.cid, data: msg.data || null }));
      return true;
    },
    online: (id) => !!linkTo(id),
    db: () => JSON.parse(JSON.stringify(db)),
    siblingsOnline: () => [...siblings].filter((w) => w.readyState === 1).length,
    syncSiblings: () => sibSoon(),
    dialRaw: (ip, p) => new Promise((resolve) => { const ws = new WebSocket(`wss://${ip}:${p || PORT}`, { rejectUnauthorized: false, handshakeTimeout: 4000 }); ws.on('open', () => resolve(ws)); ws.on('error', () => resolve(null)); setTimeout(() => resolve(null), 6000); }),
    // ---------- группы ----------
    groups() {
      return Object.values(db.groups).map((g) => ({ id: g.id, name: g.name, owner: g.owner, members: g.members.map((mb) => ({ id: mb.id, name: mb.name, avatar: mb.avatar, online: mb.id === db.me.id || !!linkTo(mb.id) })),
        unread: g.unread || 0, last: ((db.gm[g.id] || []).slice(-1)[0] || {}).ts || g.at }));
    },
    groupCreate(name, ids) {
      const fs2 = ids.map(byId).filter((f) => f && f.status === 'friend').slice(0, 9);
      if (!fs2.length) return { error: 'Выбери хотя бы одного друга' };
      const g = { id: rid() + rid(), key: crypto.randomBytes(16).toString('hex'), name: short(name, 40), owner: db.me.id, v: 1, at: Date.now(),
        members: [meAsMember(), ...fs2.map((f) => ({ id: f.id, name: f.name, avatar: f.avatar, ip: f.ip, port: f.port || PORT }))] };
      db.groups[g.id] = g; db.gm[g.id] = []; save();
      for (const f of fs2) { const w = linkTo(f.id); if (w) w.send(JSON.stringify({ t: 'g-invite', group: g })); }
      changed();
      return { ok: true, id: g.id };
    },
    groupUpdate(gid, { name, add, remove }) {
      const g = db.groups[gid]; if (!g) return { error: 'нет группы' };
      if (typeof name === 'string') g.name = short(name, 40);
      const added = [];
      for (const id of add || []) { const f = byId(id); if (f && f.status === 'friend' && !isMember(g, id) && g.members.length < 10) { g.members.push({ id: f.id, name: f.name, avatar: f.avatar, ip: f.ip, port: f.port || PORT }); added.push(f.id); } }
      const removed = (remove || []).filter((id) => id !== db.me.id && isMember(g, id) && g.owner === db.me.id);
      const old = g.members.slice();
      g.members = g.members.filter((mb) => !removed.includes(mb.id));
      g.v = (g.v || 1) + 1; save();
      const meta = { t: 'g-meta', gid, group: g };
      for (const mb of old) if (mb.id !== db.me.id) { const w = linkTo(mb.id); if (w) w.send(JSON.stringify(removed.includes(mb.id) ? { t: 'g-meta', gid, group: { ...g } } : meta)); }
      for (const id of added) { const w = linkTo(id); if (w) w.send(JSON.stringify({ t: 'g-invite', group: g })); }
      changed();
      return { ok: true };
    },
    groupLeave(gid) {
      const g = db.groups[gid]; if (!g) return;
      const ng = { ...g, members: g.members.filter((mb) => mb.id !== db.me.id), v: (g.v || 1) + 1 };
      gsendAll(g, { t: 'g-meta', gid, group: ng });
      delete db.groups[gid]; delete db.gm[gid]; save(); changed();
    },
    groupMessages(gid) { return (db.gm[gid] || []).slice(-G_MAX); },
    groupRead(gid) { const g = db.groups[gid]; if (g && g.unread) { g.unread = 0; save(); changed(); } },
    groupSend(gid, text) {
      const g = db.groups[gid]; text = short(text, 4000).trim(); if (!g || !text) return null;
      const p = getProfile() || {};
      const m = { mid: rid(), from: db.me.id, name: short(p.name, 24) || 'кент', text, ts: Date.now() };
      storeGroupMsg(g, m); save();
      gsendAll(g, { t: 'g-msg', gid, ...m });
      changed();
      return m;
    },
    groupCall(gid, msg) { // сигналы звонка в группе: всем участникам или одному (to)
      const g = db.groups[gid]; if (!g || !msg) return false;
      const o = { t: 'g-call', gid, from: db.me.id, k: msg.k, cid: msg.cid, data: msg.data || null, to: msg.to || null };
      if (msg.to) { const w = linkTo(msg.to); if (w) { w.send(JSON.stringify(o)); return true; }
        for (const mb of g.members) { const w2 = mb.id !== db.me.id && linkTo(mb.id); if (w2) { w2.send(JSON.stringify(o)); return true; } } return false; } // нет прямой связи — через другого участника
      gsendAll(g, o); return true;
    },
    // сменил ник или аватарку — сообщаем друзьям на связи
    announce() { for (const ws of conns.values()) if (ws.readyState === 1) hello(ws); },
    // чем я занят сейчас — друзьям на связи
    sendPresence() { const p = getPresence ? getPresence() : null; for (const ws of conns.values()) if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'presence', p })); },
    messages(id) { return (db.dms[id] || []).slice(-DM_MAX); },
    read(id) { const f = byId(id); if (f && f.unread) { f.unread = 0; save(); changed(); } },
    send(id, text) {
      const f = byId(id); text = short(text, 4000).trim();
      if (!f || f.status !== 'friend' || !text) return null;
      const x = { mid: rid(), from: 'me', text, ts: Date.now() };
      (db.dms[id] = db.dms[id] || []).push(x); save(); flush(id); changed();
      return x;
    },
    invite(id, address, name) {
      const f = byId(id); if (!f || f.status !== 'friend') return null;
      const x = { mid: rid(), from: 'me', invite: { address: short(address, 80), name: short(name, 40) }, ts: Date.now() };
      (db.dms[id] = db.dms[id] || []).push(x); save(); flush(id); changed();
      return x;
    },
    close() { closed = true; clearInterval(timer); clearTimeout(first); for (const c of wss.clients) c.terminate(); for (const c of conns.values()) { try { c.terminate(); } catch {} } try { server.close(); } catch {} try { fs.writeFileSync(file, JSON.stringify(db)); } catch {} },
  };
}

module.exports = { createFriends, FRIEND_PORT: PORT };
