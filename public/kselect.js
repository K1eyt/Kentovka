// Выпадающие списки в стиле Кентовки вместо системных (белых) окошек Windows.
// Настоящий <select> остаётся на месте (невидимый): у него те же id, value и событие change —
// весь остальной код и сохранённые настройки работают как раньше. Кнопка рядом показывает выбранное
// и открывает свой список. Значение, поставленное из кода (select.value = …), тоже сразу видно.
(() => {
  if (window.__kselect) return;
  window.__kselect = true;
  const CHEV = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
  const CHECK = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
  const css = `
    select.ksel-native { position: absolute !important; opacity: 0 !important; width: 1px !important; height: 1px !important; min-width: 0 !important; padding: 0 !important; border: 0 !important; margin: 0 !important; pointer-events: none !important; overflow: hidden; }
    .ksel-btn { display: inline-flex; align-items: center; justify-content: space-between; gap: 8px; text-align: left; cursor: pointer; max-width: 100%; min-width: 0;
      font: inherit; color: var(--text, #e6e8ff); background: var(--panel2, #171a2a); border: 1px solid var(--line, #262a40); border-radius: var(--r-sm, 8px); padding: 9px 11px;
      transition: border-color .15s, box-shadow .15s, background .15s; }
    .ksel-btn:hover { border-color: rgba(var(--acc-rgb, 34,225,255), .45); }
    .ksel-btn.open, .ksel-btn:focus-visible { outline: none; border-color: var(--accent, #22e1ff); box-shadow: 0 0 0 3px rgba(var(--acc-rgb, 34,225,255), calc(.18 * var(--glow, .7))); }
    .ksel-btn:disabled { opacity: .5; cursor: default; }
    .ksel-btn .kv { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ksel-btn .kc { flex: none; display: grid; color: var(--dim, #8a8fb3); transition: transform .15s; }
    .ksel-btn.open .kc { transform: rotate(180deg); color: var(--accent, #22e1ff); }
    .ksel-pop { position: fixed; inset: auto; margin: 0; z-index: 2147482000; min-width: 160px; max-height: min(320px, 60vh); overflow-y: auto; padding: 5px; border-radius: 12px;
      background: var(--panel, #11131f); border: 1px solid rgba(var(--acc-rgb, 34,225,255), .35);
      box-shadow: 0 16px 40px rgba(0,0,0,.55), 0 0 calc(22px * var(--glow, .7)) rgba(var(--acc-rgb, 34,225,255), calc(.14 * var(--glow, .7)));
      animation: kselin .12s ease-out; font: 14px/1.35 var(--font, "Segoe UI", system-ui, sans-serif); color: var(--text, #e6e8ff); }
    @keyframes kselin { from { opacity: 0; transform: translateY(-4px); } }
    [data-motion="off"] .ksel-pop { animation: none; }
    .ksel-pop .ko { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 10px; border: 0; background: none; color: inherit; font: inherit; text-align: left; border-radius: 8px; cursor: pointer; }
    .ksel-pop .ko span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .ksel-pop .ko i { width: 15px; flex: none; display: grid; color: var(--accent, #22e1ff); }
    .ksel-pop .ko.act { background: var(--panel3, #1e2236); }
    .ksel-pop .ko.sel { color: var(--text, #fff); font-weight: 600; }
    .ksel-pop .ko:disabled { opacity: .45; cursor: default; }
    .ksel-pop::-webkit-scrollbar { width: 8px; } .ksel-pop::-webkit-scrollbar-thumb { background: var(--panel3, #1e2236); border-radius: 8px; }
  `;
  const st = document.createElement('style'); st.id = 'kselect-css'; st.textContent = css;
  (document.head || document.documentElement).appendChild(st);

  // правила страницы для select (ширина, отступы) переносим и на кнопку
  function copyRules() {
    const out = [];
    for (const sh of document.styleSheets) {
      let rules; try { rules = sh.cssRules; } catch { continue; }
      const walk = (list, wrap) => {
        for (const r of list) {
          if (r.cssRules && r.media) { walk(r.cssRules, (t) => `@media ${r.media.mediaText} { ${t} }`); continue; }
          if (!r.selectorText || !/(^|[\s,>+~(])select\b/.test(r.selectorText) || r.parentStyleSheet && r.parentStyleSheet.ownerNode && r.parentStyleSheet.ownerNode.id === 'kselect-css') continue;
          const sel = r.selectorText.split(',').filter((x) => /(^|[\s>+~(])select\b/.test(x.trim()) || /^select\b/.test(x.trim()))
            .map((x) => x.replace(/(^|[\s>+~(])select\b/g, '$1.ksel-btn')).join(',');
          if (!sel) continue;
          // цвет фона/рамки берём свои (в стиле Кентовки), размеры и отступы — как у select
          const keep = [];
          for (const p of r.style) if (/^(width|min-width|max-width|flex|flex-basis|flex-grow|flex-shrink|margin|margin-.*|align-self|justify-self|grid-.*|order|padding|padding-.*|font-size|height|min-height)$/.test(p)) keep.push(`${p}: ${r.style.getPropertyValue(p)}${r.style.getPropertyPriority(p) ? ' !important' : ''}`);
          if (keep.length) out.push(wrap(`${sel} { ${keep.join('; ')} }`));
        }
      };
      walk(rules, (t) => t);
    }
    const s2 = document.createElement('style'); s2.id = 'kselect-copied'; s2.textContent = out.join('\n');
    const old = document.getElementById('kselect-copied'); if (old) old.remove();
    document.head.appendChild(s2);
  }

  let open = null; // { sel, btn, pop, idx }
  function close(focusBack) {
    if (!open) return;
    const o = open; open = null;
    o.pop.remove(); o.btn.classList.remove('open'); o.btn.setAttribute('aria-expanded', 'false');
    if (focusBack) o.btn.focus();
  }
  function choose(sel, i) {
    if (i < 0 || i >= sel.options.length || sel.options[i].disabled) return;
    if (sel.selectedIndex !== i) {
      sel.selectedIndex = i;
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    sync(sel);
  }
  function openList(sel, btn) {
    close();
    const pop = document.createElement('div'); pop.className = 'ksel-pop'; pop.setAttribute('role', 'listbox');
    const opts = [...sel.options];
    opts.forEach((o, i) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'ko' + (i === sel.selectedIndex ? ' sel act' : ''); b.disabled = o.disabled;
      b.setAttribute('role', 'option'); b.setAttribute('aria-selected', String(i === sel.selectedIndex));
      b.innerHTML = `<i>${i === sel.selectedIndex ? CHECK : ''}</i><span></span>`; b.lastChild.textContent = o.textContent;
      b.onmousedown = (e) => e.preventDefault();
      b.onclick = () => { choose(sel, i); close(true); };
      b.onmouseenter = () => setAct(i);
      pop.appendChild(b);
    });
    // в открытом окне (настройки — модальное окно) список кладём внутрь окна: всё снаружи там не нажимается;
    // и показываем как popover — тогда он поверх всего и не обрезается краями окна
    (sel.closest('dialog[open]') || document.body).appendChild(pop);
    if (pop.showPopover) { pop.popover = 'manual'; try { pop.showPopover(); } catch {} }
    const r = btn.getBoundingClientRect();
    pop.style.minWidth = Math.max(160, r.width) + 'px';
    pop.style.maxWidth = Math.max(r.width, Math.min(420, innerWidth - 16)) + 'px';
    const h = pop.offsetHeight, w = pop.offsetWidth;
    const below = innerHeight - r.bottom - 8, above = r.top - 8;
    pop.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
    pop.style.top = (h <= below || below >= above ? Math.min(r.bottom + 4, innerHeight - h - 8) : Math.max(8, r.top - h - 4)) + 'px';
    btn.classList.add('open'); btn.setAttribute('aria-expanded', 'true');
    open = { sel, btn, pop, idx: Math.max(0, sel.selectedIndex) };
    const cur = pop.children[open.idx]; if (cur) cur.scrollIntoView({ block: 'nearest' });
  }
  function setAct(i) {
    if (!open) return;
    const kids = open.pop.children;
    i = Math.max(0, Math.min(kids.length - 1, i));
    for (const k of kids) k.classList.remove('act');
    if (kids[i]) { kids[i].classList.add('act'); kids[i].scrollIntoView({ block: 'nearest' }); }
    open.idx = i;
  }
  function sync(sel) {
    const btn = sel._kbtn; if (!btn) return;
    const o = sel.options[sel.selectedIndex];
    btn.querySelector('.kv').textContent = o ? o.textContent : '';
    btn.disabled = sel.disabled;
    btn.title = sel.title || (o ? o.textContent : '');
    if (open && open.sel === sel) { const keep = open.btn; close(); if (document.activeElement === keep) {} }
  }
  function enhance(sel) {
    if (sel._kbtn || sel.multiple || sel.size > 1 || sel.closest('[data-native-select]')) return;
    const btn = document.createElement('button'); btn.type = 'button';
    btn.className = 'ksel-btn' + (sel.className ? ' ' + sel.className : '');
    btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false');
    if (sel.id) btn.dataset.for = sel.id;
    if (sel.getAttribute('style')) btn.setAttribute('style', sel.getAttribute('style'));
    const lab = sel.getAttribute('aria-label') || (sel.id && document.querySelector(`label[for="${sel.id}"]`) && document.querySelector(`label[for="${sel.id}"]`).textContent.trim());
    if (lab) btn.setAttribute('aria-label', lab);
    btn.innerHTML = `<span class="kv"></span><span class="kc">${CHEV}</span>`;
    sel.after(btn);
    sel.classList.add('ksel-native'); sel.tabIndex = -1; sel.setAttribute('aria-hidden', 'true');
    sel._kbtn = btn;
    // подпись <label for="…"> — клик по ней фокусирует нашу кнопку
    if (sel.id) for (const l of document.querySelectorAll(`label[for="${sel.id}"]`)) l.addEventListener('click', (e) => { e.preventDefault(); btn.focus(); });
    btn.onclick = (e) => { e.stopPropagation(); if (open && open.sel === sel) close(); else openList(sel, btn); };
    btn.onkeydown = (e) => {
      const isOpen = open && open.sel === sel;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!isOpen) { if (e.altKey) return openList(sel, btn); let i = sel.selectedIndex + (e.key === 'ArrowDown' ? 1 : -1); while (sel.options[i] && sel.options[i].disabled) i += e.key === 'ArrowDown' ? 1 : -1; choose(sel, i); return; }
        setAct(open.idx + (e.key === 'ArrowDown' ? 1 : -1));
      } else if (e.key === 'Home' || e.key === 'End') { if (isOpen) { e.preventDefault(); setAct(e.key === 'Home' ? 0 : 1e6); } }
      else if (e.key === 'Enter' || e.key === ' ') { if (isOpen) { e.preventDefault(); choose(sel, open.idx); close(true); } else { e.preventDefault(); openList(sel, btn); } }
      else if (e.key === 'Escape' && isOpen) { e.preventDefault(); e.stopPropagation(); close(true); }
      else if (e.key === 'Tab' && isOpen) close();
    };
    new MutationObserver(() => sync(sel)).observe(sel, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'title'] });
    sel.addEventListener('change', () => sync(sel));
    sync(sel);
  }
  // значение, поставленное из кода, сразу видно на кнопке
  for (const k of ['value', 'selectedIndex']) {
    const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, k);
    Object.defineProperty(HTMLSelectElement.prototype, k, { configurable: true, enumerable: d.enumerable, get() { return d.get.call(this); }, set(v) { d.set.call(this, v); if (this._kbtn) sync(this); } });
  }
  const scan = (root) => { if (root.matches && root.matches('select')) enhance(root); root.querySelectorAll && root.querySelectorAll('select').forEach(enhance); };
  const start = () => {
    copyRules();
    scan(document);
    new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) scan(n); }).observe(document.body, { childList: true, subtree: true });
  };
  document.addEventListener('pointerdown', (e) => { if (open && !e.target.closest('.ksel-pop') && e.target !== open.btn && !open.btn.contains(e.target)) close(); }, true);
  window.addEventListener('resize', () => close());
  document.addEventListener('scroll', (e) => { if (open && !open.pop.contains(e.target)) close(); }, true);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  window.kSelectSync = (sel) => sync(sel);

  // ---------- свои окна вопросов вместо системных alert/confirm ----------
  const dcss = `
    dialog.kdlg { width: min(420px, calc(100vw - 32px)); padding: 0; border-radius: 16px; color: var(--text, #e6e8ff); background: var(--panel, #11131f);
      border: 1px solid rgba(var(--acc-rgb, 34,225,255), .4); box-shadow: 0 24px 60px rgba(0,0,0,.6), 0 0 calc(30px * var(--glow, .7)) rgba(var(--acc-rgb, 34,225,255), calc(.18 * var(--glow, .7)));
      font: 15px/1.45 var(--font, "Segoe UI", system-ui, sans-serif); animation: kselin .14s ease-out; }
    dialog.kdlg::backdrop { background: rgba(4,5,12,.6); backdrop-filter: blur(3px); }
    .kdlg .kd-b { padding: 20px 20px 16px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .kdlg .kd-t { font: 700 17px/1.25 var(--font-display, "Segoe UI Semibold", sans-serif); margin: 0 0 6px; }
    .kdlg .kd-f { display: flex; justify-content: flex-end; gap: 8px; padding: 0 16px 16px; }
    .kdlg button { font: 700 14px/1 var(--font-display, sans-serif); padding: 10px 16px; border-radius: 10px; border: 1px solid var(--line, #262a40); background: var(--panel3, #1e2236); color: var(--text, #e6e8ff); cursor: pointer; }
    .kdlg button:hover { border-color: rgba(var(--acc-rgb, 34,225,255), .5); }
    .kdlg button.ok { border: 0; color: var(--on-accent, #070812); background: linear-gradient(135deg, var(--accent, #22e1ff), var(--accent2, #ff3ec8)); }
    .kdlg button.ok.danger { background: var(--red, #ff4d6d); color: #fff; }
    .kdlg button:focus-visible { outline: 2px solid var(--accent, #22e1ff); outline-offset: 2px; }
  `;
  const ds = document.createElement('style'); ds.textContent = dcss; (document.head || document.documentElement).appendChild(ds);
  function kDialog({ title, text, ok = 'OK', cancel = null, danger = false }) {
    return new Promise((resolve) => {
      const d = document.createElement('dialog'); d.className = 'kdlg';
      d.innerHTML = '<div class="kd-b"><div class="kd-t"></div><div class="kd-x"></div></div><div class="kd-f"></div>';
      const t = d.querySelector('.kd-t'); if (title) t.textContent = title; else t.remove();
      d.querySelector('.kd-x').textContent = text || '';
      const f = d.querySelector('.kd-f');
      let res = false;
      if (cancel) { const c = document.createElement('button'); c.type = 'button'; c.className = 'cancel'; c.textContent = cancel; c.onclick = () => { res = false; d.close(); }; f.appendChild(c); }
      const o = document.createElement('button'); o.type = 'button'; o.className = 'ok' + (danger ? ' danger' : ''); o.textContent = ok; o.onclick = () => { res = true; d.close(); }; f.appendChild(o);
      d.addEventListener('close', () => { d.remove(); resolve(res); });
      d.addEventListener('pointerdown', (e) => { if (e.target === d && cancel) { const r = d.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) { res = false; d.close(); } } });
      (document.body || document.documentElement).appendChild(d);
      d.showModal(); o.focus();
    });
  }
  window.kAsk = (text, ok = 'Да', opts = {}) => kDialog({ text, ok, cancel: opts.cancel || 'Отмена', danger: !!opts.danger, title: opts.title });
  window.kSay = (text, opts = {}) => kDialog({ text, ok: 'Понятно', title: opts.title });
})();
