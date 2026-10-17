#!/usr/bin/env node
// Мост Кентовки — ставится на свой VPS (например в РФ). Без зависимостей, Node 12+.
//
// Как работает:
//   * Хост сам подключается к мосту (исходящее соединение — роутер и белый IP не нужны).
//   * Мост выдаёт хосту постоянные порты: для сервера и для друзей/лички. Адрес для кентов: <IP VPS>:<порт>.
//   * Кенты подключаются к этому порту, мост просто перекладывает байты к хосту и обратно.
//     Внутри — TLS между кентом и хостом: мост видит только зашифрованный поток (сквозное шифрование).
//   * Голос, если напрямую не выходит, идёт через TURN (coturn) на этом же VPS — его ставит install.sh.
//
// Запуск:  node relay.js   (настройки в relay.json рядом, создаётся при первом запуске)
'use strict';
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.KENTOVKA_BRIDGE_DIR || __dirname;
const CFG_FILE = path.join(DIR, 'relay.json');
const STATE_FILE = path.join(DIR, 'relay-state.json');

function loadCfg() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch (e) {}
  let ch = false;
  if (!c.token) { c.token = crypto.randomBytes(18).toString('base64').replace(/[+/=]/g, ''); ch = true; }
  if (!c.controlPort) { c.controlPort = 8460; ch = true; }
  if (!c.portFrom) { c.portFrom = 20000; c.portTo = 20199; ch = true; }
  if (c.turnPort === undefined) { c.turnPort = 3478; ch = true; }
  if (!c.turnSecret) { c.turnSecret = crypto.randomBytes(18).toString('hex'); ch = true; }
  if (ch) fs.writeFileSync(CFG_FILE, JSON.stringify(c, null, 2));
  return c;
}
const cfg = loadCfg();
if (process.env.KENTOVKA_BRIDGE_PORT) cfg.controlPort = Number(process.env.KENTOVKA_BRIDGE_PORT);
if (process.env.KENTOVKA_BRIDGE_RANGE) { const r = process.env.KENTOVKA_BRIDGE_RANGE.split('-').map(Number); cfg.portFrom = r[0]; cfg.portTo = r[1]; }
let state = { ports: {} }; // "id/svc" -> порт (постоянный, чтобы адрес у кентов не менялся)
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) {}
const saveState = () => { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch (e) {} };
const log = (...a) => console.log(new Date().toISOString(), ...a);

const friendCode = (id) => 'KNT-' + crypto.createHash('sha256').update('kentovka-code:' + String(id)).digest('hex').slice(0, 6).toUpperCase();

// ссылка, которую вставляют в Кентовку: адрес моста, ключ и секрет TURN для голоса
function bridgeLink(ip) {
  return 'KNTB1.' + Buffer.from(JSON.stringify({ h: ip, p: cfg.controlPort, k: cfg.token, ts: cfg.turnPort ? cfg.turnSecret : '', tp: cfg.turnPort || 0 })).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
if (process.argv[2] === 'link') { console.log(bridgeLink(process.argv[3] || cfg.publicIp || '<IP-этого-сервера>')); process.exit(0); }

// ---------- кадры: [тип 1][поток 4][длина 4][данные] ----------
const T = { JSON: 1, OPEN: 2, DATA: 3, CLOSE: 4 };
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

// ---------- хосты ----------
const hosts = new Map();     // id -> { sock, svcs: { name: { port, server } }, streams }
const listeners = new Map(); // порт -> { id, svc, server }
const usedPorts = () => new Set(Object.values(state.ports));
function portFor(id, svc) {
  const key = id + '/' + svc;
  if (state.ports[key]) return state.ports[key];
  const used = usedPorts();
  for (let p = cfg.portFrom; p <= cfg.portTo; p++) if (!used.has(p)) { state.ports[key] = p; saveState(); return p; }
  return null;
}
function listen(port, id, svc) {
  return new Promise((resolve) => {
    const old = listeners.get(port);
    if (old) { old.id = id; old.svc = svc; return resolve(true); }
    const server = net.createServer((client) => onClient(port, client));
    server.on('error', (e) => { log('порт', port, 'не открылся:', e.code); resolve(false); });
    server.listen(port, '0.0.0.0', () => { listeners.set(port, { id, svc, server }); resolve(true); });
  });
}
let nextSid = 1;
function onClient(port, client) {
  const l = listeners.get(port); const h = l && hosts.get(l.id);
  if (!h) { client.destroy(); return; }
  if (h.streams.size > 400) { client.destroy(); return; }
  const sid = (nextSid = (nextSid % 0x7fffffff) + 1);
  h.streams.set(sid, client);
  client.setNoDelay(true);
  h.sock.write(frame(T.OPEN, sid, { svc: l.svc, ip: client.remoteAddress }));
  client.on('data', (d) => { if (!h.sock.write(frame(T.DATA, sid, d))) { client.pause(); h.paused.add(client); } });
  const end = () => { if (h.streams.delete(sid)) { try { h.sock.write(frame(T.CLOSE, sid)); } catch (e) {} } };
  client.on('close', end); client.on('error', end);
}

// ---------- управляющее соединение ----------
const findHits = new Map(); // ip -> [времена] (защита от перебора кодов)
const ctl = net.createServer((sock) => {
  sock.setNoDelay(true); sock.setKeepAlive(true, 20000);
  const nonce = crypto.randomBytes(16).toString('hex');
  let host = null, authed = false;
  const send = (o) => sock.write(frame(T.JSON, 0, o));
  send({ t: 'nonce', n: nonce, v: 1 });
  const t0 = setTimeout(() => { if (!authed && !sock.findOnly) sock.destroy(); }, 15000);
  sock.on('data', (chunk) => {
    try { read(chunk); } catch (e) { sock.destroy(); }
  });
  const read = reader(async (type, sid, data) => {
    if (type === T.JSON) {
      let m; try { m = JSON.parse(data); } catch (e) { return; }
      if (m.t === 'find') { // кто с этим кодом Кентовки подключён к мосту (без токена, но не чаще 20 раз в минуту)
        sock.findOnly = true;
        const ip = sock.remoteAddress, now = Date.now();
        const hits = (findHits.get(ip) || []).filter((x) => now - x < 60000); hits.push(now); findHits.set(ip, hits);
        if (hits.length > 20) return send({ t: 'found', rid: m.rid, error: 'слишком часто' });
        const code = String(m.code || '').toUpperCase();
        for (const [id, h] of hosts) if (friendCode(id) === code && h.svcs.fr) return send({ t: 'found', rid: m.rid, port: h.svcs.fr.port, name: h.name || '' });
        return send({ t: 'found', rid: m.rid, error: 'нет' });
      }
      if (m.t === 'hello') {
        const want = crypto.createHmac('sha256', cfg.token).update('kentovka-bridge:' + nonce).digest('hex');
        if (typeof m.proof !== 'string' || m.proof.length !== want.length || !crypto.timingSafeEqual(Buffer.from(m.proof), Buffer.from(want))) { send({ t: 'denied', reason: 'Неверный ключ моста' }); return sock.end(); }
        if (!/^[0-9a-f]{32}$/.test(m.id || '')) return sock.end();
        authed = true; clearTimeout(t0);
        const prev = hosts.get(m.id);
        if (prev && prev.sock !== sock) { try { prev.sock.destroy(); } catch (e) {} }
        host = { id: m.id, name: String(m.name || '').slice(0, 24), sock, svcs: {}, streams: new Map(), paused: new Set() };
        hosts.set(m.id, host);
        sock.on('drain', () => { for (const c of host.paused) c.resume(); host.paused.clear(); });
        const svcs = (Array.isArray(m.svcs) ? m.svcs : []).filter((s) => /^[a-z0-9:-]{1,24}$/.test(s)).slice(0, 8);
        const ports = {};
        for (const s of svcs) { const p = portFor(m.id, s); if (p && await listen(p, m.id, s)) { host.svcs[s] = { port: p }; ports[s] = p; } }
        send({ t: 'ok', ports, turn: cfg.turnPort || 0 });
        log('хост', host.name || m.id.slice(0, 8), 'подключился, порты', JSON.stringify(ports));
        return;
      }
      if (m.t === 'ping') return send({ t: 'pong' });
      return;
    }
    if (!authed || !host) return;
    const c = host.streams.get(sid);
    if (type === T.DATA) { if (c) c.write(data); }
    else if (type === T.CLOSE) { if (c) { host.streams.delete(sid); c.end(); } }
  });
  sock.on('close', () => {
    clearTimeout(t0);
    if (host && hosts.get(host.id) === host) {
      hosts.delete(host.id);
      for (const c of host.streams.values()) c.destroy();
      log('хост', host.name || host.id.slice(0, 8), 'отключился');
    }
  });
  sock.on('error', () => {});
});
ctl.listen(cfg.controlPort, '0.0.0.0', () => {
  log(`Мост Кентовки слушает порт ${cfg.controlPort}, порты для хостов ${cfg.portFrom}-${cfg.portTo}`);
  if (process.env.KENTOVKA_BRIDGE_QUIET) return;
  console.log('Ссылка на мост (вставь её в Кентовку: «Аккаунт и сеть» → «Мост»):');
  console.log('  ' + bridgeLink(cfg.publicIp || process.env.PUBLIC_IP || '<IP-этого-сервера>'));
});
