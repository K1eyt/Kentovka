// «Умный шумодав»: DeepFilterNet3 в отдельном потоке + запас ~27 мс — не трещит, даже когда комп занят.
let modP = null;
export async function smartNode(ctx, opts = {}) {
  modP = modP || fetch('/df/df_bg.wasm').then((r) => { if (!r.ok) throw new Error('нет модели DeepFilterNet'); return r.arrayBuffer(); }).then((b) => WebAssembly.compile(b));
  const mod = await modP;
  await ctx.audioWorklet.addModule('/voice-fx.js');
  const node = new AudioWorkletNode(ctx, 'k-async', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'discrete', processorOptions: { target: opts.target || 10 } });
  const worker = new Worker('/df-worker.js');
  const ch = new MessageChannel();
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('шумодав долго запускается')), 30000);
    worker.onmessage = (e) => { const d = e.data || {}; if (d.ready) { clearTimeout(t); resolve(); } else if (d.error) { clearTimeout(t); reject(new Error(d.error)); } };
    worker.onerror = (e) => { clearTimeout(t); reject(new Error(e.message || 'поток шумодава не запустился')); };
    worker.postMessage({ init: true, module: mod, port: ch.port2, blend: opts.blend || null, sampleRate: ctx.sampleRate }, [ch.port2]);
  });
  node.port.postMessage({ port: ch.port1 }, [ch.port1]);
  node.destroy = () => { try { worker.terminate(); } catch {} };
  return node;
}
