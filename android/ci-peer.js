// Второй участник для проверки APK: Chromium на машине GitHub заходит в голосовой канал тестового сервера
const { chromium } = require('playwright');
const fs = require('fs');
const log = (...a) => fs.appendFileSync('/tmp/peer.txt', new Date().toISOString().slice(11, 19) + ' ' + a.join(' ') + '\n');
(async () => {
  const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--ignore-certificate-errors'] });
  const c = await b.newContext({ ignoreHTTPSErrors: true, permissions: ['microphone'] });
  const p = await c.newPage();
  p.on('pageerror', (e) => log('ERR', e.message));
  await p.goto('https://127.0.0.1:8443');
  await p.fill('#nameInput', 'Бот'); await p.click('#loginForm button'); await p.waitForTimeout(1500);
  await p.click('#voiceChannel'); log('в голосе');
  for (let i = 0; i < 100; i++) {
    await p.waitForTimeout(3000);
    const st = await p.evaluate(() => [...window.kentovka.peers.values()].map((x) => x.pc.connectionState + (x.audio && x.audio.srcObject ? '+audio' : '')).join(',')).catch((e) => 'eval ' + e.message);
    log('peers', st);
  }
  await b.close();
})().catch((e) => log('FAIL', e.message));
