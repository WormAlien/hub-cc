#!/usr/bin/env node
/** Regression for the manual AgentRouter Opus quota probe. */
'use strict';

const fs = require('fs');
const path = require('path');

const DASH = path.join(__dirname, '..', 'routing', 'transparent-proxy.js');
const HTML = path.join(__dirname, '..', 'routing', 'proxy-dashboard.html');
const src = fs.readFileSync(DASH, 'utf8');
const html = fs.readFileSync(HTML, 'utf8');
const { classifyArQuotaProbe, AR_QUOTA_BODY, AR_QUOTA_CYCLE_MS, AR_QUOTA_ANCHOR_MS,
        AR_QUOTA_POOLS, arQuotaPoolForModel, arQuotaBodyFor, arQuotaReadPools,
        arQuotaDropAt, arQuotaKeyTail, buildArQuotaCache, isArQuotaCacheFresh,
        pickFresherArQuota } = require('../routing/lib/ar-quota-probe');

const fails = [];
const ok = [];
function check(cond, msg) { (cond ? ok : fails).push(msg); }

check(src.includes("'/__switch/api/ar/quota-check'"), 'POST quota-check route exists');
check(src.includes("require('./lib/ar-quota-probe')"), 'dashboard uses quota probe module');
check(AR_QUOTA_BODY.model === 'claude-opus-5', 'probe pins claude-opus-5');
// Инвариант тут — «проба дёшева», а не «ровно один токен»: `1` не проходит у Astra
// (400 «Could not finish the message…»), и кнопка «Проверить GPT» падала с ошибкой.
// 16 — минимум, который Astra принимает. Держим проверку на верхнюю границу, чтобы
// потолок не вырос случайно (по смыслу он тут не нужен вовсе), но не привязываемся
// к числу: менять его придётся каждый раз, когда шлюз назовёт новый минимум.
check(AR_QUOTA_BODY.max_tokens >= 1 && AR_QUOTA_BODY.max_tokens <= 32, 'probe stays cheap (cheapest floor the model accepts)');
check(AR_QUOTA_BODY.messages?.[0]?.content === '1', 'probe uses minimal input');
check(classifyArQuotaProbe(200, '{}').state === 'available', '2xx means quota available');
check(classifyArQuotaProbe(402, '{"error":{"message":"402 Budget pool quota has been exhausted."}}').state === 'exhausted', 'canonical 402 means quota exhausted');
check(classifyArQuotaProbe(402, '{"error":"account disabled"}').state === 'error', 'unrelated 402 stays an error');
check(classifyArQuotaProbe(500, 'oops').state === 'error', 'other failures stay errors');
check(src.includes('AR_ACTIVE_KEY_FILE'), 'probe reads active key server-side');
const uiHandler = html.slice(html.indexOf('window.arqCheckQuota'), html.indexOf('\nfunction init()', html.indexOf('window.arqCheckQuota')));
check(!/ar-active-key|api_key|x-api-key/i.test(uiHandler), 'browser handler never reads or sends the key');

check(html.includes('id="arq-check"'), 'manual check button is under quota clock');
check(html.includes('id="arq-check-result"'), 'inline result exists');
check(html.includes('async function arqCheckQuota('), 'manual click handler exists');
check(html.includes("fetch('/__switch/api/ar/quota-check'"), 'UI calls server route');
// Циферблат теперь красит ОБЩИЙ маляр полосы, а не обработчик кнопки: состояние
// приходит и от пробы, и от фолбэка, и второе кнопку не нажимает.
check(/arqState\(fresh \? \(e\.state === 'available' \? 'fresh' : 'burned'\)/.test(html),
  'exhausted result marks clocks burned');
check(/arqState\(fresh \? \(e\.state === 'available' \? 'fresh' : 'burned'\)/.test(html),
  'available result marks clocks fresh');
check(/if \(pool === VIEW\) arqState\(/.test(html),
  'красится только показываемая полоса: две полосы в один цвет не свести');

// ── Две полосы в интерфейсе ─────────────────────────────────────────────────
check(html.includes('id="arq-check-gpt"'), 'вторая кнопка - проверка полосы GPT');
check(html.includes('id="arq-check-result-gpt"'), 'у второй полосы своя строка результата');
check(html.includes("arqCheckQuota('gpt')") && html.includes("arqCheckQuota('opus')"),
  'кнопки зовут проверку со СВОЕЙ полосой');
check(/setInterval\(stSync, 30000\)/.test(html),
  'состояние опрашивается по таймеру: фолбэк случается посреди дня, часы обязаны покраснеть сами');
check(html.includes('const KEY_POOL') && html.includes("localStorage.setItem(KEY_POOL"),
  'выбранная полоса помнится между перезагрузками');
check(/pooldrop/.test(html), 'вкладка «Маршруты» знает про пул-дроп');
check(html.includes('возврат из бэкапа не перетрёт'), 'вкладка предупреждает про возврат карты');

// ── Фолбэк выбирается из каталога шлюза, а не вписывается строкой ────────────
// Руками сюда можно было вписать модель, которой у шлюза нет, и получить ровно тот
// сырой 402, ради которого фича делалась. Список — та же ручка `routes/models`,
// что наполняет тиры на вкладке «Маршруты».
check(/<select id="ar-keepalive-pooldrop"/.test(html),
  'фолбэк — селектор из каталога шлюза, а не текстовое поле');
check(!/<input id="ar-keepalive-pooldrop"/.test(html), 'текстовое поле фолбэка не вернулось');
check(/pooldropCatalog\[name\] = d\.models/.test(html), 'список берётся из каталога шлюза');
check(/pooldropFill\(pfx, data\.cfg\.poolFallbackModel/.test(html),
  'селектор выставляет текущее значение с сервера, а не первый пункт списка');
check(/\['', \.\.\.cat, String\(current \|\| ''\)\]/.test(html),
  'текущее значение остаётся в списке даже при пустом каталоге - иначе «Применить» молча выключит фичу');

// ── Quota dial schedule: three batches a day since 2026-09-10 (MSK 03/11/19, 8h step).
// Статика по HTML: сетку в браузере из регресса не прогонишь, но следы старой
// двухпартийной сетки ловятся точным вхождением строк.
check(html.includes('const CYCLE = 8 * 3600 * 1000'), 'dial cycle is 8 hours');
check(html.includes('Date.UTC(1970, 0, 1, 16, 0, 0)'), 'dial anchor is 16:00 UTC = 19:00 MSK');
check(!html.includes('const CYCLE = 12 * 3600 * 1000'), 'old 12h cycle is gone');
check(!html.includes('02:00 и 14:00'), 'old two-batch wording is gone');
check(!html.includes("[2,'02']") && !html.includes("[14,'14']"), 'old day marks 02/14 are gone');
check(html.includes("[3,'03']") && html.includes("[11,'11']") && html.includes("[19,'19']"), 'day dial marks 03/11/19');
check(html.includes('const n = m ? 8 : 32'), 'term dial draws 32 segments (8h × 15m), mini 8');
check(html.includes('(toA - 120 + 360) % 360'), 'day arc is the 120° sector ending on the batch');
check(!html.includes('(toA + 120) % 360'), 'old +120 arc (240°, wrong direction) is gone');
check(html.includes("'вечерняя'"), 'day caption names all three batches');
check(html.includes("x.id === 'day'"), 'default dial falls back to day');
check(html.includes("ar-quota-dial2"), 'dial choice key bumped to gen2 — day default reaches everyone');
check(html.includes('localStorage.removeItem(KEY_OLD)'), 'old dial choice key is cleaned up');
check(html.includes('тремя партиями'), 'mini tooltip says three batches');
check(html.includes('Три партии в сутки'), 'big caption says three batches');

// ── Кеш результата проверки (2026-09-12) ──────────────────────────────────
// Инвалидация по ПАРТИИ, а не по TTL. Точки взяты в UTC, чтобы регресс не зависел
// от таймзоны машины: 08:00 UTC = дневная партия 11:00 МСК.
const DROP = Date.UTC(2026, 8, 12, 8, 0, 0);          // партия 11:00 МСК
const NEXT_DROP = DROP + AR_QUOTA_CYCLE_MS;           // партия 19:00 МСК
check(AR_QUOTA_CYCLE_MS === 8 * 3600 * 1000, 'cache grid cycle is 8 hours');
check(AR_QUOTA_ANCHOR_MS === Date.UTC(1970, 0, 1, 16, 0, 0), 'cache grid anchor is 16:00 UTC');
// Обе копии сетки обязаны совпадать: у циферблата своя в HTML (самодостаточный IIFE).
check(html.includes('const dropAt = t => t - (((t - ANCHOR) % CYCLE + CYCLE) % CYCLE)'),
      'browser cache reuses the dial CYCLE/ANCHOR instead of duplicating numbers');
check(arQuotaDropAt(DROP + 3600_000) === DROP, 'dropAt snaps to the batch that already happened');
check(arQuotaDropAt(DROP - 1) === DROP - AR_QUOTA_CYCLE_MS, 'dropAt before a batch points at the previous one');
check(arQuotaDropAt('nope') === null, 'dropAt rejects garbage');

const AVAIL = buildArQuotaCache({ state: 'available' }, 'sk-abcdef1234', DROP + 60_000);
check(AVAIL.state === 'available' && AVAIL.keyTail === '1234', 'cache entry keeps state and key tail');
check(!JSON.stringify(AVAIL).includes('sk-abcdef'), 'cache never stores the full key');
check(Date.parse(AVAIL.dropAt) === DROP, 'cache entry records its batch');
check(buildArQuotaCache({ state: 'error', error: 'boom' }, 'sk-1', DROP) === null, 'errors are not cached');
check(buildArQuotaCache({ state: 'exhausted' }, 'sk-1', DROP).state === 'exhausted', 'exhausted is cached');
check(arQuotaKeyTail('sk-xyz9876') === '9876' && arQuotaKeyTail('ab') === 'ab', 'key tail is last four chars');

check(isArQuotaCacheFresh(AVAIL, DROP + 3600_000, '1234'), 'entry stays fresh inside the same batch');
check(isArQuotaCacheFresh(AVAIL, NEXT_DROP - 1000, '1234'), 'entry survives until the very next drop');
check(!isArQuotaCacheFresh(AVAIL, NEXT_DROP, '1234'), 'entry dies exactly at the next drop');
check(!isArQuotaCacheFresh(AVAIL, DROP + 60_000, '9999'), 'entry dies when the active key changed');
check(isArQuotaCacheFresh(AVAIL, DROP + 60_000, ''), 'unknown active key does not invalidate the entry');
check(!isArQuotaCacheFresh({ ...AVAIL, checkedAt: 'x' }, DROP + 60_000, '1234'), 'unparseable checkedAt is not fresh');
check(!isArQuotaCacheFresh({ ...AVAIL, state: 'error' }, DROP + 60_000, '1234'), 'error state is never fresh');
check(!isArQuotaCacheFresh(null, DROP, '1234'), 'missing entry is not fresh');

const OLDER = { ...AVAIL, checkedAt: new Date(DROP + 10_000).toISOString() };
const NEWER = { ...AVAIL, state: 'exhausted', checkedAt: new Date(DROP + 90_000).toISOString() };
check(pickFresherArQuota(OLDER, NEWER) === NEWER, 'fresher checkedAt wins regardless of layer');
check(pickFresherArQuota(NEWER, OLDER) === NEWER, 'layer order does not decide the winner');
check(pickFresherArQuota(null, OLDER) === OLDER, 'missing local falls back to remote');
check(pickFresherArQuota(OLDER, null) === OLDER, 'missing remote keeps local');
check(pickFresherArQuota(null, null) === null, 'nothing cached stays nothing');

check(src.includes("'/__switch/api/ar/quota-state'"), 'GET quota-state route exists');
check(src.includes('AR_QUOTA_STATE_FILE'), 'server caches the probe result to disk');
check(src.includes('buildArQuotaCache'), 'server builds the cache entry from the probe');
check(src.includes('isArQuotaCacheFresh'), 'server validates freshness before serving cache');
check(html.includes("const KEY_ST = 'ar-quota-state'"), 'browser cache has its own storage key');
check(html.includes("fetch('/__switch/api/ar/quota-state')"), 'browser reads the shared cache');
check(html.includes('stExpire(c.t)'), 'dial tick expires the cache when a batch lands');
check(html.includes('по проверке') && html.includes('при фолбэке'),
  'restored result says WHERE the state came from: probe or fallback');
const stHandler = html.slice(html.indexOf('function stPaint'), html.indexOf('window.arqCheckQuota'));
check(stHandler.length > 200, 'stPaint extracted (иначе проверка ниже зелена по пустой строке)');
check(!/api_key|x-api-key|sk-/i.test(stHandler), 'browser cache never touches keys');

// ── Две полосы: Claude и GPT кончаются порознь ───────────────────────────────
check(AR_QUOTA_POOLS.opus === 'claude-opus-5' && AR_QUOTA_POOLS.gpt === 'gpt-6-astra',
  'обе полосы названы своими моделями');
check(arQuotaPoolForModel('claude-opus-5') === 'opus', 'claude-* идёт в полосу opus');
check(arQuotaPoolForModel('gpt-6-astra') === 'gpt', 'gpt-* идёт в полосу gpt');
check(arQuotaPoolForModel('deepseek-v4-flash') === null, 'беспуловая модель не имеет полосы');
check(arQuotaBodyFor('gpt').model === 'gpt-6-astra',
  'проба GPT бьёт моделью GPT - иначе она проверяет Opus и врёт');
check(arQuotaBodyFor('opus').model === 'claude-opus-5', 'проба opus осталась прежней');
check(arQuotaBodyFor('нет-такой').model === AR_QUOTA_BODY.model, 'неизвестная полоса не роняет пробу');

// 🪤 Файл v1 лежит на диске у всех, кто обновляется: после апдейта «квота пропала»
// выглядело бы поломкой. Читается он как запись opus.
const V1 = JSON.stringify({ state: 'exhausted', checkedAt: 'x', dropAt: 'y', keyTail: '1234' });
check(arQuotaReadPools(V1).opus?.state === 'exhausted', 'запись v1 читается как полоса opus');
const V2 = JSON.stringify({ opus: { state: 'available' }, gpt: { state: 'exhausted' } });
check(Object.keys(arQuotaReadPools(V2)).length === 2, 'новая форма читает обе полосы');
check(arQuotaReadPools(V2).gpt.state === 'exhausted', 'полосы не путаются местами');
check(Object.keys(arQuotaReadPools('{ это не JSON')).length === 0, 'битый файл даёт пусто, а не исключение');
check(Object.keys(arQuotaReadPools('[]')).length === 0, 'массив вместо объекта не даёт мусорных полос');

// Автофолбэк обязан ставить состояние полосы - иначе часы о нём не узнают.
check(/arQuotaPoolForModel\(deadModel\)/.test(src), 'пул-дроп определяет полосу по мёртвой модели');
check(/source: 'drop'/.test(src), 'состояние от фолбэка помечено источником');
check(/source: 'probe'/.test(src), 'состояние от пробы помечено источником');
check(/'\/__switch\/api\/ar\/quota-state'/.test(src) && /const pools = \{\}/.test(src),
  'quota-state отдаёт обе полосы, а не одну запись');
check(/неизвестная полоса квоты/.test(src), 'неизвестная полоса - отказ, а не молчаливый opus');

for (const msg of ok) console.log('OK  ' + msg);
for (const msg of fails) console.error('FAIL ' + msg);
console.log(`\n${ok.length} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
