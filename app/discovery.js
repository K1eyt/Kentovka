// Поиск «рядом» в локальной сети.
// Каждая Кентовка раз в несколько секунд кричит в сеть (UDP broadcast): «я тут, мой код друга такой-то, вот мои серверы».
// Так находятся серверы без ввода адреса и друзья по коду Кентовки (KNT-XXXXXX).
// Где сеть не пропускает broadcast — адрес вписывают руками.
const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.KENTOVKA_DISCO_PORT) || 8447;
const friendCode = (id) => 'KNT-' + crypto.createHash('sha256').update('kentovka-code:' + String(id)).digest('hex').slice(0, 6).toUpperCase();

function broadcastTargets() {
  const out = new Set(['255.255.255.255']);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal || !a.netmask) continue;
      const ip = a.address.split('.').map(Number), m = a.netmask.split('.').map(Number);
      out.add(ip.map((x, i) => (x | (~m[i] & 255))).join('.'));
    }
  }
  if (process.env.KENTOVKA_DISCO_LOOP) out.add('127.255.255.255');
  return [...out];
}

function createDiscovery({ getAnnounce, onUpdate }) {
  const peers = new Map(); // id -> { id, code, name, ip, fport, servers, seen }
  let sock = null, timer = null, closed = false;
  const myId = () => { try { return getAnnounce().id; } catch { return null; } };
  function send(obj) {
    if (!sock) return;
    const buf = Buffer.from(JSON.stringify(obj));
    if (buf.length > 1400) return;
    for (const t of broadcastTargets()) sock.send(buf, PORT, t, () => {});
  }
  function announce() { try { const a = getAnnounce(); if (a && a.id) send({ k: 'kentovka', v: 1, ...a }); } catch {} }
  function start() {
    sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', () => { try { sock.close(); } catch {} sock = null; if (!closed) setTimeout(start, 15000); });
    sock.on('message', (raw, rinfo) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (!m || m.k !== 'kentovka') return;
      if (m.q) { announce(); return; } // кто-то ищет — ответим сразу
      if (!/^[0-9a-f]{32}$/.test(m.id || '') || m.id === myId()) return;
      const prev = peers.get(m.id);
      const ips = new Set(prev && Date.now() - prev.seen < 15000 ? prev.ips : []); ips.add(rinfo.address);
      peers.set(m.id, {
        id: m.id, code: friendCode(m.id), name: String(m.name || '').slice(0, 24), ip: rinfo.address, ips: [...ips].slice(0, 6), fport: Number(m.fport) || 8444,
        servers: (Array.isArray(m.servers) ? m.servers : []).slice(0, 8).map((s) => ({ port: Number(s.port) || 8443, name: String(s.name || 'Сервер').slice(0, 40), access: ['open', 'approve', 'friends'].includes(s.access) ? s.access : 'open', users: Number(s.users) || 0 })),
        seen: Date.now(),
      });
      if (!prev && onUpdate) onUpdate();
    });
    sock.bind(PORT, () => { try { sock.setBroadcast(true); } catch {} announce(); send({ k: 'kentovka', q: 1 }); });
  }
  start();
  timer = setInterval(() => {
    announce();
    let ch = false;
    for (const [id, p] of peers) if (Date.now() - p.seen > 12000) { peers.delete(id); ch = true; }
    if (ch && onUpdate) onUpdate();
  }, 3000);
  return {
    peers: () => [...peers.values()],
    servers: () => {
      const out = [];
      for (const p of peers.values()) for (const s of p.servers) out.push({ ...s, owner: p.name, ownerId: p.id, ip: p.ip, address: p.ip + ':' + s.port });
      return out;
    },
    byCode: (code) => [...peers.values()].find((p) => p.code === String(code).trim().toUpperCase()) || null,
    scan: () => send({ k: 'kentovka', q: 1 }),
    announce,
    close() { closed = true; clearInterval(timer); try { sock && sock.close(); } catch {} },
  };
}

module.exports = { createDiscovery, friendCode, DISCO_PORT: PORT };
