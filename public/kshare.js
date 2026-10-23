// Качество демки (стрим экрана) — одно на всё приложение: выбирается в окне «Что показать?» перед показом,
// в настройках «Стрим» и прямо во время стрима. Подключается на страницах сервера, друзей и в окне выбора.
(function () {
  'use strict';
  const RES = { 720: [1280, 720], 1080: [1920, 1080], 1440: [2560, 1440], src: [3840, 2160] };
  const RES_LABEL = { 720: '720p', 1080: '1080p', 1440: '1440p', src: 'Исходное' };
  const LIST = ['720_15', '720_30', '720_60', '1080_15', '1080_30', '1080_60', '1440_30', '1440_60', 'src_30', 'src_60'];
  function parse(q) {
    const m = /^(720|1080|1440|src)_(15|30|60)$/.exec(String(q || ''));
    const res = m ? m[1] : '1080', fps = m ? +m[2] : 30;
    const [w, h] = RES[res];
    // битрейт по числу точек и кадров: 1080p 30 ≈ 4.5 Мбит/с, 1080p 60 ≈ 8, 1440p 60 ≈ 14
    const k = fps >= 60 ? 0.064 : fps <= 15 ? 0.09 : 0.072;
    const px = res === 'src' ? 2560 * 1440 * 1.3 : w * h;
    const bitrate = Math.round(Math.max(1.2e6, Math.min(20e6, px * fps * k)) / 1e5) * 1e5;
    return { key: res + '_' + fps, res, fps, w, h, bitrate, label: RES_LABEL[res] + ' · ' + fps + ' к/с' };
  }
  const mbps = (b) => (b / 1e6).toFixed(b >= 1e7 ? 0 : 1).replace('.', ',') + ' Мбит/с';
  const hintOf = (p) => (p.hint === 'motion' || p.hint === 'detail' ? p.hint : parse(p.q).fps >= 60 ? 'motion' : 'detail');
  // ограничения для захвата и для смены качества на лету
  function constraints(q) {
    const p = parse(q);
    const v = { frameRate: { ideal: p.fps, max: p.fps } };
    if (p.res !== 'src') { v.width = { ideal: p.w, max: p.w }; v.height = { ideal: p.h, max: p.h }; }
    return v;
  }
  async function apply(track, pref) {
    if (!track) return;
    const p = parse(pref.q);
    try { await track.applyConstraints(constraints(p.key)); } catch {}
    try { track.contentHint = hintOf(pref); } catch {}
  }
  // настройки кодировщика для зрителя: битрейт, частота кадров, что беречь при плохой сети
  function tuneSender(params, pref, viewers) {
    const p = parse(pref.q);
    if (!params.encodings || !params.encodings.length) return params;
    const share = Math.max(1, viewers || 1);
    params.encodings[0].maxBitrate = Math.round(p.bitrate / Math.sqrt(share) / 1e4) * 1e4;
    params.encodings[0].maxFramerate = p.fps;
    params.degradationPreference = hintOf(pref) === 'motion' ? 'maintain-framerate' : 'maintain-resolution';
    return params;
  }
  // элементы выбора: разрешение, кадры, режим; onChange({ q, hint })
  function controls(pref, onChange) {
    const wrap = document.createElement('div'); wrap.className = 'kshareq';
    const p0 = parse(pref.q);
    const sel = (opts, cur, title) => { const s = document.createElement('select'); s.title = title; for (const [v, t] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = t; if (String(v) === String(cur)) o.selected = true; s.appendChild(o); } return s; };
    const r = sel(Object.keys(RES_LABEL).map((k) => [k, RES_LABEL[k]]), p0.res, 'Разрешение');
    const f = sel([[15, '15 к/с'], [30, '30 к/с'], [60, '60 к/с']], p0.fps, 'Кадров в секунду');
    const h = sel([['detail', 'Чёткость (текст)'], ['motion', 'Плавность (игры)']], hintOf(pref), 'Что важнее');
    const net = document.createElement('small'); net.className = 'kshareq-net';
    const cur = () => { const q = parse(r.value + '_' + f.value).key; return { q, hint: h.value }; };
    const upd = (user) => { const c = cur(); net.textContent = '≈ ' + mbps(parse(c.q).bitrate) + ' отдачи на зрителя'; if (user) onChange && onChange(c); };
    r.onchange = () => { if (r.value === '1440' && f.value === '15') f.value = '30'; if (r.value === 'src' && f.value === '15') f.value = '30'; upd(true); };
    f.onchange = () => { if (f.value === '60' && h.value === 'detail' && !h.dataset.touched) h.value = 'motion'; if (f.value !== '60' && h.value === 'motion' && !h.dataset.touched) h.value = 'detail'; upd(true); };
    h.onchange = () => { h.dataset.touched = '1'; upd(true); };
    wrap.append(r, f, h, net); upd(false);
    wrap.value = cur;
    return wrap;
  }
  window.kShareQ = { parse, list: LIST, mbps, hintOf, constraints, apply, tuneSender, controls };
})();
