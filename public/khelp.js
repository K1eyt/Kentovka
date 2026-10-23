// Справка «?» — есть на каждом экране Кентовки, у каждого экрана и вкладки своё описание.
// kHelp.open('dm') — открыть; kHelp.button('dm') — кнопка «?» для шапки.
(function () {
  'use strict';
  const T = {
    friends: ['Друзья', [
      ['Добавить друга', 'Вкладка «Добавить в друзья»: впиши код друга (KNT-…) или его адрес в локальной сети. Он увидит заявку во вкладке «Ожидание».'],
      ['Кто в сети', '«В сети» — кто сейчас онлайн и чем занят: на каком сервере, в голосовом канале или в звонке.'],
      ['Написать', 'Нажми на друга — откроется личка. Слева — все беседы, сверху «+» — новая группа.'],
      ['Позвать на сервер', 'В личке кнопка «Позвать на сервер» — выбери один из своих серверов, другу придёт приглашение.'],
    ]],
    dm: ['Личка', [
      ['Сообщения', 'Пиши внизу и жми Enter. Правой кнопкой по сообщению — ответить, реакция, копировать, удалить.'],
      ['Файлы и скрины', 'Скрепка, Ctrl+V или перетаскивание — файл встаёт над полем. Можно добавить подпись и ещё файлы, отправить — Enter.'],
      ['Звонок', 'Трубка сверху. В звонке: микрофон, звук, показ экрана. Двойной клик по стриму — на весь экран.'],
      ['Где ты был', 'Беседа помнит, где ты читал: уйдёшь и вернёшься — окажешься там же.'],
    ]],
    group: ['Группа', [
      ['Участники', 'Справа — кто в группе и кто в сети. «Добавить друзей» — кнопка с людьми сверху.'],
      ['Звонок в группе', 'Трубка сверху: начать звонок или присоединиться к уже идущему.'],
      ['Сообщения и файлы', 'Как в личке: ответы, реакции, файлы над полем, Enter — отправить.'],
    ]],
    server: ['Сервер', [
      ['Каналы', 'Слева текстовые и голосовые каналы. Нажми на голосовой — зайдёшь в голосовой канал.'],
      ['Микрофон и звук', 'Кнопки внизу слева; стрелочка рядом — выбор устройства и громкость.'],
      ['Стрим экрана', 'В голосовом канале кнопка с монитором. Качество выбирается перед показом.'],
      ['Сообщения', 'Правой кнопкой по сообщению — ответить, реакция, сохранить файл, удалить.'],
      ['Настройки', 'Шестерёнка внизу: профиль, голос, стрим, вид, файлы, связь.'],
    ]],
    add: ['Серверы', [
      ['Зайти по адресу', 'Впиши адрес друга, который создал сервер. Подойдёт адрес из любой общей локальной сети. Порт — через двоеточие, если не 8443.'],
      ['Создать сервер', 'Ты хост: сервер работает на этом компе, друзья заходят по твоему адресу.'],
      ['Мои серверы', 'Слева в полосе: клик — зайти, правый клик — переименовать, убрать, остановить или удалить.'],
    ]],
    account: ['Аккаунт', [
      ['Сохранения', 'Аккаунт сохраняется сам. Пароль защищает сохранения — без него их не открыть.'],
      ['Другие устройства', '«Показать код» здесь и «Ввести код» на новом устройстве — тот же аккаунт с ноутбука или телефона.'],
      ['Мост', 'Чтобы заходили не только из локальной сети — подключи мост на своём VPS.'],
    ]],
    profile: ['Профиль', [
      ['Карточка', 'Ник, аватарка, «о себе» и шапка — так тебя видят другие по клику на ник.'],
      ['Сохранить', '«Сохранить профиль» или «Готово» — сохранит. «Отменить изменения» — вернёт как было.'],
    ]],
    voice: ['Голос', [
      ['Шумодав', 'Убирает шум вокруг. «Умный» — по умолчанию. Сила — насколько сильно чистить.'],
      ['Устройства', 'Микрофон и куда выводить звук. «Послушать себя» — проверить, как тебя слышно.'],
      ['Горячие клавиши', 'Микрофон и звук одной клавишей — даже из игры. Можно поставить просто Ctrl или Alt.'],
    ]],
    stream: ['Стрим', [
      ['Качество', 'Разрешение, кадры и режим: «Чёткость» — текст и код, «Плавность» — игры. То же выбирается перед показом.'],
      ['Игры', 'Если картинка замирает — переключи игру в режим «Окно без рамки» или показывай весь экран.'],
    ]],
    look: ['Вид', [['Оформление', 'Цвета, свечение, фон и анимации — меняется сразу и одинаково везде.']]],
    files: ['Файлы', [['Кеш', 'Файлы из чата хранятся на этом компе. Старое удаляется само.']]],
    net: ['Связь', [['Проверка', 'Если кого-то плохо слышно или большой пинг — «Проверить связь» покажет, где проблема.']]],
  };
  const css = `.khelp h4 { margin: 14px 0 4px; font: 700 14.5px var(--font-display, sans-serif); color: var(--text, #e6e8ff); }
    .khelp h4:first-of-type { margin-top: 8px; } .khelp p { margin: 0; color: var(--dim, #a3a8c8); font-size: 13.5px; line-height: 1.45; white-space: normal; }
    .khelpbtn { width: 30px; height: 30px; border-radius: 50%; display: inline-grid; place-items: center; flex: none; background: transparent; border: 0; color: var(--dim, #8a8fb3); cursor: pointer; }
    .khelpbtn:hover { color: var(--text, #e6e8ff); background: var(--panel3, #1e2236); } .khelpbtn svg { width: 19px; height: 19px; }
    .kdlg .khelpbtn, .stagebar .khelpbtn { padding: 0 !important; border: 0 !important; background: transparent !important; border-radius: 50% !important; width: 30px; height: 30px; }
    .kdlg .khelpbtn:hover { background: var(--panel3, #1e2236) !important; }`;
  const st = document.createElement('style'); st.textContent = css; (document.head || document.documentElement).appendChild(st);
  let openD = null, openTopic = null;
  function open(topic) {
    if (openD && openD.open) { const same = openTopic === topic; openD.close(); if (same) return; }
    const t = T[topic] || T.server;
    const d = document.createElement('dialog'); d.className = 'kdlg khelp';
    d.innerHTML = '<div class="kd-b"><div class="kd-t"></div></div><div class="kd-f"><button type="button" class="ok">Понятно</button></div>';
    d.querySelector('.kd-t').textContent = 'Справка — ' + t[0];
    const b = d.querySelector('.kd-b');
    for (const [h, p] of t[1]) { const H = document.createElement('h4'); H.textContent = h; const P = document.createElement('p'); P.textContent = p; b.append(H, P); }
    d.querySelector('.ok').onclick = () => d.close();
    let out = false;
    d.addEventListener('pointerdown', (e) => { const r = d.getBoundingClientRect(); out = e.target === d && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom); });
    d.addEventListener('click', (e) => { if (out && e.target === d) d.close(); out = false; });
    d.addEventListener('close', () => { d.remove(); if (openD === d) openD = null; });
    document.body.appendChild(d); d.showModal(); openD = d; openTopic = topic;
  }
  function button(topic) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'khelpbtn'; b.title = 'Справка';
    b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/></svg>';
    b.onclick = (e) => { e.stopPropagation(); open(typeof topic === 'function' ? topic() : topic); };
    return b;
  }
  window.kHelp = { open, button, topics: T };
})();
