// Друг для проверки APK: узел друзей на машине GitHub. Принимает заявки, отвечает эхом, на «файл» присылает картинку.
const path = require('path');
const fs = require('fs');
const { createFriends } = require(path.join(__dirname, '..', 'app', 'friends.js'));
const { getCert } = require(path.join(__dirname, '..', 'server.js'));
const log = (...a) => fs.appendFileSync('/tmp/friend.txt', new Date().toISOString().slice(11, 19) + ' ' + a.join(' ') + '\n');
const dir = '/tmp/friend'; fs.mkdirSync(dir, { recursive: true });
let F;
F = createFriends({ dataDir: dir, cert: getCert(dir + '/cert'), port: 18455, getProfile: () => ({ name: 'Друг-бот' }),
  onChange: () => {
    for (const f of F.list()) if (f.status === 'incoming') { log('заявка от', f.name); F.respond(f.id, true); }
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
