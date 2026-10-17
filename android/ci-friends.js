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
    await sleep(2500);
    const W = "document.getElementById('friendsFrame').contentWindow";
    console.log('картинка видна', await ev(`(() => { const i = ${W}.document.querySelector('#msgs img'); return i ? i.naturalWidth + 'x' + i.naturalHeight + ' ' + i.src : 'нет img'; })()`));
    execSync('adb exec-out screencap -p > ci-out/1b-chat.png');
    // звонок в личке: жмём трубку, бот отвечает из Chromium
    console.log('кнопка звонка', await ev(`(() => { const b = ${W}.document.querySelector('.chead .callme'); if (!b) return 'нет'; if (b.disabled) return 'выключена'; b.click(); return 'нажата'; })()`));
    for (let i = 0; i < 8; i++) {
      await sleep(2500);
      const st = await ev('window.kentovkaApp.callState().then((s) => JSON.stringify(s))');
      console.log('звонок', st);
      if (/live/.test(st)) break;
    }
    console.log('сцена', await ev(`(() => { const d = ${W}.document; const s = d.querySelector('.stage'); return s ? 'есть, плиток ' + s.querySelectorAll('.tile').length : 'нет'; })()`));
    execSync('adb exec-out screencap -p > ci-out/1c-call.png');
    await sleep(3000);
    console.log('звонок после', await ev('window.kentovkaApp.callState().then((s) => JSON.stringify(s))'));
    console.log('положить', await ev(`(() => { const d = ${W}.document; const b = [...d.querySelectorAll('button')].find((x) => /Положить|Завершить|Сбросить/.test(x.title || '')); if (!b) return 'нет кнопки'; b.click(); return 'ок ' + b.title; })()`));
    await sleep(2000);
    console.log('звонок в конце', await ev('window.kentovkaApp.callState().then((s) => JSON.stringify(s))'));
  }
  console.log('сохранить аккаунт', await ev('window.kentovkaApp.account.saveNow().then((r) => JSON.stringify(r))')); await sleep(7000);
  try { console.log('сохранения в Документах', execSync("adb shell ls -la '/sdcard/Documents/Kentovka/Сохранения'").toString()); } catch (e) { console.log('сохранения в Документах: нет', e.message.slice(0, 200)); }
  process.exit(0);
})().catch((e) => { console.log('ERR', e.message); process.exit(0); });
