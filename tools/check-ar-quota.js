#!/usr/bin/env node
/** Regression for the manual AgentRouter Opus quota probe. */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Расписание на весь прогон — СВОЁ, не пользовательское. У владельца в
// `~/.claude/ar-quota-schedule.json` лежит живое расписание, и проба, читающая его,
// краснела бы от правки настроек в панели: «сломалось» то, что никогда не проверялось.
// По этому пути файла нет, значит модуль работает поставкой — и её можно утверждать.
process.env.AR_QUOTA_SCHEDULE_FILE = path.join(os.tmpdir(), `ar-quota-schedule-test-${process.pid}.json`);

const DASH = path.join(__dirname, '..', 'routing', 'transparent-proxy.js');
const HTML = path.join(__dirname, '..', 'routing', 'proxy-dashboard.html');
const src = fs.readFileSync(DASH, 'utf8');
const html = fs.readFileSync(HTML, 'utf8');
const { classifyArQuotaProbe, AR_QUOTA_BODY, AR_SCHEDULE_DEFAULT,
        AR_QUOTA_POOLS, arQuotaPoolForModel, arQuotaBodyFor, arQuotaReadPools,
        arQuotaDropAt, arQuotaKeyTail, buildArQuotaCache, isArQuotaCacheFresh,
        pickFresherArQuota, arQuotaSchedule, arQuotaScheduleSave, arScheduleParseTimes,
        arScheduleTzOk, arQuotaBatches } = require('../routing/lib/ar-quota-probe');

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
check(/if \(pool === VIEW\) \{[^}]*arqState\(/.test(html),
  'красится только показываемая полоса: две полосы в один цвет не свести');

// ── Явная строка «что отвечает и когда кончилась квота» ─────────────────────
// Владелец 16.09 не понял этого по мелкой подписи в карточке конфига: панель маппинга
// показывала claude-opus-5, а строка про фолбэк - deepseek, и обе были правы про РАЗНЫЕ
// пути. Теперь состояние считает ОДНА функция по двум источникам сразу: квота (файл
// состояния) + то, что реально отвечает (карта активного пути из `gatewayTiers`).
check(html.includes('id="arq-pool-state"'), 'в карточке часов есть явная строка состояния');
check(/function stPoolLine\(pool\)/.test(html), 'строку рисует одна функция, а не два места');
check(/AR_MAP = \(p && p\.gatewayTiers\)/.test(html),
  '«что отвечает» берётся из карты активного пути, а не из памяти о дропе');
check(/квота кончилась \$\{at\} \(\$\{why\}\) · отвечает/.test(html),
  'пул пуст и трафик ушёл: сказано, когда кончилась и куда ушёл');
check(/а карта стоит на \$\{arpool\}/.test(html),
  'пул пуст, но карта возвращена: сказано, что каждый запрос сначала упрётся в 402');
check(/⚠️ пул пуст по \$\{dead\}[\s\S]{0,120}но карта уже на \$\{serving\}/.test(html),
  'строка в карточке конфига сверяется с картой, а не повторяет память о дропе');

// ── Баннер «Маршрутов» обязан ВЫЗЫВАТЬСЯ, а не просто существовать ───────────
// 🪤 Живой баг 16.09: `routesDropAt` звал `pad`, который объявлен внутри IIFE часов и
// оттуда не виден, - вкладка «Маршруты» падала на рендере (`pad is not defined`), и
// нашла это другая сессия, а не регресс. `node --check` такое не ловит: файл синтаксически
// цел, ошибка в области видимости и всплывает только при вызове. Поэтому здесь функция
// ВЫПОЛНЯЕТСЯ на настоящей дате.
{
    const s3 = html.indexOf('const routesDropAt =');
    check(s3 > 0, 'помощник баннера существует');
    if (s3 > 0) {
        const e3 = html.indexOf('\n};', s3);
        const body = html.slice(s3, e3 + 3);
        let out = null, err = null;
        try {
            out = new Function(body + '\nreturn routesDropAt;')()(new Date().toISOString());
        } catch (e) { err = e.message; }
        check(err === null && /^\d{2}:\d{2}$|^\d{2}\.\d{2} \d{2}:\d{2}$/.test(String(out)),
            `дата дропа форматируется при вызове, без ReferenceError (${err || out})`);
        // Прочерк на мусоре, а не «Invalid Date» на экране.
        try {
            out = new Function(body + '\nreturn routesDropAt;')()('не-дата');
            check(out === '—', 'битая дата даёт прочерк, а не «Invalid Date»');
        } catch (e) { check(false, 'битая дата уронила форматирование: ' + e.message); }
    }
}

// ── Селектор один, и он применяет себя сам ───────────────────────────────────
// Владелец 16.09: «я не понимаю всё равно зачем нам дубль селектора». Второй такой же
// в блоке часов был и убран: два зеркала ОДНОГО ключа разъезжаются (сначала общий
// «Применить» затирал чужую правку, потом понадобилась синхронизация двух зеркал).
// Настройка живёт там, где живёт сам ключ; часы только НАЗЫВАЮТ адрес строкой состояния.
check(html.includes('id="ar-keepalive-pooldrop"'), 'селектор «при пустом пуле пускать в» есть');
check(!html.includes('arq-pooldrop'), 'второго селектора того же ключа нет — дубль убран');
check(/при пустом пуле пускать в/.test(html), 'селектор подписан словами владельца');
check(/sel\.onchange = async \(\) => \{[\s\S]{0,400}?poolFallbackModel: sel\.value/.test(html),
  'селектор применяет себя сам, по onchange');
check(!/patch\.poolFallbackModel/.test(html),
  '«Применить» фолбэк не шлёт: иначе он затирает правку, сделанную мимо кнопки');
check(/sel\.value = prev;[\s\S]{0,200}?не применён/.test(html),
  'неудачная запись откатывает выбор и говорит об этом, а не оставляет врать панель');
check(/pooldropFill\(pfx, data\.cfg\.poolFallbackModel \|\| ''\);\s*\n\s*KEEPALIVE_STATE/.test(html),
  'селектор обновляется на каждом тике статов, а не только при полной загрузке');
check(/if \(!force && sel\.dataset\.filled === want\) return;/.test(html),
  'повторная отрисовка того же значения не пересобирает разметку каждый тик');
// Часы значение ЧИТАЮТ (чтобы назвать адрес в строке), но не пишут.
check(/async function arqFbSync/.test(html) && /await arqFbSync\(\)/.test(html),
  'карточка часов читает фолбэк для строки состояния');
check(/отвечает \$\{serving\}|поедет на \$\{FB/.test(html),
  'строка состояния называет адрес: «пул пуст» без адреса бесполезно');

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
check(/\['', \.\.\.cat, want\]/.test(html),
  'текущее значение остаётся в списке даже при пустом каталоге - иначе выбор молча выключит фичу');

// ── Автопроверка квоты по таймингу наливки ──────────────────────────────────
// Решение «пора ли проверять» вырезается из монолита и гоняется на синтетических
// временах: оно будит ПЛАТНЫЙ шлюз, а таймер в 60 с глазами не проверить.
{
    const probeLib2 = require('../routing/lib/ar-quota-probe');
    const ql = require('../routing/lib/pooldrop');
    const src2 = fs.readFileSync(DASH, 'utf8');
    const head = 'function arQuotaAutoTickNow(';
    const s2 = src2.indexOf(head);
    check(s2 > 0, 'решение автопроверки вынесено в функцию, а не заперто в таймере');
    if (s2 > 0) {
        const end = src2.indexOf('\n}\n', s2);
        const body = src2.slice(s2, end + 3);
        const ticked = new Set();
        let markerExists = true;
        const autoTick = new Function('AR_QUOTA_AUTOTICK', 'arQuotaTicked', 'AR_QUOTA_POOLS',
            'AR_QUOTA_WINDOWS_MS', 'arQuotaDropAt', 'poolDropLib', 'tierMapFile', 'fs', `
            ${body}
            return arQuotaAutoTickNow;`)(
            true, ticked, probeLib2.AR_QUOTA_POOLS, [2 * 60000, 20 * 60000],
            probeLib2.arQuotaDropAt, ql, () => '/x/ar-modelmap.json',
            { existsSync: () => markerExists },
        );
        const BATCH = Date.UTC(2026, 8, 16, 11, 0, 0);     // 14:00 МСК, вторая партия суток
        const at = (ms) => autoTick(BATCH + ms);
        check(at(60_000).length === 0, 'за минуту до отметки проба не идёт: партия ещё не налита');
        check(at(2 * 60_000).length === 2, 'через 2 минуты после наливки проверяются обе полосы');
        check(at(2 * 60_000 + 30_000).length === 0, 'в том же окне второй раз не проверяем — шлюз платный');
        check(at(20 * 60_000).length === 2, 'вторая отметка через 20 минут: налив бывает с задержкой');
        check(at(60 * 60_000).length === 0, 'через час после наливки проба не идёт: окно прошло');
        check(at(2 * 60_000).length === 0, 'следующая партия — своё окно, но не раньше её отметки');
        ticked.clear();
        const NEXT = BATCH + 15 * 3600 * 1000;             // следующая партия — 05:00 МСК, через 15 ч
        check(autoTick(NEXT + 2 * 60_000).length === 2, 'на новой партии автопроверка снова срабатывает');
        ticked.clear();
        // 🪤 Гейт «проверяем только при живом маркере пул-дропа» был и снят 16.09: он
        // молчал ровно в том случае, ради которого существует, - когда никто ещё не поймал
        // 402 и состояние просто неизвестно. Владелец: «пока я вручную не кликну, хуй что
        // мне скажет, что у нас уже дипсик». Цена снятия - 12 крошечных проб в сутки.
        markerExists = false;
        check(autoTick(BATCH + 2 * 60_000).length === 2,
            'проверяем в каждую партию независимо от маркера: иначе состояние неизвестно, пока не кликнешь');
        markerExists = true;
    }
    // Замер на старте дашборда: после рестарта состояние известно сразу, а не с партии.
    check(/setTimeout\(\(\) => \{[\s\S]{0,220}?arQuotaProbeAsync\(pool\)[\s\S]{0,80}?\}, 10_000\)/.test(src),
        'на старте дашборда состояние квоты замеряется сразу, а не ждёт ближайшей партии');
    check(/function arQuotaProbeAsync\(pool\)/.test(src),
        'проба вынесена отдельной функцией: её зовут и таймер, и старт');
    check(/arQuotaProbeAsync\(pool\);\n\}, 60_000\)/.test(src), 'и таймер по-прежнему зовёт её же');
}

// ── Расписание партий: список времён в зоне шлюза (объявление 2026-09-18) ────
// Было: сетка «8 ч от 16:00 UTC» (03/11/19 МСК). Стало: две партии, Пекин 10:00 и
// 19:00 = 02:00 и 11:00 UTC = 05:00 и 14:00 МСК. Сеткой это не выражается —
// промежутки 9 ч и 15 ч, — и именно поэтому расписание стало списком.
check(AR_SCHEDULE_DEFAULT.tz === 'Asia/Shanghai', 'поставка расписания — зона шлюза, а не МСК');
check(AR_SCHEDULE_DEFAULT.times.join(',') === '10:00,19:00', 'поставка = две партии, Пекин 10:00 и 19:00');
check(arQuotaSchedule().source === 'default', 'без файла расписание берётся из поставки');
check(!html.includes('const CYCLE = 8 * 3600 * 1000'), 'жёсткая сетка 8 ч ушла из часов');
check(!html.includes('Date.UTC(1970, 0, 1, 16, 0, 0)'), 'опора сетки 16:00 UTC ушла из часов');
check(html.includes("tz: 'Asia/Shanghai', times: ['10:00', '19:00']"),
  'встроенный дефолт часов совпадает с поставкой сервера — иначе F5 до рестарта врёт');
check(!html.includes("[3,'03']") && !html.includes("[11,'11']") && !html.includes("[19,'19']"),
  'метки 03/11/19 ушли из разметки');
check(html.includes('batchesOfDay(Date.now())'), 'метки «Суток» считаются из расписания');
check(!html.includes('(toA - 120 + 360) % 360'), 'жёсткий сектор 120° ушёл');
check(html.includes('span > 180 ? 1 : 0'),
  'флаг большой дуги считается: на 15-часовом промежутке (225°) ноль выворачивает сектор');
check(html.includes('arq-sched-times') && html.includes('arq-sched-tz'),
  'в панели есть карточка расписания: времена и зона');
check(html.includes("'/__switch/api/ar/quota-schedule'"), 'часы читают расписание ручкой');
check(src.includes("'/__switch/api/ar/quota-schedule'"), 'ручка расписания зарегистрирована на сервере');
check(/arQuotaScheduleSave\(body\)/.test(src), 'POST пишет расписание валидатором, а не сырым JSON');
check(!html.includes('Три партии в сутки') && !html.includes('тремя партиями'),
  'зашитое «три партии» ушло из подписей');

// Разбор и валидация: молча проглоченная опечатка сдвинула бы налив на сутки.
check(arScheduleParseTimes('10:00, 19:00').times.join(',') === '10:00,19:00', 'список читается через запятую');
check(arScheduleParseTimes('19:00 10:00 10:00').times.join(',') === '10:00,19:00', 'порядок и дубли приводятся');
check(arScheduleParseTimes('9, 19:30').times.join(',') === '09:00,19:30', '«9» читается как 09:00');
check(arScheduleParseTimes('10:00, позже').ok === false, 'мусор отвергается');
check(arScheduleParseTimes('25:00, 10:00').ok === false, 'час вне суток отвергается');
check(arScheduleParseTimes('10:00').ok === false,
  'одна партия отвергается: дуга «до следующей» выродилась бы в полный круг');
check(arScheduleTzOk('Europe/Moscow') === true, 'IANA-зона принимается');
check(arScheduleTzOk('Марс/Олимп') === false, 'выдуманная зона отвергается');
check(arScheduleTzOk('') === false, 'пустая зона отвергается');

// ── Две копии арифметики обязаны совпадать ────────────────────────────────
// Часы несут СВОЮ копию зонной арифметики намеренно: ручки расписания до рестарта
// `:8200` может не быть вовсе, и без копии циферблат стоял бы мёртвым. Но это ровно
// тот случай, где расхождение МОЛЧИТ: обе копии «работают», а часы показывают не ту
// партию, по которой сервер пробует пул. Поэтому копии сверяются между собой на
// батарее моментов — ассерт по исходнику («в файле есть такая строка») тут бесполезен,
// он зеленеет и на сломанной арифметике.
{
    const padN = n => String(n).padStart(2, '0');
    const head = html.indexOf('const SCHED_FALLBACK');
    const endMark = html.indexOf('\n', html.indexOf('const fmtLocal', head));
    check(head > 0 && endMark > head, 'в часах есть свой слой расписания');
    if (head > 0 && endMark > head) {
        const block = html.slice(head, endMark);
        const patched = block.replace('let SCHED = SCHED_FALLBACK;', '');
        check(patched !== block, 'копия часов берёт расписание снаружи — иначе сверять нечего');
        const build = sched => new Function('__sched', 'pad', `
            const SCHED = __sched;
            ${patched}
            return { batches, batchesOfDay, zonedParts, zonedToUtc };`)(sched, padN);
        const SCHEDS = [
            AR_SCHEDULE_DEFAULT,
            { tz: 'Europe/Moscow', times: ['05:00', '14:00'] },
            { tz: 'UTC', times: ['00:00', '08:00', '16:00'] },
            { tz: 'Europe/Berlin', times: ['02:30', '03:30', '14:00'] },   // дни перевода часов
            { tz: 'Asia/Tokyo', times: ['00:00', '23:59'] },               // полночь и конец суток
            { tz: 'America/New_York', times: ['00:30', '12:00', '23:30'] },
        ];
        let seen = 0;
        const bad = [];
        for (const s of SCHEDS) {
            const c = build(s);
            for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 37 * 60000) {
                const a = arQuotaBatches(t, s), b = c.batches(t);
                seen++;
                if (!a || !b || a.last !== b.last || a.next !== b.next) {
                    if (bad.length < 3) {
                        bad.push(`${s.tz} ${new Date(t).toISOString()}: сервер ${a && a.last}/${a && a.next}`
                            + `, часы ${b && b.last}/${b && b.next}`);
                    }
                }
            }
        }
        check(bad.length === 0,
            `копии расписания совпадают на ${seen} моментах (6 расписаний × год, шаг 37 мин)`
            + (bad.length ? ' — ' + bad.join(' | ') : ''));
    }
}

// ── Кеш результата проверки (2026-09-12) ──────────────────────────────────
// Инвалидация по ПАРТИИ, а не по TTL. Точки взяты в UTC, чтобы регресс не зависел
// от таймзоны машины: 02:00 и 11:00 UTC = партии 05:00 и 14:00 МСК.
const SCHED0 = AR_SCHEDULE_DEFAULT;
const DROP = Date.UTC(2026, 8, 12, 2, 0, 0);          // первая партия, 05:00 МСК
const NEXT_DROP = Date.UTC(2026, 8, 12, 11, 0, 0);    // вторая партия, 14:00 МСК
check(arQuotaDropAt(DROP + 3600_000, SCHED0) === DROP, 'dropAt snaps to the batch that already happened');
check(arQuotaDropAt(DROP - 1, SCHED0) === Date.UTC(2026, 8, 11, 11, 0, 0),
  'dropAt before a batch points at the previous one — через 15 ч, а не через 8');
check(arQuotaDropAt(NEXT_DROP - 1, SCHED0) === DROP, 'вторая партия дня — ближайшая прошедшая');
check(arQuotaDropAt('nope') === null, 'dropAt rejects garbage');
check(arQuotaBatches(DROP + 3600_000, SCHED0).next === NEXT_DROP, 'next — вторая партия тех же суток');
// 🎯 Промежутки РАЗНЫЕ, и это главная причина, по которой сетка «цикл N часов» умерла:
// от утренней партии до вечерней 9 ч, от вечерней до следующей утренней — 15 ч.
const afterMorning = arQuotaBatches(DROP + 3600_000, SCHED0);
check(afterMorning.next - afterMorning.last === 9 * 3600 * 1000, 'день: 9 ч между партиями');
const afterEvening = arQuotaBatches(NEXT_DROP + 3600_000, SCHED0);
check(afterEvening.next - afterEvening.last === 15 * 3600 * 1000, 'ночь: 15 ч между партиями');

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
check(/arQuotaPoolForModel\(deadModel/.test(src), 'пул-дроп определяет полосу по мёртвой модели');
check(/source: 'drop'/.test(src), 'состояние от фолбэка помечено источником');
check(/source: 'probe'/.test(src), 'состояние от пробы помечено источником');
check(/'\/__switch\/api\/ar\/quota-state'/.test(src) && /const pools = \{\}/.test(src),
  'quota-state отдаёт обе полосы, а не одну запись');
check(/неизвестная полоса квоты/.test(src), 'неизвестная полоса - отказ, а не молчаливый opus');

// ── Расписание читается с диска, а не из кода ─────────────────────────────
// Пишем и читаем ВРЕМЕННЫЙ файл: переменная окружения уводит туда весь модуль, живое
// `~/.claude` не трогается. Проверяем не «файл есть», а что записанное расписание
// реально управляет партией — иначе настройка была бы украшением.
{
    const TMP = path.join(os.tmpdir(), `ar-quota-schedule-check-${process.pid}.json`);
    const prevEnv = process.env.AR_QUOTA_SCHEDULE_FILE;
    process.env.AR_QUOTA_SCHEDULE_FILE = TMP;
    try {
        check(arQuotaScheduleSave({ tz: 'Europe/Moscow', times: '05:00, 14:00' }).ok === true,
            'расписание записано на диск');
        check(arQuotaSchedule().source === 'file' && arQuotaSchedule().tz === 'Europe/Moscow',
            'после записи модуль читает файл, а не поставку');
        check(arQuotaDropAt(Date.UTC(2026, 8, 18, 3, 0, 0)) === Date.UTC(2026, 8, 18, 2, 0, 0),
            'записанное расписание управляет партией: 05:00 МСК = 02:00 UTC');
        check(JSON.parse(fs.readFileSync(TMP, 'utf8')).times.join(',') === '05:00,14:00',
            'на диск легли нормализованные времена');
        check(arQuotaScheduleSave({ tz: 'Марс/Олимп', times: '10:00, 19:00' }).ok === false,
            'невалидная зона не попадает на диск');
        check(arQuotaScheduleSave({ tz: 'UTC', times: '10:00' }).ok === false,
            'одна партия не попадает на диск');
        check(JSON.parse(fs.readFileSync(TMP, 'utf8')).tz === 'Europe/Moscow',
            'отказ валидатора не переписал живой файл');
    } finally {
        if (prevEnv === undefined) delete process.env.AR_QUOTA_SCHEDULE_FILE;
        else process.env.AR_QUOTA_SCHEDULE_FILE = prevEnv;
        try { fs.unlinkSync(TMP); } catch (e) { /* свой временный файл мог и не появиться */ }
    }
}

for (const msg of ok) console.log('OK  ' + msg);
for (const msg of fails) console.error('FAIL ' + msg);
console.log(`\n${ok.length} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
