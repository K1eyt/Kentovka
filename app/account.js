// Аккаунт Кентовки — локальный, без серверов в интернете.
// Аккаунт = id (тот же, что для друзей и серверов) + пара ключей Ed25519. Хранится только на твоих устройствах.
// Серверы проверяют подпись ключом — под чужим аккаунтом (и чужим ником) не зайти.
// Сохранения: кнопкой в файл и автоматически в «Документы\Kentovka\Сохранения» — переживают удаление программы.
// Новое устройство: код со старого (данные идут напрямую между устройствами) или файл сохранения.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAGIC = 'kentovka-account';
const KEEP = 5;
const aidOf = (id) => crypto.createHash('sha256').update('kentovka-aid:' + String(id)).digest('hex').slice(0, 12);

function createAccount({ dataDir, documentsDir, getId, getConfig, setConfig, getFriendsDb, safeStorage }) {
  const file = path.join(dataDir, 'account.json');
  let acc = null, isNew = false;
  try { acc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  function ensure() {
    const id = getId();
    if (acc && acc.id === id && acc.priv) return acc;
    isNew = true;
    const k = crypto.generateKeyPairSync('ed25519');
    acc = { id, pub: k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), priv: k.privateKey.export({ type: 'pkcs8', format: 'pem' }), created: Date.now() };
    fs.writeFileSync(file, JSON.stringify(acc));
    return acc;
  }
  ensure();
  const privKey = () => crypto.createPrivateKey(ensure().priv);

  // подпись для сервера: доказываем, что этот id — наш
  function sign(text) {
    const a = ensure();
    return { id: a.id, pub: a.pub, sig: crypto.sign(null, Buffer.from(String(text)), privKey()).toString('base64') };
  }

  // ---------- сохранение и восстановление ----------
  const saveDir = () => path.join(documentsDir, 'Kentovka', 'Сохранения');
  function bundle() {
    const c = getConfig();
    return { v: 1, magic: MAGIC, at: Date.now(), account: ensure(),
      config: { profile: c.profile || null, theme: c.theme || null, voice: c.voice || null, hotkeys: c.hotkeys || null, servers: c.servers || [], direct: c.direct || null, access: c.access || null },
      friends: getFriendsDb() };
  }
  function encrypt(obj, password) {
    const data = Buffer.from(JSON.stringify(obj));
    if (!password) return { magic: MAGIC, v: 1, aid: aidOf(obj.account.id), name: (obj.config.profile || {}).name || '', at: obj.at, enc: false, data: data.toString('base64') };
    const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
    const key = crypto.scryptSync(String(password), salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return encWithKey(obj, key, salt, iv);
  }
  function encWithKey(obj, key, salt, iv = crypto.randomBytes(12)) {
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj))), c.final()]);
    return { magic: MAGIC, v: 1, aid: aidOf(obj.account.id), name: (obj.config.profile || {}).name || '', at: obj.at, enc: true, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
  }
  function decrypt(f, password) {
    if (!f || f.magic !== MAGIC) throw new Error('Это не сохранение Кентовки');
    if (!f.enc) return JSON.parse(Buffer.from(f.data, 'base64').toString('utf8'));
    if (!password) throw new Error('Нужен пароль от сохранения');
    const key = crypto.scryptSync(String(password), Buffer.from(f.salt, 'base64'), 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(f.iv, 'base64'));
      d.setAuthTag(Buffer.from(f.tag, 'base64'));
      return JSON.parse(Buffer.concat([d.update(Buffer.from(f.data, 'base64')), d.final()]).toString('utf8'));
    } catch { throw new Error('Неверный пароль'); }
  }
  // пароль для автосохранений задаётся один раз: храним не пароль, а ключ (защищён Windows, если можно)
  function setBackupPassword(password) {
    const c = getConfig();
    if (password === null) { c.backup = { mode: 'plain', at: Date.now() }; setConfig(c); return; }
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(String(password), salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    let keyStore;
    try { keyStore = safeStorage && safeStorage.isEncryptionAvailable() ? { os: safeStorage.encryptString(key.toString('base64')).toString('base64') } : { raw: key.toString('base64') }; }
    catch { keyStore = { raw: key.toString('base64') }; }
    c.backup = { mode: 'password', salt: salt.toString('base64'), key: keyStore, at: Date.now() };
    setConfig(c);
  }
  function storedKey() {
    const b = getConfig().backup; if (!b || b.mode !== 'password' || !b.key) return null;
    try { return Buffer.from(b.key.os ? safeStorage.decryptString(Buffer.from(b.key.os, 'base64')) : b.key.raw, 'base64'); } catch { return null; }
  }
  const stamp = (t) => { const d = new Date(t), z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}-${z(d.getMinutes())}`; };
  const safeName = (n) => String(n || 'аккаунт').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim().slice(0, 24) || 'аккаунт';
  // автосохранение (если выбран пароль или «без пароля»)
  function autoSave() {
    // пока пароль не выбран — сохраняем без пароля (чтобы после переустановки аккаунт точно нашёлся)
    const b = getConfig().backup || { mode: 'plain' };
    const obj = bundle();
    let out;
    if (b.mode === 'plain') out = encrypt(obj, null);
    else { const key = storedKey(); if (!key) return { skipped: 'нет ключа' }; out = encWithKey(obj, key, Buffer.from(b.salt, 'base64')); }
    fs.mkdirSync(saveDir(), { recursive: true });
    const name = path.join(saveDir(), `Кентовка-${safeName(obj.config.profile && obj.config.profile.name)}-${stamp(obj.at)}.knt`);
    fs.writeFileSync(name, JSON.stringify(out));
    // храним последние KEEP копий
    const all = listSaves().filter((x) => x.id === aidOf(obj.account.id) || (!x.id && x.name === ((obj.config.profile || {}).name || '')));
    for (const old of all.slice(KEEP)) { try { fs.unlinkSync(old.file); } catch {} }
    const c = getConfig(); c.lastAutoSave = obj.at; setConfig(c);
    return { ok: true, file: name };
  }
  function saveTo(file, password) {
    const obj = bundle();
    fs.writeFileSync(file, JSON.stringify(encrypt(obj, password || null)));
    return { ok: true, file };
  }
  function listSaves() {
    let names = [];
    try { names = fs.readdirSync(saveDir()).filter((n) => n.endsWith('.knt')); } catch { return []; }
    return names.map((n) => {
      const f = path.join(saveDir(), n);
      try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); if (j.magic !== MAGIC) return null; return { file: f, name: j.name, at: j.at, enc: !!j.enc, id: j.aid || null }; } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.at - a.at);
  }
  function readSave(file, password) { return decrypt(JSON.parse(fs.readFileSync(file, 'utf8')), password); }

  return { get isNew() { return isNew; }, sign, get secret() { return crypto.createHash('sha256').update('kentovka-sib:' + ensure().priv).digest('hex'); }, get id() { return ensure().id; }, get pub() { return ensure().pub; }, bundle, encrypt, decrypt, autoSave, saveTo, listSaves, readSave, setBackupPassword, saveDir, storedKey };
}

module.exports = { createAccount, MAGIC };
