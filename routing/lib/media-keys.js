'use strict';
/*
 * media-keys.js — какой ключ провайдера тратит студия MEDIA.
 *
 * Зачем отдельный файл. У одного провайдера может лежать несколько ключей — по аккаунту
 * на грант, — а студия брала ПЕРВЫЙ и остальные не использовала вообще. Выбор живёт здесь,
 * а не в записи провайдера: `custom-providers.json` пишет живой дашборд, и правка его
 * третьей рукой — гарантированная потеря встречного обновления. Ровно по этой причине
 * рядом и кеш моделей держится в своём файле (см. шапку `media-routes.js`).
 *
 * 🪤 В файле лежит САМ ключ, поэтому он в `routing/runtime/` — этот каталог уже в
 * .gitignore (строка 135). Наружу ключ не отдаётся никогда: студия получает только маски
 * и индекс, а обратно шлёт индекс — значение ключа с сервера не покидает.
 *
 * 🪤 Выбор хранится ЗНАЧЕНИЕМ, а не индексом: индексы поедут, как только ключ удалят из
 * карточки, и выбор молча переключился бы на чужой аккаунт. Пропавший из карточки выбор
 * просто игнорируется — это и есть автоматический откат к поведению по умолчанию.
 */

const fs = require('fs');
const path = require('path');

// 🪤 Перекрывается переменной окружения — этим пользуется регресс `tools/check-media.js`,
// чтобы проверять порядок выбора, не записывая ничего в живой файл студии.
const FILE = process.env.MEDIA_KEYS_FILE || path.join(__dirname, '..', 'runtime', 'media-keys.json');

function read() {
    try {
        const raw = fs.readFileSync(FILE, 'utf8');
        const doc = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
    } catch { return {}; }
}

function save(doc) {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, FILE);
}

/** Что выбрано в студии для этого провайдера, или null. */
function chosen(providerId) {
    const v = read()[String(providerId || '')];
    return typeof v === 'string' && v ? v : null;
}

/** Запомнить выбор. Пустой `apiKey` — снять выбор и вернуться к умолчанию. */
function set(providerId, apiKey) {
    const id = String(providerId || '');
    if (!id) throw new Error('нужен providerId');
    const doc = read();
    if (apiKey) doc[id] = String(apiKey);
    else delete doc[id];
    save(doc);
}

/**
 * Маска ключа для интерфейса.
 * 🪤 Хвост показываем ТОЛЬКО у достаточно длинного ключа: у короткого `slice(-8)` вернул бы
 * его же целиком, и «маска» стала бы утечкой. Случай не гипотетический — системный токен
 * New API заметно короче обычного `sk-`, а ключи бывают и совсем короткими (заглушка,
 * локальный шлюз).
 */
function mask(apiKey) {
    const s = String(apiKey || '');
    if (!s) return null;
    return s.length >= 16 ? '…' + s.slice(-8) : '…скрыт';
}

/**
 * Ключ, которым студия пойдёт к провайдеру.
 * Порядок: выбор в студии → первый активный → первый ключ карточки.
 * Первые два шага совместимы с прежним поведением, когда выбора ещё нет.
 */
function pick(provider) {
    const keys = (provider && provider.keys) || [];
    const want = chosen(provider && provider.id);
    if (want) {
        const hit = keys.find(k => k && k.apiKey === want);
        if (hit) return hit;
    }
    return keys.find(k => k && k.active) || keys[0] || null;
}

module.exports = { FILE, read, chosen, set, mask, pick };
