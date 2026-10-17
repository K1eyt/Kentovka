// Через отладчик WebView: друзья в APK — добавить друга по адресу, личка туда-обратно, картинка от друга
const { execSync } = require('child_process');
const http = require('http');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => http.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(d)); }).on('error', rej));
(async () => {
  const socks = execSync('adb shell cat /proc/net/unix').toString().match(/webview_devtools_remote_\d+/g) || [];
  if (!socks.length) { console.log('нет отладчика WebView'); return; }
  execSync(`adb forward tcp:9334 localabstract:${socks[0]}`);
  const pages = JSON.parse(await get('http://127.0.0.1:9334/json'));
  console.log('pages', pages.map((p) => p.type + ' ' + p.url).join(' | '));
  const pg = pages.find((p) => p.type === 'page');
  const WebSocket = require('ws');
  const ws = new WebSocket(pg.webSocketDebuggerUrl);
  await new Promise((r) => ws.on('open', r));
  let id = 0; const wait = new Map();
  ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } });
  const ev = (expr) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } })); }).then((m) => (m.result && m.result.result ? m.result.result.value : JSON.stringify(m.result || m.error)));
  const F = "document.getElementById('friendsFrame').contentWindow.kentovkaApp.friends";
  console.log('url', await ev('location.href'));
  console.log('режим программы', await ev('!!(window.kentovkaApp && window.kentovkaApp.android)'));
  console.log('регистрация скрыта', await ev("document.getElementById('reg').hidden"));
  console.log('фрейм друзей', await ev("!!document.getElementById('friendsFrame')"));
  console.log('я', await ev(`${F}.me().then((m) => JSON.stringify({ id: m.id, code: m.code, name: m.profile && m.profile.name, addrs: m.all }))`));
  console.log('добавить друга', await ev(`${F}.add('10.0.2.2:18455').then((r) => JSON.stringify(r))`));
  await sleep(4000);
  console.log('друзья', await ev(`${F}.list().then((l) => JSON.stringify(l.map((f) => f.name + ':' + f.status + ':' + f.online)))`));
  const fid = await ev(`${F}.list().then((l) => (l.find((f) => f.status === 'friend') || {}).id || '')`);
  if (fid) {
    await ev(`${F}.send('${fid}', 'привет с телефона')`);
    await sleep(4000);
    console.log('личка', await ev(`${F}.messages('${fid}').then((m) => JSON.stringify(m.map((x) => x.from + ': ' + (x.text || '') + (x.file ? ' [файл ' + x.file.name + ']' : '') + (x.delivered ? ' ✓' : ''))))`));
    await ev(`${F}.send('${fid}', 'пришли файл')`);
    await sleep(6000);
    const f2 = await ev(`${F}.messages('${fid}').then((m) => { const x = m.find((y) => y.file); return x ? x.file.id : ''; })`);
    console.log('картинка от друга', f2 ? await ev(`${F}.fileInfo('${f2}').then((i) => JSON.stringify(i))`) : 'нет');
    await ev(`(() => { const w = document.getElementById('friendsFrame').contentWindow; const r = w.document.querySelector('.dm'); if (r) r.click(); })()`);
    await sleep(2000);
  }
  process.exit(0);
})().catch((e) => { console.log('ERR', e.message); process.exit(0); });
