// Всплывающие окна настроек — одни и те же на серверах и в личке:
// микрофон, звук, камера (стрелочки у кнопок) и громкость отдельного человека.
// Страница даёт «переходник» (что выбрать, что сохранить), а вид и поведение — здесь.
//   kPop.mic(btn, A)    — микрофон: устройство, громкость, шумодав, уровень
//   kPop.out(btn, A)    — звук: устройство, общая громкость
//   kPop.cam(btn, A)    — камера: устройство, качество, превью, вкл/выкл
//   kPop.person(el, A)  — громкость человека и «заглушить для себя»
// Повторное нажатие на ту же кнопку закрывает окно; клик мимо и Esc — тоже.
(function () {
  'use strict';
  let cur = null; // { el, btn, key, timers: [] }
  const $c = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

  function close() {
    if (!cur) return;
    const c = cur; cur = null;
    for (const t of c.timers) clearInterval(t);
    for (const f of c.cleanup) { try { f(); } catch {} }
    c.el.remove();
    if (c.btn) c.btn.classList.remove('open');
  }
  function isOpen(key) { return !!(cur && (key == null || cur.key === key)); }

  // открыть окно у кнопки; если уже открыто этой же кнопкой (или с тем же ключом) — закрыть
  function open(btn, key, build, opts = {}) {
    if (cur && (cur.btn === btn || (key && cur.key === key))) { close(); return null; }
    close();
    const el = $c('div', 'kpop' + (opts.cls ? ' ' + opts.cls : ''));
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    cur = { el, btn, key, timers: [], cleanup: [] };
    if (btn) btn.classList.add('open');
    build(el, cur);
    document.body.appendChild(el);
    const anchor = opts.anchor || (btn && (btn.closest('.devgrp') || btn));
    const place = () => {
      if (!el.isConnected) return;
      const r = anchor ? anchor.getBoundingClientRect() : { left: innerWidth / 2 - 150, right: innerWidth / 2 + 150, top: innerHeight / 2, bottom: innerHeight / 2 };
      const w = el.offsetWidth, h = el.offsetHeight;
      el.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
      // над кнопкой, а если не влезает — под ней
      let top = r.top - h - 8; if (top < 8 || opts.below) top = Math.min(innerHeight - h - 8, r.bottom + 8);
      el.style.top = Math.max(8, top) + 'px';
    };
    place();
    if (window.ResizeObserver) { const ro = new ResizeObserver(place); ro.observe(el); cur.cleanup.push(() => ro.disconnect()); }
    return el;
  }
  document.addEventListener('pointerdown', (e) => { if (cur && !(cur.btn && cur.btn.contains(e.target))) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && cur) close(); });

  // ---------- строительные блоки ----------
  const title = (el, t) => el.appendChild($c('h4', null, t));
  function devList(el, load) {
    const box = el.appendChild($c('div', 'kpo-devs'));
    const draw = async () => {
      let items = [];
      try { items = await load(); } catch {}
      box.innerHTML = '';
      if (typeof items === 'string') { box.appendChild($c('p', 'kpo-hint', items)); return; }
      for (const it of items) {
        if (it.note) { box.appendChild($c('p', 'kpo-hint', it.note)); continue; }
        const b = $c('button', it.on ? 'on' : ''); b.type = 'button'; b.title = it.name;
        b.append($c('i'), $c('span', null, it.name));
        b.onclick = async () => { await it.pick(); draw(); };
        box.appendChild(b);
      }
    };
    draw();
    return draw;
  }
  function slider(el, o) {
    const lab = el.appendChild($c('label', 'kpo-l')); lab.append(o.label + ': '); const v = lab.appendChild($c('b'));
    const r = el.appendChild($c('input')); r.type = 'range'; r.min = o.min ?? 0; r.max = o.max ?? 200; r.step = o.step ?? 5; r.value = o.value;
    const show = () => { v.textContent = r.value + (o.unit ?? '%'); if (window.kRangeFill) window.kRangeFill(r); };
    show();
    r.oninput = () => { show(); o.oninput && o.oninput(+r.value); };
    r.onchange = () => { o.onchange && o.onchange(+r.value); };
    return { r, lab, set: (x) => { r.value = x; show(); } };
  }
  function seg(el, o) {
    if (o.label) el.appendChild($c('label', 'kpo-l', o.label));
    const box = el.appendChild($c('div', 'kpo-seg'));
    const draw = (val) => {
      box.innerHTML = '';
      for (const [k, t] of o.options) {
        const b = $c('button', k === val ? 'on' : '', t); b.type = 'button';
        b.onclick = () => { draw(k); o.onpick(k); };
        box.appendChild(b);
      }
    };
    draw(o.value);
    return { box, draw };
  }
  function check(el, o) {
    const l = el.appendChild($c('label', 'kpo-chk')); const c = $c('input'); c.type = 'checkbox'; c.checked = !!o.checked;
    l.append(c, ' ' + o.label); c.onchange = () => o.onchange(c.checked);
    return c;
  }
  function meter(el, st, get) {
    const m = el.appendChild($c('div', 'kpo-meter')); const i = m.appendChild($c('i'));
    const t = setInterval(() => { const db = get(); if (db == null) { m.hidden = true; return; } m.hidden = false; i.style.width = Math.max(0, Math.min(100, (db + 70) / 70 * 100)) + '%'; }, 90);
    st.timers.push(t);
    return m;
  }
  function more(el, text, fn) { const b = el.appendChild($c('button', 'kpo-more', text)); b.type = 'button'; b.onclick = () => { close(); fn(); }; return b; }
  function bigBtn(el, text, cls, fn) { const b = el.appendChild($c('button', 'kbtn kpo-big ' + (cls || ''), text)); b.type = 'button'; b.onclick = fn; return b; }

  // уровень из анализатора (дБ)
  function levelOf(an) {
    if (!an) return null;
    const b = new Float32Array(an.fftSize); an.getFloatTimeDomainData(b);
    let x = 0; for (const v of b) x += v * v; return 20 * Math.log10(Math.sqrt(x / b.length) + 1e-9);
  }

  // список устройств браузера (или телефона) в одном виде
  async function browserDevices(kind, curId, curLabel, pick) {
    const KA = window.kAndroid && window.kAndroid.audioDevices && kind !== 'videoinput' ? window.kAndroid : null;
    const nat = KA ? KA.audioDevices() : null;
    if (nat) {
      const isIn = kind === 'audioinput';
      const arr = isIn ? nat.inputs : nat.outputs, c = isIn ? nat.curIn : nat.curOut;
      const out = (arr || []).map((d) => ({ name: d.name, on: String(d.id) === String(c), pick: () => { KA.setAudioDevice(isIn ? 'in' : 'out', d.id); return new Promise((r) => setTimeout(r, 350)); } }));
      if (isIn && nat.note) out.push({ note: nat.note });
      return out;
    }
    const devs = (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter((d) => d.kind === kind && d.deviceId !== 'communications');
    if (!devs.length) return kind === 'videoinput' ? 'Камера не найдена. Подключи её и открой это окно ещё раз.' : 'Устройства не найдены.';
    if (!devs[0].label) return kind === 'videoinput' ? 'Названия камер появятся, когда первый раз включишь камеру.' : 'Список появится после первого звонка (нужно разрешение на микрофон).';
    const list = [];
    if (kind !== 'videoinput' && !devs.some((d) => d.deviceId === 'default')) list.push({ name: 'Как в системе', on: !curId && !curLabel, pick: () => pick(null) });
    for (const d of devs) {
      const def = d.deviceId === 'default';
      const name = def ? 'Как в системе' : d.label;
      const on = def ? (!curId && !curLabel) : (curId ? d.deviceId === curId : curLabel ? d.label === curLabel : false);
      list.push({ name, on, pick: () => pick(def ? null : d) });
    }
    if (kind === 'videoinput' && !list.some((x) => x.on) && list[0]) list[0].on = true;
    return list;
  }

  const NS = [['smart', 'Умный'], ['rnnoise', 'RNNoise'], ['dfn', 'DeepFilter'], ['ultra', 'ИИ-Макс'], ['browser', 'Встроенный'], ['off', 'Выкл']];
  const NS_STR = ['smart', 'dfn', 'ultra', 'rnnoise', 'gtcrn'];

  // ---------- микрофон ----------
  // A: { devId, devLabel, pickDev(d|null), gain(), setGain(v, final), ns(), setNs(mode), strength(), setStrength(v, final), level(), more() }
  function mic(btn, A) {
    return open(btn, 'mic', (el, st) => {
      title(el, 'Микрофон');
      devList(el, () => browserDevices('audioinput', A.devId && A.devId(), A.devLabel && A.devLabel(), A.pickDev));
      slider(el, { label: 'Громкость микрофона', value: Math.round(A.gain() * 100), oninput: (v) => A.setGain(v / 100, false), onchange: (v) => A.setGain(v / 100, true) });
      meter(el, st, () => levelOf(A.analyser && A.analyser()));
      if (A.ns) {
        const modes = NS.filter(([v]) => !window.kAndroid || !['smart', 'dfn', 'ultra'].includes(v));
        let strWrap;
        seg(el, { label: 'Шумодав', options: modes, value: A.ns(), onpick: (m) => { A.setNs(m); strWrap.hidden = !NS_STR.includes(m); } });
        strWrap = el.appendChild($c('div', 'kpo-str'));
        slider(strWrap, { label: 'Сила шумодава', min: 40, max: 100, value: A.strength(), oninput: (v) => A.setStrength(v, false), onchange: (v) => A.setStrength(v, true) });
        strWrap.hidden = !NS_STR.includes(A.ns());
      }
      if (A.more) more(el, 'Все настройки голоса', A.more);
    });
  }
  // ---------- звук ----------
  // A: { devId, devLabel, pickDev, canPick, vol(), setVol(v, final), more() }
  function out(btn, A) {
    return open(btn, 'out', (el) => {
      title(el, 'Звук');
      if (A.canPick && !A.canPick()) el.appendChild($c('p', 'kpo-hint', 'Здесь нельзя выбрать, куда выводить звук.'));
      else devList(el, () => browserDevices('audiooutput', A.devId && A.devId(), A.devLabel && A.devLabel(), A.pickDev));
      slider(el, { label: 'Громкость участников', value: Math.round(A.vol() * 100), oninput: (v) => A.setVol(v / 100, false), onchange: (v) => A.setVol(v / 100, true) });
      if (A.more) more(el, 'Все настройки голоса', A.more);
    });
  }
  // ---------- камера ----------
  // A: { on(), toggle(), devId(), pickDev(d|null), q(), setQ(q), facing(), setFacing(f), stream(), more() }
  const CAM_Q = [['360', '360p'], ['720', '720p'], ['1080', '1080p']];
  function cam(btn, A) {
    return open(btn, 'cam', (el, st) => {
      title(el, 'Камера');
      const pv = el.appendChild($c('div', 'kpo-prev'));
      const v = pv.appendChild($c('video')); v.muted = true; v.autoplay = true; v.playsInline = true;
      const hint = pv.appendChild($c('span', null, 'Камера выключена'));
      const sync = () => { const s = A.stream(); if (v.srcObject !== s) { v.srcObject = s || null; if (s) v.play().catch(() => {}); } pv.classList.toggle('on', !!s); hint.hidden = !!s; tb.textContent = s ? 'Выключить камеру' : 'Включить камеру'; tb.classList.toggle('danger', !!s); tb.classList.toggle('ok', !s); };
      if (window.kAndroid) seg(el, { label: 'Какая камера', options: [['user', 'Передняя'], ['environment', 'Задняя']], value: A.facing(), onpick: (f) => A.setFacing(f) });
      else devList(el, () => browserDevices('videoinput', A.devId(), null, A.pickDev));
      seg(el, { label: 'Качество', options: CAM_Q, value: A.q(), onpick: (q) => A.setQ(q) });
      el.appendChild($c('p', 'kpo-hint', 'Камеру видят все в звонке. Чем выше качество, тем больше нужен интернет.'));
      const tb = bigBtn(el, '', '', async () => { await A.toggle(); sync(); });
      sync();
      st.timers.push(setInterval(sync, 500));
      st.cleanup.push(() => { v.srcObject = null; });
      if (A.more) more(el, 'Все настройки', A.more);
    });
  }
  // ---------- громкость человека ----------
  // A: { name, vol(), setVol(v, final), muted(), setMuted(b) }
  function person(anchor, A, opts = {}) {
    return open(anchor, 'person:' + (A.key || A.name), (el) => {
      title(el, A.name || 'Участник');
      slider(el, { label: 'Громкость', value: Math.round(A.vol() * 100), oninput: (v) => A.setVol(v / 100, false), onchange: (v) => A.setVol(v / 100, true) });
      check(el, { label: 'Заглушить для себя', checked: A.muted(), onchange: (b) => A.setMuted(b) });
      if (A.profile) more(el, 'Профиль', A.profile);
    }, Object.assign({ anchor, cls: 'kpo-person', below: true }, opts));
  }

  window.kPop = { open, close, isOpen, mic, out, cam, person, levelOf, blocks: { title, devList, slider, seg, check, meter, more } };
})();
