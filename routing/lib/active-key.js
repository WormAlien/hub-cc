'use strict';
// Активный ключ шлюза: файл активации, а при его отсутствии - ключ из пула аккаунтов.
//
// 🎯 Зачем. Маршрутизация через префикс (`/model odyssey`) упиралась в `401 This API key
// is not valid`: локальный keepalive инжектит ключ из `<prefix>-active-key.txt`, а файла
// нет, пока ни один аккаунт не активирован кнопкой 🔑. Тогда наверх уходил КЛИЕНТСКИЙ
// токен от активного шлюза, и чужой шлюз его отвергал. Живой замер 16.09: odyssey,
// `request_id req_13e829bb3adafc7ea916729e`. Решение владельца: не требовать активации
// ради маршрутов - брать ключ из пула.
//
// Файл читается на КАЖДЫЙ запрос (как и раньше), поэтому смена ключа на вкладке работает
// на лету. Пул читается по mtime: правка пула подхватывается сама, без рестарта прокси.

const fs = require('fs');

// Ступени выбора аккаунта: активный → живой → ЛЮБОЙ с ключом.
//
// 🪤 Третья ступень обязательна, и это не запас на всякий случай: у odyssey все аккаунты
// помечены `unknown`/`dead` (статус ставит проверка баланса, а она не ходила), поэтому на
// первых двух ступенях пул отдаёт пустоту, хотя ключи рабочие - каталог по ним приходит.
function pickAccountKey(list) {
    const arr = Array.isArray(list) ? list.filter(a => a && a.api_key) : [];
    const pick = arr.find(a => a.active) || arr.find(a => a.status === 'live') || arr[0];
    return pick ? String(pick.api_key).trim() : '';
}

// Пул аккаунтов: объект по ключам `'0'`, `'1'`… или массив - понимаем обе формы.
function poolAccounts(sessionsFile) {
    let doc = {};
    try {
        const raw = fs.readFileSync(sessionsFile, 'utf8');
        doc = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw) || {};
    } catch { return []; }
    if (Array.isArray(doc)) return doc;
    return Object.values(doc).filter(v => v && typeof v === 'object');
}

const poolCache = new Map();                        // файл → { mtimeMs, key }
function poolKey(sessionsFile) {
    if (!sessionsFile) return '';
    try {
        const st = fs.statSync(sessionsFile);
        const hit = poolCache.get(sessionsFile);
        if (hit && hit.mtimeMs === st.mtimeMs) return hit.key;
        const key = pickAccountKey(poolAccounts(sessionsFile));
        poolCache.set(sessionsFile, { mtimeMs: st.mtimeMs, key });
        return key;
    } catch { return ''; }
}

// Итог: `{ key, source }`, где source - `active`, `pool` или `none`.
// Пустой ключ означает «инжектить нечего»: вызывающий оставляет заголовки как пришли,
// и это то же поведение, что было до правки.
function resolveKey(opts) {
    const keyFile = (opts && opts.keyFile) || '';
    const sessionsFile = (opts && opts.sessionsFile) || '';
    try {
        const k = fs.readFileSync(keyFile, 'utf8').trim();
        if (k) return { key: k, source: 'active' };
    } catch { /* активации нет - это и есть случай, ради которого модуль */ }
    const k = poolKey(sessionsFile);
    return k ? { key: k, source: 'pool' } : { key: '', source: 'none' };
}

module.exports = { pickAccountKey, poolAccounts, resolveKey };
