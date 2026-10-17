// Подключение к мосту Кентовки (bridge/relay.js на VPS).
// Хост сам держит исходящее соединение с мостом; мост открывает для него постоянные порты.
// Кенты подключаются к <IP моста>:<порт>, а байты идут сюда и дальше на локальный сервер.
// Внутри — TLS нашего сервера: мост видит только шифрованный поток.
const net = require('net');
const crypto = require('crypto');

const T = { JSON: 1, OPEN: 2, DATA: 3, CLOSE: 4 };
// локальные порты соединений, пришедших через мост (для них адрес 127.0.0.1 — не адрес кента)
const bridgedPorts = new Set();
const isBridged = (port) => bridgedPorts.has(Number(port));
function frame(type, sid, data) {
  const body = data ? (Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data))) : Buffer.alloc(0);
  const h = Buffer.alloc(9); h[0] = type; h.writeUInt32BE(sid >>> 0, 1); h.writeUInt32BE(body.length, 5);
  return Buffer.concat([h, body]);
}
function reader(onFrame) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 9) {
      const len = buf.readUInt32BE(5);
      if (len > 4 * 1024 * 1024) throw new Error('кадр слишком большой');
      if (buf.length < 9 + len) break;
      const type = buf[0], sid = buf.readUInt32BE(1), data = buf.slice(9, 9 + len);
      buf = buf.slice(9 + len);
      onFrame(type, sid, data);
    }
  };
}

// KNTB1.<base64url json {h, p, k, ts, tp}>
function parseLink(link) {
  const s = String(link || '').trim();
  if (!/^KNTB1\./.test(s)) return null;
  try {
    const j = JSON.parse(Buffer.from(s.slice(6), 'base64url').toString('utf8'));
    if (!j.h || !j.k) return null;
    return { host: String(j.h).slice(0, 200), port: Number(j.p) || 8460, token: String(j.k), turnSecret: j.ts ? String(j.ts) : '', turnPort: Number(j.tp) || 0, link: s };
  } catch { return null; }
}

// одно подключение к одному мосту; services: () => ({ 'srv:9711': 9711, fr: 8444 })
function connectBridge({ link, id, name, services, onState }) {
  const b = typeof link === 'string' ? parseLink(link) : link;
  if (!b) throw new Error('Ссылка на мост не похожа на ссылку Кентовки (KNTB1.…)');
  let sock = null, closed = false, retry = 1000, pingT = null;
  const st = { host: b.host, state: 'connecting', ports: {}, error: null, turnPort: 0 };
  const set = (o) => { Object.assign(st, o); if (onState) onState({ ...st }); };
  const streams = new Map();
  function open() {
    if (closed) return;
    set({ state: 'connecting' });
    sock = net.connect({ host: b.host, port: b.port });
    sock.setNoDelay(true); sock.setKeepAlive(true, 20000);
    const send = (o) => sock.write(frame(T.JSON, 0, o));
    const paused = new Set();
    sock.on('drain', () => { for (const c of paused) c.resume(); paused.clear(); });
    const read = reader((type, sid, data) => {
      if (type === T.JSON) {
        let m; try { m = JSON.parse(data); } catch { return; }
        if (m.t === 'nonce') {
          const svcs = Object.keys(services());
          send({ t: 'hello', id, name: typeof name === 'function' ? name() : name, svcs, proof: crypto.createHmac('sha256', b.token).update('kentovka-bridge:' + m.n).digest('hex') });
        } else if (m.t === 'ok') { retry = 1000; set({ state: 'up', ports: m.ports || {}, error: null, turnPort: m.turn || 0 }); }
        else if (m.t === 'denied') { set({ state: 'error', error: m.reason || 'мост отказал' }); closed = true; sock.destroy(); }
        return;
      }
      if (type === T.OPEN) {
        let m = {}; try { m = JSON.parse(data); } catch {}
        const port = services()[m.svc];
        if (!port) { sock.write(frame(T.CLOSE, sid)); return; }
        const pending = [];
        const c = net.connect({ host: '127.0.0.1', port });
        c.setNoDelay(true);
        streams.set(sid, { c, pending, ready: false });
        c.on('connect', () => { c._kport = c.localPort; bridgedPorts.add(c.localPort); const s = streams.get(sid); if (!s) return; s.ready = true; for (const d of pending) c.write(d); pending.length = 0; });
        c.on('data', (d) => { if (!sock.write(frame(T.DATA, sid, d))) { c.pause(); paused.add(c); } });
        const end = () => { if (c._kport) setTimeout(() => bridgedPorts.delete(c._kport), 1000); if (streams.delete(sid)) { try { sock.write(frame(T.CLOSE, sid)); } catch {} } };
        c.on('close', end); c.on('error', end);
        return;
      }
      const s = streams.get(sid);
      if (type === T.DATA && s) { if (s.ready) s.c.write(data); else s.pending.push(data); }
      else if (type === T.CLOSE && s) { streams.delete(sid); s.c.end(); }
    });
    sock.on('data', (d) => { try { read(d); } catch { sock.destroy(); } });
    sock.on('error', (e) => { st.error = e.code === 'ECONNREFUSED' ? 'мост не отвечает' : e.code === 'ETIMEDOUT' || e.code === 'EHOSTUNREACH' ? 'мост недоступен' : String(e.code || e.message); });
    sock.on('close', () => {
      clearInterval(pingT);
      for (const s of streams.values()) s.c.destroy(); streams.clear();
      if (closed) return;
      set({ state: 'down', ports: {} });
      setTimeout(open, retry); retry = Math.min(retry * 2, 30000);
    });
    pingT = setInterval(() => { try { send({ t: 'ping' }); } catch {} }, 25000);
  }
  open();
  return {
    info: b, state: () => ({ ...st }),
    address: (svc) => (st.state === 'up' && st.ports[svc] ? `${b.host}:${st.ports[svc]}` : null),
    reconnect() { if (sock) sock.destroy(); },  // после смены набора сервисов
    close() { closed = true; clearInterval(pingT); try { sock && sock.destroy(); } catch {} },
  };
}

// найти друга по коду Кентовки через мост (без ключа моста)
function findOnBridge(link, code) {
  const b = typeof link === 'string' ? parseLink(link) : link;
  return new Promise((resolve) => {
    if (!b) return resolve(null);
    const sock = net.connect({ host: b.host, port: b.port });
    const done = (v) => { clearTimeout(t); try { sock.destroy(); } catch {} resolve(v); };
    const t = setTimeout(() => done(null), 6000);
    const read = reader((type, sid, data) => {
      let m; try { m = JSON.parse(data); } catch { return; }
      if (m.t === 'nonce') sock.write(frame(T.JSON, 0, { t: 'find', code, rid: 1 }));
      if (m.t === 'found') done(m.port ? { host: b.host, port: m.port, name: m.name } : null);
    });
    sock.on('data', (d) => { try { read(d); } catch { done(null); } });
    sock.on('error', () => done(null));
  });
}

// временные логин/пароль для TURN (coturn, use-auth-secret): живут сутки
function turnCreds(secret, user, ttl = 24 * 3600) {
  const username = `${Math.floor(Date.now() / 1000) + ttl}:${String(user || 'k').replace(/:/g, '')}`;
  return { username, credential: crypto.createHmac('sha1', secret).update(username).digest('base64') };
}

module.exports = { parseLink, connectBridge, findOnBridge, turnCreds, isBridged };
