#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  league-admin.js — роли и права участников лиги. Запускается НА НОДЕ.
//
//  Зачем файл существует. Приёмник умеет менять роли по сети (`/admin/role`), но
//  только по требованию того, кто УЖЕ админ. Первого админа так не сделать: пока
//  админов ноль, некому подписать запрос. Ручка «сделай меня админом, если админов
//  нет» была бы дырой размером с лигу — её занял бы первый, кто нашёл адрес.
//  Поэтому вход в администрирование только один и офлайновый: доступ к каталогу
//  данных ноды. Кто может править `members.json` руками, тот и так может всё.
//
//  Второе назначение — чинить лигу, оставшуюся без админов. По сети это состояние
//  невосстановимо by design (приёмник не даёт снять последнего админа, но запись
//  можно потерять иначе — порчей файла, ошибкой переноса), и тогда единственный
//  выход здесь.
//
//  Что делает: читает и правит `<DATA>/members.json` — тем же атомарным приёмом и
//  с теми же правами `0600`, что и приёмник (запись во времянку + rename). Рестарт
//  сервиса НЕ нужен: приёмник перечитывает файл по метке времени на каждом запросе.
//
//  Запуск:
//    node tools/league-admin.js <DATA> --list
//    node tools/league-admin.js <DATA> --bootstrap
//    node tools/league-admin.js <DATA> --promote=<memberId>
//    node tools/league-admin.js <DATA> --demote=<memberId>
//    node tools/league-admin.js <DATA> --grant=<memberId>     # разрешить файлы и звук
//    node tools/league-admin.js <DATA> --revoke=<memberId>    # запретить их же
//
//  Настройки графика (владелец 23.09.2026: «настройки графика живут на ноде»). Их читает
//  приёмник и отдаёт хабам, хабы - странице: менять график можно всем сразу, не дожидаясь
//  ничьих обновлений. Хранилище - `<DATA>/chart.json`, тот же офлайн-вход, что и роли.
//
//    node tools/league-admin.js <DATA> --chart                 # показать
//    node tools/league-admin.js <DATA> --chart-top=5           # сколько лидеров линиями (1..12)
//    node tools/league-admin.js <DATA> --chart-self=on|off     # рисовать ли смотрящего
//
//  Расписание наливки AgentRouter (владелец 23.09.2026: «часы наливки на сервере, а не в
//  обновлении»). Хаб забирает его на тике и пишет в локальный файл расписания, откуда его
//  берут все читатели сразу: проба квоты, планировщик партии, статуслайн, вкладка.
//
//    node tools/league-admin.js <DATA> --ar-schedule                        # показать
//    node tools/league-admin.js <DATA> --ar-schedule-tz=Asia/Shanghai
//    node tools/league-admin.js <DATA> --ar-schedule-times=10:00,19:00
//
//  Каталог данных — тот, что стоит в живом юните (`Environment=DATA=…`), обычно
//  `/opt/league/data`. Токенов скрипт не печатает и не создаёт: в файле лежат
//  только их хеши, и восстановить токен из хеша нельзя — это свойство, а не помеха.
//
//  Коды выхода: 0 — сделано; 1 — не сделано (причина напечатана).
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const ARGV = process.argv.slice(2);
const has = n => ARGV.includes('--' + n);
const opt = (n) => {
  const p = `--${n}=`;
  const hit = ARGV.find(a => a.startsWith(p));
  return hit === undefined ? null : hit.slice(p.length);
};
const DATA = (ARGV.find(a => !a.startsWith('--')) || '').replace(/[/\\]+$/, '');
const CHART = path.join(DATA, 'chart.json');
// Расписание наливки лежит рядом: см. `schedClean` в league-receiver.js.
const ARSCHED = path.join(DATA, 'ar-schedule.json');

// Значения по умолчанию повторяют приёмник (`CHART_DEFAULT` в league-receiver.js): если файла
// нет, показывать и писать одно и то же - иначе «--chart» врал бы про фактическую отрисовку.
const CHART_DEFAULT = { top: 5, self: true };
function chartRead() {
  try {
    const raw = fs.readFileSync(CHART, 'utf8');
    const d = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    return Object.assign({}, CHART_DEFAULT, d);
  } catch { return Object.assign({}, CHART_DEFAULT); }
}
function arSchedRead() {
  try {
    const raw = fs.readFileSync(ARSCHED, 'utf8');
    const d = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    return { tz: String((d && d.tz) || ''), times: Array.isArray(d && d.times) ? d.times : [], note: String((d && d.note) || '') };
  } catch { return { tz: '', times: [], note: '' }; }
}
function writeArSched(obj) {
  const tmp = ARSCHED + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, ARSCHED);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* и времянки нет - тем лучше */ }
    stop(`запись ${ARSCHED} не удалась: ${e.message} (${e.code || 'без кода'})`);
  }
}
function writeChart(obj) {
  const tmp = CHART + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, CHART);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* и времянки нет - тем лучше */ }
    stop(`запись ${CHART} не удалась: ${e.message} (${e.code || 'без кода'})`);
  }
}

const say = s => console.log(s);
const okk = s => console.log('  ✅ ' + s);
const stop = (s) => { console.error('❌ ' + s); process.exit(1); };

if (has('help') || has('h') || !DATA) {
  say(`league-admin.js — роли и права участников лиги (запускать на ноде)

  node tools/league-admin.js <DATA> --list
  node tools/league-admin.js <DATA> --bootstrap
  node tools/league-admin.js <DATA> --promote=<memberId>
  node tools/league-admin.js <DATA> --demote=<memberId>
  node tools/league-admin.js <DATA> --grant=<memberId>
  node tools/league-admin.js <DATA> --revoke=<memberId>

  <DATA> — каталог данных из живого юнита (Environment=DATA=…), обычно /opt/league/data.

  --bootstrap выдаёт админа, только если админов НЕТ ВООБЩЕ и активная запись ровно одна.
  Это не «сделать меня главным», а «поднять лигу, оставшуюся без управления».`);
  process.exit(DATA ? 0 : 1);
}

const MEMBERS = path.join(DATA, 'members.json');

function readMembers() {
  let raw;
  try { raw = fs.readFileSync(MEMBERS, 'utf8'); }
  catch (e) {
    stop(e.code === 'ENOENT'
      ? `нет ${MEMBERS}\n   Либо каталог данных другой, либо лига ещё на общем ключе —`
        + ' тогда сначала перевод: node tools/league-migrate.js <DATA>'
      : `${MEMBERS} не читается: ${e.message}`);
  }
  let map;
  try { map = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw); }
  catch (e) { stop(`${MEMBERS} не разбирается: ${e.message}\n   Файл не тронут.`); }
  if (!map || typeof map !== 'object' || Array.isArray(map)) stop(`${MEMBERS}: ждём объект-карту`);
  return map;
}

// Тот же приём, что `writeState` в приёмнике: времянка рядом + rename. Права 0600
// ставятся при СОЗДАНИИ времянки — выставить их после переименования уже поздно,
// между двумя вызовами файл существует с правами по умолчанию.
function writeMembers(map) {
  const tmp = MEMBERS + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, MEMBERS);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* и времянки нет — тем лучше */ }
    stop(`запись ${MEMBERS} не удалась: ${e.message} (${e.code || 'без кода'})`);
  }
}

// Отсутствие поля прав — это «прав нет», а не «неизвестно». Проверки утвердительные,
// иначе записи, заведённые до появления ролей, читались бы как админские.
const roleOf = r => (r && r.role === 'admin' ? 'admin' : 'member');
const uploadOf = r => !!(r && r.canUpload === true);

function find(map, mid) {
  const key = String(mid || '').trim();
  if (!key) stop('не назван memberId');
  const rec = map[key];
  if (!rec || typeof rec !== 'object') {
    stop(`участника ${key} нет в реестре.\n   Посмотреть, кто есть: --list`);
  }
  return { key, rec };
}

function list(map) {
  const rows = Object.entries(map);
  if (!rows.length) return say('реестр пуст');
  say(`участников: ${rows.length}\n`);
  const w = Math.max(...rows.map(([k]) => k.length), 8);
  say('  ' + 'memberId'.padEnd(w) + '  роль    файлы  статус    ник');
  for (const [mid, rec] of rows) {
    const r = rec && typeof rec === 'object' ? rec : {};
    say('  ' + mid.padEnd(w)
      + '  ' + roleOf(r).padEnd(6)
      + '  ' + (uploadOf(r) ? 'да   ' : 'нет  ')
      + '  ' + String(r.status || '?').padEnd(8)
      + '  ' + (r.nick || '(без ника)'));
  }
  const admins = rows.filter(([, r]) => roleOf(r) === 'admin' && r && r.status === 'active').length;
  say('');
  if (!admins) say('⚠️  активных админов НЕТ — принимать заявки некому. Починка: --bootstrap');
  else say(`активных админов: ${admins}`);
}

function setField(map, mid, patch, what) {
  const { key, rec } = find(map, mid);
  const next = { ...rec, ...patch };
  map[key] = next;
  writeMembers(map);
  okk(`${key} (${rec.nick || 'без ника'}): ${what}`);
  say('   Рестарт не нужен: приёмник перечитает файл на следующем запросе.');
}

const map = readMembers();

if (has('list')) { list(map); process.exit(0); }

if (has('bootstrap')) {
  const active = Object.entries(map).filter(([, r]) => r && r.status === 'active');
  const admins = active.filter(([, r]) => roleOf(r) === 'admin');
  if (admins.length) {
    stop(`админы уже есть (${admins.length}), бутстрап не нужен.`
      + `\n   Выдать ещё одного: --promote=<memberId>`);
  }
  if (active.length !== 1) {
    stop(`активных записей ${active.length}, а бутстрап работает только когда она одна.`
      + '\n   Кому выдавать — должно быть очевидно без догадок. Смотри --list и назови явно:'
      + '\n   --promote=<memberId>');
  }
  const [mid, rec] = active[0];
  map[mid] = { ...rec, role: 'admin', canUpload: true };
  writeMembers(map);
  okk(`${mid} (${rec.nick || 'без ника'}) — теперь админ, файлы разрешены`);
  process.exit(0);
}

const promote = opt('promote');
if (promote !== null) {
  const { rec } = find(map, promote);
  if (roleOf(rec) === 'admin') { say(`  ${promote} уже админ — ничего не менял`); process.exit(0); }
  setField(map, promote, { role: 'admin', canUpload: true }, 'теперь админ, файлы разрешены');
  process.exit(0);
}

const demote = opt('demote');
if (demote !== null) {
  const { key, rec } = find(map, demote);
  if (roleOf(rec) !== 'admin') { say(`  ${key} и так не админ — ничего не менял`); process.exit(0); }
  const others = Object.entries(map)
    .filter(([k, r]) => k !== key && roleOf(r) === 'admin' && r && r.status === 'active').length;
  if (!others) {
    stop(`${key} — последний активный админ, снять его нельзя.`
      + '\n   Лига без админов не принимает заявки и не раздаёт права, а починить это можно'
      + '\n   только здесь же, руками на ноде. Сначала выдай админа другому: --promote=<memberId>');
  }
  setField(map, demote, { role: 'member' }, 'больше не админ (право на файлы оставлено)');
  process.exit(0);
}

const schTz = opt('ar-schedule-tz');
const schTimes = opt('ar-schedule-times');
if (has('ar-schedule') || schTz !== null || schTimes !== null) {
  const cur = arSchedRead();
  if (schTz !== null) cur.tz = String(schTz).trim();
  if (schTimes !== null) {
    cur.times = String(schTimes).split(',').map(x => x.trim()).filter(Boolean);
    if (!cur.times.length) stop('--ar-schedule-times пусто: назови времена через запятую, например 10:00,19:00');
  }
  if (schTz !== null || schTimes !== null) {
    writeArSched(cur);
    okk(`расписание наливки записано: ${ARSCHED}`);
  }
  say(`  зона: ${cur.tz || '(не задана)'}   времена партий: ${cur.times.join(', ') || '(нет)'}`);
  say('  приёмник прочитает на ближайшем запросе, хабы подтянут на своём тике (раз в 10 минут).');
  process.exit(0);
}

const chTop = opt('chart-top');
const chSelf = opt('chart-self');
if (has('chart') || chTop !== null || chSelf !== null) {
  const cur = chartRead();
  if (chTop !== null) {
    const n = Number(chTop);
    if (!Number.isFinite(n) || n < 1 || n > 12) stop(`--chart-top принимает 1..12, получено «${chTop}»`);
    cur.top = Math.trunc(n);
  }
  if (chSelf !== null) {
    const v = String(chSelf).trim().toLowerCase();
    if (!['on', 'off', '1', '0', 'да', 'нет'].includes(v)) stop(`--chart-self принимает on|off, получено «${chSelf}»`);
    cur.self = ['on', '1', 'да'].includes(v);
  }
  if (chTop !== null || chSelf !== null) {
    writeChart(cur);
    okk(`настройки графика записаны: ${CHART}`);
  }
  say(`  лидеров линиями: ${cur.top}   смотрящий: ${cur.self ? 'да, всегда' : 'нет'}`);
  say('  приёмник прочитает на ближайшем запросе, хабы подтянут на своём тике (раз в 10 минут).');
  process.exit(0);
}

const grant = opt('grant');
if (grant !== null) { setField(map, grant, { canUpload: true }, 'файлы и звук разрешены'); process.exit(0); }

const revoke = opt('revoke');
if (revoke !== null) { setField(map, revoke, { canUpload: false }, 'файлы и звук запрещены'); process.exit(0); }

stop('не назван ни один режим. Что можно: --list, --bootstrap, --promote=, --demote=, --grant=, --revoke=, --chart, --chart-top=, --chart-self=, --ar-schedule, --ar-schedule-tz=, --ar-schedule-times=');
