'use strict';
// league-instance.js — «какая нода у приёмника и можно ли на этом основании
// переподключаться». Вынесено из transparent-proxy.js, чтобы правило можно было
// проверить тестом без сети и без хаба (tools/check-league-instance-verdict.js).
//
// Зачем это вообще нужно. После переезда приёмника на другую ноду у старых хабов
// остаётся токен, которого новый приёмник не знает: 401. Тот ЖЕ 401 приходит и
// отозванному участнику на прежней ноде, а ему переподключаться нельзя — это был бы
// обход отзыва. Отличить один случай от другого можно только по `instance` из
// `/health` (единственная ручка без ключа).
//
// 🪤 Отсутствующий файл с прежним instance — это НЕ «нода новая». Старые установки
// приходят ровно с такой дыркой (живой случай 22.11.2026: клиент месяц не заходил).
// Трактовать её как разрешение на авто-джойн значило бы молча обходить отзыв, поэтому
// отсутствие — состояние unknown_prev и запрет.

const fs = require('node:fs');
const path = require('node:path');

const INSTANCE_RE = /^[a-f0-9]{16}$/;

// Где по умолчанию лежит клиентское состояние. Нарочно НЕ `league-data/`: тот каталог
// принадлежит ПРИЁМНИКУ (secret, instance-id ноды, срезы), и на клиенте его обычно нет.
const DEFAULT_DIR = path.join(__dirname, '..', 'league-client-state');
const DEFAULT_FILE = path.join(DEFAULT_DIR, 'receiver-instance.json');

function known({ file = DEFAULT_FILE } = {}) {
    try {
        const d = JSON.parse(fs.readFileSync(file, 'utf8'));
        const inst = String((d && d.instance) || '').trim();
        return INSTANCE_RE.test(inst) ? inst : null;
    } catch { return null; }
}

function remember({ file = DEFAULT_FILE, instance, extra } = {}) {
    const inst = String(instance || '').trim();
    if (!INSTANCE_RE.test(inst)) return false;
    if (known({ file }) === inst) return true;      // уже записан — файл не трогаем
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({
            instance: inst, seenAt: new Date().toISOString(), ...(extra || {}),
        }, null, 2) + '\n');
        fs.renameSync(tmp, file);
        return true;
    } catch { return false; }
}

// Шесть исходов, которые обязаны различаться:
//   unknown_prev    — прежний instance неизвестен: авто-джойн НЕ разрешён;
//   changed         — известный прежний сменился: нода другая (переезд);
//   same            — instance совпал: отказ про личность, не про ноду;
//   receiver_down   — /health не ответил: транспорт, а не авторизация;
//   disabled        — участие выключено человеком: обратно не включаем;
//   config_broken   — конфиг не разбирается: чинить руками.
//
// `autoJoinAllowed` — право ПЕРЕПОДКЛЮЧИТЬСЯ на новой ноде. Оно есть только при
// changed; `revokedMustStayRevoked` напоминает, что даже changed не возвращает
// отозванную личность: смена ноды не отменяет решение владельца приёмника.
function verdict({ file = DEFAULT_FILE, remote, enabled = true, broken = false } = {}) {
    if (broken) return { state: 'config_broken', autoJoinAllowed: false };
    if (!enabled) return { state: 'disabled', autoJoinAllowed: false };
    if (!remote) return { state: 'receiver_down', autoJoinAllowed: false };
    const inst = String(remote);
    if (!INSTANCE_RE.test(inst)) return { state: 'receiver_down', autoJoinAllowed: false };
    const prev = known({ file });
    if (!prev) return { state: 'unknown_prev', instance: inst, autoJoinAllowed: false };
    if (prev !== inst) {
        return { state: 'changed', instance: inst, previous: prev,
            autoJoinAllowed: true, revokedMustStayRevoked: true };
    }
    return { state: 'same', instance: inst, autoJoinAllowed: false };
}

module.exports = { INSTANCE_RE, DEFAULT_DIR, DEFAULT_FILE, known, remember, verdict };
