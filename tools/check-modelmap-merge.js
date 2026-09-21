#!/usr/bin/env node
'use strict';
// Тир-карты: слияние вместо полной перезаписи.
//
// Что доказываем и почему именно это:
//  1. `gpt`, выставленный из вкладки «Маршруты», ПЕРЕЖИВАЕТ сохранение с вкладки шлюза.
//     До 11.09 девять ручек из десяти собирали объект из тела запроса и писали файл
//     целиком — то есть молча стирали тир, которым не управляют. Ответ приходил `ok`,
//     файл оставался на месте, значение исчезало. Это главный регресс, который фича
//     «управлять маппингом из Маршрутов» создала бы сама себе.
//  2. Ни одна ручка больше не пишет тир-карту целиком (статическая проверка).
//  3. Битый/отсутствующий/не-объектный файл не роняет запись.
//  4. Историческое расхождение пустых значений ('' у ar/tb/xp, null у остальных)
//     сохранено осознанно — читателям всё равно, но диффы семи файлов не шумят.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const SRC = path.join(__dirname, '..', 'routing', 'transparent-proxy.js');
const src = fs.readFileSync(SRC, 'utf8');

// ── Вытащить writeTierMap из монолита и исполнить в песочнице ────────────────
// Требовать весь transparent-proxy.js нельзя: он поднимает сервер на боевом порту.
function extract(name) {
    const head = src.indexOf(`function ${name}(`);
    assert.ok(head > 0, `${name} не найдена в transparent-proxy.js`);
    const end = src.indexOf('\n}\n', head);
    assert.ok(end > head, `не найден конец ${name}`);
    return src.slice(head, end + 3);
}
const logLines = [];
const sandbox = { fs, path, logLine: (s) => logLines.push(s) };
// eslint-disable-next-line no-new-func
const writeTierMap = new Function('fs', 'path', 'logLine',
    `${extract('writeTierMap')}; return writeTierMap;`)(sandbox.fs, sandbox.path, sandbox.logLine);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mmmerge-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { } });
const f = (n) => path.join(TMP, n);
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const failures = [];
const check = (name, fn) => {
    try { fn(); console.log(`  ok   ${name}`); }
    catch (e) { failures.push(name); console.log(`  FAIL ${name}\n       ${e.message}`); }
};

// ── 1. Главное: gpt переживает сохранение трёх тиров ────────────────────────
check('gpt переживает сохранение трёх тиров с вкладки шлюза', () => {
    const p = f('a.json');
    fs.writeFileSync(p, JSON.stringify({ opus: 'o1', sonnet: 's1', haiku: 'h1', gpt: 'gpt-5.6-sol' }), 'utf8');
    const mm = writeTierMap(p, { opus: 'o2', sonnet: 's2', haiku: 'h2' }, null);
    assert.strictEqual(mm.gpt, 'gpt-5.6-sol', 'gpt стёрт в возвращённом объекте');
    assert.strictEqual(read(p).gpt, 'gpt-5.6-sol', 'gpt стёрт на диске');
    assert.strictEqual(read(p).opus, 'o2', 'opus не записан');
});

check('правка одного тира не трогает остальные три', () => {
    const p = f('b.json');
    fs.writeFileSync(p, JSON.stringify({ opus: 'o', sonnet: 's', haiku: 'h', gpt: 'g' }), 'utf8');
    writeTierMap(p, { gpt: 'gpt-new' }, '');
    const d = read(p);
    assert.deepStrictEqual([d.opus, d.sonnet, d.haiku, d.gpt], ['o', 's', 'h', 'gpt-new']);
});

check('любой посторонний ключ тоже переживает (не только gpt)', () => {
    const p = f('c.json');
    fs.writeFileSync(p, JSON.stringify({ opus: 'o', note: 'правил руками' }), 'utf8');
    writeTierMap(p, { opus: 'o2' }, null);
    assert.strictEqual(read(p).note, 'правил руками');
});

// ── 3. Устойчивость к состоянию файла ───────────────────────────────────────
check('файла нет — создаётся с нуля, без исключения', () => {
    const p = f('missing.json');
    const mm = writeTierMap(p, { opus: 'o' }, null);
    assert.strictEqual(mm.opus, 'o');
    assert.strictEqual(read(p).opus, 'o');
});

check('битый JSON не роняет запись (трактуется как пустой)', () => {
    const p = f('broken.json');
    fs.writeFileSync(p, '{ это не json', 'utf8');
    const mm = writeTierMap(p, { opus: 'o' }, null);
    assert.strictEqual(mm.opus, 'o');
});

check('массив вместо объекта не даёт записать мусор', () => {
    const p = f('arr.json');
    fs.writeFileSync(p, '["a","b"]', 'utf8');
    const mm = writeTierMap(p, { opus: 'o' }, null);
    assert.strictEqual(mm.opus, 'o');
    assert.ok(!Array.isArray(read(p)), 'на диске остался массив');
    assert.strictEqual(read(p)[0], undefined, 'элементы массива просочились в карту');
});

check('BOM в начале файла не ломает разбор', () => {
    const p = f('bom.json');
    fs.writeFileSync(p, '﻿' + JSON.stringify({ gpt: 'g' }), 'utf8');
    writeTierMap(p, { opus: 'o' }, null);
    assert.strictEqual(read(p).gpt, 'g', 'при BOM потеряли соседний тир');
});

check('null-литерал в файле трактуется как пустая карта', () => {
    const p = f('null.json');
    fs.writeFileSync(p, 'null', 'utf8');
    const mm = writeTierMap(p, { opus: 'o' }, null);
    assert.strictEqual(mm.opus, 'o');
});

// ── 4. Пустые значения и пробелы ────────────────────────────────────────────
check('пустое значение пишется по конвенции провайдера (null / пусто)', () => {
    const p1 = f('e1.json'); const p2 = f('e2.json');
    assert.strictEqual(writeTierMap(p1, { opus: '' }, null).opus, null);
    assert.strictEqual(writeTierMap(p2, { opus: '' }, '').opus, '');
});

check('пробелы обрезаются, undefined не даёт строку "undefined"', () => {
    const p = f('trim.json');
    const mm = writeTierMap(p, { opus: '  claude-opus-5  ', sonnet: undefined }, null);
    assert.strictEqual(mm.opus, 'claude-opus-5');
    assert.strictEqual(mm.sonnet, null, `sonnet стал ${JSON.stringify(mm.sonnet)}`);
});

check('файл заканчивается переводом строки', () => {
    const p = f('nl.json');
    writeTierMap(p, { opus: 'o' }, null);
    assert.ok(fs.readFileSync(p, 'utf8').endsWith('\n'));
});

// ── 2. Статические проверки по источнику ────────────────────────────────────
check('ни одна ручка не пишет тир-карту целиком', () => {
    const n = (src.match(/MODELMAP_FILE, JSON\.stringify/g) || []).length;
    assert.strictEqual(n, 0, `осталось полных перезаписей: ${n}`);
});

check('все десять ручек шлюзов зовут writeTierMap', () => {
    const want = ['AR', 'GO', 'KK', 'AP', 'HN', 'TB', 'XP', 'JW', 'SK', 'TS'];
    const missing = want.filter(k => !src.includes(`writeTierMap(${k}_MODELMAP_FILE`));
    assert.deepStrictEqual(missing, [], `не переведены: ${missing.join(', ')}`);
});

check('ручка Маршрутов пишет через тот же хелпер и валидирует тир', () => {
    assert.ok(/function routeWriteTier/.test(src), 'routeWriteTier не найдена');
    assert.ok(/ROUTE_TIERS\.includes\(tier\)/.test(src), 'тир не валидируется против ROUTE_TIERS');
    assert.ok(/CC_MODEL_PREFIX\[provider\]/.test(src), 'провайдер не резолвится через CC_MODEL_PREFIX');
    assert.ok(/routes\/modelmap/.test(src), 'маршрут POST /__switch/api/routes/modelmap не зарегистрирован');
});

check('truesota проверяет системный промпт по всем тирам, а пустоту — только по трём', () => {
    const fn = src.slice(src.indexOf('async function handleTsModelMap'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    assert.ok(/ROUTE_TIERS\.filter\(t => mm\[t\] && !TS_SYSTEM_HONORED/.test(body),
        'проверка honored не расширена на все тиры');
    assert.ok(/\['opus', 'sonnet', 'haiku'\]\.some\(t => !mm\[t\]\)/.test(body),
        'предупреждение о пустом тире должно остаться на трёх claude-тирах');
});

// ── Каталог моделей для вкладки «Маршруты» ──────────────────────────────────
check('ROUTE_EP покрывает все десять шлюзов и не путается с CC_MODEL_PREFIX', () => {
    const m = src.match(/const ROUTE_EP = \{([\s\S]*?)\};/);
    assert.ok(m, 'ROUTE_EP не найден');
    for (const p of ['agentrouter', 'gorouter', 'kktoken', 'aipm', 'hcnsec', 'tabi', 'xpeach', 'justwoker', 'seekai', 'truesota']) {
        assert.ok(m[1].includes(`${p}:`), `в ROUTE_EP нет ${p}`);
    }
    // 🪤 Именно это расхождение и есть смысл второй карты: файл `gorouter-modelmap.json`,
    // а эндпоинт `/go/models`. Слить их в одну — значит сломать одно из двух.
    assert.ok(/gorouter: 'go'/.test(m[1]), 'gorouter обязан ходить в /go/');
    assert.ok(/gorouter: 'gorouter'/.test(src), 'CC_MODEL_PREFIX.gorouter обязан остаться gorouter');
});

check('каталог берёт ключ из файла и не режет его по префиксу sk-', () => {
    const fn = src.slice(src.indexOf('function handleRoutesModels'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    assert.ok(/-active-key\.txt/.test(body), 'ключ не читается из active-key файла');
    // Ищем ВЫЗОВ, а не слово: в комментарии рядом isRealKey упомянут намеренно.
    assert.ok(!/isRealKey\(/.test(body), 'isRealKey отсечёт валидные ключи без префикса sk-');
    assert.ok(/models: \[\]/.test(body), 'нет мягкой деградации в пустой каталог');
});

// ── Фронтенд вкладки «Маршруты» ─────────────────────────────────────────────
const HTML = path.join(__dirname, '..', 'routing', 'proxy-dashboard.html');
// 🪤 Нормализуем CRLF. proxy-dashboard.html лежит в CRLF, а transparent-proxy.js в LF:
// поиск конца функции по '\n}\n' в сыром HTML возвращал -1, slice(0,-1) отдавал ПОЧТИ
// ВЕСЬ файл — и проверки «функция не зовёт X» проходили на чужом коде. Тест, зеленевший
// по этой причине, хуже отсутствующего.
const html = fs.readFileSync(HTML, 'utf8').replace(/\r\n/g, '\n');

// Тело функции от объявления до закрывающей скобки на нулевом отступе.
function bodyOf(text, decl) {
    const i = text.indexOf(decl);
    assert.ok(i >= 0, `не найдено объявление: ${decl}`);
    const rest = text.slice(i);
    const end = rest.indexOf('\n}\n');
    assert.ok(end > 0, `не найден конец функции: ${decl}`);
    return rest.slice(0, end + 3);
}

check('селекты тиров сохраняются сразу при выборе, без кнопки', () => {
    assert.ok(/onchange="routesSaveTier\(this\)"/.test(html), 'нет автосохранения на onchange');
    const body = bodyOf(html, 'async function routesSaveTier');
    assert.ok(/routes\/modelmap/.test(body), 'сохранение не бьёт в свою ручку');
    assert.ok(/sel\.value = prev/.test(body), 'нет отката выбора при ошибке записи');
    assert.ok(body.length < 3000, `тело routesSaveTier подозрительно велико (${body.length}) — экстрактор снова врёт`);
});

check('Маршруты НЕ зовут хрупкие сохранялки вкладок провайдеров', () => {
    const body = bodyOf(html, 'async function routesSaveTier');
    // 🪤 kkSaveModelMap/loadKkModelMap объявлены дважды, побеждает копия AIPM — вызов
    // по имени увёл бы запись на чужой шлюз. Пишем только через свою ручку.
    for (const bad of ['SaveModelMap', 'loadKkModelMap', 'kkSetBalance']) {
        assert.ok(!body.includes(bad), `routesSaveTier зовёт ${bad} — это чужой и дублированный путь`);
    }
});

check('в опции тира идёт только подтверждённый каталог, а не значение карты', () => {
    // 🪤 До 21.09 сюда подмешивались значения карт (`gatewayTiers` и текущее), и владелец
    // видел в списке модели, которых шлюз не отдаёт: hcnsec - `kimi-k3` и `step-explore`,
    // justwoker - три `gpt-5.6-*` при живом каталоге из одной модели. Значение тир-карты
    // продолжает роутить, но из СПИСКА уходит; что цель не подтверждена, говорит пометка.
    const body = bodyOf(html, 'function routesOptions');
    assert.ok(/routesCatalog\[name\]/.test(body), 'каталог в опциях не участвует');
    assert.ok(!/gatewayTiers/.test(body), 'в опции вернулись значения карты шлюза');
    assert.ok(/— как есть —/.test(body), 'нет пустой опции «как есть»');
    assert.ok(/current/.test(body), 'текущее значение не отмечается выбранным');
});

console.log(failures.length
    ? `\n[FAIL] провалено ${failures.length}: ${failures.join('; ')}`
    : '\n[OK] слияние тир-карт держится, gpt не теряется');
process.exit(failures.length ? 1 : 0);
