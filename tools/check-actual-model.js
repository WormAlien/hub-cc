#!/usr/bin/env node
// Регресс: во вкладке «Здоровье» стоит модель, которая РЕАЛЬНО исполнила запрос.
//
// Дефект (11.09.2026): у justwoker в таблице висела строка `claude-opus-5`, хотя Opus
// на этом шлюзе нет вовсе — тир-карта отправляет `opus` на `gpt-5.6-sol`. Причина не в
// карте: keepalive честно шлёт наверх цель карты, но в ОТВЕТЕ подменяет поле `model`
// обратно на клиентское имя (`rewriteModelJson`, MODEL_ECHO), а счётчик токенов на
// front-door читает именно тело. Реальное имя не доживало до журнала.
//
// Лечение: keepalive отдаёт цель заголовком `x-actual-model`, tap пишет её отдельным
// полем `am`, «Здоровье» группирует по `am`, когда оно есть.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const KEEP = path.join(ROOT, 'routing', 'keepalive-proxy.js');
const AGG = path.join(ROOT, 'routing', 'health-agg.js');

const fails = [];
const ok = [];
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { fails.push(`не прочитан ${p}: ${e.message}`); return ''; } };

// ---- 1. keepalive объявляет реальную модель заголовком --------------------
const keep = read(KEEP);
if (keep) {
    if (!/setHeader\('x-actual-model'/.test(keep))
        fails.push('keepalive-proxy.js: заголовок x-actual-model не выставляется — реальная модель не доедет до журнала');
    else ok.push('keepalive отдаёт x-actual-model');

    // Заголовок обязан сниматься с ТЕЛА, которое реально ушло наверх (reqBody), а не с
    // исходного: иначе он повторит клиентское имя и дефект вернётся незамеченным.
    const m = keep.match(/const sent = String\(JSON\.parse\((\w+)\.toString/);
    if (!m) fails.push('keepalive-proxy.js: не найдено снятие реальной модели с отправленного тела');
    else if (m[1] !== 'reqBody') fails.push(`keepalive-proxy.js: реальная модель снимается с ${m[1]}, а должна с reqBody (тело после ремапа)`);
    else ok.push('реальная модель снимается с отправленного тела (reqBody)');

    // MODEL_ECHO обязан остаться: клиент должен видеть имя, которое просил.
    if (!/function rewriteModelJson/.test(keep))
        fails.push('keepalive-proxy.js: rewriteModelJson исчез — клиент увидит чужое имя модели');
    else ok.push('подмена имени для клиента (MODEL_ECHO) сохранена');
}

// ---- 2. tap: боевой createTap на синтетическом ответе ----------------------
const { createTap } = require(path.join(ROOT, 'routing', 'usage-tap.js'));

function runTap(headers, bodyObj) {
    let rec = null;
    const tap = createTap({
        method: 'POST', url: '/v1/messages', backend: 'justwoker',
        ua: 'claude-cli/1.0', status: 200, headers,
    }, (r) => { rec = r; });
    if (!tap) return null;
    tap.chunk(Buffer.from(JSON.stringify(bodyObj), 'utf8'));
    tap.end();
    return rec;
}

const USAGE = { input_tokens: 1000, output_tokens: 50 };

// Шлюз с тир-картой: тело врёт (клиентское имя), заголовок говорит правду.
const r1 = runTap(
    { 'content-type': 'application/json', 'x-actual-model': 'gpt-5.6-sol' },
    { model: 'claude-opus-5', usage: USAGE });
if (!r1) fails.push('tap не создался на обычном JSON-ответе');
else {
    if (r1.m !== 'claude-opus-5') fails.push(`tap: клиентское имя потеряно (m=${JSON.stringify(r1.m)})`);
    else ok.push('tap сохраняет клиентское имя в m');
    if (r1.am !== 'gpt-5.6-sol') fails.push(`tap: реальная модель не записана (am=${JSON.stringify(r1.am)})`);
    else ok.push('tap пишет реальную модель в am');
}

// Прямой шлюз без подмены: дубля быть не должно.
const r2 = runTap(
    { 'content-type': 'application/json', 'x-actual-model': 'claude-opus-5' },
    { model: 'claude-opus-5', usage: USAGE });
if (r2 && 'am' in r2) fails.push('tap: am продублировал m там, где подмены не было — журнал распухнет впустую');
else ok.push('без расхождения am не пишется');

// Старый шлюз без заголовка: поведение прежнее, ничего не падает.
const r3 = runTap({ 'content-type': 'application/json' }, { model: 'claude-opus-5', usage: USAGE });
if (!r3 || r3.m !== 'claude-opus-5' || 'am' in r3) fails.push('tap: ответ без заголовка сломан');
else ok.push('ответ без заголовка обрабатывается по-старому');

// ---- 3. «Здоровье» группирует по реальной модели ---------------------------
const agg = read(AGG);
if (agg) {
    if (!/norm\(e\.am \|\| e\.m\)/.test(agg))
        fails.push('health-agg.js: группировка не предпочитает am — ложная модель вернётся в таблицу');
    else ok.push('«Здоровье» группирует по am, когда оно есть');
}

for (const s of ok) console.log(`  OK   ${s}`);
for (const s of fails) console.log(`  FAIL ${s}`);
console.log(fails.length ? `\n${fails.length} провал(ов) из ${ok.length + fails.length}` : `\nвсё чисто: ${ok.length}/${ok.length}`);
process.exit(fails.length ? 1 : 0);
