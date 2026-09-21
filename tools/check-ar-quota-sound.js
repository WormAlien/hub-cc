// tools/check-ar-quota-sound.js
//
// Регресс на два звука, которыми дашборд сообщает о судьбе партии AgentRouter:
// ВВЕРХ - когда налили, ВНИЗ - когда пул выпит.
//
// Зачем отдельный файл: у этих звуков нет кнопки «проверить», их не видно на экране, а
// цена ошибки несимметрична. Пропущенный звонок - просто нет уведомления, зато лишний
// звенит ночью и на каждой автоперечитке, и тогда фичу выключают целиком.
// Поэтому проверяются ровно те случаи, где ошибку не видно на глаз:
//   • F5 посреди партии не должен звенеть повторно ни вверх, ни вниз;
//   • автопроба на +20 минут не должна повторять звонок на ту же партию;
//   • событие, случившееся пока страница была закрыта, не звенит на загрузке -
//     страница, которая пищит на F5, хуже страницы без звука;
//   • состояние не путается: `available` не звенит вниз, `exhausted` - вверх;
//   • 🎯 метки у налива и у конца РАЗНЫЕ: общая съела бы второе событие партии;
//   • ручная «Проверить квоту» не звенит (владелец и так смотрит на ответ), но
//     помечает партию просмотренной - и ТОЛЬКО совпавшим состоянием;
//   • 🎯 звук обязан доходить при `document.hidden` - в этом весь смысл фичи, сторож
//     наливки и все рендеры в фоне спят, а звук нужен именно тогда.
//
// Как: часть 1 - чистое решение `arqSndDecide` вырезано из живого HTML и исполнено
// (свежесть записи подаётся аргументом: сцены про РЕШЕНИЕ, а не про арифметику сетки).
// Часть 2 - ограды по исходнику: они не доказывают работу, их дело - заметить, что
// вызов пропал. Часть 3 - живой прогон страницы через playwright: подменены ручка
// `quota-state` и AudioContext, счёт идёт по осцилляторам, которые просит синтез.
// Часть 4 и 5 - живые режимы против настоящего :8200 (`--live`, `--watch`).
// Сети нет, сервер :8200 не нужен. Запуск: node tools/check-ar-quota-sound.js
//
// 🪤 Домен пробы `dashboard.test` на этой машине не резолвится (в hosts записи нет), и
// страница не открывалась: проба падала в таймаут waitForFunction, где «сервер не отдал
// страницу» неотличимо от «фича сломалась». Поэтому запросы уводятся на живой :8200
// (routeDash) - он отвечает и на чужой Host. Если поднимаешь стенд по-настоящему,
// запись в hosts вернёт прежнее поведение и ничего не сломает.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DASH = path.join(__dirname, '..', 'routing', 'proxy-dashboard.html');
const URL = 'http://dashboard.test/__switch';
// Партия берётся из ТОГО ЖЕ расписания, что и страница, — из модуля `ar-quota-probe`,
// а не своей формулой. Третья копия арифметики разошлась бы с двумя боевыми МОЛЧА:
// расхождение здесь выглядит не как ошибка, а как «звук перестал звенеть» (ровно это
// и случилось при переходе на две партии — 10 красных сцен на ровном месте).
const { arQuotaDropAt: dropAt, arQuotaBatches } = require('../routing/lib/ar-quota-probe');
// ...и уводим его на несуществующий файл: живое расписание владельца тут не при чём,
// а страница в этой пробе работает встроенным дефолтом (ручку расписания мы не отдаём).
process.env.AR_QUOTA_SCHEDULE_FILE =
    require('path').join(require('os').tmpdir(), `ar-quota-schedule-sound-${process.pid}.json`);
const ISO = (t) => new Date(t).toISOString();

const src = fs.readFileSync(DASH, 'utf8');
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✅' : '❌'} ${msg}`); if (!cond) failed++; };
const eq = (got, want, msg) => ok(got === want,
    `${msg}${got === want ? '' : `  (ожидалось ${JSON.stringify(want)}, получено ${JSON.stringify(got)})`}`);

// Вырезает `function name(...) {...}` по балансу фигурных скобок.
function grab(name) {
    const at = src.indexOf(`function ${name}(`);
    if (at < 0) throw new Error(`в дашборде нет function ${name}`);
    let i = src.indexOf('{', at), depth = 0;
    for (let j = i; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}' && --depth === 0) return src.slice(at, j + 1);
    }
    throw new Error(`не закрыта function ${name}`);
}

// ═════ 1. Решение «звенеть или нет» ══════════════════════════════════════════
console.log('── решение arqSndDecide ─────────────────────────────────────────────');
const { arqSndDecide } = new Function(`${grab('arqSndDecide')}
    return { arqSndDecide };`)();

const T = Date.parse('2026-09-17T08:00:00Z');   // страница открыта утром МСК
// Метки партий для чистых проверок: текущая, следующая и предыдущая. Значения нужны
// различными (дедуп сверяет их между собой), а не «ровно через 8 часов».
const b11 = arQuotaBatches(T).last, b19 = arQuotaBatches(T).next, b03 = arQuotaBatches(b11 - 1).last;
const rec = (state, checkedAt, drop, source) =>
    ({ state, checkedAt: ISO(checkedAt), dropAt: ISO(drop), source: source || 'probe' });

ok(arqSndDecide(rec('available', T + 120000, b11), true, T, 0) === true,
    'новая партия, свежая запись, квота есть → звенит');
ok(arqSndDecide(rec('available', T + 1200000, b11), true, T, b11) === false,
    'та же партия на автопробе +20 минут → молчит (дедуп по dropAt)');
ok(arqSndDecide(rec('available', T - 180000, b11), true, T, 0) === false,
    'партия налита до открытия страницы (F5) → молчит');
ok(arqSndDecide(rec('available', T + 60000, b11), true, T, b03) === true,
    'звенели на прошлую партию, пришла новая → звенит');
ok(arqSndDecide(rec('exhausted', T + 120000, b11), true, T, 0) === false,
    'exhausted (партии нет) → молчит');
ok(arqSndDecide(rec('available', T + 120000, b03), false, T, 0) === false,
    'запись прошлой партии (не свежая) → молчит даже при available');
ok(arqSndDecide(null, true, T, 0) === false, 'записи нет → молчит');
ok(arqSndDecide({ state: 'available', checkedAt: 'вчера', dropAt: ISO(b11) }, true, T, 0) === false,
    'битый checkedAt → молчит, а не звенит наугад');
ok(arqSndDecide(rec('available', T + 1, b19), true, T, 0) === true,
    'запись следующей партии отличается от просмотренной → звенит');

// Тот же вопрос про КОНЕЦ партии: правила дедупа общие, состояние другое.
ok(arqSndDecide(rec('exhausted', T + 120000, b11), true, T, 0, 'exhausted') === true,
    'пул выпит, партия свежая → звенит вниз');
ok(arqSndDecide(rec('exhausted', T + 1200000, b11), true, T, b11, 'exhausted') === false,
    'о конце этой партии уже звенели → молчит (вторая проба не повторяет)');
ok(arqSndDecide(rec('available', T + 120000, b11), true, T, 0, 'exhausted') === false,
    'состояния не путаются: available о конце не звенит');
ok(arqSndDecide(rec('exhausted', T - 180000, b11), true, T, 0, 'exhausted') === false,
    'пул выпит до открытия страницы (F5) → молчит');
ok(arqSndDecide(rec('exhausted', T + 120000, b11), true, T, b03, 'exhausted') === true,
    'звенели о конце ПРОШЛОЙ партии, выпита новая → звенит');

// ═════ 2. Ограды по исходнику ═══════════════════════════════════════════════
console.log('\n── вызовы на месте ──────────────────────────────────────────────────');
ok(/<div id="arq-mini"[\s\S]{0,700}?id="arq-snd"/.test(src), '🔔 стоит в строке мини-часов в сайдбаре');
ok(/await arqSndCheck\(p, stLoad\(\)\[p\]\)/.test(src),
    'оба звука зовутся из stSync (автопроба сервера, по полосе)');
ok(/if \(data\.state === 'available'\) arqSndMark/.test(src),
    'ручная проверка помечает партию просмотренной только при available');
ok(/const KEY_SND = 'ar-quota-sound'/.test(src) && /=== '0'/.test(src),
    'приглушение: ключ ar-quota-sound, дефолт «включено» (глушит только явный 0)');
ok(/const KEY_SND_DRY = 'ar-quota-sound-dry'/.test(src),
    'у конца партии своя метка: общая съела бы второе событие партии');
ok(/addEventListener\('pointerdown', arqSndArm/.test(src), 'контекст будится жестом человека');
ok(/function arqSndScheduleUp/.test(src) && /await arqSndScheduleUp\(\);/.test(src),
    'налив по расписанию определён и зовётся из stSync (звенит и когда ротация занулила пробу)');
ok(/arqSndScheduleUp[\s\S]{0,400}?arqSndSeen\(KEY_SND_DROP\) === d[\s\S]{0,200}?arqSndPlay\('in'\)/.test(src),
    'налив по расписанию: дедуп общий с пробой (KEY_SND_DROP), голос вверх');

// ═════ 3. Живой прогон ══════════════════════════════════════════════════════
// Подменяем AudioContext счётчиком: сколько осцилляторов попросил синтез. Голоса два,
// и числа привязаны к ним: сменишь голос - поправь здесь, иначе проба развалится на
// первом же сценарии, и это будет правильно.
//   налив («Чаша»): три низкие синусоиды + удар колокола (несущая + модулятор) = 5
//   конец («Провал»): одна нота со съездом = 1
const VOICE_OSC = 5;
const DRY_OSC = 1;

// Домен пробы не резолвится на этой машине (в hosts его нет): уводим те же запросы
// на живой :8200 - хаб отвечает и на чужой Host. Без этого проба падает в таймаут
// waitForFunction, и «страница не открылась» неотличимо от «фича сломалась».
async function routeDash(page) {
    await page.route('**/*', (route) => {
        const u = route.request().url();
        if (!u.startsWith(URL)) return route.continue();
        const dst = URL.replace('://dashboard.test', '://localhost:8200') + u.slice(URL.length);
        if (u.includes('/api/')) return route.continue({ url: dst });
        const h = Object.assign({}, route.request().headers());
        delete h.host;
        return route.continue({ url: dst, headers: h });
    });
}

async function mkPage(context, stub) {
    await context.route('**/*', (route) => {
        const u = route.request().url();
        if (u === URL) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: src });
        if (u.includes('/ar/quota-state')) return route.fulfill({
            contentType: 'application/json', body: JSON.stringify({ ok: true, pools: stub.pools }) });
        if (u.includes('/ar/quota-check')) return route.fulfill({
            contentType: 'application/json', body: JSON.stringify(stub.check || {}) });
        if (/\.js(\?|$)/.test(u)) return route.fulfill({ contentType: 'application/javascript', body: '' });
        return route.fulfill({ contentType: 'application/json', body: '{}' });
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
        window.__osc = 0;
        const P = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {},
            exponentialRampToValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues() {} });
        const N = () => ({ gain: P(), frequency: P(), Q: P(), detune: P(), playbackRate: P(),
            buffer: null, type: '', connect() { return this; }, disconnect() {}, start() {}, stop() {} });
        class AC {
            constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = N(); }
            // resume() разрешается отложенно, как в настоящем браузере: с синхронным
            // `Promise.resolve()` проба зеленела бы и на коде, который читает `state`
            // сразу после вызова, не дожидаясь пробуждения (21.09 - чуть не уехало в бой).
            resume() { const self = this; return new Promise((res) => {
                Promise.resolve().then(() => { self.state = 'running'; res(); }); }); }
            createOscillator() { window.__osc++; return N(); }
            createGain() { return N(); }
            createBiquadFilter() { return N(); }
            createBufferSource() { return N(); }
            createBuffer() { return { getChannelData: () => new Float32Array(16) }; }
            close() { this.state = 'closed'; return Promise.resolve(); }
        }
        window.AudioContext = AC;
        window.webkitAudioContext = AC;
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
        const m = document.getElementById('arq-mini');
        return m && !m.classList.contains('hidden');
    }, null, { timeout: 15000 });
    return { page, errors };
}
// Ручной вызов того же пути, каким ходит `setInterval(stSync, 30000)`: обработчик
// visibilitychange зовёт stSync, когда вкладка НЕ скрыта.
const poke = (page) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
const osc = (page) => page.evaluate(() => window.__osc);

async function main() {
    const browser = await chromium.launch();

    // ── A: обычная жизнь открытой страницы ────────────────────────────────────
    console.log('\n── A. страница открыта ──────────────────────────────────────────────');
    const stub = { pools: { opus: rec('available', dropAt(Date.now()) - 60000,
                                      arQuotaBatches(dropAt(Date.now()) - 1).last) } };
    const ctxA = await browser.newContext();
    const A = await mkPage(ctxA, stub);
    await A.page.waitForTimeout(600);
    eq(await osc(A.page), 0, 'на загрузке молчит: запись прошлой партии, а не свежая');
    eq(await A.page.evaluate(() => document.querySelector('#arq-mini #arq-snd').getAttribute('aria-pressed')),
        'true', '🔔 нарисован как включённый');
    ok(/не разрешил звучать/.test(await A.page.evaluate(() => document.querySelector('#arq-mini #arq-snd').title)),
        'подсказка честно говорит, что браузер ещё не разрешил звук');

    stub.pools.opus = rec('available', Date.now() + 500, dropAt(Date.now()));
    await poke(A.page);
    await A.page.waitForTimeout(1200);
    eq(await osc(A.page), VOICE_OSC, 'партию налили на глазах → звонок вверх (5 осцилляторов)');

    stub.pools.opus = rec('available', Date.now() + 5000, dropAt(Date.now()));
    await poke(A.page);
    await A.page.waitForTimeout(1200);
    eq(await osc(A.page), VOICE_OSC, 'автопроба на +20 минут на ту же партию → молчит');

    // 🎯 Полосы наливают ВМЕСТЕ: вторая полоса в том же залпе не звенит вторым голосом.
    stub.pools.gpt = rec('available', Date.now() + 5500, dropAt(Date.now()));
    await poke(A.page);
    await A.page.waitForTimeout(1200);
    eq(await osc(A.page), VOICE_OSC, 'обе полосы налиты одним залпом → один звонок, а не два');

    // Пул выпит: тот же путь, что и налив (проба пишет state, бросок на 402 помечает
    // `source: 'drop'`), но голос другой и метка своя. Здесь запись взята БОЕВОЙ формы -
    // ровно такой, какую 17.09 в 19:56 положил бросок на 402 (`source: 'drop'`): стенд
    // обязан проверять ту же форму, что приезжает в бою, а не удобную себе.
    stub.pools.gpt = rec('exhausted', Date.now() + 6000, dropAt(Date.now()), 'drop');
    await poke(A.page);
    await A.page.waitForTimeout(1200);
    eq(await osc(A.page), VOICE_OSC + DRY_OSC,
        'пул выпит броском на 402 (source: drop) → звонок вниз, своим голосом');

    stub.pools.gpt = rec('exhausted', Date.now() + 9000, dropAt(Date.now()));
    await poke(A.page);
    await A.page.waitForTimeout(1200);
    eq(await osc(A.page), VOICE_OSC + DRY_OSC, 'следующая проба по тому же пустому пулу → молчит');

    // 🎯 А кончаются полосы ПОРОЗНЬ, и это два разных события: смерть gpt не имеет
    // права заглушить смерть opus (и наоборот). Проба тут ловит ровно эту симметрию -
    // с одной меткой на партию второй звонок пропадал.
    stub.pools.opus = rec('exhausted', Date.now() + 12000, dropAt(Date.now()));
    await poke(A.page);
    await A.page.waitForTimeout(1200);
    eq(await osc(A.page), VOICE_OSC + DRY_OSC + DRY_OSC,
        'та же партия, о наливе которой уже звенели: конец ВТОРОЙ полосы всё равно слышен');
    eq(A.errors.length, 0, `ошибок в странице нет${A.errors.length ? ': ' + A.errors[0] : ''}`);
    await ctxA.close();

    // ── B: партия пришла, пока страница была закрыта, и звук при свёрнутом окне ──
    console.log('\n── B. страница закрыта, потом свёрнута ──────────────────────────────');
    const stubB = { pools: { opus: rec('available', Date.now() - 3000, dropAt(Date.now())) } };
    const ctxB = await browser.newContext();
    const B = await mkPage(ctxB, stubB);
    await B.page.waitForTimeout(800);
    eq(await osc(B.page), 0, 'налили, пока страницы не было → на загрузке молчит');
    ok(/Квота есть/.test(await B.page.evaluate(() => document.getElementById('arq-check-result').textContent)),
        'но состояние не спрятано: строка под часами говорит «Квота есть»');

    // 🎯 Главная сцена: окно свёрнуто, тик опроса идёт своим ходом, сторож наливки спит.
    await B.page.evaluate(() => Object.defineProperty(document, 'hidden', { get: () => true, configurable: true }));
    stubB.pools.opus = rec('available', Date.now() + 500, dropAt(Date.now()));
    console.log('   … ждём фоновый тик stSync (30 с): звук обязан дойти при document.hidden');
    let heard = true;
    try { await B.page.waitForFunction((n) => window.__osc === n, VOICE_OSC, { timeout: 40000 }); }
    catch (e) { heard = false; }
    ok(heard, 'свёрнутое окно: партия налита → звенит без единого клика и без видимой страницы');
    await ctxB.close();

    // ── C: ручная проверка ────────────────────────────────────────────────────
    console.log('\n── C. кнопка «Проверить квоту» ───────────────────────────────────────');
    const stubC = { pools: {}, check: {} };
    const ctxC = await browser.newContext();
    const C = await mkPage(ctxC, stubC);
    stubC.check = { state: 'available', checkedAt: ISO(Date.now()), dropAt: ISO(dropAt(Date.now())), restored: false };
    await C.page.evaluate(() => document.getElementById('arq-check').click());
    await C.page.waitForTimeout(900);
    eq(await osc(C.page), 0, 'нажал «Проверить квоту» сам → молчит, ответ и так на экране');
    eq(await C.page.evaluate(() => localStorage.getItem('ar-quota-sound-drop')),
        String(dropAt(Date.now())), 'но партия помечена просмотренной: автопроба не звякнет задним числом');
    eq(C.errors.length, 0, `ошибок в странице нет${C.errors.length ? ': ' + C.errors[0] : ''}`);
    await ctxC.close();

    // ── D: два окна одного профиля ────────────────────────────────────────────
    // Дашборд открыт в двух окнах - не редкость. localStorage у них общий, и метка
    // партии тоже, поэтому наливка обязана прозвенеть ОДИН раз, а не дважды.
    //
    // 🪤 Сцена писалась дважды и оба раза врала, причём молча. Первая версия ждала
    // звонка от «первого» окна, а вторая страница контекста прячет первую: у той
    // `document.hidden` = true, и `poke` (зовущий `stSync` только для видимой вкладки)
    // не делал ничего. Вторая версия подняла окна наверх, но осталась гоночной: партию
    // метит то окно, чей тик успел первым, и это не обязательно то, которое стреляем
    // мы. Поэтому здесь проверяется не «кто именно», а инвариант: на партию приходится
    // ровно один звонок, и окна делят его между собой. Замер диагноста 17.09 показал
    // ровно это: пометившее окно звонило, второе молчало по общей метке.
    console.log('\n── D. два окна одного профиля ───────────────────────────────────────');
    const stubD = { pools: { opus: rec('exhausted', dropAt(Date.now()) + 60000, dropAt(Date.now())) } };
    const ctxD = await browser.newContext();
    const D1 = await mkPage(ctxD, stubD);
    const D2 = await mkPage(ctxD, stubD);
    // Ждём, пока первичный stSync обоих окон уляжется: иначе запись подменится у них
    // на полпути, и сцена снова станет гоночной.
    for (const [tag, D] of [['первого', D1], ['второго', D2]]) {
        await D.page.waitForFunction(() => !!localStorage.getItem('ar-quota-state'), null, { timeout: 10000 })
            .catch(() => {});
        ok(await D.page.evaluate(() => !!localStorage.getItem('ar-quota-state')),
            `${tag} окна первичный опрос улёгся`);
    }
    stubD.pools.opus = rec('available', Date.now() + 500, dropAt(Date.now()));
    for (const D of [D1, D2]) { await D.page.bringToFront(); await poke(D.page); }
    await D1.page.waitForTimeout(2000);
    const total = (await osc(D1.page)) + (await osc(D2.page));
    const each = [await osc(D1.page), await osc(D2.page)];
    eq(total, VOICE_OSC, `на партию ровно один звонок на два окна (осцилляторов ${each.join(' + ')})`);
    ok(each.filter((n) => n === 0).length === 1, 'звенело одно окно, второе смолчало');
    await ctxD.close();

    await browser.close();
    console.log(failed ? `\n❌ провалов: ${failed}` : '\n✅ все проверки прошли');
    process.exit(failed ? 1 : 0);
}

// ═════ 4. Живая приёмка ═════════════════════════════════════════════════════
// `node tools/check-ar-quota-sound.js --live` - против НАСТОЯЩЕГО :8200, без подмены
// ручек. Проверяет то, чего не видно на стенде: что живая запись партии (её форма,
// её время) не заставляет страницу звенеть на каждой перезагрузке. Открывает окно
// только в headless, окна владельца не трогает и :8200 не рестартует.
async function live() {
    const HUB = process.env.HUB_URL || 'http://localhost:8200/__switch';
    console.log(`── живой дашборд: ${HUB} ─────────────────────────────────────`);
    const browser = await chromium.launch();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await routeDash(page);
    await page.addInitScript(() => {
        window.__osc = 0;
        const P = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {},
            exponentialRampToValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues() {} });
        const N = () => ({ gain: P(), frequency: P(), Q: P(), detune: P(), playbackRate: P(),
            buffer: null, type: '', connect() { return this; }, disconnect() {}, start() {}, stop() {} });
        class AC {
            constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = N(); }
            resume() { this.state = 'running'; return Promise.resolve(); }
            createOscillator() { window.__osc++; return N(); }
            createGain() { return N(); } createBiquadFilter() { return N(); }
            createBufferSource() { return N(); } close() { return Promise.resolve(); }
        }
        window.AudioContext = AC; window.webkitAudioContext = AC;
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    await page.goto(HUB, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => {
        const m = document.getElementById('arq-mini');
        return m && !m.classList.contains('hidden');
    }, null, { timeout: 20000 });
    await page.waitForTimeout(3000);   // модуль успевает сделать свой первый stSync
    const got = await page.evaluate(() => {
        const b = document.querySelector('#arq-mini #arq-snd');
        return { snd: !!b, pressed: b && b.getAttribute('aria-pressed'), icon: b && b.textContent,
            title: b && b.title, osc: window.__osc,
            rec: localStorage.getItem('ar-quota-state'),
            line: (document.getElementById('arq-check-result') || {}).textContent };
    });
    ok(got.snd, '🔔 в сайдбаре на живом дашборде');
    eq(got.pressed, 'true', '🔔 по умолчанию включён');
    eq(got.icon, '🔔', 'иконка без приглушения');
    eq(got.osc, 0, 'загрузка страницы НЕ звенит (главный риск: писк на каждом F5)');
    eq(errors.length, 0, `ошибок в консоли нет${errors.length ? ': ' + errors[0] : ''}`);
    console.log(`   запись партии: ${got.rec || '—'}`);
    console.log(`   партия сейчас: ${ISO(dropAt(Date.now()))} (${new Date(dropAt(Date.now())).toLocaleString('ru-RU')})`);
    console.log(`   строка под часами: ${got.line}`);
    await browser.close();
    console.log(failed ? `\n❌ провалов: ${failed}` : '\n✅ живой дашборд здоров');
    process.exit(failed ? 1 : 0);
}

// ═════ 5. Ждём настоящую партию ═════════════════════════════════════════════
// `node tools/check-ar-quota-sound.js --watch [минут]` - открывает живой дашборд и
// ждёт, пока нальют по-настоящему. Партии в 03/11/19 МСК, сервер пробует пул на +2 и
// +20 минут, поэтому окно ожидания - не меньше получаса: партия «用完即止», и проба на
// +2 минуты может застать пул уже сухим, тогда второй шанс только на +20-й.
// Смотреть за этим глазами бессмысленно (звонок длится секунду), а стендовая часть
// доказать форму живой записи не может - её пишет сервер, а не тест.
async function watch(minutes) {
    const HUB = process.env.HUB_URL || 'http://localhost:8200/__switch';
    const until = Date.now() + minutes * 60000;
    console.log(`── ждём живую партию: ${HUB}, до ${new Date(until).toLocaleTimeString('ru-RU')} ──`);
    const browser = await chromium.launch();
    const page = await (await browser.newContext()).newPage();
    await page.addInitScript(() => {
        window.__osc = 0;
        const P = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {},
            exponentialRampToValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues() {} });
        const N = () => ({ gain: P(), frequency: P(), Q: P(), detune: P(), playbackRate: P(),
            buffer: null, type: '', connect() { return this; }, disconnect() {}, start() {}, stop() {} });
        class AC {
            constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = N(); }
            resume() { this.state = 'running'; return Promise.resolve(); }
            createOscillator() { window.__osc++; return N(); }
            createGain() { return N(); } createBiquadFilter() { return N(); }
            createBufferSource() { return N(); } close() { return Promise.resolve(); }
        }
        window.AudioContext = AC; window.webkitAudioContext = AC;
    });
    page.on('pageerror', (e) => console.log('   ⚠ ошибка страницы: ' + e.message));
    await page.goto(HUB, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => {
        const m = document.getElementById('arq-mini');
        return m && !m.classList.contains('hidden');
    }, null, { timeout: 20000 });
    let beeped = null, lastLine = '';
    while (Date.now() < until) {
        await page.waitForTimeout(20000);
        const s = await page.evaluate(() => ({
            osc: window.__osc, line: (document.getElementById('arq-check-result') || {}).textContent,
            rec: localStorage.getItem('ar-quota-state'), seen: localStorage.getItem('ar-quota-sound-drop') }));
        if (s.osc > 0 && !beeped) {
            beeped = s;
            console.log(`   🔔 ЗВОНОК ${new Date().toLocaleTimeString('ru-RU')}: осцилляторов ${s.osc}`);
            console.log(`      запись: ${s.rec}`);
            console.log(`      партия помечена: ${s.seen} (${new Date(Number(s.seen)).toLocaleString('ru-RU')})`);
            break;
        }
        if (s.line !== lastLine) { lastLine = s.line; console.log(`   ${new Date().toLocaleTimeString('ru-RU')} · ${s.line}`); }
    }
    ok(!!beeped, beeped ? 'живая партия: дашборд звенел сам' : 'живая партия: звонка не было за окно ожидания');
    ok(!beeped || beeped.osc === VOICE_OSC, `звонок ровно один (осцилляторов ${beeped ? beeped.osc : '—'} из ${VOICE_OSC})`);
    await browser.close();
    console.log(failed ? `\n❌ провалов: ${failed}` : '\n✅ живая приёмка пройдена');
    process.exit(failed ? 1 : 0);
}

const waitMin = Number(process.argv[process.argv.indexOf('--watch') + 1]) || 30;
(process.argv.includes('--live') ? live()
    : process.argv.includes('--watch') ? watch(waitMin)
        : main()).catch((e) => { console.error('❌ прогон упал:', e); process.exit(1); });
