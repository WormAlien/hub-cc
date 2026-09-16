'use strict';
// Источники каталога моделей для вкладки «Маршруты».
//
// Зачем: селект тира должен предлагать то, что шлюз РЕАЛЬНО отдаёт, а не только значения,
// уже лежащие в его тир-карте. Иначе строка выглядит выключенной (`— как есть —` и одна
// модель), хотя шлюз отдаёт одиннадцать. Замер 16.09: odyssey 1 опция из 11, aikeysapi 1,
// gorouter 2 из 4, tabi 2 из 4, rumeng 3 из 17.
//
// Источников цепочка, первый ответивший выигрывает:
//   1. живой ключ `<prefix>-active-key.txt` → `/<ep>/models` (было и раньше)
//   2. ключ любого аккаунта пула            → `/<ep>/models` (у odyssey и aikeysapi
//      активации нет вовсе, а ключи в пуле лежат)
//   3. наш снимок `custom-models-cache.json` по хосту шлюза (gorouter, tabi, rumeng)
//   4. значения тир-карты — их подмешивает сама вкладка, здесь их нет
//
// 🎯 В селект идут ТОЛЬКО текстовые модели (решение владельца 16.09). Картинка или видео
// целью тира — это упавший запрос: шлюз получит `gpt-image-2` там, где ждёт чат.
//
// 🪤 Служебные имена (`auto`, `step-router-v1`) НЕ трогаем: они и так лежат в живых
// каталогах, а резать работающее без заявки хуже, чем оставить.

const fs = require('fs');
const path = require('path');

// Ступени выбора ключа аккаунта живут в одном месте - `lib/active-key.js`: там же резолвер
// для keepalive. Вторая копия этих ступеней разошлась бы с ним (так уже было до 16.09).
const { pickAccountKey } = require('./active-key');

const CACHE_FILE = path.join(__dirname, '..', 'custom-models-cache.json');

// Хосты шлюзов, которых нет в MONEY_GW: там только денежные шлюзы, а снимок каталога есть
// и у этих двух. Ключ — имя провайдера, значение — хост из `custom-models-cache.json`.
const EXTRA_HOSTS = { rumeng: 'api.rumeng-ai.com', aikeysapi: 'www.aikeysapi.com' };

// Медиа, эмбеддинги, озвучка и модерация целью тира быть не могут. Границы слова —
// разделитель или край строки, чтобы `gpt-image-2` отсеялся, а `imaging-pro` тоже.
//
// 🪤 Последние две — известные СЕМЬИ медиа, которые по имени себя не выдают: в снимке
// aikeysapi рядом с тремя текстовыми GPT лежат `omni_flash_10s` (видео) и
// `omni_flash_abra_edit` (правка картинок), и ни то, ни другое в имени не признаётся.
// Список пополняемый: новая семья — новая строка здесь и проверка в регрессе.
const NON_TEXT = /(^|[/_.\-])(image|img|video|embed|embedding|rerank|whisper|tts|audio|speech|moderation|flux|dall|sd\d|omni_flash)([/_.:\-]|$)/i;

// Одна модель каталога текстовáя? Пустой или отсутствующий список типов — это «нет
// данных», а НЕ «медиа»: у odyssey он пуст у всех одиннадцати, и старый фильтр выбрасывал
// каталог целиком, считая каждую модель картинкой.
function isTextModel(id, types) {
    const name = String(id || '');
    if (!name) return false;
    if (NON_TEXT.test(name)) return false;
    const list = Array.isArray(types) ? types : [];
    if (list.some(t => /video|image|embedding|audio|rerank/i.test(String(t)))) return false;
    return true;
}

// Приводим ответ шлюза к списку имён: строки, объекты `{id}`, дедуп, только текстовые.
function textOnly(models) {
    const seen = new Set();
    const out = [];
    for (const m of Array.isArray(models) ? models : []) {
        const id = typeof m === 'string' ? m : (m && m.id);
        if (!id || seen.has(id)) continue;
        if (!isTextModel(id, m && m.supported_endpoint_types)) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

// Ключ аккаунта из пула берётся из `active-key.js` (см. require выше).

// Читаем снимок каталога. Ключ в файле — базовый URL шлюза (`https://gorouter.app/v1`).
function readSnapshot(cacheFile) {
    let doc = {};
    try {
        const raw = fs.readFileSync(cacheFile || CACHE_FILE, 'utf8');
        doc = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw) || {};
    } catch { return {}; }
    const byHost = {};
    for (const [url, entry] of Object.entries(doc)) {
        let host = '';
        try { host = new URL(url).hostname; } catch { continue; }
        if (!host || !entry) continue;
        const data = Array.isArray(entry.data) ? entry.data
            : (entry.data && Array.isArray(entry.data.data) ? entry.data.data : []);
        // 🪤 Две записи на один хост не склеиваем: берём свежую по `ts`.
        const prev = byHost[host];
        if (prev && prev.ts >= (entry.ts || 0)) continue;
        byHost[host] = { models: textOnly(data), ts: entry.ts || 0 };
    }
    return byHost;
}

// Снимок по хосту шлюза. Совпадение — сам хост или поддомен в любую сторону
// (`aipm9527.online` против `aipm9527.xyz` не совпадёт, и это правильно: это разные шлюзы).
function snapshotFor(host, opts) {
    if (!host) return null;
    const byHost = readSnapshot(opts && opts.cacheFile);
    const key = Object.keys(byHost).find(h => h === host || h.endsWith('.' + host) || host.endsWith('.' + h));
    if (!key) return null;
    const hit = byHost[key];
    if (!hit || !hit.models.length) return null;
    return {
        models: hit.models,
        ts: hit.ts,
        staleDays: hit.ts ? Math.floor((Date.now() - hit.ts) / 86400000) : null,
    };
}

module.exports = { EXTRA_HOSTS, CACHE_FILE, isTextModel, textOnly, pickAccountKey, readSnapshot, snapshotFor };
