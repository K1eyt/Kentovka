// Подписи под устройство: на телефоне — «телефон», «долгое нажатие», без Ctrl+V и Esc.
// Меняет только надписи интерфейса (кнопки, подсказки, окна), переписку и ники не трогает.
(function () {
  'use strict';
  const phone = !!(window.__kentovkaAndroid || window.KentovkaAndroid || window.kAndroid || /Android/i.test(navigator.userAgent));
  window.kPhone = phone;
  // телефон: поле ввода чата — «редактируемый блок», а не <input>: только в такое поле клавиатура Android
  // разрешает вставить картинку из своего буфера (в обычном поле скрины зачёркнуты)
  window.kEditable = function (inp, onFiles) {
    if (!phone || !inp || inp.tagName !== 'INPUT') return inp;
    const d = document.createElement('div');
    d.id = inp.id; d.className = (inp.className ? inp.className + ' ' : '') + 'keditable';
    d.contentEditable = 'true'; d.setAttribute('role', 'textbox'); d.setAttribute('enterkeyhint', 'send'); d.spellcheck = true;
    d.dataset.ph = inp.placeholder || '';
    const max = inp.maxLength > 0 ? inp.maxLength : 4000;
    Object.defineProperty(d, 'value', { get() { return d.innerText.replace(/\u00a0/g, ' ').replace(/\n+$/, '').slice(0, max); }, set(v) { d.textContent = v == null ? '' : String(v); } });
    Object.defineProperty(d, 'placeholder', { get() { return d.dataset.ph || ''; }, set(v) { d.dataset.ph = v; } });
    d.maxLength = max; d.select = () => { const r = document.createRange(); r.selectNodeContents(d); const s = getSelection(); s.removeAllRanges(); s.addRange(r); };
    d.setSelectionRange = () => {};
    d.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); const f = d.closest('form'); if (f) { if (f.requestSubmit) f.requestSubmit(); else f.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); } }
    });
    // картинка с клавиатуры: появляется <img> — забираем её как файл и убираем из текста
    const grab = async (img) => {
      const src = img.getAttribute('src'); img.remove(); if (!src) return;
      try { const b = await (await fetch(src)).blob(); onFiles && onFiles([new File([b], 'скрин.' + ((b.type.split('/')[1] || 'png').replace('jpeg', 'jpg')), { type: b.type || 'image/png' })]); } catch {}
    };
    new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) { if (n.nodeType !== 1) continue; if (n.tagName === 'IMG') grab(n); else if (n.querySelectorAll) n.querySelectorAll('img').forEach(grab); } })
      .observe(d, { childList: true, subtree: true });
    // вставка: файлы и картинки — отдаём чату; текст — без оформления
    d.addEventListener('paste', (e) => {
      const dt = e.clipboardData; if (!dt) return;
      const files = [...(dt.files || [])];
      if (files.length) { if (!onFiles) return; e.preventDefault(); e.stopPropagation(); onFiles(files); return; }
      const t = dt.getData('text/plain');
      if (t) { e.preventDefault(); document.execCommand('insertText', false, t); }
    });
    if (!document.getElementById('keditable-css')) {
      const st = document.createElement('style'); st.id = 'keditable-css';
      st.textContent = '.keditable{flex:1;min-width:0;min-height:22px;max-height:120px;overflow-y:auto;outline:none;white-space:pre-wrap;overflow-wrap:anywhere;padding:8px 0;cursor:text;line-height:1.4}.keditable:empty::before{content:attr(data-ph);color:var(--faint,#6b7090);pointer-events:none}';
      document.head.appendChild(st);
    }
    inp.replaceWith(d);
    return d;
  };
  // заливка ползунков ровно до кружка (в окне друзей её не было — стояла на середине)
  if (!window.kRangeFill) (() => {
    const fill = (el) => { if (!el || el.type !== 'range') return; const min = +el.min || 0, max = el.max === '' ? 100 : +el.max, v = +el.value;
      el.style.setProperty('--v', (max > min ? Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100)) : 0) + '%'); };
    const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    Object.defineProperty(HTMLInputElement.prototype, 'value', { configurable: true, enumerable: d.enumerable, get() { return d.get.call(this); }, set(v) { d.set.call(this, v); if (this.type === 'range') fill(this); } });
    for (const k of ['min', 'max']) { const dd = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, k); Object.defineProperty(HTMLInputElement.prototype, k, { configurable: true, get() { return dd.get.call(this); }, set(v) { dd.set.call(this, v); if (this.type === 'range') fill(this); } }); }
    document.addEventListener('input', (e) => fill(e.target), true);
    const all = () => document.querySelectorAll('input[type=range]').forEach(fill);
    new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) { if (n.matches('input[type=range]')) fill(n); else n.querySelectorAll && n.querySelectorAll('input[type=range]').forEach(fill); } })
      .observe(document.documentElement, { childList: true, subtree: true });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', all); else all();
    window.kRangeFill = fill;
  })();
  if (!phone) return;
  // телефон: ползунок под палец — кружок крупнее, зона касания выше, тянешь ползунок — страница не листается
  {
    const st = document.createElement('style'); st.id = 'krange-phone';
    st.textContent = 'input[type=range]{height:30px!important;touch-action:none}input[type=range]::-webkit-slider-thumb{width:22px!important;height:22px!important;margin-top:-8.5px!important}input[type=range]:active::-webkit-slider-thumb{transform:scale(1.1)}.kp-seek input[type=range]{height:18px!important}.kp-seek input[type=range]::-webkit-slider-thumb{width:16px!important;height:16px!important;margin-top:-5.5px!important}';
    (document.head || document.documentElement).appendChild(st);
  }
  const R = [
    [/Сохранить на компьютер/g, 'Сохранить на телефон'],
    [/на компьютер/g, 'на телефон'], [/компьютер(?!а)/g, 'телефон'], [/компьютера/g, 'телефона'],
    [/на твоём компе/g, 'на твоём телефоне'], [/на этом компе/g, 'на этом телефоне'], [/на любом компе/g, 'на любом устройстве'],
    [/у тебя на компе/g, 'у тебя на телефоне'], [/на компе/g, 'на телефоне'], [/к компу/g, 'к телефону'], [/на этот комп/g, 'на этот телефон'],
    [/звук компа из колонок/g, 'звук телефона из динамика'], [/звук компа/g, 'звук телефона'],
    [/для слабого компа/g, 'для слабого телефона'], [/грузит комп/g, 'грузит телефон'],
    [/между (вашими )?компами/g, 'между устройствами'],
    [/Правой кнопкой по сообщению/g, 'Долгое нажатие на сообщение'], [/[Пп]равый клик/g, 'долгое нажатие'], [/правой кнопкой/g, 'долгим нажатием'],
    [/\.?\s*Ещё можно Ctrl\+V или перетащить в окно/g, ''], [/\s*\(можно Ctrl\+V или перетащить\)/g, ''],
    [/кинь скрин через Ctrl\+V/g, 'кинь скрин через скрепку'], [/Win\+Shift\+S, потом Ctrl\+V в чат/g, 'Скрепка у поля ввода'],
    [/\s*\((Esc|Enter)\)/g, ''], [/ или Esc\b/g, ''],
    [/[Нн]аведи на /g, (m) => (m[0] === 'Н' ? 'Нажми на ' : 'нажми на ')],
    [/наушники или колонки/g, 'наушники или динамик'],
    [/Кнопки внизу слева\.\s*/g, ''],
  ];
  const SKIP = '.msg .text, .msg .body .txt, #messages .msg > .body > div:not(.meta), #msgs .b, #msgs .gt, .rq span, .fnm, .uname, .nm, .gh b, .mebtn b, input, textarea, [contenteditable], script, style, code';
  const fix = (t) => { let s = t; for (const [re, to] of R) s = s.replace(re, to); return s; };
  const skip = (el) => !el || (el.closest && el.closest(SKIP));
  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { if (!skip(root.parentElement)) { const v = fix(root.nodeValue); if (v !== root.nodeValue) root.nodeValue = v; } return; }
    if (root.nodeType !== 1 || skip(root)) return;
    for (const a of ['title', 'placeholder', 'aria-label', 'data-tip']) { const v = root.getAttribute && root.getAttribute(a); if (v) { const f = fix(v); if (f !== v) root.setAttribute(a, f); } }
    for (const c of root.childNodes) walk(c);
  }
  const start = () => {
    walk(document.body);
    new MutationObserver((ms) => { for (const m of ms) { if (m.type === 'characterData') walk(m.target); else if (m.type === 'attributes') walk(m.target); else for (const n of m.addedNodes) walk(n); } })
      .observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['title', 'placeholder', 'data-tip'] });
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
