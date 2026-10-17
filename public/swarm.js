// Кентовка — раздача файлов между участниками (как торрент, но внутри вашей компании).
// Сервер (хост) только сообщает, у кого какие куски. Сами данные идут напрямую
// между компами по WebRTC. Каждый, кто скачал кусок, сразу раздаёт его другим.
// Скачанное и отправленное хранится в кеше на диске (IndexedDB браузера/приложения) — после перезахода
// скрины и файлы снова на месте, а ты снова их раздаёшь. Кеш сам чистится (по сроку и по размеру),
// его можно очистить кнопкой в настройках. Каждый кусок проверяется по SHA-256.
(function () {
  const CHUNK = 1024 * 1024;           // 1 МБ — кусок файла
  const FRAME = 64 * 1024;             // по каналу шлём кадрами по 64 КБ
  const HDR = 21;                      // заголовок кадра: тип(1) + id файла(12) + № куска(4) + смещение(4)
  const PER_PEER = 4;                  // одновременно запросов к одному кенту
  const TOTAL_INFLIGHT = 12;           // одновременно запросов всего
  const REQ_TIMEOUT = 20000;
  let CACHE_MAX = 2 * 1024 * 1024 * 1024;   // 2 ГБ кеша на всё (меняется в настройках)
  let CACHE_TTL = 7 * 24 * 60 * 60 * 1000;  // неделя без использования — удаляем (меняется в настройках)
  const MEM_IDLE = 10 * 60 * 1000;          // в памяти держим только то, что трогали последние 10 минут
  const MEM_BLOB_MAX = 24 * 1024 * 1024;    // большие файлы целиком в память не собираем — читаем с диска кусками
  const MAX_FILE = 2 * 1024 * 1024 * 1024;

  const hexToBytes = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
  const bytesToHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };

  // ---------- кеш на диске (IndexedDB) ----------
  // files: { id, meta, hashes, all, have: [№ кусков], lastUse, mine }   chunks: 'id:00042' -> ArrayBuffer
  function openDisk() {
    let dbp = null;
    const open = () => dbp || (dbp = new Promise((resolve) => {
      try {
        const r = indexedDB.open('kentovka-files', 1);
        r.onupgradeneeded = () => { r.result.createObjectStore('files', { keyPath: 'id' }); r.result.createObjectStore('chunks'); };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => resolve(null);
        r.onblocked = () => resolve(null);
      } catch { resolve(null); }
    }));
    const tx = async (stores, mode, fn) => {
      const db = await open(); if (!db) throw new Error('нет кеша');
      return new Promise((resolve, reject) => {
        const t = db.transaction(stores, mode); let out;
        Promise.resolve(fn(t)).then((v) => { out = v; });
        t.oncomplete = () => resolve(out); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error || new Error('abort'));
      });
    };
    const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const ck = (id, i) => id + ':' + String(i).padStart(5, '0');
    const range = (id) => IDBKeyRange.bound(id + ':', id + ':~');
    return {
      async list() { try { return await tx(['files'], 'readonly', (t) => req(t.objectStore('files').getAll())); } catch { return []; } },
      putChunk: (id, i, buf) => tx(['chunks'], 'readwrite', (t) => { t.objectStore('chunks').put(buf, ck(id, i)); }),
      getChunk: (id, i) => tx(['chunks'], 'readonly', (t) => req(t.objectStore('chunks').get(ck(id, i)))),
      putFile: (rec) => tx(['files'], 'readwrite', (t) => { t.objectStore('files').put(rec); }),
      del: (id) => tx(['files', 'chunks'], 'readwrite', (t) => { t.objectStore('files').delete(id); t.objectStore('chunks').delete(range(id)); }).catch(() => {}),
      wipe: () => tx(['files', 'chunks'], 'readwrite', (t) => { t.objectStore('files').clear(); t.objectStore('chunks').clear(); }).catch(() => {}),
    };
  }

  function createSwarm({ send, sendBinary, myId, onChange }) {
    const disk = openDisk();
    const files = new Map();   // id -> запись о файле
    const dpeers = new Map();  // id кента -> соединение для файлов
    const waiters = new Map(); // ответы сервера: key -> resolve
    let reqSeq = 0;
    const relayOnly = new Map(); // кент -> до какого времени качать у него через хоста (напрямую не соединились)
    const relayWait = new Map(); // rid -> ожидание куска через хоста
    const stats = { served: 0, got: {} }; // сколько кусков отдали; от кого сколько получили

    // ---------- запросы к серверу (кто что раздаёт, хэши кусков) ----------
    function ask(type, payload, timeout = 5000) {
      const rid = ++reqSeq;
      return new Promise((resolve) => {
        const t = setTimeout(() => { waiters.delete(rid); resolve(null); }, timeout);
        waiters.set(rid, (v) => { clearTimeout(t); resolve(v); });
        send({ type, rid, ...payload });
      });
    }

    function entry(meta) {
      let f = files.get(meta.id);
      if (!f) {
        f = { meta, n: Math.ceil(meta.size / meta.chunkSize) || 1, hashes: null, chunks: null, have: 0,
              blob: null, url: null, source: null, lastUse: Date.now(), loading: null, progress: 0, peers: 0, speed: 0,
              // для просмотра видео без скачивания: какие куски нужны срочно, кто их ждёт, докуда смотрим
              prio: [], waiters: new Map(), streaming: false, fullWanted: false, cursor: 0,
              // что лежит в кеше на диске: all — весь файл, set — отдельные куски
              disk: { all: false, set: new Set(), mine: false, saveT: null } };
        files.set(meta.id, f);
      }
      return f;
    }
    const complete = (f) => !!(f.blob || f.source || f.disk.all);
    const inMemory = (f) => !!(f.blob || f.source);
    const onDisk = (f, i) => f.disk.all || f.disk.set.has(i);
    // запись о файле на диске — не чаще раза в полсекунды
    function saveRec(f) {
      clearTimeout(f.disk.saveT);
      f.disk.saveT = setTimeout(() => {
        if (!files.has(f.meta.id) || !f.hashes) return;
        disk.putFile({ id: f.meta.id, meta: f.meta, hashes: f.hashes, all: f.disk.all, have: f.disk.all ? [] : [...f.disk.set], lastUse: f.lastUse, mine: f.disk.mine }).catch(() => {});
      }, 500);
    }
    function storeChunk(f, i, buf) {
      if (onDisk(f, i)) return Promise.resolve();
      return disk.putChunk(f.meta.id, i, buf).then(() => {
        if (!files.has(f.meta.id)) return;
        f.disk.set.add(i);
        if (f.disk.set.size >= f.n) { f.disk.all = true; f.disk.set.clear(); }
        saveRec(f);
      }).catch(() => {}); // нет места / кеш недоступен — работаем из памяти, как раньше
    }
    // свой файл тоже кладём в кеш — после перезахода его можно будет раздавать дальше
    async function storeOwn(f) {
      for (let i = 0; i < f.n && f.source && files.has(f.meta.id); i++) {
        if (onDisk(f, i)) continue;
        const buf = await f.source.slice(i * f.meta.chunkSize, i * f.meta.chunkSize + chunkLen(f, i)).arrayBuffer();
        await storeChunk(f, i, buf);
        if (!onDisk(f, i)) return; // не записалось — бросаем
      }
    }
    const chunkLen = (f, i) => Math.min(f.meta.chunkSize, f.meta.size - i * f.meta.chunkSize);

    // ---------- отдать свой файл ----------
    // prepare — посчитать хэши заранее (пока файл лежит во вложениях и ещё не отправлен)
    async function prepare(file, name, onPrep, isCancelled) {
      if (file.size > MAX_FILE) throw new Error('файл больше 2 ГБ');
      if (!file.size) throw new Error('пустой файл');
      const n = Math.ceil(file.size / CHUNK);
      const hashes = [];
      for (let i = 0; i < n; i++) {
        if (isCancelled && isCancelled()) throw new Error('отменено');
        const buf = await file.slice(i * CHUNK, Math.min(file.size, (i + 1) * CHUNK)).arrayBuffer();
        hashes.push(b64(await crypto.subtle.digest('SHA-256', buf)));
        if (onPrep && (i % 8 === 0 || i === n - 1)) onPrep((i + 1) / n);
      }
      const id = bytesToHex(crypto.getRandomValues(new Uint8Array(12)));
      return { file, hashes, meta: { id, name, size: file.size, mime: file.type || '', chunkSize: CHUNK } };
    }
    // offer — объявить файл всем (с подписью/ответом в extra)
    async function offer(prep, extra = {}) {
      const f = entry(prep.meta);
      f.source = prep.file; f.hashes = prep.hashes; f.have = f.n; f.progress = 1; f.disk.mine = true;
      const r = await ask('file-offer', { file: prep.meta, hashes: prep.hashes, ...extra }, 10000);
      if (!r || r.error) { files.delete(prep.meta.id); throw new Error((r && r.error) || 'сервер не ответил'); }
      setTimeout(() => storeOwn(f).then(enforceCache).catch(() => {}), 1500);
      return prep.meta;
    }
    async function share(file, name, onPrep, extra = {}) {
      return offer(await prepare(file, name, onPrep), extra);
    }

    // ---------- скачать файл (сразу у всех, у кого есть) ----------
    async function fromDisk(f) {
      const parts = [];
      for (let i = 0; i < f.n; i++) parts.push(await readChunk(f, i));
      if (parts.some((p) => !p)) throw new Error('gone');
      return new Blob(parts, { type: f.meta.mime || 'application/octet-stream' });
    }
    function fetchFile(meta, onProgress) {
      const f = entry(meta);
      f.lastUse = Date.now();
      if (inMemory(f)) return Promise.resolve(blobOf(f));
      if (f.disk.all) {
        // весь файл в кеше на диске — собираем (картинка, сохранение на компьютер)
        f.diskLoad = f.diskLoad || fromDisk(f).then((b) => { f.blob = b; return b; })
          .catch((e) => { f.disk.all = false; saveRec(f); throw e; }).finally(() => { f.diskLoad = null; });
        return f.diskLoad.catch(() => fetchFile(meta, onProgress));
      }
      f.fullWanted = true; // нужен весь файл (картинка, сохранение)
      if (onProgress) f.extraProgress = onProgress;
      return ensureLoading(f).then((b) => (b instanceof Blob ? b : fetchFile(meta, onProgress)));
    }
    function ensureLoading(f, onProgress) {
      if (!f.loading) {
        f.loading = download(f, onProgress)
          .catch((e) => { failWaiters(f, e); throw e; })
          .finally(() => { f.loading = null; });
      }
      return f.loading;
    }
    function failWaiters(f, e) {
      for (const list of f.waiters.values()) for (const w of list) w.reject(e);
      f.waiters.clear();
    }
    const hasChunk = (f, i) => complete(f) || !!(f.chunks && f.chunks[i]) || onDisk(f, i);
    function waitChunk(f, i) {
      if (hasChunk(f, i)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        if (!f.waiters.has(i)) f.waiters.set(i, []);
        f.waiters.get(i).push({ resolve, reject });
      });
    }

    // кусок видео по запросу плеера: нужные куски качаются первыми, плюс немного вперёд
    const AHEAD = 3;  // ~3 МБ запаса вперёд — не качаем весь фильм, если смотрят начало
    async function readRange(meta, start, end) {
      const f = entry(meta);
      f.lastUse = Date.now();
      const cs = meta.chunkSize;
      end = Math.min(end, meta.size - 1);
      if (start > end) return new Uint8Array(0);
      const i0 = Math.floor(start / cs), i1 = Math.floor(end / cs);
      if (!complete(f)) {
        f.streaming = true;
        // смотрят ролик — через 20 с тихо докачиваем его целиком (до 500 МБ): тогда он не оборвётся на середине,
        // даже если отправитель выйдет, и останется в кеше. Большие фильмы — только то, что смотрят.
        if (!f.fullTimer && !f.fullWanted && meta.size <= 500 * 1024 * 1024) f.fullTimer = setTimeout(() => { f.fullWanted = true; ensureLoading(f).catch(() => {}); wake(); }, 20000);
        f.cursor = i1 + 1;
        const need = [];
        for (let i = i0; i <= i1; i++) if (!hasChunk(f, i)) need.push(i);
        if (need.length) {
          f.prio = [...need, ...f.prio.filter((x) => !need.includes(x))].slice(0, 32);
          ensureLoading(f).catch(() => {});
          wake();
          await Promise.all(need.map((i) => waitChunk(f, i)));
        } else if (!f.loading && f.have < f.n) {
          ensureLoading(f).catch(() => {}); // докачиваем запас вперёд
        }
      }
      const out = new Uint8Array(end - start + 1);
      let pos = 0;
      for (let i = i0; i <= i1; i++) {
        const buf = new Uint8Array(await readChunk(f, i));
        const from = i === i0 ? start - i * cs : 0;
        const to = i === i1 ? end - i * cs + 1 : buf.length;
        out.set(buf.subarray(from, to), pos);
        pos += to - from;
      }
      return out;
    }

    async function download(f, onProgress) {
      const report = () => {
        const cb = onProgress || f.extraProgress;
        if (cb) cb({ progress: f.have / f.n, peers: f.peers, speed: f.speed });
        onChange && onChange(f.meta.id);
      };
      if (!f.hashes) {
        const r = await ask('manifest', { id: f.meta.id });
        if (!r || !r.hashes) throw new Error('gone');
        f.hashes = r.hashes;
      }
      if (!f.chunks) f.chunks = new Array(f.n).fill(null);
      f.have = 0; for (let i = 0; i < f.n; i++) if (f.chunks[i] || onDisk(f, i)) f.have++; // часть уже в кеше на диске
      const order = shuffle([...Array(f.n).keys()]); // случайный порядок — куски расходятся по всем быстрее
      // что качать сейчас: срочные куски плеера → запас вперёд от места просмотра → (если нужен весь файл) остальное
      const candidates = () => {
        const list = f.prio.filter((i) => !hasChunk(f, i));
        if (f.streaming) for (let i = f.cursor; i < Math.min(f.n, f.cursor + AHEAD); i++) list.push(i);
        if (f.fullWanted) {
          if (f.streaming) { for (let i = f.cursor; i < f.n; i++) list.push(i); for (let i = 0; i < f.cursor; i++) list.push(i); }
          else list.push(...order);
        }
        return list;
      };
      let idleSince = 0;
      const inflight = new Map(); // № куска -> id кента
      const perPeer = new Map();
      const banned = new Map();   // кент -> до какого времени не трогать
      let holders = {}, lastPoll = 0, bytes = 0, t0 = Date.now(), noHolderSince = 0;

      while (f.have < f.n) {
        if (Date.now() - lastPoll > 1500) {
          lastPoll = Date.now();
          const r = await ask('holders', { id: f.meta.id });
          holders = (r && r.holders) || {};
          delete holders[myId()];
          const ids = Object.keys(holders);
          f.peers = ids.length;
          if (!ids.length) {
            if (!noHolderSince) noHolderSince = Date.now();
            if (Date.now() - noHolderSince > 8000) throw new Error('gone');
          } else noHolderSince = 0;
          report();
        }
        // раздаём запросы: каждому кенту не больше PER_PEER, всего не больше TOTAL_INFLIGHT
        const want = candidates();
        if (!f.fullWanted && !inflight.size && !want.some((i) => !hasChunk(f, i))) {
          // смотрят видео, запас набран — ставим загрузку на паузу, чтобы не грузить интернет
          if (!idleSince) idleSince = Date.now();
          if (Date.now() - idleSince > 3000) { report(); return null; }
        } else idleSince = 0;
        for (const i of want) {
          if (inflight.size >= TOTAL_INFLIGHT) break;
          if (hasChunk(f, i) || inflight.has(i)) continue;
          const cands = Object.entries(holders)
            .filter(([pid, h]) => (h === 'all' || h.includes(i)) && (perPeer.get(pid) || 0) < PER_PEER && !((banned.get(pid) || 0) > Date.now()))
            .map(([pid]) => pid);
          if (!cands.length) continue;
          // к кому меньше всего запросов, при равенстве — случайно
          cands.sort((a, b) => (perPeer.get(a) || 0) - (perPeer.get(b) || 0) || Math.random() - 0.5);
          const pid = cands[0];
          inflight.set(i, pid);
          perPeer.set(pid, (perPeer.get(pid) || 0) + 1);
          requestChunk(Number(pid), f, i).then(async (buf) => {
            const h = b64(await crypto.subtle.digest('SHA-256', buf));
            if (h !== f.hashes[i]) throw new Error('битый кусок');
            if (!f.chunks || f.chunks[i] || onDisk(f, i)) return;
            f.chunks[i] = buf; f.have++; bytes += buf.byteLength;
            storeChunk(f, i, buf);
            f.prio = f.prio.filter((x) => x !== i);
            const ws = f.waiters.get(i); if (ws) { f.waiters.delete(i); ws.forEach((w) => w.resolve()); }
            stats.got[pid] = (stats.got[pid] || 0) + 1;
            f.speed = bytes / Math.max(0.5, (Date.now() - t0) / 1000);
            send({ type: 'have', id: f.meta.id, i }); // теперь и мы раздаём этот кусок
            report();
          }).catch(() => { banned.set(pid, Date.now() + 5000); })
            .finally(() => { inflight.delete(i); perPeer.set(pid, (perPeer.get(pid) || 1) - 1); wake(); });
        }
        await waitWake(400);
      }
      if (f.meta.size <= MEM_BLOB_MAX || !f.disk.all) {
        // недостающие в памяти куски (были в кеше на диске) — дочитываем
        for (let i = 0; i < f.n; i++) if (!f.chunks[i]) f.chunks[i] = await readChunk(f, i);
        if (f.chunks.some((c) => !c)) throw new Error('gone');
        f.blob = new Blob(f.chunks, { type: f.meta.mime || 'application/octet-stream' });
      }
      f.chunks = null; // дальше раздаём кусками из blob или с диска
      for (const ws of f.waiters.values()) ws.forEach((w) => w.resolve());
      f.waiters.clear();
      send({ type: 'have', id: f.meta.id, all: true });
      report();
      enforceCache();
      return f.blob || (f.disk.all ? true : blobOf(f));
    }
    const wakers = new Set();
    const wake = () => { for (const w of [...wakers]) w(); };
    const waitWake = (ms) => new Promise((r) => {
      const done = () => { wakers.delete(done); clearTimeout(t); r(); };
      const t = setTimeout(done, ms);
      wakers.add(done);
    });

    function blobOf(f) {
      f.lastUse = Date.now();
      return f.source || f.blob;
    }

    async function readChunk(f, i) {
      if (f.chunks && f.chunks[i]) return f.chunks[i];
      const src = f.source || f.blob;
      if (src) return src.slice(i * f.meta.chunkSize, i * f.meta.chunkSize + chunkLen(f, i)).arrayBuffer();
      if (onDisk(f, i)) {
        const b = await disk.getChunk(f.meta.id, i).catch(() => null);
        if (b && b.byteLength === chunkLen(f, i)) return b;
        f.disk.all = false; f.disk.set.delete(i); saveRec(f); // кусок пропал с диска
      }
      return null;
    }

    // ---------- соединения для файлов ----------
    // кто открывает соединение: всегда кент с меньшим id (так не бывает «встречных» звонков)
    function getPeer(pid) {
      let p = dpeers.get(pid);
      if (p && !p.dead) return p;
      p = { id: pid, pc: new RTCPeerConnection({ iceServers: [] }), dc: null, pendingIce: [], pending: new Map(), queue: [], sending: false, dead: false };
      p.ready = new Promise((res, rej) => { p.resolve = res; p.reject = rej; });
      p.ready.catch(() => {}); // сорвалось — не страшно, кусок возьмём через хоста
      p.timer = setTimeout(() => kill(p, 'timeout'), 6000);
      dpeers.set(pid, p);
      p.pc.onicecandidate = (e) => {
        if (!e.candidate) return;
        // только IPv4 + UDP — как и для голоса
        const str = e.candidate.candidate || '', addr = str.split(' ')[4] || '';
        if (str && (/ tcp /i.test(str) || addr.includes(':') || addr.endsWith('.local'))) return;
        send({ type: 'dsignal', to: pid, data: { candidate: e.candidate } });
      };
      p.pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(p.pc.connectionState)) kill(p, 'closed'); };
      p.pc.ondatachannel = (e) => setupChannel(p, e.channel);
      if (myId() < pid) {
        setupChannel(p, p.pc.createDataChannel('files', { ordered: true }));
        p.pc.createOffer().then((o) => p.pc.setLocalDescription(o))
          .then(() => send({ type: 'dsignal', to: pid, data: { sdp: p.pc.localDescription } })).catch(() => kill(p, 'offer'));
      } else {
        send({ type: 'dsignal', to: pid, data: { want: true } });
      }
      return p;
    }

    function kill(p, why) {
      if (p.dead) return;
      p.dead = true;
      clearTimeout(p.timer);
      try { p.pc.close(); } catch {}
      for (const r of p.pending.values()) r.reject(new Error(why));
      p.pending.clear();
      p.reject(new Error(why));
      if (dpeers.get(p.id) === p) dpeers.delete(p.id);
    }

    function setupChannel(p, dc) {
      p.dc = dc;
      dc.binaryType = 'arraybuffer';
      dc.bufferedAmountLowThreshold = 1024 * 1024;
      dc.onopen = () => { clearTimeout(p.timer); p.resolve(); };
      dc.onclose = () => kill(p, 'closed');
      dc.onbufferedamountlow = () => pump(p);
      dc.onmessage = (e) => onData(p, e.data);
    }

    async function onSignal(from, data) {
      if (data.want) { if (myId() < from) { const old = dpeers.get(from); if (old) kill(old, 'renew'); getPeer(from); } return; }
      let p = dpeers.get(from);
      if (data.sdp && data.sdp.type === 'offer') {
        if (!p || p.dead) p = getPeer(from);
        await p.pc.setRemoteDescription(data.sdp);
        for (const c of p.pendingIce) await p.pc.addIceCandidate(c).catch(() => {});
        p.pendingIce = [];
        await p.pc.setLocalDescription(await p.pc.createAnswer());
        send({ type: 'dsignal', to: from, data: { sdp: p.pc.localDescription } });
      } else if (data.sdp && p) {
        await p.pc.setRemoteDescription(data.sdp).catch(() => {});
        for (const c of p.pendingIce) await p.pc.addIceCandidate(c).catch(() => {});
        p.pendingIce = [];
      } else if (data.candidate && p) {
        if (p.pc.remoteDescription) await p.pc.addIceCandidate(data.candidate).catch(() => {});
        else p.pendingIce.push(data.candidate);
      }
    }

    // ---------- обмен кусками ----------
    async function requestChunk(pid, f, i) {
      if ((relayOnly.get(pid) || 0) > Date.now()) return relayChunk(pid, f, i);
      let p;
      try { p = getPeer(pid); await p.ready; } catch {
        // напрямую не вышло (например, разные сети) — следующую минуту качаем у него через хоста транзитом
        relayOnly.set(pid, Date.now() + 60000);
        return relayChunk(pid, f, i);
      }
      const key = f.meta.id + ':' + i;
      return new Promise((resolve, reject) => {
        const len = chunkLen(f, i);
        const t = setTimeout(() => { p.pending.delete(key); reject(new Error('timeout')); }, REQ_TIMEOUT);
        p.pending.set(key, {
          buf: new Uint8Array(len), got: 0, len,
          resolve: (b) => { clearTimeout(t); resolve(b); },
          reject: (e) => { clearTimeout(t); reject(e); },
        });
        p.dc.send(JSON.stringify({ t: 'req', f: f.meta.id, i }));
      });
    }

    async function onData(p, data) {
      if (typeof data === 'string') {
        let m; try { m = JSON.parse(data); } catch { return; }
        if (m.t === 'req') serveChunk(p, m.f, m.i);
        else if (m.t === 'no') { const r = p.pending.get(m.f + ':' + m.i); if (r) { p.pending.delete(m.f + ':' + m.i); r.reject(new Error('no')); } }
        return;
      }
      const u8 = new Uint8Array(data);
      if (u8.length < HDR || u8[0] !== 1) return;
      const id = bytesToHex(u8.subarray(1, 13));
      const dv = new DataView(data);
      const i = dv.getUint32(13), off = dv.getUint32(17);
      const key = id + ':' + i;
      const r = p.pending.get(key);
      if (!r) return;
      const payload = u8.subarray(HDR);
      if (off + payload.length > r.len) return;
      r.buf.set(payload, off);
      r.got += payload.length;
      if (r.got >= r.len) { p.pending.delete(key); r.resolve(r.buf.buffer); }
    }

    async function serveChunk(p, id, i) {
      const f = files.get(id);
      const ok = f && Number.isInteger(i) && i >= 0 && i < f.n && hasChunk(f, i);
      const raw = ok ? await readChunk(f, i) : null;
      if (!raw) { try { p.dc.send(JSON.stringify({ t: 'no', f: id, i })); } catch {} return; }
      f.lastUse = Date.now();
      stats.served++;
      const buf = new Uint8Array(raw);
      const idb = hexToBytes(id);
      for (let off = 0; off < buf.length; off += FRAME - HDR) {
        const part = buf.subarray(off, Math.min(buf.length, off + FRAME - HDR));
        const fr = new Uint8Array(HDR + part.length);
        fr[0] = 1; fr.set(idb, 1);
        const dv = new DataView(fr.buffer); dv.setUint32(13, i); dv.setUint32(17, off);
        fr.set(part, HDR);
        p.queue.push(fr);
      }
      pump(p);
    }

    function pump(p) {
      if (!p.dc || p.dc.readyState !== 'open') return;
      while (p.queue.length && p.dc.bufferedAmount < 4 * 1024 * 1024) {
        try { p.dc.send(p.queue.shift()); } catch { return; }
      }
    }

    // ---------- запасной путь: кусок через хоста (транзитом, без сохранения) ----------
    function relayChunk(pid, f, i) {
      const rid = ++reqSeq;
      const len = chunkLen(f, i);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { relayWait.delete(rid); reject(new Error('timeout')); }, REQ_TIMEOUT);
        relayWait.set(rid, { len, resolve: (b) => { clearTimeout(t); resolve(b); }, reject: (e) => { clearTimeout(t); reject(e); } });
        send({ type: 'relay-req', to: pid, f: f.meta.id, i, rid });
      });
    }
    async function serveRelay(from, id, i, rid) {
      const f = files.get(id);
      const ok = f && Number.isInteger(i) && i >= 0 && i < f.n && hasChunk(f, i);
      const raw = ok ? await readChunk(f, i) : null;
      const data = raw ? new Uint8Array(raw) : new Uint8Array(0);
      if (raw) { stats.served++; f.lastUse = Date.now(); }
      const fr = new Uint8Array(8 + data.length);
      const dv = new DataView(fr.buffer);
      dv.setUint32(0, from); dv.setUint32(4, rid);
      fr.set(data, 8);
      sendBinary(fr.buffer);
    }
    function onBinary(buf) {
      if (buf.byteLength < 8) return;
      const dv = new DataView(buf);
      const rid = dv.getUint32(4);
      const w = relayWait.get(rid);
      if (!w) return;
      relayWait.delete(rid);
      if (buf.byteLength - 8 !== w.len) return w.reject(new Error('no'));
      w.resolve(buf.slice(8));
    }

    // ---------- кеш: чистим старое и лишнее ----------
    const sizeOf = (f) => (f.disk.all ? f.meta.size : f.disk.set.size * f.meta.chunkSize);
    function enforceCache() {
      const now = Date.now();
      let total = 0;
      for (const f of [...files.values()]) {
        if (f.loading || f.source) continue;
        // память: давно не трогали — отпускаем (на диске копия осталась)
        if (now - f.lastUse > MEM_IDLE) {
          if (f.chunks) for (let i = 0; i < f.n; i++) if (f.chunks[i] && onDisk(f, i)) f.chunks[i] = null;
          // большие файлы держим на диске, а не в памяти; картинки оставляем — они на экране в чате
          if (f.blob && f.disk.all && f.meta.size > MEM_BLOB_MAX) { f.blob = null; if (f.url) { URL.revokeObjectURL(f.url); f.url = null; } }
        }
        const stored = sizeOf(f) || (f.blob ? f.meta.size : f.chunks ? f.have * f.meta.chunkSize : 0);
        if (!stored) continue;
        if (now - f.lastUse > CACHE_TTL) evict(f); else total += stored;
      }
      [...files.values()].filter((f) => !f.loading && !f.source && (sizeOf(f) || f.blob)).sort((a, b) => a.lastUse - b.lastUse).forEach((f) => {
        if (total > CACHE_MAX) { total -= sizeOf(f) || f.meta.size; evict(f); }
      });
    }
    function evict(f) {
      failWaiters(f, new Error('evicted'));
      f.chunks = null; f.blob = null; clearTimeout(f.disk.saveT);
      if (f.url) URL.revokeObjectURL(f.url);
      files.delete(f.meta.id);
      disk.del(f.meta.id);
      send({ type: 'drop', id: f.meta.id });
      onChange && onChange(f.meta.id);
    }
    setInterval(enforceCache, 60 * 1000);

    // при запуске — что лежит в кеше с прошлого раза
    const loaded = disk.list().then((recs) => {
      for (const r of recs) {
        if (!r || !r.meta || !r.hashes) continue;
        if (Date.now() - (r.lastUse || 0) > CACHE_TTL) { disk.del(r.id); continue; }
        const f = entry(r.meta); // сообщение с этим файлом могло прийти раньше — дополняем
        if (f.source) continue;
        f.hashes = f.hashes || r.hashes; f.lastUse = Math.max(f.lastUse, r.lastUse || 0); f.disk.mine = !!r.mine;
        f.disk.all = !!r.all; for (const i of r.all ? [] : r.have || []) f.disk.set.add(i);
        if (!f.chunks) f.have = f.disk.all ? f.n : f.disk.set.size;
        onChange && onChange(f.meta.id);
      }
      announceDisk();
    });
    let connected = false;
    function announceDisk() {
      if (!connected) return;
      for (const f of files.values()) {
        if (f.source) continue;
        if (f.disk.all) send({ type: 'file-reoffer', id: f.meta.id, file: f.meta, hashes: f.hashes });
        else for (const i of f.disk.set) send({ type: 'have', id: f.meta.id, i });
      }
    }

    return {
      share, prepare, offer, onBinary, readRange,
      know(meta) { entry(meta); },
      fetch: fetchFile,
      // объектная ссылка для показа (картинка/видео) — живёт, пока файл в кеше
      url(meta) {
        const f = files.get(meta.id);
        if (!f || !inMemory(f)) return null;
        f.lastUse = Date.now();
        if (!f.url) f.url = URL.createObjectURL(blobOf(f));
        return f.url;
      },
      state(id) {
        const f = files.get(id);
        if (!f) return { cached: false };
        // cached — готов в памяти (можно показать сразу), stored — весь файл лежит в кеше на диске
        return { cached: inMemory(f), stored: f.disk.all, loading: !!f.loading || !!f.diskLoad, progress: f.have / f.n, peers: f.peers, speed: f.speed, mine: !!f.source || f.disk.mine };
      },
      onServer(m) {
        if (m.type === 'swarm-reply') { const w = waiters.get(m.rid); if (w) { waiters.delete(m.rid); w(m); } }
        else if (m.type === 'dsignal') onSignal(m.from, m.data);
        else if (m.type === 'relay-req') serveRelay(m.from, m.f, m.i, m.rid);
      },
      peerLeft(pid) { const p = dpeers.get(pid); if (p) kill(p, 'left'); },
      // после переподключения к серверу заново сообщаем, что у нас есть
      reannounce() {
        connected = true;
        for (const f of files.values()) {
          if (f.source) send({ type: 'file-reoffer', id: f.meta.id, file: f.meta, hashes: f.hashes });
          else if (f.blob && !f.disk.all) send({ type: 'have', id: f.meta.id, all: true });
        }
        loaded.then(announceDisk);
      },
      ready: () => loaded,
      // выход в меню: отпускаем память, кеш на диске остаётся
      clear() {
        connected = false;
        for (const f of [...files.values()]) {
          if (f.source) continue;
          failWaiters(f, new Error('closed'));
          f.chunks = null; f.blob = null; if (f.url) { URL.revokeObjectURL(f.url); f.url = null; }
        }
      },
      // кнопка «Очистить кеш»: всё скачанное и копии своих файлов — с диска и из памяти
      async wipe() {
        for (const f of [...files.values()]) {
          if (f.source) { f.disk.all = false; f.disk.set.clear(); f.disk.mine = false; clearTimeout(f.disk.saveT); continue; }
          if (f.loading) continue;
          evict(f);
        }
        await disk.wipe();
      },
      // сообщение с файлом удалили — забываем файл (и в кеше на диске)
      drop(id) { const f = files.get(id); if (f && !f.source && !f.loading) evict(f); else if (f && f.source) { f.disk.all = false; f.disk.set.clear(); disk.del(id); } },
      cacheSize() { let s = 0; for (const f of files.values()) s += sizeOf(f); return s; },
      setLimits({ maxBytes, ttlMs }) { if (maxBytes > 0) CACHE_MAX = maxBytes; if (ttlMs > 0) CACHE_TTL = ttlMs; enforceCache(); },
      MAX_FILE,
      stats: () => JSON.parse(JSON.stringify(stats)),
    };
  }

  window.KentovkaSwarm = { create: createSwarm };
})();
