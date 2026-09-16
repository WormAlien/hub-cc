#!/usr/bin/env node
'use strict';
// Пул-дроп, дашборд-часть: тир-карта на фолбэк при `402 Budget pool quota has been
// exhausted` и возврат из бэкапа.
//
// Что доказываем и почему именно это:
//  1. БЭКАП СОЗДАЁТСЯ РОВНО ОДИН РАЗ. Повторный вызов (keepalive ретраит, кнопку нажали
//     дважды, дашборд дёрнули ещё раз) не должен затирать исходник уже переключённым
//     файлом: иначе кнопка «вернуть как было» вернёт фолбэк, а карта владельца пропадёт
//     молча — ответ `ok`, маркер на месте, восстановление даёт deepseek.
//  2. ПЕРЕКЛЮЧАЮТСЯ ТОЛЬКО ПУЛОВЫЕ ЦЕЛИ (`^(claude|gpt)[-_]`) и сама мёртвая модель.
//     `glm-5.3`, `deepseek-*` и пустые тиры — это беспуловые модели, их 402 не касается,
//     и трогать их нельзя (решение владельца 15.09).
//  3. ИДЕМПОТЕНТНОСТЬ: маркер уже есть → `{ok:true, already:true}`, файл не меняется.
//     Это то, что спасает от п.1 — обе карты переключаются одним вызовом, а маркер один.
//  4. `poolRestore` ВОЗВРАЩАЕТ ФАЙЛ ПОБАЙТОВО. Карту правит и владелец, и дашборд;
//     пересбор через `JSON.stringify` давал бы дифф на ровном месте и терял форматирование.
//  5. Пустой фолбэк и провайдер без тир-карты — честная ошибка и НОЛЬ записей.
//
// Как гоняем. `poolDropTiers`/`poolRestoreTiers`/`tierMapFile`/`writeTierMap` вырезаются
// из монолита и исполняются в песочнице (`new Function`) — требовать
// `transparent-proxy.js` нельзя, он поднимает сервер на боевом порту :8200. `__dirname`
// и `CC_MODEL_PREFIX` подменяются, поэтому все пути уходят во ВРЕМЕННЫЙ каталог, а не в
// `routing/`. Боевые `ar-modelmap.json`/`ar-routes-modelmap.json` не читаются и не
// пишутся ни на одном шаге.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const SRC = path.join(__dirname, '..', 'routing', 'transparent-proxy.js');
const src = fs.readFileSync(SRC, 'utf8');
const poolDropLib = require('../routing/lib/pooldrop.js');

// ── Вырезать функцию из монолита ─────────────────────────────────────────────
function extract(name) {
    const head = src.indexOf(`function ${name}(`);
    assert.ok(head > 0, `${name} не найдена в transparent-proxy.js`);
    const end = src.indexOf('\n}\n', head);
    assert.ok(end > head, `не найден конец ${name}`);
    return src.slice(head, end + 3);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pooldrop-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { } });

const logLines = [];
// Записи состояния квоты, которые делает пул-дроп: (полоса, запись). Настоящий
// `arQuotaPut` пишет в `~/.claude/ar-quota-state.json` - боевой файл владельца,
// и регрессу туда нельзя. Подставлен свой, а собирается запись НАСТОЯЩИМ
// `buildArQuotaCache` из модуля: проверяем форму, а не заглушку.
const quotaWrites = [];
const probeLib = require('../routing/lib/ar-quota-probe');
// `__dirname` и `CC_MODEL_PREFIX` — параметры, а не свободные имена: так `tierMapFile`
// строит пути от TMP, а не от боевого `routing/`.
const sandbox = new Function('fs', 'path', 'poolDropLib', 'logLine', '__dirname', 'CC_MODEL_PREFIX',
    'arQuotaPoolForModel', 'arQuotaPut', 'buildArQuotaCache', 'AR_ACTIVE_KEY_FILE', `
    ${extract('tierMapFile')}
    ${extract('writeTierMap')}
    ${extract('resolveProviderKey')}
    ${extract('poolDropTiers')}
    ${extract('poolRestoreTiers')}
    return { tierMapFile, writeTierMap, resolveProviderKey, poolDropTiers, poolRestoreTiers };
`)(
    fs, path, poolDropLib, (s) => logLines.push(s), TMP,
    { agentrouter: 'ar', gorouter: 'gorouter' },
    probeLib.arQuotaPoolForModel,
    (pool, entry) => { quotaWrites.push([pool, entry]); return {}; },
    probeLib.buildArQuotaCache,
    path.join(TMP, 'ar-active-key.txt'),
);

const { tierMapFile, resolveProviderKey, poolDropTiers, poolRestoreTiers } = sandbox;
const map = path.join(TMP, 'ar-modelmap.json');
const routes = path.join(TMP, 'ar-routes-modelmap.json');
const bak = path.join(TMP, 'ar-modelmap.pooldrop.bak.json');
const routesBak = path.join(TMP, 'ar-routes-modelmap.pooldrop.bak.json');
const marker = path.join(TMP, 'ar-pooldrop.json');

// Карта владельца «как была»: пуловые цели, беспуловые, пустой тир — всё в одном файле.
const ORIG = {
    opus: 'claude-opus-5',
    sonnet: 'gpt-5.6-sol',
    haiku: 'glm-5.3',
    gpt: 'deepseek-v4-flash',
    default: '',
};
const ORIG_ROUTES = {
    default: 'claude-opus-5',
    opus: 'claude-opus-5',
    haiku: 'glm-5.3',
};
// Сериализуем «как владелец»: 2 пробела + хвостовой \n (как writeTierMap).
const write = (p, obj) => fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const bytes = (p) => fs.readFileSync(p);

const failures = [];
let passed = 0;
const check = (name, fn) => {
    try { fn(); passed += 1; console.log(`  ok   ${name}`); }
    catch (e) { failures.push(name); console.log(`  FAIL ${name}\n       ${e.message}`); }
};

// Сброс сцены: временный каталог в исходное состояние.
function reset() {
    for (const p of [map, routes, bak, routesBak, marker]) { try { fs.rmSync(p, { force: true }); } catch { } }
    write(map, ORIG);
    write(routes, ORIG_ROUTES);
    logLines.length = 0;
}

const DEAD = 'claude-opus-5';
const FB = 'deepseek-v4-flash';
const drop = () => poolDropTiers('agentrouter', DEAD, FB);

console.log('пул-дроп: тир-карта на фолбэк и обратно\n');

// ── 1. Опускание: что переключено, что нет ───────────────────────────────────
check('переключена только СВОЯ семья, чужая полоса и беспуловые не тронуты', () => {
    reset();
    const r = drop();
    assert.strictEqual(r.ok, true, `drop не прошёл: ${r.error}`);
    assert.strictEqual(r.already, undefined, 'первый вызов не должен быть already');
    assert.strictEqual(r.fallback, FB);

    const m = read(map);
    assert.strictEqual(m.opus, FB, 'claude-opus-5 не переключён');
    // 🪤 Полосы Claude и GPT кончаются ПОРОЗНЬ (15.09 пул Opus был пуст, а GPT отдавался),
    // поэтому дроп по claude-* не смеет уводить gpt-цели: трафик уехал бы с рабочего пула.
    assert.strictEqual(m.sonnet, 'gpt-5.6-sol', 'чужая семья (gpt) уведена на фолбэк — этого делать нельзя');
    assert.strictEqual(m.haiku, 'glm-5.3', 'беспуловая модель задета — этого делать нельзя');
    assert.strictEqual(m.gpt, 'deepseek-v4-flash', 'пул не должен трогать уже беспуловый тир');
    assert.strictEqual(m.default, '', 'пустой тир должен остаться пустым, а не получить фолбэк');

    const rt = read(routes);
    assert.strictEqual(rt.default, FB, 'routes.default не переключён');
    assert.strictEqual(rt.opus, FB, 'routes.opus не переключён');
    assert.strictEqual(rt.haiku, 'glm-5.3', 'routes.haiku — беспуловая, трогать нельзя');

    // Обратная сторона: когда кончается GPT, уезжает ТОЛЬКО gpt-семья.
    reset();
    const g = poolDropTiers('agentrouter', 'gpt-6-astra', FB);
    assert.strictEqual(g.ok, true, `дроп по gpt не прошёл: ${g.error}`);
    const m2 = read(map);
    assert.strictEqual(m2.sonnet, FB, 'gpt-цель не переключена при пуле GPT');
    assert.strictEqual(m2.opus, 'claude-opus-5', 'claude-цель уведена при пуле GPT — полосы разные');
    assert.strictEqual(m2.haiku, 'glm-5.3', 'беспуловая задета при пуле GPT');
});

check('бэкапы обеих карт созданы и совпадают с исходником побайтово', () => {
    reset();
    drop();
    assert.ok(fs.existsSync(bak), 'бэкап обычной карты не создан');
    assert.ok(fs.existsSync(routesBak), 'бэкап routes-карты не создан');
    assert.strictEqual(bytes(bak).toString('utf8'), JSON.stringify(ORIG, null, 2) + '\n');
    assert.strictEqual(bytes(routesBak).toString('utf8'), JSON.stringify(ORIG_ROUTES, null, 2) + '\n');
});

check('маркер описывает дроп: provider, deadModel, fallback, обе карты', () => {
    reset();
    drop();
    const mk = read(marker);
    assert.strictEqual(mk.provider, 'agentrouter');
    assert.strictEqual(mk.deadModel, DEAD);
    assert.strictEqual(mk.fallback, FB);
    assert.ok(mk.droppedAt && !Number.isNaN(Date.parse(mk.droppedAt)), 'droppedAt не ISO-дата');
    assert.strictEqual(mk.backupFiles.length, 2, `в маркере ${mk.backupFiles.length} бэкапов вместо двух`);
    assert.ok(mk.backupFiles.some(b => path.basename(b) === path.basename(bak)));
    assert.ok(mk.backupFiles.some(b => path.basename(b) === path.basename(routesBak)));
});

// ── 2. Главное: бэкап не затирается повторным вызовом ────────────────────────
check('повторный вызов идемпотентен и НЕ затирает бэкап', () => {
    reset();
    drop();
    const bakBefore = bytes(bak);
    const routesBakBefore = bytes(routesBak);
    const mapAfterFirst = bytes(map);

    // Второй вызов — с ДРУГИМ фолбэком, чтобы подмена бэкапа была видна, если она случится.
    const r2 = poolDropTiers('agentrouter', DEAD, 'glm-5.3');
    assert.strictEqual(r2.ok, true, `повторный вызов упал: ${r2.error}`);
    assert.strictEqual(r2.already, true, 'повторный вызов не помечен already');
    assert.strictEqual(r2.fallback, FB, 'ответ должен описывать ПЕРВЫЙ дроп, а не новый фолбэк');

    assert.strictEqual(Buffer.compare(bakBefore, bytes(bak)), 0, 'бэкап обычной карты затёрт повторным вызовом');
    assert.strictEqual(Buffer.compare(routesBakBefore, bytes(routesBak)), 0, 'бэкап routes-карты затёрт');
    assert.strictEqual(Buffer.compare(mapAfterFirst, bytes(map)), 0, 'карта переписана повторным вызовом');
});

check('карта, исправленная владельцем после дропа, не попадает в бэкап', () => {
    reset();
    drop();
    // Владелец руками вернул себе opus и правит карту дальше.
    const edited = { ...read(map), opus: 'claude-opus-5' };
    write(map, edited);
    poolDropTiers('agentrouter', DEAD, FB);      // повторный 402
    const m = read(map);
    assert.strictEqual(m.opus, 'claude-opus-5', 'повторный дроп обязан быть no-op, пока стоит маркер');
    assert.strictEqual(bytes(bak).toString('utf8'), JSON.stringify(ORIG, null, 2) + '\n',
        'бэкап перезаписан правкой владельца — «вернуть как было» вернуло бы не то');
});

// ── 3. Возврат ───────────────────────────────────────────────────────────────
check('poolRestore возвращает обе карты побайтово и снимает маркер', () => {
    reset();
    drop();
    const r = poolRestoreTiers('agentrouter');
    assert.strictEqual(r.ok, true, `restore упал: ${r.error}`);
    assert.strictEqual(r.restored, true);
    assert.ok(r.droppedAt, 'в ответе нет времени дропа');
    assert.strictEqual(bytes(map).toString('utf8'), JSON.stringify(ORIG, null, 2) + '\n',
        'обычная карта не совпала с исходником побайтово');
    assert.strictEqual(bytes(routes).toString('utf8'), JSON.stringify(ORIG_ROUTES, null, 2) + '\n',
        'routes-карта не совпала с исходником побайтово');
    assert.strictEqual(poolDropLib.readMarker(marker), null, 'маркер не снят');
});

check('восстановление сохраняет форматирование, а не пересобирает JSON', () => {
    reset();
    // Карта с «нештатным» форматированием: отступ 4, без хвостового \n, другой порядок ключей.
    const odd = '{\n    "sonnet": "gpt-5.6-sol",\n    "opus": "claude-opus-5"\n}';
    fs.writeFileSync(map, odd, 'utf8');
    const r = poolDropTiers('agentrouter', DEAD, FB);
    assert.strictEqual(r.ok, true, `drop упал: ${r.error}`);
    assert.notStrictEqual(bytes(map).toString('utf8'), odd, 'карта не изменилась — сцена бессмысленна');
    poolRestoreTiers('agentrouter');
    assert.strictEqual(bytes(map).toString('utf8'), odd,
        'восстановление пересобрало JSON вместо побайтового возврата');
});

check('без маркера возврат отказывает и НИЧЕГО не трогает', () => {
    reset();
    // Бэкап лежит от прошлого дропа, а маркера нет (его снял успешный возврат).
    fs.writeFileSync(bak, JSON.stringify({ opus: 'claude-opus-5' }, null, 2) + '\n', 'utf8');
    const before = bytes(map);
    const r = poolRestoreTiers('agentrouter');
    assert.strictEqual(r.ok, false, 'возврат без маркера не должен проходить');
    assert.ok(/маркера нет/.test(r.error), `невнятная ошибка: ${r.error}`);
    assert.strictEqual(Buffer.compare(before, bytes(map)), 0, 'карта изменена возвратом без маркера');
});

check('битый бэкап — ошибка, карта не тронута', () => {
    // 🪤 Маркер обязан быть ЖИВЫМ, иначе проверка зелена не по делу: без маркера
    // `poolRestoreTiers` отказывает по «маркера нет» и до чтения бэкапа не доходит.
    // Именно так эта проверка и была зелёной, пока порча бэкапа проверялась мутацией
    // (снятая валидация в `poolRestore` не роняла ни одной проверки). Тест, зелёный
    // по чужой причине, хуже отсутствующего.
    reset();
    drop();
    fs.writeFileSync(bak, '{ это не JSON', 'utf8');
    const before = bytes(map);
    const r = poolRestoreTiers('agentrouter');
    assert.strictEqual(r.ok, false, 'битый бэкап должен давать ошибку');
    assert.ok(/битый|не объект|JSON|Unexpected/i.test(String(r.error || '')),
        `ответ не про бэкап, а про что-то другое: ${r.error}`);
    assert.strictEqual(Buffer.compare(before, bytes(map)), 0, 'карта перезаписана битым бэкапом');
});

check('потерян один бэкап из двух — ошибка, маркер переживает, карта не брошена', () => {
    // 🪤 Полу-возврат опаснее отказа. Если вернуть одну карту из двух и СНЯТЬ маркер,
    // вторая осталась бы на фолбэке навсегда: бэкапа нет, маркера нет, и никакая
    // ручка её уже не вернула бы. Поэтому частичный возврат обязан зваться ошибкой,
    // а маркер — оставаться на месте, чтобы возврат можно было повторить.
    reset();
    drop();
    const lostBak = bytes(routesBak);
    fs.unlinkSync(routesBak);
    const r = poolRestoreTiers('agentrouter');
    assert.strictEqual(r.ok, false, 'полу-возврат не должен выглядеть успехом');
    assert.ok(/бэкап не найден/.test(String(r.error || '')), `ответ не про потерянный бэкап: ${r.error}`);
    assert.ok(poolDropLib.readMarker(marker), 'маркер снят при частичном возврате — карта брошена навсегда');
    assert.deepStrictEqual(read(routes), { default: FB, opus: FB, haiku: 'glm-5.3' },
        'routes-карта уехала не туда: ожидалась опущенной (её бэкап потерян)');
    // Бэкап положили на место руками — возврат обязан доиграться, а не залипнуть.
    fs.writeFileSync(routesBak, lostBak);
    const r2 = poolRestoreTiers('agentrouter');
    assert.strictEqual(r2.ok, true, `повторный возврат после починки бэкапа упал: ${r2.error}`);
    assert.strictEqual(bytes(routes).toString('utf8'), JSON.stringify(ORIG_ROUTES, null, 2) + '\n',
        'routes-карта не вернулась к исходнику');
    assert.strictEqual(poolDropLib.readMarker(marker), null, 'маркер не снят после успешного возврата');
});

check('префикс провайдера принимается наравне с именем — иначе карта не пишется НИКОГДА', () => {
    // 🪤 Стык, которого не видит ни один модульный тест по отдельности: keepalive знает
    // только ПРЕФИКС (выводит его из имени хоста: agentrouter.org → 'ar') и ровно его шлёт
    // в `pool-drop`, а таблица путей ключуется ИМЕНЕМ провайдера. До 15.09 `poolDropTiers('ar')`
    // отказывал («провайдер 'ar' не редактируется»), то есть тир-карта на диск не писалась
    // никогда, и сессия выживала только памятью процесса. Нашёл сквозной стенд
    // (`tools/pooldrop-stand.js`); здесь закреплено, чтобы не вернулось.
    reset();
    assert.strictEqual(resolveProviderKey('ar'), 'agentrouter', 'префикс не разрешился в имя');
    assert.strictEqual(resolveProviderKey('agentrouter'), 'agentrouter', 'имя не пережило разрешение');
    assert.strictEqual(resolveProviderKey('нет-такого'), 'нет-такого',
        'незнакомое имя должно дойти до обычного отказа, а не превратиться в что-то');
    const r = poolDropTiers('ar', DEAD, FB);
    assert.strictEqual(r.ok, true, `дроп по префиксу упал: ${r.error}`);
    assert.strictEqual(read(map).opus, FB, 'карта не переключилась по префиксу');
    assert.strictEqual(poolRestoreTiers('ar').ok, true, 'возврат по префиксу не прошёл');
});

check('фолбэк помечает полосу квоты исчерпанной — иначе часы о нём не узнают', () => {
    // Заявка владельца 15.09: часы должны показывать, что квота кончилась, КОГДА
    // СРАБОТАЛ ФОЛБЭК, а не только по ручной проверке. Состояние пишется той же
    // записью, что у пробы, и отличается только источником.
    reset();
    quotaWrites.length = 0;
    drop();
    const w = quotaWrites.find(([p]) => p === 'opus');
    assert.ok(w, 'состояние полосы не записано — часы о фолбэке не узнают');
    assert.strictEqual(w[1].state, 'exhausted', 'полоса помечена не как исчерпанная');
    assert.strictEqual(w[1].source, 'drop', 'источник не отличён от ручной проверки');
    assert.ok(w[1].dropAt, 'нет привязки к партии — запись не погаснет по наливу');
});

check('беспуловая модель полосы не имеет — состояние ей не пишется', () => {
    // У deepseek/glm пула нет, и «квота исчерпана» на них была бы враньём.
    reset();
    quotaWrites.length = 0;
    poolDropTiers('agentrouter', 'deepseek-v4-flash', FB);
    assert.strictEqual(quotaWrites.length, 0, 'беспуловая модель пометила полосу квоты');
});

check('повторный 402 при ЖИВОМ маркере всё равно обновляет состояние', () => {
    // 🪤 Это и была разорванная связка владельца 16.09: «пока я вручную не кликну, хуй что
    // мне скажет, что у нас уже дипсик». Запись состояния стояла ПОСЛЕ раннего выхода
    // «маркер уже есть» — то есть пока висел маркер от прошлого дропа, каждый новый
    // пойманный 402 упирался в `already: true` и состояние НЕ писал. Файл заполнял только
    // ручной клик, а бар читает именно файл.
    reset();
    drop();
    assert.ok(poolDropLib.readMarker(marker), 'сцена бессмысленна: маркера нет');
    quotaWrites.length = 0;
    const again = drop();                       // второй 402 по тому же пулу
    assert.strictEqual(again.already, true, 'повторный вызов должен остаться идемпотентным по карте');
    const w = quotaWrites.find(([p]) => p === 'opus');
    assert.ok(w, 'состояние не обновлено при живом маркере — бар снова ничего не узнает');
    assert.strictEqual(w[1].source, 'drop', 'источник не отличён от ручной проверки');
});

// ── 4. Отказы: ноль записей ──────────────────────────────────────────────────
check('пустой фолбэк — ошибка и ноль записей', () => {
    reset();
    const before = bytes(map);
    const r = poolDropTiers('agentrouter', DEAD, '');
    assert.strictEqual(r.ok, false, 'пустой фолбэк должен быть отказом');
    assert.strictEqual(Buffer.compare(before, bytes(map)), 0, 'карта изменена при выключенной фиче');
    assert.ok(!fs.existsSync(bak), 'бэкап создан при выключенной фиче');
    assert.ok(!fs.existsSync(marker), 'маркер создан при выключенной фиче');
});

check('не названа мёртвая модель — отказ и ноль записей', () => {
    reset();
    const before = bytes(map);
    const r = poolDropTiers('agentrouter', '', FB);
    assert.strictEqual(r.ok, false, 'без deadModel дроп невозможен');
    assert.strictEqual(Buffer.compare(before, bytes(map)), 0, 'карта изменена');
    assert.ok(!fs.existsSync(marker), 'маркер создан');
});

check('провайдер без тир-карты → {ok:false, error}', () => {
    reset();
    const r = poolDropTiers('xpeach', DEAD, FB);
    assert.strictEqual(r.ok, false, 'у провайдера без карты дроп должен отказывать');
    assert.ok(/не редактируется|тир-карты/.test(r.error), `невнятная ошибка: ${r.error}`);
    const r2 = poolRestoreTiers('xpeach');
    assert.strictEqual(r2.ok, false, 'возврат у нередактируемого провайдера должен отказывать');
});

check('отсутствующая routes-карта — не ошибка, обычная всё равно опускается', () => {
    reset();
    fs.rmSync(routes, { force: true });
    const r = poolDropTiers('agentrouter', DEAD, FB);
    assert.strictEqual(r.ok, true, `дроп упал без routes-карты: ${r.error}`);
    assert.strictEqual(read(map).opus, FB, 'обычная карта не опущена');
    const mk = read(marker);
    assert.strictEqual(mk.backupFiles.length, 1, 'в маркере должен быть один бэкап');
    const rr = poolRestoreTiers('agentrouter');
    assert.strictEqual(rr.ok, true, `возврат упал без routes-карты: ${rr.error}`);
    assert.strictEqual(bytes(map).toString('utf8'), JSON.stringify(ORIG, null, 2) + '\n');
});

// ── 4b. Непонятный вход: внятный ответ вместо исключения ─────────────────────
//
// Ручка дашборда на исключении из модуля отдаст 500, а владелец прочитает это как
// «пул переключён» там, где не переключено ничего. Поэтому вход, который модуль не
// понял, обязан кончаться внятным ответом, а не падением.
//
// 🪤 Отказ тут НЕ обязан быть `ok:false`. Карта, в которой вместо объекта массив,
// для `readTiers`/`writeTierMap` - это «все тиры пустые», и так задумано (см.
// `tools/check-modelmap-merge.js`, «массив вместо объекта не даёт записать мусор»).
// Требуем другое и большее: не бросить, ответить объектом с булевым `ok` и НЕ выдумать
// тиры из нечитаемого файла.
check('массив вместо объекта в файле карты - внятный ответ, а не исключение', () => {
    reset();
    fs.writeFileSync(map, '["a","b"]', 'utf8');
    let r = null; let threw = null;
    try { r = poolDropTiers('agentrouter', DEAD, FB); } catch (e) { threw = e; }
    assert.strictEqual(threw, null,
        `модуль бросил исключение: ${threw && threw.message} - ручка дашборда отдаст 500`);
    assert.ok(r && typeof r === 'object' && typeof r.ok === 'boolean',
        `вместо внятного ответа пришло ${JSON.stringify(r)}`);
    if (r.ok === false) {
        assert.ok(String(r.error || '').trim(), 'ok:false без текста ошибки');
        return;
    }
    assert.deepStrictEqual(r.tiers, {}, 'тиры выдуманы из нечитаемого файла');
    assert.strictEqual(r.routesTiers.default, FB, 'здоровая routes-карта обязана была опуститься');
});

check('нестроковое значение тира - внятный ответ, а не исключение', () => {
    reset();
    write(map, { opus: 'claude-opus-5', sonnet: { nested: 1 }, haiku: 'glm-5.3', default: '' });
    let r = null; let threw = null;
    try { r = poolDropTiers('agentrouter', DEAD, FB); } catch (e) { threw = e; }
    assert.strictEqual(threw, null, `модуль бросил исключение: ${threw && threw.message}`);
    assert.ok(r && typeof r === 'object' && typeof r.ok === 'boolean',
        `вместо внятного ответа пришло ${JSON.stringify(r)}`);
    if (r.ok === false) {
        assert.ok(String(r.error || '').trim(), 'ok:false без текста ошибки');
        return;
    }
    assert.strictEqual(read(map).opus, FB, 'пуловая цель не опущена');
    assert.notStrictEqual(read(map).sonnet, FB, 'объект в тире приняли за пуловую модель');
});

check('посторонние ключи карт переживают и дроп, и возврат', () => {
    reset();
    // Соседние ключи не управляются ни одной вкладкой: их владелец мог дописать руками.
    // `poolDropTiers` обязан переписывать ТОЛЬКО пуловые тиры, а не собирать карту заново.
    write(map, { ...ORIG, note: 'правил руками' });
    write(routes, { ...ORIG_ROUTES, scheme: 'v2' });
    const r = poolDropTiers('agentrouter', DEAD, FB);
    assert.strictEqual(r.ok, true, `drop упал: ${r.error}`);
    assert.strictEqual(read(map).note, 'правил руками', 'посторонний ключ стёрт дропом');
    assert.strictEqual(read(routes).scheme, 'v2', 'посторонний ключ routes-карты стёрт дропом');

    const rr = poolRestoreTiers('agentrouter');
    assert.strictEqual(rr.ok, true, `возврат упал: ${rr.error}`);
    assert.strictEqual(read(map).note, 'правил руками', 'посторонний ключ стёрт возвратом');
    assert.strictEqual(read(routes).scheme, 'v2', 'посторонний ключ routes стёрт возвратом');
    assert.strictEqual(bytes(map).toString('utf8'),
        JSON.stringify({ ...ORIG, note: 'правил руками' }, null, 2) + '\n',
        'карта не совпала с исходником побайтово');
});

// Возврат без бэкапа ВООБЩЕ (оба потеряны: чистка `routing/`, падение до записи).
// Маркер при этом остаётся: иначе неудачный возврат убил бы и саму возможность вернуться.
check('бэкапов нет вовсе - честная ошибка, карты не тронуты, маркер на месте', () => {
    reset();
    drop();
    fs.rmSync(bak, { force: true });
    fs.rmSync(routesBak, { force: true });
    const beforeMap = bytes(map);
    const beforeRoutes = bytes(routes);
    const r = poolRestoreTiers('agentrouter');
    assert.strictEqual(r.ok, false, 'возврат без бэкапов не должен проходить');
    assert.ok(/бэкап/.test(String(r.error || '')), `невнятная ошибка: ${r.error}`);
    assert.strictEqual(Buffer.compare(beforeMap, bytes(map)), 0, 'карта изменена неудачным возвратом');
    assert.strictEqual(Buffer.compare(beforeRoutes, bytes(routes)), 0, 'routes-карта изменена неудачным возвратом');
    assert.ok(fs.existsSync(marker), 'маркер снят при неудачном возврате - вернуться будет нечем');
});

// ── 5. Статика: ручки и настройки на месте ───────────────────────────────────
check('обе ручки объявлены и зовут общие функции', () => {
    for (const route of ['/__switch/api/routes/pool-drop', '/__switch/api/routes/pool-restore']) {
        assert.ok(src.includes(`req.url === '${route}'`), `ручка ${route} не найдена`);
    }
    assert.ok(/poolDropTiers\(\s*String\(j\.provider/.test(src), 'pool-drop зовёт не poolDropTiers');
    assert.ok(/poolRestoreTiers\(\s*String\(j\.provider/.test(src), 'pool-restore зовёт не poolRestoreTiers');
});

check('возврат висит на проверке квоты, а не на фоновом опросе', () => {
    const head = src.indexOf('async function handleArQuotaCheck');
    assert.ok(head > 0, 'handleArQuotaCheck не найдена');
    const end = src.indexOf('\nasync function handleArQuotaCheck', head + 10);
    const body = src.slice(head, end > 0 ? end : src.length);
    assert.ok(/poolRestoreTiers\('ar'\)/.test(body), 'quota-check не возвращает карту');
    assert.ok(/state === 'available'/.test(body), 'возврат не привязан к состоянию пула');
    assert.ok(/restored: true/.test(body), 'в JSON-ответе нет restored');
});

check('KNOBS знает poolFallbackModel и poolDeadMs', () => {
    const head = src.indexOf('const KNOBS = [');
    assert.ok(head > 0, 'KNOBS не найден');
    const line = src.slice(head, src.indexOf('];', head));
    for (const k of ['poolFallbackModel', 'poolDeadMs']) {
        assert.ok(line.includes(`'${k}'`), `${k} не в белом списке — панель получит 400`);
    }
});

check('tierMapFile и writeTierMap НЕ скопированы в lib', () => {
    const lib = fs.readFileSync(path.join(__dirname, '..', 'routing', 'lib', 'pooldrop.js'), 'utf8');
    assert.ok(!/function\s+writeTierMap/.test(lib), 'в lib завелась вторая копия writeTierMap');
    assert.ok(!/function\s+tierMapFile/.test(lib), 'в lib завелась вторая копия tierMapFile');
    assert.ok(/DEPS\.writeTierMap/.test(lib), 'lib не принимает writeTierMap инъекцией');
});

console.log(failures.length
    ? `\n[FAIL] провалено ${failures.length} из ${passed + failures.length} проверок: ${failures.join('; ')}`
    : `\n[OK] ${passed} проверок OK: пул-дроп держится - бэкап один, беспуловые не тронуты, возврат побайтовый`);
process.exit(failures.length ? 1 : 0);
