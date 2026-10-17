// Кентовка на Android: вместо preload из Electron — тот же preload.js, только IPC идёт по WebSocket к node.
(function () {
  'use strict';
  var K = window.__kentovkaAndroid || { role: 'main', port: 18444 };
  var SYNC = __SYNC__;
  var listeners = {};
  var pending = {};
  var queue = [];
  var seq = 0;
  var ws = null;
  function b64(buf) { var s = '', a = new Uint8Array(buf); for (var i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000)); return btoa(s); }
  function unb64(s) { var bin = atob(s), a = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
  function enc(v) {
    if (v instanceof ArrayBuffer) return { __b64: b64(v) };
    if (ArrayBuffer.isView(v)) return { __b64: b64(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)) };
    if (Array.isArray(v)) return v.map(enc);
    if (v && typeof v === 'object' && (v.constructor === Object || !v.constructor)) { var o = {}; for (var k in v) o[k] = enc(v[k]); return o; }
    return v;
  }
  function dec(v) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.__b64 === 'string' && Object.keys(v).length === 1) return unb64(v.__b64);
    if (Array.isArray(v)) return v.map(dec);
    if (v && typeof v === 'object') { var o = {}; for (var k in v) o[k] = dec(v[k]); return o; }
    return v;
  }
  function connect() {
    ws = new WebSocket('ws://127.0.0.1:' + K.port + '/rpc?role=' + K.role);
    ws.onopen = function () { var q = queue.splice(0); for (var i = 0; i < q.length; i++) ws.send(q[i]); if (K.role === 'main') ws.send(JSON.stringify({ t: 'page' })); };
    ws.onmessage = function (e) {
      var m; try { m = JSON.parse(e.data); } catch (x) { return; }
      if (m.id && pending[m.id]) { var p = pending[m.id]; delete pending[m.id]; if (m.err) p.reject(new Error(m.err)); else p.resolve(dec(m.r)); return; }
      if (m.ev) { var ls = listeners[m.ev] || []; var args = dec(m.args || []); for (var i = 0; i < ls.length; i++) { try { ls[i].apply(null, [{}].concat(args)); } catch (x) { console.error(x); } } }
    };
    ws.onclose = function () { setTimeout(connect, 800); };
  }
  function raw(s) { if (ws && ws.readyState === 1) ws.send(s); else queue.push(s); }
  var ipcRenderer = {
    invoke: function (ch) { var args = [].slice.call(arguments, 1); var id = ++seq; return new Promise(function (resolve, reject) { pending[id] = { resolve: resolve, reject: reject }; raw(JSON.stringify({ id: id, ch: ch, args: enc(args) })); }); },
    send: function (ch) { var args = [].slice.call(arguments, 1); raw(JSON.stringify({ ch: ch, args: enc(args) })); },
    sendSync: function (ch) { return SYNC[ch]; },
    on: function (ch, cb) { (listeners[ch] = listeners[ch] || []).push(cb); return ipcRenderer; },
    removeAllListeners: function (ch) { delete listeners[ch]; },
  };
  connect();
  var electron = {
    contextBridge: { exposeInMainWorld: function (k, v) { window[k] = v; } },
    ipcRenderer: ipcRenderer,
    webUtils: { getPathForFile: function () { return ''; } },
  };
  // на телефоне: запись экрана для демки в звонках и выбор устройств звука — через приложение (Java)
  if (window.KentovkaAndroid && !window.kAndroid) {
    var KJ = window.KentovkaAndroid;
    var j = function (x) { try { return JSON.parse(x); } catch (e) { return null; } };
    window.kAndroid = {
      android: true,
      audioDevices: function () { return j(KJ.audioDevices()); },
      setAudioDevice: function (kind, id) { KJ.setAudioDevice(String(kind), String(id)); },
    // демка с телефона: кадры записи экрана рисуем в canvas и отдаём как видеодорожку
      screenStream: (o) => new Promise((resolve) => {
        if (!KJ.startScreen) return resolve(null);
        window.__kScreen = (ok, w, h) => {
          window.__kScreen = null;
          if (!ok) return resolve(null);
          const c = document.createElement('canvas'); c.width = w; c.height = h;
          const g = c.getContext('2d'), fps = Math.max(2, Math.min(15, o.fps || 10));
          const st = c.captureStream(fps), tr = st.getVideoTracks()[0];
          let on = true, n = 0;
          const stopNative = tr.stop.bind(tr);
          tr.stop = () => { if (!on) return; on = false; try { KJ.stopScreen(); } catch {} stopNative(); };
          window.__kScreenEnd = () => { if (!on) return; on = false; stopNative(); tr.dispatchEvent(new Event('ended')); };
          const wait = (ms) => new Promise((r) => setTimeout(r, ms));
          (async () => {
            while (on) {
              const t0 = performance.now();
              try {
                const r = await fetch('/__kandroid_frame?n=' + (n++), { cache: 'no-store' });
                if (r.status === 200) {
                  const bm = await createImageBitmap(await r.blob());
                  if (c.width !== bm.width || c.height !== bm.height) { c.width = bm.width; c.height = bm.height; }
                  g.drawImage(bm, 0, 0); bm.close();
                }
              } catch {}
              await wait(Math.max(10, 1000 / fps - (performance.now() - t0)));
            }
          })();
          resolve(st);
        };
        KJ.startScreen(Math.max(o.w || 1280, o.h || 720), o.fps || 10);
      }),
    };
  }
  // фрейм внутри главной: ответы приложения (запись экрана) и кнопка «назад» приходят от главной страницы
  if (window.parent !== window) {
    window.addEventListener('message', function (e) {
      var d = e.data || {};
      if (d.k === 'kscreen' && window.__kScreen) window.__kScreen(d.ok, d.w, d.h);
      if (d.k === 'kscreen-end' && window.__kScreenEnd) window.__kScreenEnd();
      if (d.k === 'kback') { var h = false; try { h = !!(window.kentovkaBack && window.kentovkaBack()); } catch (x) {} try { e.source.postMessage({ k: 'kback-r', id: d.id, handled: h }, '*'); } catch (x) {} }
      if (d.k === 'kshown' && window.kentovkaShown) { try { window.kentovkaShown(!!d.on); } catch (x) {} }
      if (d.k === 'kpaste' && typeof d.d === 'string' && window.__kPasteImage) { try { window.__kPasteImage(d.d); } catch (x) {} }
    });
  }
  window.__kentovkaLocal = true; // для preload: это страница приложения (как file:// на ПК)
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', __PRELOAD__)(function (n) { return n === 'electron' ? electron : null; }, {}, {});
})();
