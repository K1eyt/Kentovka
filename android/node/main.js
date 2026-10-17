// Точка входа node на Android: подменяем модуль electron и запускаем ту же программу, что на ПК.
// Аргументы от Java: <папка данных> <папка программы app>
'use strict';
const path = require('path');
const Module = require('module');
const dataDir = process.argv[2] || path.join(__dirname, 'data');
const appDir = process.argv[3] || path.join(__dirname, 'app');
process.env.KENTOVKA_USERDATA = process.env.KENTOVKA_USERDATA || dataDir;
process.env.KENTOVKA_APPDIR = appDir;
process.env.KENTOVKA_DOCS = process.env.KENTOVKA_DOCS || path.join(dataDir, 'docs');
const shimPath = path.join(__dirname, 'electron-shim.js');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === 'electron') return shimPath;
  if (request === 'uiohook-napi') throw Object.assign(new Error('нет на Android'), { code: 'MODULE_NOT_FOUND' });
  return origResolve.call(this, request, parent, ...rest);
};
process.on('uncaughtException', (e) => console.error('ошибка:', e && e.stack || e));
process.on('unhandledRejection', (e) => console.error('ошибка (promise):', e && e.stack || e));
require(path.join(appDir, 'main.js'));
