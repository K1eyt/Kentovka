// Подписи под устройство: на телефоне — «телефон», «долгое нажатие», без Ctrl+V и Esc.
// Меняет только надписи интерфейса (кнопки, подсказки, окна), переписку и ники не трогает.
(function () {
  'use strict';
  const phone = !!(window.__kentovkaAndroid || window.KentovkaAndroid || window.kAndroid || /Android/i.test(navigator.userAgent));
  window.kPhone = phone;
  if (!phone) return;
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
