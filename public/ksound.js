// Звуки Кентовки: свои, фирменные (синтез прямо в браузере — без файлов) и можно поставить свой файл на любое событие.
// Одинаковые на серверах, в друзьях и в звонках. В приложении свои файлы и громкость хранятся в настройках приложения.
(function () {
  'use strict';
  if (window.KSound) return;
  const APP = window.kentovkaApp || null;
  const EVENTS = [
    ['message', 'Сообщение на сервере'],
    ['dm', 'Сообщение в личке'],
    ['join', 'Кто-то зашёл в голос'],
    ['leave', 'Кто-то вышел из голоса'],
    ['mute', 'Микрофон выключен'],
    ['unmute', 'Микрофон включён'],
    ['deaf', 'Звук выключен'],
    ['undeaf', 'Звук включён'],
    ['stream', 'Кто-то показывает экран'],
    ['online', 'Друг в сети'],
    ['ringIn', 'Входящий звонок'],
    ['ringOut', 'Исходящий звонок (гудки)'],
    ['callStart', 'Звонок соединился'],
    ['callEnd', 'Звонок закончился'],
  ];
  let ctx = null, master = null, verb = null, sink = '';
  let vol = 1, on = true, custom = {}; // custom: { событие: data:audio/... }
  const buffers = new Map();
  try { const l = JSON.parse(localStorage.getItem('ksound') || 'null'); if (l) { vol = l.vol ?? 1; on = l.on ?? true; custom = l.custom || {}; } } catch {}
  const ready = (async () => {
    if (APP && APP.soundsGet) { try { const s = await APP.soundsGet(); if (s) { vol = s.vol ?? vol; on = s.on ?? on; custom = s.custom || {}; } } catch {} }
  })();
  if (APP && APP.onSounds) APP.onSounds((s) => { if (!s) return; vol = s.vol ?? vol; on = s.on ?? on; custom = s.custom || {}; buffers.clear(); });

  function ac() {
    if (!ctx || ctx.state === 'closed') {
      ctx = new AudioContext({ latencyHint: 'interactive' });
      master = ctx.createGain(); master.gain.value = 1;
      // лёгкое «неоновое» эхо: короткая задержка с затуханием и мягкими верхами
      const d = ctx.createDelay(0.5); d.delayTime.value = 0.13;
      const fb = ctx.createGain(); fb.gain.value = 0.28;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200;
      verb = ctx.createGain(); verb.gain.value = 0.35;
      verb.connect(d); d.connect(lp); lp.connect(fb); fb.connect(d); lp.connect(master);
      master.connect(ctx.destination);
      if (sink && ctx.setSinkId) ctx.setSinkId(sink).catch(() => {});
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }
  document.addEventListener('pointerdown', () => { if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {}); }, true);

  // одна нота: частота, начало, длительность; тембр — смесь синуса и «стеклянного» обертона (FM)
  function note(c, out, f, t, dur, o = {}) {
    const g = c.createGain(), osc = c.createOscillator();
    osc.type = o.type || 'sine'; osc.frequency.setValueAtTime(f, t);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + dur * 0.8);
    if (o.fm) { const m = c.createOscillator(), mg = c.createGain(); m.frequency.value = f * (o.fmRatio || 2); mg.gain.setValueAtTime(f * o.fm, t); mg.gain.exponentialRampToValueAtTime(1, t + dur); m.connect(mg); mg.connect(osc.frequency); m.start(t); m.stop(t + dur + 0.05); }
    const a = o.a || 0.006, peak = (o.v || 0.22);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g); g.connect(out); if (o.wet !== false) g.connect(verb);
    osc.start(t); osc.stop(t + dur + 0.05);
  }
  // фирменные звуки: светлые «стеклянные» щипки, восходящие — хорошее, нисходящие — уход/выключение
  const SYN = {
    message: (c, o, t) => { note(c, o, 1318.5, t, 0.22, { fm: 1.2, fmRatio: 3, v: 0.16 }); note(c, o, 1975.5, t + 0.07, 0.3, { fm: 0.8, fmRatio: 3, v: 0.12 }); },
    dm: (c, o, t) => { note(c, o, 987.8, t, 0.18, { fm: 1, fmRatio: 2.5, v: 0.15 }); note(c, o, 1318.5, t + 0.08, 0.2, { fm: 1, fmRatio: 2.5, v: 0.14 }); note(c, o, 1760, t + 0.16, 0.32, { fm: 0.7, fmRatio: 2.5, v: 0.12 }); },
    join: (c, o, t) => { note(c, o, 440, t, 0.26, { to: 660, type: 'triangle', v: 0.14 }); note(c, o, 880, t + 0.12, 0.34, { fm: 0.6, v: 0.12 }); },
    leave: (c, o, t) => { note(c, o, 660, t, 0.26, { to: 392, type: 'triangle', v: 0.14 }); note(c, o, 523.3, t + 0.12, 0.3, { fm: 0.4, v: 0.1 }); },
    mute: (c, o, t) => { note(c, o, 587.3, t, 0.09, { type: 'triangle', v: 0.14, wet: false }); note(c, o, 392, t + 0.07, 0.12, { type: 'triangle', v: 0.13, wet: false }); },
    unmute: (c, o, t) => { note(c, o, 392, t, 0.09, { type: 'triangle', v: 0.14, wet: false }); note(c, o, 587.3, t + 0.07, 0.12, { type: 'triangle', v: 0.13, wet: false }); },
    deaf: (c, o, t) => { note(c, o, 349.2, t, 0.12, { type: 'triangle', v: 0.15, wet: false }); note(c, o, 233.1, t + 0.09, 0.18, { type: 'triangle', v: 0.14, wet: false }); },
    undeaf: (c, o, t) => { note(c, o, 233.1, t, 0.12, { type: 'triangle', v: 0.15, wet: false }); note(c, o, 349.2, t + 0.09, 0.18, { type: 'triangle', v: 0.14, wet: false }); },
    stream: (c, o, t) => { [523.3, 659.3, 784, 1046.5].forEach((f, i) => note(c, o, f, t + i * 0.06, 0.28, { fm: 0.9, fmRatio: 3, v: 0.11 })); },
    online: (c, o, t) => { note(c, o, 1046.5, t, 0.35, { fm: 1.4, fmRatio: 3.5, v: 0.12 }); },
    ringIn: (c, o, t) => { [784, 987.8, 1174.7, 987.8].forEach((f, i) => note(c, o, f, t + i * 0.14, 0.32, { fm: 1.1, fmRatio: 4, v: 0.17 })); [784, 987.8, 1174.7, 1568].forEach((f, i) => note(c, o, f, t + 0.75 + i * 0.14, 0.34, { fm: 1.1, fmRatio: 4, v: 0.17 })); },
    ringOut: (c, o, t) => { note(c, o, 440, t, 0.9, { type: 'sine', v: 0.09, a: 0.04, wet: false }); note(c, o, 554.4, t, 0.9, { type: 'sine', v: 0.05, a: 0.04, wet: false }); },
    callStart: (c, o, t) => { note(c, o, 659.3, t, 0.16, { fm: 0.8, v: 0.14 }); note(c, o, 987.8, t + 0.1, 0.3, { fm: 0.8, v: 0.13 }); },
    callEnd: (c, o, t) => { note(c, o, 659.3, t, 0.18, { type: 'triangle', v: 0.13 }); note(c, o, 440, t + 0.12, 0.3, { type: 'triangle', v: 0.12 }); },
  };
  const LOOP = { ringIn: 2400, ringOut: 3000 };

  async function bufferOf(name) {
    const src = custom[name]; if (!src) return null;
    if (buffers.has(name)) return buffers.get(name);
    const p = (async () => { try { const r = await fetch(src); return await ac().decodeAudioData(await r.arrayBuffer()); } catch { return null; } })();
    buffers.set(name, p); return p;
  }
  async function play(name, level) {
    await ready;
    if (!on && level === undefined) return;
    const c = ac(), t = c.currentTime + 0.01;
    const g = c.createGain(); g.gain.value = Math.max(0, Math.min(2, (level ?? 1) * vol)); g.connect(master);
    const buf = await bufferOf(name);
    if (buf) { const s = c.createBufferSource(); s.buffer = buf; s.connect(g); s.start(t); s.onended = () => { try { g.disconnect(); } catch {} }; return s; }
    if (SYN[name]) { SYN[name](c, g, t); setTimeout(() => { try { g.disconnect(); } catch {} }, 4000); }
    return null;
  }
  // повтор (звонок): возвращает «остановить»
  function loop(name, level) {
    let stopped = false, cur = null, timer = null;
    const go = async () => { if (stopped) return; cur = await play(name, level); const buf = custom[name] ? await bufferOf(name) : null; timer = setTimeout(go, buf ? Math.max(800, buf.duration * 1000 + 400) : LOOP[name] || 2500); };
    go();
    return () => { stopped = true; clearTimeout(timer); try { cur && cur.stop(); } catch {} };
  }
  function persist() {
    try { localStorage.setItem('ksound', JSON.stringify({ vol, on, custom: APP && APP.soundsSet ? {} : custom })); } catch {}
    if (APP && APP.soundsSet) APP.soundsSet({ vol, on });
  }
  async function setCustom(name, dataUrl) {
    buffers.delete(name);
    if (dataUrl) custom[name] = dataUrl; else delete custom[name];
    if (APP && APP.soundsSet) { const r = await APP.soundsSet({ name, data: dataUrl || null }); if (r && r.error) throw new Error(r.error); }
    else persist();
  }
  // строки «событие — ▶ — свой файл — сброс» для настроек
  function renderSettings(box) {
    box.innerHTML = '';
    box.classList.add('ksnd');
    if (!document.getElementById('ksnd-css')) {
      const st = document.createElement('style'); st.id = 'ksnd-css';
      st.textContent = `.ksnd { display: flex; flex-direction: column; gap: 2px; margin: 6px 0 4px; }
        .ksnd .r { display: flex; align-items: center; gap: 6px; padding: 5px 6px; border-radius: 9px; font-size: 13.5px; }
        .ksnd .r:hover { background: var(--panel2, #171a2a); }
        .ksnd .r span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .ksnd .r small { color: var(--accent, #22e1ff); font-size: 11.5px; margin-left: 6px; }
        .ksnd .r button { padding: 5px 9px; border-radius: 8px; font: 600 12px var(--font-display, sans-serif); background: var(--panel3, #1e2236); color: var(--text, #e6e8ff); border: 1px solid var(--line, #262a40); cursor: pointer; flex: none; }
        .ksnd .r button:hover { border-color: var(--accent, #22e1ff); }
        .ksnd .r button.play { width: 30px; padding: 5px 0; }`;
      document.head.appendChild(st);
    }
    ready.then(() => {
      for (const [k, label] of EVENTS) {
        const r = document.createElement('div'); r.className = 'r';
        const nm = document.createElement('span'); nm.textContent = label;
        if (custom[k]) { const s = document.createElement('small'); s.textContent = 'свой'; nm.appendChild(s); }
        const pl = document.createElement('button'); pl.type = 'button'; pl.className = 'play'; pl.textContent = '▶'; pl.title = 'Послушать';
        pl.onclick = () => play(k, 1);
        const up = document.createElement('button'); up.type = 'button'; up.textContent = custom[k] ? 'Заменить' : 'Свой звук'; up.title = 'Поставить свой файл (mp3, ogg, wav — до 1 МБ)';
        up.onclick = () => {
          const f = document.createElement('input'); f.type = 'file'; f.accept = 'audio/*';
          f.onchange = async () => {
            const file = f.files[0]; if (!file) return;
            if (file.size > 1024 * 1024) { (window.kSay || alert)('Файл больше 1 МБ — возьми покороче (звуку хватит пары секунд).'); return; }
            const url = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(file); });
            try { await setCustom(k, url); play(k, 1); } catch (e) { (window.kSay || alert)('Не получилось: ' + e.message); }
            renderSettings(box);
          };
          f.click();
        };
        r.append(nm, pl, up);
        if (custom[k]) { const rs = document.createElement('button'); rs.type = 'button'; rs.textContent = 'Как было'; rs.title = 'Вернуть звук Кентовки'; rs.onclick = async () => { await setCustom(k, null); renderSettings(box); }; r.appendChild(rs); }
        box.appendChild(r);
      }
    });
  }
  window.KSound = {
    EVENTS, play, loop, renderSettings, ready,
    get volume() { return vol; }, set volume(v) { vol = Math.max(0, Math.min(2, Number(v) || 0)); persist(); },
    get enabled() { return on; }, set enabled(v) { on = !!v; persist(); },
    setSink(id) { sink = id || ''; if (ctx && ctx.setSinkId) ctx.setSinkId(sink).catch(() => {}); },
  };
})();
