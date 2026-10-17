// Через отладчик WebView (CDP) проверяем страницу сервера в APK: вошли ли, голосовой канал, звук
const { execSync } = require('child_process');
const http = require('http');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(d)); }).on('error', rej));
(async () => {
  const socks = execSync('adb shell cat /proc/net/unix').toString().match(/webview_devtools_remote_\d+/g) || [];
  console.log('sockets', socks);
  if (!socks.length) return;
  execSync(`adb forward tcp:9333 localabstract:${socks[0]}`);
  const pages = JSON.parse(await get('http://127.0.0.1:9333/json'));
  console.log('pages', pages.map((p) => p.url));
  const pg = pages.find((p) => p.type === 'page');
  const WebSocket = require('ws');
  const ws = new WebSocket(pg.webSocketDebuggerUrl);
  await new Promise((r) => ws.on('open', r));
  let id = 0; const wait = new Map(); const ctxs = [];
  ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.method === 'Runtime.executionContextCreated') ctxs.push(m.params.context); if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } });
  const call = (method, params) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await call('Runtime.enable', {}); await sleep(1500);
  // страница сервера — во фрейме-вкладке на главной (не 18444)
  let ctxId;
  for (let i = 0; i < 20 && !ctxId; i++) { const c = ctxs.filter((x) => x.auxData && x.auxData.isDefault && /^http:\/\/127\.0\.0\.1:\d+/.test(x.origin) && !/:18444$/.test(x.origin)).pop(); if (c) ctxId = c.id; else await sleep(1000); }
  console.log('контекст вкладки сервера', ctxId, ctxs.map((x) => x.origin).join(' '));
  const ev = (expr) => call('Runtime.evaluate', Object.assign({ expression: expr, awaitPromise: true, returnByValue: true }, ctxId ? { contextId: ctxId } : {})).then((m) => (m.result && m.result.result ? m.result.result.value : JSON.stringify(m.result || m.error)));
  console.log('вкладка во фрейме, приложение', await ev('window.parent !== window') , await ev('!!(window.kentovkaApp && window.kentovkaApp.isTab)'));
  console.log('url', await ev('location.href'));
  console.log('kAndroid', await ev('!!window.kAndroid'));
  console.log('myName', await ev("document.getElementById('myName') && document.getElementById('myName').textContent"));
  console.log('audioDevices', JSON.stringify(await ev('window.kAndroid && window.kAndroid.audioDevices && JSON.stringify(window.kAndroid.audioDevices())')));
  console.log('nsMode default', await ev("JSON.parse(localStorage.getItem('settings') || '{}').nsMode || '(по умолчанию)'"));
  console.log('ws connected (каналы)', await ev("[...document.querySelectorAll('#textList .channel, #voiceList .channel')].map((x) => x.textContent.trim()).join(' | ')"));
  console.log('getUserMedia', await ev("navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => { s.getTracks().forEach((t) => t.stop()); return 'ok'; }, (e) => e.name + ': ' + e.message)"));
  console.log('secure context', await ev('window.isSecureContext'));
  await ev("document.getElementById('voiceChannel') && document.getElementById('voiceChannel').click()");
  for (let i = 0; i < 25; i++) { await sleep(1000); if (await ev("document.getElementById('voiceBar') && document.getElementById('voiceBar').classList.contains('on')")) break; }
  await sleep(8000);
  console.log('voice peers', await ev("JSON.stringify([...window.kentovka.peers.values()].map((x) => ({ st: x.pc.connectionState, audio: !!(x.audio && x.audio.srcObject) })))"));
  console.log('inVoice', await ev("document.getElementById('voiceBar') && document.getElementById('voiceBar').classList.contains('on')"));
  console.log('messages', JSON.stringify(await ev("(document.getElementById('messages') || {}).innerText && document.getElementById('messages').innerText.slice(-600)")));
  console.log('peers', await ev("window.kentovka && window.kentovka.budget ? JSON.stringify(window.kentovka.budget()) : '-'"));
  process.exit(0);
})().catch((e) => { console.log('ERR', e.message); process.exit(0); });
