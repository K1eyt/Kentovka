// Мостик между окном и приложением. Странице сервера даём только безопасный минимум,
// управление подключением — только стартовому экрану (локальный файл).
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const isLocal = location.protocol === 'file:' || location.protocol === 'kapp:';
const isEmbed = location.protocol === 'kapp:'; // страница внутри главного окна (друзья) — без своей рамки

const api = {
  isApp: true,
  onHotkey: (cb) => ipcRenderer.on('hotkey', (_e, action) => cb(action)),
  hotkeys: () => ipcRenderer.invoke('app:hotkeys'),
  setHotkey: (action, accel) => ipcRenderer.invoke('app:set-hotkey', action, accel),
  pauseHotkeys: (on) => ipcRenderer.send('hotkeys:pause', on),
  hostInfo: () => ipcRenderer.invoke('app:host-info'),
  copy: (text) => ipcRenderer.invoke('app:copy', text),
  back: () => ipcRenderer.invoke('app:back'),
  // звук демки без голосов из Кентовки
  takeSysAudio: () => ipcRenderer.invoke('sysaudio:take'),
  startSysAudio: () => ipcRenderer.invoke('sysaudio:start'),
  stopSysAudio: () => ipcRenderer.invoke('sysaudio:stop'),
  onSysAudio: (cb) => ipcRenderer.on('sysaudio:data', (_e, data) => cb(data)),
  onSysAudioEnd: (cb) => ipcRenderer.on('sysaudio:end', (_e, info) => cb(info)),
  // видео из чата без скачивания: приложение просит кусок — окно отдаёт его из раздачи
  canStreamVideo: true,
  onVideoRequest: (cb) => ipcRenderer.on('kvid:req', (_e, req) => cb(req)),
  videoRespond: (res) => ipcRenderer.send('kvid:res', res),
  setTheme: (theme) => ipcRenderer.invoke('app:set-theme', theme),
  getTheme: () => ipcRenderer.invoke('app:get-theme'),
  onTheme: (cb) => ipcRenderer.on('theme:changed', (_e, t) => cb(t)),
  getBg: () => ipcRenderer.invoke('app:bg-get'),
  setBg: (data, mime) => ipcRenderer.invoke('app:bg-set', data, mime),
  onBg: (cb) => ipcRenderer.on('bg:changed', () => cb()),
  // друзья: открыть окно, значок непрочитанного; id этой Кентовки — для серверов «только для друзей»
  // аккаунт: подпись для входа на сервер (приложение подписывает только для сервера, к которому подключено)
  serverAlts: (alts) => ipcRenderer.send('server:alts', alts),
  sign: (nonce, host) => ipcRenderer.invoke('account:sign', nonce, host),
  appId: (() => { try { return ipcRenderer.sendSync('app:id'); } catch { return ''; } })(),
  openFriends: (id) => ipcRenderer.invoke('friends:open', id),
  toggleFriends: () => ipcRenderer.invoke('friends:toggle'),
  closeFriends: () => ipcRenderer.send('friends:close'),
  friendsArea: (r) => ipcRenderer.send('friends:area', r),
  onFriendsShown: (cb) => ipcRenderer.on('friends:shown', (_e, v) => cb(v)),
  // звонок из лички: показать «Принять / Отклонить» на странице сервера, сбросить при входе в голосовой канал
  onCallRing: (cb) => ipcRenderer.on('call:ring', (_e, m) => cb(m)),
  onCallState: (cb) => ipcRenderer.on('call:state', (_e, m) => cb(m)),
  callState: () => ipcRenderer.invoke('call:get'),
  callCmd: (c) => ipcRenderer.send('call:cmd', c),
  voiceState: (st) => ipcRenderer.send('voice:state', st),
  onVoiceCmd: (cb) => ipcRenderer.on('voice:cmd', (_e, c) => cb(c)),
  voiceSettings: () => ipcRenderer.invoke('voice:settings-get'),
  // хост вышел посреди звонка — временный сервер у меня (без прав хоста)
  backupStart: (o) => ipcRenderer.invoke('backup:start', o),
  serverCache: (snap) => ipcRenderer.send('server:cache', snap),
  tempNote: () => ipcRenderer.invoke('app:temp-note'),
  backupPort: (() => { try { return ipcRenderer.sendSync('backup:port'); } catch { return 8449; } })(),
  saveVoiceSettings: (v) => ipcRenderer.send('voice:settings-set', v),
  servers: () => ipcRenderer.invoke('app:servers'),
  // мини-профиль: добавить кента в друзья прямо с сервера (по его адресу), узнать, друг ли он
  addFriend: (ip) => ipcRenderer.invoke('friends:add', ip),
  friendStatus: (appId) => ipcRenderer.invoke('friends:status', appId),
  goServer: (opts) => ipcRenderer.invoke('app:go-server', opts),
  friendsBadge: () => ipcRenderer.invoke('friends:badge'),
  onFriendsBadge: (cb) => ipcRenderer.on('friends:badge', (_e, n) => cb(n)),
  hostKnock: (name) => ipcRenderer.send('host:knock', name),
  setAccess: (a) => ipcRenderer.invoke('app:set-access', a),
  // ник и аватарка — общие для всех серверов
  getProfile: () => ipcRenderer.invoke('app:profile-get'),
  setProfile: (p) => ipcRenderer.invoke('app:profile-set', p),
};

if (isLocal) {
  Object.assign(api, {
    launcherGet: () => ipcRenderer.invoke('launcher:get'),
    connect: (opts) => ipcRenderer.invoke('launcher:connect', opts),
    serverEdit: (opts) => ipcRenderer.invoke('launcher:server-edit', opts),
    serverStop: (port) => ipcRenderer.invoke('launcher:server-stop', port),
    lan: () => ipcRenderer.invoke('lan:list'),
    lanScan: () => ipcRenderer.invoke('lan:scan'),
    onLan: (cb) => ipcRenderer.on('lan:changed', () => cb()),
    bridges: () => ipcRenderer.invoke('bridges:list'),
    bridgeAdd: (link) => ipcRenderer.invoke('bridges:add', link),
    bridgeRemove: (link) => ipcRenderer.invoke('bridges:remove', link),
    onBridges: (cb) => ipcRenderer.on('bridges:changed', () => cb()),
    account: {
      info: () => ipcRenderer.invoke('account:info'),
      setPassword: (pw) => ipcRenderer.invoke('account:set-password', pw),
      saveNow: () => ipcRenderer.invoke('account:save-now'),
      saveAs: (pw) => ipcRenderer.invoke('account:save-as', pw),
      openFolder: () => ipcRenderer.invoke('account:open-folder'),
      pickFile: () => ipcRenderer.invoke('account:pick-file'),
      restore: (file, pw) => ipcRenderer.invoke('account:restore', file, pw),
      linkCode: () => ipcRenderer.invoke('account:link-code'),
      linkJoin: (code) => ipcRenderer.invoke('account:link-join', code),
      onLinked: (cb) => ipcRenderer.on('account:linked', () => cb()),
    },
    friends: {
      me: () => ipcRenderer.invoke('friends:me'),
      list: () => ipcRenderer.invoke('friends:list'),
      add: (ip) => ipcRenderer.invoke('friends:add', ip),
      respond: (id, yes) => ipcRenderer.invoke('friends:respond', id, yes),
      remove: (id) => ipcRenderer.invoke('friends:remove', id),
      messages: (id) => ipcRenderer.invoke('friends:messages', id),
      read: (id) => ipcRenderer.invoke('friends:read', id),
      send: (id, text) => ipcRenderer.invoke('friends:send', id, text),
      invite: (id) => ipcRenderer.invoke('friends:invite', id),
      join: (address, name) => ipcRenderer.invoke('friends:join', address, name),
      onChanged: (cb) => ipcRenderer.on('friends:changed', () => cb()),
      onFocus: (cb) => ipcRenderer.on('friends:focus', (_e, id) => cb(id)),
      onShown: (cb) => ipcRenderer.on('friends:shown', (_e, v) => cb(v)),
      isShown: () => ipcRenderer.invoke('friends:is-shown'),
      isHome: () => ipcRenderer.invoke('friends:is-home'),
      // файл с диска отдаём путём (быстро, любого размера), вставленный скрин — байтами
      filePath: (file) => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },
      sendFile: (target, src, caption) => ipcRenderer.invoke('friends:send-file', target, src, caption),
      fileInfo: (fid) => ipcRenderer.invoke('friends:file-info', fid),
      fileFetch: (fid) => ipcRenderer.invoke('friends:file-fetch', fid),
      fileSave: (fid) => ipcRenderer.invoke('friends:file-save', fid),
      fileOpen: (fid) => ipcRenderer.invoke('friends:file-open', fid),
      close: () => ipcRenderer.send('friends:close'),
      call: (id, msg) => ipcRenderer.invoke('call:send', id, msg),
      ice: () => ipcRenderer.invoke('friends:ice'),
      groups: () => ipcRenderer.invoke('groups:list'),
      groupCreate: (name, ids) => ipcRenderer.invoke('groups:create', name, ids),
      groupUpdate: (gid, o) => ipcRenderer.invoke('groups:update', gid, o),
      groupLeave: (gid) => ipcRenderer.invoke('groups:leave', gid),
      groupMessages: (gid) => ipcRenderer.invoke('groups:messages', gid),
      groupRead: (gid) => ipcRenderer.invoke('groups:read', gid),
      groupSend: (gid, text) => ipcRenderer.invoke('groups:send', gid, text),
      groupCall: (gid, msg) => ipcRenderer.invoke('groups:call', gid, msg),
      onGroupCall: (cb) => ipcRenderer.on('gcall:in', (_e, m) => cb(m)),
      onCall: (cb) => ipcRenderer.on('call:in', (_e, m) => cb(m)),
      onCallCmd: (cb) => ipcRenderer.on('call:cmd', (_e, c) => cb(c)),
      callState: (st) => ipcRenderer.send('call:state', st),
      voice: () => ipcRenderer.invoke('voice:get'),
      onVoice: (cb) => ipcRenderer.on('voice:state', (_e, v) => cb(v)),
      voiceCmd: (c) => ipcRenderer.send('voice:cmd', c),
      onHotkey: (cb) => ipcRenderer.on('hotkey', (_e, a) => cb(a)),
    },
    pickerSources: () => ipcRenderer.invoke('picker:sources'),
    pickerChoose: (choice) => ipcRenderer.invoke('picker:choose', choice),
  });
}

contextBridge.exposeInMainWorld('kentovkaApp', api);

// ---------- своя рамка окна: неоновая полоса сверху с кнопками свернуть / развернуть / закрыть ----------
// одна и та же на стартовом экране и в приложении; в полноэкранном режиме (F11) прячется
if (!/picker\.html$/.test(location.pathname) && !isEmbed) {
  const SVG = (d) => `<svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.2">${d}</svg>`;
  const ICONS = {
    min: SVG('<path d="M1.5 6.5h9"/>'),
    max: SVG('<rect x="1.5" y="1.5" width="9" height="9" rx="1.5"/>'),
    restore: SVG('<rect x="1.5" y="3.5" width="7" height="7" rx="1.2"/><path d="M3.5 3.5V2.7c0-.7.5-1.2 1.2-1.2h4.6c.7 0 1.2.5 1.2 1.2v4.6c0 .7-.5 1.2-1.2 1.2h-.8"/>'),
    close: SVG('<path d="M2 2l8 8M10 2l-8 8"/>'),
  };
  const css = `
    :root { --k-tb: 32px; }
    html.k-full, html.k-full.k-max { --k-tb: 0px; }
    html { padding-top: var(--k-tb) !important; box-sizing: border-box; }
    #k-titlebar { position: fixed; top: 0; left: 0; right: 0; height: 32px; z-index: 2147483000; display: flex; align-items: center;
      -webkit-app-region: drag; user-select: none; font: 600 12.5px/1 Bahnschrift, "Segoe UI", system-ui, sans-serif; letter-spacing: .03em;
      color: var(--dim, #8a8fb3); background: color-mix(in srgb, var(--bg, #0a0b14) 88%, transparent); backdrop-filter: blur(8px);
      border-bottom: 1px solid var(--line, #262a40); }
    #k-titlebar::after { content: ""; position: absolute; left: 0; right: 0; bottom: -1px; height: 1px; pointer-events: none;
      background: linear-gradient(90deg, transparent, var(--accent, #22e1ff) 30%, var(--accent2, #ff3ec8) 70%, transparent);
      opacity: calc(.35 + .5 * var(--glow, .7)); box-shadow: 0 0 calc(10px * var(--glow, .7)) var(--accent, #22e1ff); }
    /* полноэкранный режим (F11): полоса прячется и выезжает, если подвести мышь к верхнему краю */
    html.k-full #k-titlebar { transform: translateY(calc(-100% + 3px)); opacity: 0; transition: transform .18s ease, opacity .18s ease; }
    html.k-full #k-titlebar:hover { transform: none; opacity: 1; }
    #k-titlebar .k-logo { width: 16px; height: 16px; margin: 0 9px 0 12px; border-radius: 5px; display: grid; place-items: center;
      font: 800 10px/1 Bahnschrift, sans-serif; color: var(--on-accent, #070812); background: linear-gradient(135deg, var(--accent, #22e1ff), var(--accent2, #ff3ec8));
      box-shadow: 0 0 calc(10px * var(--glow, .7)) rgba(var(--acc-rgb, 34,225,255), calc(.5 * var(--glow, .7))); }
    #k-titlebar .k-name { color: var(--dim, #8a8fb3); }
    #k-titlebar .k-sp { flex: 1; }
    #k-titlebar button { -webkit-app-region: no-drag; width: 46px; height: 32px; border: 0; background: transparent; color: var(--dim, #8a8fb3);
      display: grid; place-items: center; cursor: default; transition: background .12s, color .12s; }
    #k-titlebar button:hover { background: var(--panel3, #1e2236); color: var(--text, #e6e8ff); }
    #k-titlebar button.k-close:hover { background: #e81123; color: #fff; }
    #k-titlebar button:focus { outline: none; }
    /* тонкая неоновая рамка вокруг окна, когда оно не развёрнуто */
    html:not(.k-max):not(.k-full)::after { content: ""; position: fixed; inset: 0; z-index: 2147483001; pointer-events: none;
      border: 1px solid rgba(var(--acc-rgb, 34,225,255), calc(.18 + .3 * var(--glow, .7))); }
    html.k-blur::after { border-color: var(--line, #262a40) !important; }
    html.k-blur #k-titlebar::after { opacity: .2; box-shadow: none; }
  `;
  const build = () => {
    if (document.getElementById('k-titlebar')) return;
    const st = document.createElement('style'); st.id = 'k-titlebar-css'; st.textContent = css; document.head.appendChild(st);
    const bar = document.createElement('div'); bar.id = 'k-titlebar';
    bar.innerHTML = `<span class="k-logo">К</span><span class="k-name">${/friends\.html$/.test(location.pathname) ? 'Кентовка · Друзья' : 'Кентовка'}</span><span class="k-sp"></span>
      <button class="k-min" title="Свернуть" tabindex="-1">${ICONS.min}</button>
      <button class="k-max" title="Развернуть" tabindex="-1">${ICONS.max}</button>
      <button class="k-close" title="Закрыть" tabindex="-1">${ICONS.close}</button>`;
    document.body.appendChild(bar);
    // кнопки окна не забирают фокус (курсор остаётся в чате)
    bar.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
    bar.querySelector('.k-min').onclick = () => ipcRenderer.send('win:ctl', 'min');
    bar.querySelector('.k-max').onclick = () => ipcRenderer.send('win:ctl', 'max');
    bar.querySelector('.k-close').onclick = () => ipcRenderer.send('win:ctl', 'close');
    ipcRenderer.invoke('win:state').then(apply);
    if (!isLocal) ipcRenderer.invoke('app:server-name').then((n) => { if (n) bar.querySelector('.k-name').textContent = 'Кентовка · ' + n; });
  };
  const apply = (s) => {
    if (!s) return;
    const h = document.documentElement;
    h.classList.toggle('k-max', !!s.max); h.classList.toggle('k-full', !!s.full); h.classList.toggle('k-blur', s.focused === false);
    const b = document.querySelector('#k-titlebar .k-max');
    if (b) { b.innerHTML = s.max ? ICONS.restore : ICONS.max; b.title = s.max ? 'Свернуть в окно' : 'Развернуть'; }
  };
  ipcRenderer.on('win:state', (_e, s) => apply(s));
  window.addEventListener('keydown', (e) => { if (e.key === 'F11') { e.preventDefault(); ipcRenderer.send('win:ctl', 'full'); } }, true);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
}
