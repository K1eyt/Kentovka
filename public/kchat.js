// Общее для всех чатов Кентовки (сервер, личка, группы): вид сообщений, даты, прокрутка без прыжков.
// Подключается в <head> страницы сервера и страницы друзей — и там, и там сообщения выглядят одинаково.
(function () {
  'use strict';
  const CSS = `
  .kmsgs { overflow-anchor: auto; position: relative; }
  /* сообщение по ширине своего текста (не растягивается на весь экран), кнопка реакции — прямо у текста */
  .msg { display: flex; gap: 12px; padding: 5px 46px 5px 8px; margin: 0 -8px; border-radius: var(--r-sm, 8px); transition: background var(--t-fast, .12s); position: relative;
    width: fit-content; min-width: min(100%, 320px); max-width: min(100%, 860px); box-sizing: border-box; }
  .kmsgs > .kday, .kmsgs > .sys, .kmsgs > .empty { max-width: 860px; }
  @media (max-width: 700px) { .msg { padding-right: 8px; min-width: 0; max-width: 100%; } }
  .msg.fresh { animation: kmsgin var(--t, .18s) ease-out; }
  @keyframes kmsgin { from { opacity: 0; transform: translateY(6px); } }
  .msg:hover { background: rgba(255,255,255,.03); }
  .mreact { position: absolute; top: 2px; right: 8px; width: 30px; height: 30px; border-radius: 9px; display: none; place-items: center; color: var(--dim);
    background: var(--panel2); border: 1px solid var(--line); box-shadow: 0 4px 14px rgba(0,0,0,.35); z-index: 2; }
  .mreact svg { width: 17px; height: 17px; }
  .msg:hover .mreact, .mreact:focus-visible { display: grid; }
  .mreact:hover { color: var(--accent); border-color: rgba(var(--acc-rgb), .5); }
  @media (hover: none) { .msg:hover .mreact { display: none; } }
  .reacts { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-top: 4px; }
  .reacts[hidden] { display: none; }
  /* плашки реакций: строго одной высоты и на одной линии. Эмодзи разных шрифтов (на Windows ❤️ и 👍 из разных
     наборов) имеют разную высоту и базовую линию — поэтому эмодзи сидит в жёсткой клетке 18×18 по центру */
  .reacts { align-items: center; }
  .rchip { display: inline-flex; align-items: center; gap: 5px; height: 26px; min-height: 26px; max-height: 26px; box-sizing: border-box; padding: 0 9px 0 7px; margin: 0; border-radius: 99px;
    background: var(--panel2); border: 1px solid var(--line); font: 600 13px/1 var(--font, "Segoe UI", sans-serif); color: var(--dim); vertical-align: top; overflow: hidden; flex: none;
    transition: border-color var(--t-fast, .12s), background var(--t-fast, .12s); }
  .rchip .em { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; flex: none; overflow: visible;
    font-size: 15px; line-height: 18px; font-family: "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif; font-variant-emoji: emoji; font-style: normal; }
  .rchip .n { display: inline-block; height: 18px; line-height: 18px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .rchip:hover { border-color: rgba(var(--acc-rgb), .5); }
  .rchip.mine { background: rgba(var(--acc-rgb), .14); border-color: rgba(var(--acc-rgb), .6); color: var(--text); }
  .rchip.add { padding: 0 7px; display: none; } .rchip.add svg { width: 15px; height: 15px; display: block; }
  .msg:hover .rchip.add, .rchip.add:focus-visible { display: inline-flex; }
  @media (hover: none) { .rchip.add { display: inline-flex; } }
  .msg > .ava { width: 38px; height: 38px; font-size: 15px; margin-top: 2px; flex: none; }
  .msg.cont { padding-top: 1px; padding-bottom: 1px; }
  .msg.cont > .ava { visibility: hidden; height: 0; }
  .mbody { min-width: 0; flex: 1; }
  .msg .meta { font-size: 12px; color: var(--faint); }
  .msg .meta b { font: 700 15px/1.3 var(--font-display); margin-right: 8px; color: var(--text); cursor: pointer; }
  .msg .meta b:hover { text-decoration: underline; }
  .msg .meta .st { margin-left: 6px; }
  .msg .text { white-space: pre-wrap; overflow-wrap: anywhere; }
  .msg .text a { color: var(--accent); }
  .msg .ked { font-size: 11px; color: var(--faint); margin-left: 6px; }
  .msg.flash { animation: kflash 1.4s; }
  @keyframes kflash { 0%, 40% { background: rgba(var(--acc-rgb), .14); } 100% { background: transparent; } }
  .msg.gone-out { animation: kmsgout .18s ease-in forwards; }
  @keyframes kmsgout { to { opacity: 0; transform: translateX(-8px); } }
  .sys { color: var(--faint); font-size: 13px; text-align: center; padding: 8px 0; }
  .quote { font-size: 13px; color: var(--dim); margin: 0 0 2px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 520px; padding-left: 10px; border-left: 2px solid var(--line); }
  .quote:hover { color: var(--text); border-left-color: var(--accent); }
  .quote b { color: var(--text); margin-right: 4px; }
  .quote svg { width: 13px; height: 13px; vertical-align: -2px; margin-right: 4px; color: var(--dim); }
  /* разделитель дня и плашка с датой при прокрутке */
  .kday { display: flex; align-items: center; gap: 10px; margin: 16px 0 8px; color: var(--faint); font-size: 12px; font-weight: 600; }
  .kday::before, .kday::after { content: ""; flex: 1; height: 1px; background: var(--line); }
  .kdaypill { position: absolute; left: 50%; transform: translate(-50%, -4px); z-index: 6; padding: 4px 12px; border-radius: 99px; font-size: 12px; font-weight: 600;
    color: var(--text); background: color-mix(in srgb, var(--panel3) 92%, transparent); border: 1px solid var(--line); box-shadow: 0 4px 14px rgba(0,0,0,.35);
    pointer-events: none; opacity: 0; transition: opacity .18s, transform .18s; }
  .kdaypill.on { opacity: 1; transform: translate(-50%, 0); }
  /* «печатает…» */
  .ktyping { height: 18px; font-size: 12px; color: var(--dim); padding: 0 20px; display: flex; align-items: center; gap: 6px; flex: none; }
  .ktyping i { display: inline-flex; gap: 3px; } .ktyping i b { width: 4px; height: 4px; border-radius: 50%; background: currentColor; animation: ktdot 1.2s infinite; }
  .ktyping i b:nth-child(2) { animation-delay: .15s; } .ktyping i b:nth-child(3) { animation-delay: .3s; }
  @keyframes ktdot { 0%, 60%, 100% { opacity: .3; transform: none; } 30% { opacity: 1; transform: translateY(-2px); } }
  /* правка своего сообщения прямо в ленте */
  .kedit { display: flex; flex-direction: column; gap: 4px; }
  .kedit textarea { font: inherit; color: var(--text); background: var(--panel2); border: 1px solid var(--accent); border-radius: 8px; padding: 7px 10px; resize: none; min-height: 38px; outline: none; }
  .kedit small { font-size: 11.5px; color: var(--dim); }
  .kedit small a { color: var(--accent); cursor: pointer; }
  `;
  function inject() {
    if (document.getElementById('kchat-css')) return;
    const s = document.createElement('style'); s.id = 'kchat-css'; s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }
  inject();

  // ---------- даты ----------
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  function dayLabel(ts) {
    const d = new Date(ts), now = new Date(), y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    if (same(d, now)) return 'Сегодня';
    if (same(d, y)) return 'Вчера';
    const o = { day: 'numeric', month: 'long' }; if (d.getFullYear() !== now.getFullYear()) o.year = 'numeric';
    return d.toLocaleDateString('ru-RU', o).replace(/\s*г\.$/, '');
  }
  const dayKey = (ts) => { const d = new Date(ts); return String(d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate()); };
  function daySep(ts) {
    const d = document.createElement('div'); d.className = 'kday'; d.dataset.day = dayKey(ts); d.dataset.key = 'day:' + dayKey(ts);
    d.textContent = dayLabel(ts); return d;
  }
  const timeOf = (ts) => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const fullTime = (ts) => new Date(ts).toLocaleString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  // ---------- прокрутка: где ты был — там и остаёшься ----------
  const ROW = '[data-ts]';
  const keyOf = (r) => r.dataset.key || r.dataset.mid || '';
  const nearBottom = (box) => box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  // запомнить место: «внизу» или «вот это сообщение на таком-то расстоянии от верха»
  function capture(box) {
    if (!box || !box.isConnected || !box.clientHeight) return box && box.__kLast || null;
    if (nearBottom(box)) return { bottom: true };
    const top = box.getBoundingClientRect().top;
    for (const r of box.querySelectorAll(ROW)) {
      const rc = r.getBoundingClientRect();
      if (rc.bottom > top + 1) return { key: keyOf(r), off: rc.top - top, top: box.scrollTop };
    }
    return { top: box.scrollTop };
  }
  function findRow(box, key) { if (!key) return null; for (const r of box.querySelectorAll(ROW)) if (keyOf(r) === key) return r; return null; }
  function restore(box, st) {
    if (!box) return;
    if (!st || st.bottom) { box.scrollTop = box.scrollHeight; box.__kAtBottom = true; return; }
    const r = findRow(box, st.key);
    if (r) box.scrollTop += (r.getBoundingClientRect().top - box.getBoundingClientRect().top) - st.off;
    else if (st.top != null) box.scrollTop = st.top;
    box.__kAtBottom = nearBottom(box);
    if (box.clientHeight) box.__kLast = capture(box);
  }
  // сделать что-то с лентой (вставить, заменить, удалить) — и не сдвинуть то, что ты читаешь
  function preserve(box, fn) { const st = capture(box); const r = fn(); restore(box, st); return r; }

  // следим за лентой: прилип к низу — новое и догрузившиеся картинки держат низ; листаешь — плашка с датой
  function watch(box) {
    if (!box || box.__kWatch) return box;
    box.__kWatch = true; box.classList.add('kmsgs'); box.__kAtBottom = true;
    const pill = document.createElement('div'); pill.className = 'kdaypill';
    let hideT = 0, raf = 0;
    const host = () => {
      const h = box.parentElement; if (!h) return null;
      if (pill.parentElement !== h) { if (getComputedStyle(h).position === 'static') h.style.position = 'relative'; h.appendChild(pill); }
      return h;
    };
    const showPill = () => {
      if (!host()) return;
      const top = box.getBoundingClientRect().top;
      let label = '';
      for (const r of box.querySelectorAll(ROW)) { const rc = r.getBoundingClientRect(); if (rc.bottom > top + 4) { label = dayLabel(+r.dataset.ts); break; } }
      // разделитель этого же дня и так виден наверху — плашка не нужна
      let sepVisible = false;
      for (const s of box.querySelectorAll('.kday')) { const rc = s.getBoundingClientRect(); if (rc.top >= top - 2 && rc.top < top + 44) { sepVisible = true; break; } }
      pill.style.top = (box.offsetTop + 8) + 'px';
      if (!label || sepVisible || box.scrollTop < 10 || nearBottom(box)) { pill.classList.remove('on'); return; }
      pill.textContent = label; pill.classList.add('on');
      clearTimeout(hideT); hideT = setTimeout(() => pill.classList.remove('on'), 1400);
    };
    box.addEventListener('scroll', () => {
      box.__kAtBottom = nearBottom(box);
      box.__kLast = capture(box);
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; showPill(); });
    }, { passive: true });
    const keep = () => { if (box.__kAtBottom && box.isConnected) box.scrollTop = box.scrollHeight; };
    box.addEventListener('load', keep, true);
    box.addEventListener('loadedmetadata', keep, true);
    try { new MutationObserver(() => { if (box.__kAtBottom) requestAnimationFrame(keep); }).observe(box, { childList: true, subtree: true }); } catch {}
    let wasH = box.clientHeight;
    try { new ResizeObserver(() => {
      const h = box.clientHeight;
      if (!wasH && h && box.__kLast) { const st = box.__kLast; restore(box, st); requestAnimationFrame(() => restore(box, st)); } else keep();
      wasH = h;
    }).observe(box); } catch {}
    return box;
  }

  // ---------- точечное обновление ленты: меняется только то, что поменялось ----------
  // items: [{ key, sig, build: () => Element }] в нужном порядке. Элементы с тем же key и sig не трогаются.
  function sync(box, items) {
    return preserve(box, () => {
      const have = new Map();
      for (const el of [...box.children]) { if (el.dataset && el.dataset.key) have.set(el.dataset.key, el); }
      let i = 0;
      const keepSet = new Set();
      for (const it of items) {
        let el = have.get(it.key);
        if (el && el.__ksig !== it.sig) { const n = it.build(); n.dataset.key = it.key; n.__ksig = it.sig; el.replaceWith(n); el = n; }
        else if (!el) { el = it.build(); el.dataset.key = it.key; el.__ksig = it.sig; }
        keepSet.add(el);
        const at = box.children[i];
        if (at !== el) box.insertBefore(el, at || null);
        i++;
      }
      for (const el of [...box.children]) if (!keepSet.has(el) && el.dataset && el.dataset.key) el.remove();
      for (const el of [...box.children]) if (!keepSet.has(el) && !(el.dataset && el.dataset.keep)) el.remove();
    });
  }

  // ---------- повторное нажатие на кнопку закрывает то, что она открыла ----------
  // toggle(btn, isOpen, open, close): вызывать из onclick
  function toggle(btn, isOpen, open, close) { if (isOpen()) { close(); return false; } open(); return true; }

  window.kChat = { dayLabel, dayKey, daySep, timeOf, fullTime, capture, restore, preserve, watch, sync, toggle, nearBottom };
})();
