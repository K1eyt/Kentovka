// Качество видео: отправитель (в приложении) после отправки ролика сам делает лёгкие версии 720p и 480p —
// прямо у себя, видеокартой (WebCodecs). Кенты со слабым интернетом выбирают их в плеере.
// Разбор mp4 — mp4box.js (BSD-3), сборка mp4 — mp4-muxer (MIT); звук копируется как есть, без перекодирования.
(() => {
  const loadScript = (src) => new Promise((res, rej) => {
    if (document.querySelector(`script[data-k="${src}"]`)) return res();
    const s = document.createElement('script'); s.src = src; s.dataset.k = src; s.onload = res; s.onerror = () => rej(new Error('нет ' + src));
    document.head.appendChild(s);
  });
  let libs = null;
  const ready = () => (libs = libs || Promise.all([loadScript('/vendor/mp4box.all.min.js'), loadScript('/vendor/mp4-muxer.js')]));

  const MAX = 1024 * 1024 * 1024; // больше 1 ГБ не перекодируем — долго и тяжело для памяти
  function canRun(file) {
    return typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined' && file && file.size <= MAX
      && (/^video\/(mp4|quicktime)$/.test(file.type || '') || /\.(mp4|m4v|mov)$/i.test(file.name || ''));
  }
  const even = (x) => Math.max(2, Math.round(x / 2) * 2);
  const RATE = { 720: 2_500_000, 480: 1_200_000, 360: 700_000 };

  // targets — высоты (например [720, 480]); onProgress(0..1); вернёт [{ height, width, blob }]
  async function make(file, targets, onProgress, isCancelled) {
    await ready();
    const MP4Box = window.MP4Box, { Muxer, ArrayBufferTarget } = window.Mp4Muxer;
    const mp4 = MP4Box.createFile();
    let info = null, vTrack = null, aTrack = null, failed = null;
    const vq = [], aq = []; // разобранные кадры и куски звука, ждут обработки
    mp4.onError = (e) => { failed = new Error('не разобрался в файле: ' + e); };
    mp4.onReady = (i) => {
      info = i;
      vTrack = i.videoTracks[0] || null;
      aTrack = (i.audioTracks || []).find((t) => /^mp4a/.test(t.codec)) || null;
      if (vTrack) mp4.setExtractionOptions(vTrack.id, 'v', { nbSamples: 60 });
      if (aTrack) mp4.setExtractionOptions(aTrack.id, 'a', { nbSamples: 200 });
      mp4.start();
    };
    mp4.onSamples = (id, user, samples) => {
      // данные копируем: releaseUsedSamples их освобождает
      (user === 'v' ? vq : aq).push(...samples.map((x) => ({ is_sync: x.is_sync, cts: x.cts, duration: x.duration, data: new Uint8Array(x.data) })));
      mp4.releaseUsedSamples(id, samples[samples.length - 1].number + 1);
    };
    // читаем файл кусками; между кусками даём кодерам разгрестись (чтобы память не росла)
    const CH = 4 * 1024 * 1024;
    let pos = 0;
    const feed = async () => {
      if (pos >= file.size) return false;
      const buf = await file.slice(pos, Math.min(file.size, pos + CH)).arrayBuffer();
      buf.fileStart = pos; pos += buf.byteLength;
      mp4.appendBuffer(buf);
      if (pos >= file.size) mp4.flush();
      return true;
    };
    while (!info && !failed && await feed()) {}
    if (failed) throw failed;
    if (!info || !vTrack) throw new Error('в файле нет видео');
    const W = vTrack.video ? vTrack.video.width : vTrack.track_width, H = vTrack.video ? vTrack.video.height : vTrack.track_height;
    targets = targets.filter((h) => H > h + 40);
    if (!targets.length) return [];

    const trak = mp4.getTrackById(vTrack.id);
    const entry = trak.mdia.minf.stbl.stsd.entries[0];
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    let description;
    if (box) { const ds = new window.DataStream(undefined, 0, window.DataStream.BIG_ENDIAN); box.write(ds); description = new Uint8Array(ds.buffer, 8); }
    const dcfg = { codec: vTrack.codec, codedWidth: W, codedHeight: H, description, hardwareAcceleration: 'prefer-hardware' };
    if (!(await VideoDecoder.isConfigSupported(dcfg)).supported) { delete dcfg.hardwareAcceleration; if (!(await VideoDecoder.isConfigSupported(dcfg)).supported) throw new Error('этот кодек не перекодировать'); }

    // звук: копируем как есть
    let aMeta = null;
    if (aTrack) {
      try {
        const at = mp4.getTrackById(aTrack.id).mdia.minf.stbl.stsd.entries[0];
        const dsi = at.esds.esd.descs[0].descs[0].data;
        aMeta = { decoderConfig: { codec: aTrack.codec, numberOfChannels: aTrack.audio.channel_count, sampleRate: aTrack.audio.sample_rate, description: dsi } };
      } catch { aMeta = null; }
    }
    const fps = vTrack.nb_samples && vTrack.duration ? Math.min(60, Math.round(vTrack.nb_samples / (vTrack.duration / vTrack.timescale))) : 30;
    const outs = [];
    for (const h of targets) {
      const w = even(W * h / H), hh = even(h);
      const muxer = new Muxer({ target: new ArrayBufferTarget(), fastStart: 'in-memory', firstTimestampBehavior: 'offset',
        video: { codec: 'avc', width: w, height: hh, frameRate: fps },
        audio: aMeta ? { codec: 'aac', numberOfChannels: aMeta.decoderConfig.numberOfChannels, sampleRate: aMeta.decoderConfig.sampleRate } : undefined });
      const o = { h: hh, w, muxer, err: null, canvas: new OffscreenCanvas(w, hh), n: 0, firstAudio: true };
      o.ctx = o.canvas.getContext('2d', { alpha: false });
      o.enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { o.err = e; } });
      let ecfg = { codec: hh <= 480 ? 'avc1.4D401E' : 'avc1.4D401F', width: w, height: hh, bitrate: RATE[h] || 1_500_000, framerate: fps, hardwareAcceleration: 'prefer-hardware', avc: { format: 'avc' }, latencyMode: 'quality' };
      if (!(await VideoEncoder.isConfigSupported(ecfg)).supported) { ecfg = { ...ecfg, codec: 'avc1.42E01F' }; delete ecfg.hardwareAcceleration; }
      if (!(await VideoEncoder.isConfigSupported(ecfg)).supported) throw new Error('кодер H.264 недоступен');
      o.enc.configure(ecfg);
      outs.push(o);
    }
    let decErr = null, done = 0;
    const total = vTrack.nb_samples || 1;
    const keyEvery = Math.max(1, fps * 2);
    const dec = new VideoDecoder({
      output: (frame) => {
        for (const o of outs) {
          if (o.err) continue;
          o.ctx.drawImage(frame, 0, 0, o.w, o.h);
          const vf = new VideoFrame(o.canvas, { timestamp: frame.timestamp, duration: frame.duration || undefined });
          o.enc.encode(vf, { keyFrame: o.n++ % keyEvery === 0 });
          vf.close();
        }
        frame.close();
        done++;
        if (onProgress && done % 15 === 0) onProgress(Math.min(0.99, done / total));
      },
      error: (e) => { decErr = e; },
    });
    dec.configure(dcfg);
    const ts = vTrack.timescale, ats = aTrack ? aTrack.timescale : 1;
    const busy = () => dec.decodeQueueSize > 8 || outs.some((o) => o.enc.encodeQueueSize > 8);
    const wait = () => new Promise((r) => setTimeout(r, 4));
    for (;;) {
      if (isCancelled && isCancelled()) { try { dec.close(); } catch {} outs.forEach((o) => { try { o.enc.close(); } catch {} }); throw new Error('отменено'); }
      if (decErr) throw decErr;
      for (const o of outs) if (o.err) throw o.err;
      while (aq.length) {
        const s = aq.shift();
        for (const o of outs) {
          o.muxer.addAudioChunkRaw(s.data, s.is_sync ? 'key' : 'delta', Math.round(s.cts * 1e6 / ats), Math.round(s.duration * 1e6 / ats), o.firstAudio ? aMeta : undefined);
          o.firstAudio = false;
        }
      }
      if (vq.length) {
        if (busy()) { await wait(); continue; }
        const s = vq.shift();
        dec.decode(new EncodedVideoChunk({ type: s.is_sync ? 'key' : 'delta', timestamp: Math.round(s.cts * 1e6 / ts), duration: Math.round(s.duration * 1e6 / ts), data: s.data }));
        continue;
      }
      if (!(await feed())) break; // всё прочитали и всё отдали в декодер
    }
    await dec.flush(); dec.close();
    if (decErr) throw decErr;
    const res = [];
    for (const o of outs) {
      await o.enc.flush(); o.enc.close();
      if (o.err) throw o.err;
      o.muxer.finalize();
      res.push({ height: o.h, width: o.w, blob: new Blob([o.muxer.target.buffer], { type: 'video/mp4' }) });
    }
    if (onProgress) onProgress(1);
    return res;
  }
  window.kTranscode = { canRun, make };
})();
