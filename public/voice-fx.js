// Обработка голоса Кентовки (AudioWorklet).
//
// k-blend — «не резать голос»: смешивает выход шумодава с исходным (выровненным по задержке) сигналом.
//   Пока шумодав считает звук голосом (его выход сравним с входом), подмешиваем живой сигнал —
//   шёпот, окончания слов и тихие согласные не обрубаются. В тишине и на чистом шуме выход шумодава
//   почти ноль — подмешивание плавно уходит в ноль, шум остаётся вырезанным полностью.
//   Вход 0 — после шумодава, вход 1 — исходный звук.
//
// k-gate — мягкий шумовой порог: заглядывает на 5 мс вперёд (не съедает первые звуки слова),
//   плавно открывается/закрывается, держит паузы между словами, в закрытом виде глушит на 40 дБ, а не в ноль.

const BLOCK = 128;
const dbToLin = (d) => Math.pow(10, d / 20);
const rmsOf = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / a.length); };

class Blend extends AudioWorkletProcessor {
  constructor(o) {
    super();
    const p = o.processorOptions || {};
    this.delay = Math.max(0, p.delay | 0);
    this.keep = p.keep ?? 0.6;                       // сколько живого звука можно подмешать (0 — чистый шумодав)
    this.lo = p.lo ?? 0.12; this.hi = p.hi ?? 0.4;   // «это голос»: какую долю звука пропустил шумодав
    this.snr = dbToLin(p.snrDb ?? 6);                // «это шёпот»: насколько звук выше фонового шума
    this.ring = new Float32Array(this.delay + BLOCK * 2 + 1);
    this.dd = new Float32Array(BLOCK);
    this.w = 0; this.envW = 0; this.envD = 0; this.hold = 0; this.pos = 0;
    this.hp = 0; this.hpX = 0; this.envR = 0; this.floor = 1e-3; this.act = 0;
    if (p.debug) this.dbg = { n: 0, ratio: 0, energy: 0 };
    this.mins = new Float32Array(8).fill(1); this.mi = 0; this.curMin = Infinity; this.subN = 0;
    const bps = sampleRate / BLOCK;
    this.holdBlocks = Math.round(0.3 * bps);         // держим ~300 мс после голоса — паузы внутри фразы
    this.actNeed = Math.round(0.05 * bps);           // шёпот признаём, если он длится ≥ 50 мс (щелчки клавиатуры короче)
    this.subLen = Math.round(0.2 * bps);
    this.warm = this.subLen * 2;
    this.hpA = Math.exp(-2 * Math.PI * 300 / sampleRate); // для шёпота смотрим выше 300 Гц — гул вентилятора ниже
    // щелчки клавиатуры и мыши: резкий скачок верхних частот на 2–3 мс. Ловим их во входе заранее
    // (выход отстаёт на задержку шумодава) и на время щелчка приглушаем выход и не подмешиваем живой звук
    this.declick = p.declick ?? true;
    this.dryOff = []; this.t = 0; this.prevX = 0; this.slowHF = 1e-5; this.clickRun = 0; this.events = []; this.duck = 1; this.dw = 1;
    this.clickLen = Math.round(0.03 * sampleRate);
    this.port.onmessage = (e) => {
      if (e.data && typeof e.data.keep === 'number') this.keep = e.data.keep;
      if (e.data && typeof e.data.declick === 'boolean') this.declick = e.data.declick;
    };
  }
  process(inputs, outputs) {
    const out = outputs[0][0]; if (!out) return true;
    const wet = (inputs[0] && inputs[0][0]) || null;
    const dry = (inputs[1] && inputs[1][0]) || null;
    const n0 = out.length;
    // верхние частоты входа (разность соседних отсчётов) и общий уровень
    let hf = 0, bb = 0;
    if (dry) for (let i = 0; i < n0; i++) { const d = dry[i] - this.prevX; this.prevX = dry[i]; hf += d * d; bb += dry[i] * dry[i]; }
    const hfr = Math.sqrt(hf / n0), bbr = Math.sqrt(bb / n0);
    const jump = hfr > this.slowHF * 5 && hfr > 6e-4;   // +14 дБ верхов за 2.7 мс
    // кандидат в щелчки: подтверждаем, только если через ~8 мс звук так же резко спал
    // (у речи — «т», «к», начало слова — дальше идёт гласная, уровень держится)
    if (this.declick) {
      const c = this.cand;
      if (c) {
        c.age++; c.peakHf = Math.max(c.peakHf, hfr); c.peakBb = Math.max(c.peakBb, bbr);
        if (c.age >= 3) {
          if (hfr < c.peakHf * 0.25 && bbr < c.peakBb * 0.35) {
            const last = this.events[this.events.length - 1];
            if (last && c.s <= last.e) last.e = Math.max(last.e, c.s + (c.age + 1) * n0 + this.clickLen);
            else this.events.push({ s: c.s, e: c.s + (c.age + 1) * n0 + this.clickLen });
            this.clicks = (this.clicks || 0) + 1;
          }
          this.cand = null;
        }
      } else if (jump) {
        this.cand = { s: this.t + this.delay - 64, age: 0, peakHf: hfr, peakBb: bbr };
        // пока не ясно, щелчок ли это, — хотя бы не подмешиваем живой звук (шумодав щелчки и так режет)
        this.dryOff.push({ s: this.cand.s, e: this.cand.s + 4 * n0 + this.clickLen });
      }
    }
    if (!jump) this.slowHF = this.slowHF * 0.97 + hfr * 0.03;
    else this.slowHF = this.slowHF * 0.995 + Math.min(hfr, this.slowHF * 2) * 0.005;
    while (this.events.length && this.events[0].e < this.t) this.events.shift();
    while (this.dryOff.length && this.dryOff[0].e < this.t) this.dryOff.shift();
    const n = out.length, R = this.ring, L = R.length, dd = this.dd.length === n ? this.dd : (this.dd = new Float32Array(n));
    // задерживаем исходный звук ровно на задержку шумодава; заодно меряем его выше 300 Гц
    let hs = 0;
    for (let i = 0; i < n; i++) {
      const x = dry ? dry[i] : 0;
      this.hp = this.hpA * (this.hp + x - this.hpX); this.hpX = x; hs += this.hp * this.hp;
      R[this.pos] = x;
      let j = this.pos - this.delay; if (j < 0) j += L;
      dd[i] = R[j];
      this.pos = (this.pos + 1) % L;
    }
    if (!wet) { out.fill(0); this.t += n; return true; }
    // 1) шумодав сам пропускает звук — значит голос
    const rw = rmsOf(wet), rd = rmsOf(dd);
    this.envW = rw > this.envW ? rw * 0.6 + this.envW * 0.4 : this.envW * 0.93;
    this.envD = rd > this.envD ? rd * 0.6 + this.envD * 0.4 : this.envD * 0.93;
    const ratio = this.envD > 1e-4 ? this.envW / this.envD : 0;
    let voice = Math.min(1, Math.max(0, (ratio - this.lo) / (this.hi - this.lo)));
    if (this.envD < 3e-4) voice = 0;                 // цифровая тишина (−70 дБ)
    // 2) шёпот: нейросеть его часто принимает за шум. Ловим ровный звук заметно выше фона
    const hr = Math.sqrt(hs / n);
    this.envR = this.envR ? this.envR * 0.9 + hr * 0.1 : hr; // сглаживание ~25 мс
    // фон — минимум за последние ~1.6 с (в речи всегда есть паузы между словами), +3 дБ до среднего
    if (this.envR < this.curMin) this.curMin = this.envR;
    if (++this.subN >= this.subLen) { this.mins[this.mi] = this.curMin; this.mi = (this.mi + 1) % this.mins.length; this.curMin = Infinity; this.subN = 0; }
    let mn = this.curMin; for (const v of this.mins) if (v < mn) mn = v;
    this.floor = Math.max(mn * 1.41, 1e-6);
    if (this.warm > 0) this.warm--;                  // первые 0.4 с только слушаем фон
    const loud = !this.warm && this.envR > this.floor * this.snr && this.envR > 2e-4;
    if (loud) this.act = Math.min(this.act + 1, this.actNeed * 3);
    else this.act = Math.max(0, this.act - 2);
    if (this.dbg) { this.dbg.n++; if (voice > 0.5) this.dbg.ratio++; if (this.act >= this.actNeed) this.dbg.energy++; if (this.dbg.n % 375 === 0) this.port.postMessage({ dbg: { ...this.dbg, floorDb: 20 * Math.log10(this.floor), envDb: 20 * Math.log10(this.envR + 1e-9) } }); }
    if (this.act >= this.actNeed) voice = Math.max(voice, 1);
    const active = voice > 0.5;                 // голос прямо сейчас (не «держим паузу»)
    if (voice > 0.5) this.hold = this.holdBlocks;
    else if (this.hold > 0) { this.hold--; voice = Math.max(voice, 0.75); }
    const target = voice * this.keep;
    // подмешивание: открывается за ~5 мс, уходит за ~120 мс
    const k = target > this.w ? 0.55 : 0.022;
    const w0 = this.w, w1 = this.w + (target - this.w) * k;
    this.w = w1;
    const duckTo = active ? 1 : 0.08;           // поверх голоса щелчок не слышно — голос не трогаем; в паузах глушим (−22 дБ)
    const ev = this.events;
    for (let i = 0; i < n; i++) {
      const g = this.t + i;
      let inClick = false;
      for (let e = 0; e < ev.length; e++) if (g >= ev[e].s && g < ev[e].e) { inClick = true; break; }
      let noDry = inClick;
      if (!noDry) for (let e = 0; e < this.dryOff.length; e++) if (g >= this.dryOff[e].s && g < this.dryOff[e].e) { noDry = true; break; }
      const tg = inClick ? duckTo : 1;
      this.duck += (tg - this.duck) * (tg < this.duck ? 0.25 : 0.004);
      this.dw += ((noDry ? 0 : 1) - this.dw) * (noDry ? 0.2 : 0.01);
      const w = (w0 + (w1 - w0) * (i / n)) * this.dw;
      out[i] = (wet[i] * (1 - w) + dd[i] * w) * this.duck;
    }
    this.t += n;
    return true;
  }
}
registerProcessor('k-blend', Blend);

class Gate extends AudioWorkletProcessor {
  constructor(o) {
    super();
    const p = o.processorOptions || {};
    this.setThreshold(p.threshold ?? -50);
    this.look = Math.round(0.005 * sampleRate);  // 5 мс заглядывания вперёд
    this.ring = new Float32Array(this.look + BLOCK + 1); this.pos = 0;
    this.floor = dbToLin(-40);
    this.g = this.floor; this.env = 0; this.hold = 0;
    this.holdBlocks = Math.round(0.3 * sampleRate / BLOCK);
    this.attack = 1 - Math.exp(-1 / (0.001 * sampleRate));   // 1 мс
    this.release = 1 - Math.exp(-1 / (0.12 * sampleRate));   // 120 мс
    this.port.onmessage = (e) => { if (e.data && typeof e.data.threshold === 'number') this.setThreshold(e.data.threshold); };
  }
  setThreshold(db) { this.open = dbToLin(db); this.close = dbToLin(db - 6); }
  process(inputs, outputs) {
    const out = outputs[0][0]; if (!out) return true;
    const x = (inputs[0] && inputs[0][0]) || null;
    const n = out.length, R = this.ring, L = R.length;
    // решение принимаем по «будущему» блоку, а отдаём задержанный звук
    const r = x ? rmsOf(x) : 0;
    this.env = r > this.env ? r : this.env * 0.9 + r * 0.1;
    let isOpen;
    if (this.env > this.open) { isOpen = true; this.hold = this.holdBlocks; }
    else if (this.env > this.close && this.hold > 0) { isOpen = true; this.hold = this.holdBlocks; }
    else if (this.hold > 0) { isOpen = true; this.hold--; }
    else isOpen = false;
    const target = isOpen ? 1 : this.floor;
    const c = isOpen ? this.attack : this.release;
    for (let i = 0; i < n; i++) {
      R[this.pos] = x ? x[i] : 0;
      let j = this.pos - this.look; if (j < 0) j += L;
      this.g += (target - this.g) * c;
      out[i] = R[j] * this.g;
      this.pos = (this.pos + 1) % L;
    }
    return true;
  }
}
registerProcessor('k-gate', Gate);

// k-async — «умный шумодав» без треска: тяжёлая нейросеть (DeepFilterNet3 + k-blend) считается в отдельном
//   потоке (df-worker.js), а здесь только очередь. Блоки уходят в поток пачками, обработанные копятся в запасе
//   (~27 мс) — если комп на миг задумался, звук не рвётся. Задержка голоса: запас + задержка самой нейросети.
class Async extends AudioWorkletProcessor {
  constructor(o) {
    super();
    const p = o.processorOptions || {};
    this.target = p.target || 10;          // блоков в запасе перед стартом (10 × 2.7 мс)
    this.max = p.max || 48;                // больше — значит отстаём: выкидываем лишнее
    this.batch = p.batch || 2;
    this.fifo = []; this.primed = false; this.wp = null; this.under = 0; this.fade = 1;
    this.inbuf = new Float32Array(BLOCK * this.batch); this.n = 0;
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.port) {
        this.wp = d.port;
        this.wp.onmessage = (m) => {
          const a = m.data; if (!(a instanceof Float32Array)) return;
          for (let i = 0; i < a.length; i += BLOCK) this.fifo.push(a.subarray(i, i + BLOCK));
          if (this.fifo.length > this.max) this.fifo.splice(0, this.fifo.length - this.target);
        };
      } else if (this.wp && typeof d.keep === 'number') this.wp.postMessage({ keep: d.keep });
    };
  }
  process(inputs, outputs) {
    const out = outputs[0] && outputs[0][0]; if (!out) return true;
    const inp = inputs[0] && inputs[0][0];
    if (this.wp) {
      if (inp) this.inbuf.set(inp, this.n); else this.inbuf.fill(0, this.n, this.n + BLOCK);
      this.n += BLOCK;
      if (this.n >= this.inbuf.length) { const b = this.inbuf; this.wp.postMessage(b, [b.buffer]); this.inbuf = new Float32Array(BLOCK * this.batch); this.n = 0; }
    }
    if (!this.primed) { if (this.fifo.length >= this.target) this.primed = true; else return true; }
    const blk = this.fifo.shift();
    if (blk) out.set(blk);
    else { this.primed = false; this.under++; } // поток не успел — копим запас заново (тишина 2.7 мс лучше треска)
    return true;
  }
}
registerProcessor('k-async', Async);
