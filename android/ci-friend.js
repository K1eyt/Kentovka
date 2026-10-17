// Друг для проверки APK: узел друзей на машине GitHub. Принимает заявки, отвечает эхом, на «файл» присылает картинку.
const path = require('path');
const fs = require('fs');
const { createFriends } = require(path.join(__dirname, '..', 'app', 'friends.js'));
const { getCert } = require(path.join(__dirname, '..', 'server.js'));
const log = (...a) => fs.appendFileSync('/tmp/friend.txt', new Date().toISOString().slice(11, 19) + ' ' + a.join(' ') + '\n');
const dir = '/tmp/friend'; fs.mkdirSync(dir, { recursive: true });
let F, page = null, curCall = null;
// звонок в личке: отвечает Chromium с ненастоящим микрофоном (тот же протокол, что в friends.html)
(async () => {
  try {
    const { chromium } = require('playwright');
    const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
    const c = await b.newContext({ permissions: ['microphone'] });
    page = await c.newPage();
    page.on('pageerror', (e) => log('page ERR', e.message));
    await page.exposeFunction('say', (k, data) => { if (curCall) F.call(curCall.id, { k, cid: curCall.cid, data }); });
    await page.exposeFunction('plog', (...a) => log('звонок:', ...a));
    await page.setContent('<html><body>bot</body></html>');
    await page.evaluate(() => {
      window.onSig = async (d) => {
        if (!window.pc) {
          const st = await navigator.mediaDevices.getUserMedia({ audio: true });
          const pc = window.pc = new RTCPeerConnection({ iceServers: [] });
          st.getTracks().forEach((t) => pc.addTrack(t, st));
          pc.onicecandidate = (e) => e.candidate && say('signal', { candidate: e.candidate.toJSON() });
          pc.ontrack = () => plog('дорожка от телефона');
          pc.onconnectionstatechange = () => plog('состояние', pc.connectionState);
        }
        const pc = window.pc;
        if (d.sdp) { await pc.setRemoteDescription(d.sdp); if (d.sdp.type === 'offer') { const a = await pc.createAnswer(); await pc.setLocalDescription(a); say('signal', { sdp: { type: 'answer', sdp: pc.localDescription.sdp } }); } }
        else if (d.candidate) { try { await pc.addIceCandidate(d.candidate); } catch (e) { plog('ice', e.message); } }
      };
      window.hang = () => { if (window.pc) { window.pc.close(); window.pc = null; } };
    });
    log('бот для звонков готов');
  } catch (e) { log('нет звонков:', e.message); }
})();
F = createFriends({ dataDir: dir, cert: getCert(dir + '/cert'), port: 18455, getProfile: () => ({ name: 'Друг-бот' }),
  onChange: () => {
    for (const f of F.list()) if (f.status === 'incoming') { log('заявка от', f.name); F.respond(f.id, true); }
  },
  onCall: async (m) => {
    log('звонок', m.k, m.data ? Object.keys(m.data).join(',') : '');
    if (!page) return;
    if (m.k === 'ring') { curCall = { id: m.id, cid: m.cid }; setTimeout(() => F.call(m.id, { k: 'accept', cid: m.cid }), 1500); }
    else if (m.k === 'signal' && m.data && curCall) await page.evaluate((d) => window.onSig(d), m.data).catch((e) => log('sig ERR', e.message));
    else if (m.k === 'end' || m.k === 'gone') { curCall = null; await page.evaluate(() => window.hang()).catch(() => {}); }
  },
  onMessage: (m) => {
    if (m.kind !== 'dm') return;
    log('сообщение', m.name, m.text);
    if (/файл/.test(m.text)) { F.sendFile({ id: m.id }, { bytes: fs.readFileSync(path.join(__dirname, 'res', 'mipmap-xxhdpi', 'ic_launcher.png')), name: 'картинка.png', mime: 'image/png' }, 'держи'); log('отправил картинку'); }
    else F.send(m.id, 'эхо: ' + m.text);
  },
});
log('друг слушает 18455');
setInterval(() => {}, 1 << 30);
