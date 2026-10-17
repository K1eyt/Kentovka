// Прослойка для аудиопотока (AudioWorklet): в нём нет TextDecoder и crypto,
// а модуль DeepFilterNet3 обращается к ним при загрузке. Подставляем простые замены.
// Грузится через audioWorklet.addModule ДО /df/worklet.js — у модулей общий global.
if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = class {
    decode(bytes) {
      if (!bytes) return '';
      const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer || bytes);
      let out = '', i = 0;
      while (i < b.length) {
        const c = b[i++];
        if (c < 0x80) out += String.fromCharCode(c);
        else if (c < 0xe0) out += String.fromCharCode(((c & 0x1f) << 6) | (b[i++] & 0x3f));
        else if (c < 0xf0) out += String.fromCharCode(((c & 0x0f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f));
        else {
          const cp = (((c & 0x07) << 18) | ((b[i++] & 0x3f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f)) - 0x10000;
          out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
        }
      }
      return out;
    }
  };
}
if (typeof globalThis.crypto === 'undefined') {
  // нужен только для начального «посева» случайных чисел внутри модели — не для безопасности
  globalThis.crypto = {
    getRandomValues(arr) { for (let i = 0; i < arr.length; i++) arr[i] = (Math.random() * 256) | 0; return arr; },
  };
}
registerProcessor('kentovka-df-shim', class extends AudioWorkletProcessor { process() { return false; } });
