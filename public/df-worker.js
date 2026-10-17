// Поток «умного шумодава»: DeepFilterNet3 и k-blend (бережём голос) — те же обработчики, что в аудиопотоке,
// только здесь им не мешает отрисовка страницы и всё остальное. Вход и выход — блоки по 128 отсчётов.
'use strict';
let DF = null, BL = null;
self.AudioWorkletProcessor = class { constructor() { this.port = { postMessage() {}, onmessage: null }; } };
self.registerProcessor = (name, cls) => { if (name === 'deepfilternet-processor') DF = cls; if (name === 'k-blend') BL = cls; };
let df = null, bl = null, port = null;
const w = new Float32Array(128), f = new Float32Array(128);
self.onmessage = (e) => {
  const d = e.data || {};
  if (d.init) {
    try {
      self.sampleRate = d.sampleRate || 48000;
      importScripts('/df/worklet.js', '/voice-fx.js');
      df = new DF({ processorOptions: { wasmModule: d.module, attenuationLimit: d.atten || 100 } });
      bl = d.blend && BL ? new BL({ processorOptions: d.blend }) : null;
      port = d.port;
      port.onmessage = (m) => {
        const a = m.data;
        if (!(a instanceof Float32Array)) { if (a && typeof a.keep === 'number' && bl) bl.keep = a.keep; return; }
        const out = new Float32Array(a.length);
        for (let o = 0; o < a.length; o += 128) {
          const blk = a.subarray(o, o + 128);
          w.fill(0); df.process([[blk]], [[w]]);
          if (bl) { f.fill(0); bl.process([[w], [blk]], [[f]]); out.set(f, o); } else out.set(w, o);
        }
        port.postMessage(out, [out.buffer]);
      };
      self.postMessage({ ready: true });
    } catch (err) { self.postMessage({ error: String(err && err.message || err) }); }
  }
};
