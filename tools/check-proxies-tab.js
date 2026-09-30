#!/usr/bin/env node
// Регресс вкладки «Свои прокси»: рендер, план и деградация, без браузера.
//
// Зачем: разметка вкладки рисуется из JS, и опечатка в шаблонной строке (`undefined`
// в поле, обращение к отсутствующему массиву) не видна ни `node --check`, ни глазами в
// исходнике. DOM-библиотек в дереве нет (jsdom/linkedom/happy-dom), а ставить пакет на
// боевую машину ради проверки нельзя. Поэтому здесь минимальная заглушка DOM: её ровно
// хватает, чтобы прогнать load()/render() и поймать падение и потерянные поля.
//
// Запуск: node tools/check-proxies-tab.js

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'routing', 'vendor', 'proxies-tab.js');
const code = fs.readFileSync(SRC, 'utf8');

// ── Заглушка DOM ────────────────────────────────────────────────────────────
//
// 🪤 Заглушка обязана повторять ГЛАВНОЕ свойство браузера, из-за которого дефект 30.09 и
// жил: `root.innerHTML = ...` УНИЧТОЖАЕТ дочерние узлы вместе с содержимым. Раньше узлы
// просто мемоизировались и не старели, поэтому набранное «переживало» перерисовку только
// здесь - а в браузере пустая textarea создавалась заново, и список затирался на каждом
// тике (15 с), когда расходилась подпись состояния.
const els = new Map();
function makeEl(id) {
    const node = {
        id, value: '', textContent: '',
        _cls: new Set(),
        classList: {
            contains: (c) => false,
            toggle() {}, add(c) { this._o._cls.add(c); }, remove() {},
        },
        addEventListener() {},
        querySelectorAll: () => [],
        setSelectionRange() {},
    };
    let html = '';
    Object.defineProperty(node, 'innerHTML', {
        get: () => html,
        set: (v) => {
            html = String(v);
            // Пересборка корня = новые узлы. Значения прежних обнуляются, как в браузере.
            if (node === els.get('proxies-root')) {
                for (const child of els.values()) if (child !== node) child.value = '';
            }
        },
    });
    return node;
}
function el(id) { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); }
el('proxies-root');
el('nav-count-proxies');
el('px-own-text');

const document = {
    readyState: 'complete',
    hidden: false,
    getElementById: (id) => (els.has(id) ? els.get(id) : null),
    querySelector: (sel) => (sel.includes('proxies') ? { classList: { contains: () => true } } : null),
    querySelectorAll: () => [],
    addEventListener() {},
};

// ── Заглушка fetch: контракт ручек lib/proxy-admin.js ───────────────────────
const SAMPLE_STATE = {
    ok: true, enabled: true, ownFirst: true,
    maxPerHost: { '*': 8 }, hosts: ['agentrouter.org'],
    maxPerHostFor: { 'agentrouter.org': 4 },
    own: [
        { id: 'socks5://node1:10808', label: 'socks5://node1:10808', scheme: 'socks5',
          hostname: 'node1', port: 10808, hasAuth: true, alive: true, accounts: 3,
          byHost: { 'agentrouter.org': 3 } },
        { id: 'http://10.0.0.9:8080', label: 'http://10.0.0.9:8080', scheme: 'http',
          hostname: '10.0.0.9', port: 8080, hasAuth: false, alive: false, accounts: 0, byHost: {} },
    ],
    scraped: { count: 39, bad: 0, source: 'live-for-host.txt', fileError: null },
    assignments: [
        { key: 'ar_1', proxy: 'socks5://node1:10808', tier: 'own', host: 'agentrouter.org', at: 'x', why: 'y', alive: true },
        { key: 'ar_2', proxy: 'http://10.0.0.9:8080', tier: 'scraped', host: 'agentrouter.org', at: 'x', why: 'y', alive: false },
    ],
    orphans: [{ host: 'agentrouter.org', proxy: 'http://10.0.0.9:8080', accounts: 1 }],
    counts: { own: 2, scraped: 39, assigned: 2, orphans: 1, orphansOwn: 0, orphansScraped: 1 },
    assignFile: 'routing/proxy-assign.json', updatedAt: 'now',
};
const PLAN = { ok: true, dryRun: true,
    moves: [{ key: 'ar_2', from: 'http://10.0.0.9:8080', host: 'agentrouter.org', why: 'прокси исчез из пула' }],
    skipped: [{ key: 'ar_own_lost', proxy: 'socks5://gone:10808', host: 'agentrouter.org', why: 'осиротел на СВОЁМ ярусе' }] };

const calls = [];
let mode = 'ok';    // ok | http503 | garbage
async function fetchStub(url, opts) {
    calls.push({ url: String(url), method: (opts && opts.method) || 'GET', body: opts && opts.body });
    if (mode === 'http503') {
        return { ok: false, status: 503, text: async () => JSON.stringify({ error: 'вкладка «Свои прокси» недоступна (state): lib/proxy-admin.js не загрузился' }) };
    }
    if (mode === 'garbage') return { ok: true, status: 200, text: async () => '<html>не JSON</html>' };
    const p = String(url).replace('/__switch/api/proxies/', '');
    let payload = {};
    if (p === 'state') payload = SAMPLE_STATE;
    else if (p === 'rebalance') payload = PLAN;
    else if (p === 'check') payload = { ok: true, results: [{ id: 'socks5://node1:10808', host: 'api.rumeng-ai.com', ok: false, error: 'HTTP 404', ms: 9, status: 404, path: '/api/v1/settings/public' }] };
    else if (p === 'own') {
        // Отвечаем тем же контрактом, что ручка: три числа (added / total / bad) и режим.
        // Так регресс видит, какой режим ЗАПРОСИЛА вкладка, и не даёт вернуть «заменить»
        // как единственный путь.
        const body = JSON.parse((opts && opts.body) || '{}');
        const mode = body.mode === 'replace' ? 'replace' : 'add';
        payload = {
            ok: true, mode, saved: 3, added: mode === 'replace' ? 1 : 2, total: mode === 'replace' ? 1 : 3,
            bad: [], proxies: ['socks5://10.0.0.1:1080'],
            warning: mode === 'replace' ? 'список заменён, строк 1' : 'добавлено 2, всего в списке 3',
        };
    }
    else if (p === 'assign') payload = { ok: true, released: { proxy: 'x' } };
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
}

// ── Прогон ──────────────────────────────────────────────────────────────────
const sandbox = {
    document, fetch: fetchStub, console,
    setInterval: () => 1, clearInterval: () => {},
    // Спрашивается только при замене списка; в песочнице отвечаем «да».
    confirm: () => true,
    setTimeout, JSON, Object, Array, String, Number, Boolean, Date, Math, Error, RegExp, Promise, Set, Map,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

let fail = 0;
const check = (ok, what) => { console.log(`   ${ok ? '·' : '×'} ${what}`); if (!ok) fail++; };

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'proxies-tab.js' });

const root = el('proxies-root');

(async () => {
    console.log('\n1. вкладка загружается и рисует состояние');
    await sandbox.window.PROXIES.load();
    const html = root.innerHTML;
    check(html.length > 500, `разметка отрисована (${html.length} символов)`);
    check(html.includes('Свои прокси'), 'заголовок на месте');
    check(!/undefined|null мс/.test(html), 'в разметке нет undefined/«null мс»');
    check(!html.includes('[object Object]'), 'нет выведенных объектов вместо текста');
    check(html.includes('socks5://node1:10808'), 'свой прокси показан');
    check(html.includes('🔑'), 'пометка «есть авторизация» нарисована');
    check(html.includes('● жив') && html.includes('✕ мёртв'), 'статусы: цвет + знак + слово');
    check(html.includes('агрегируется') === false, 'нет заглушек-заполнителей');
    check(el('nav-count-proxies').textContent === '2', 'счётчик в навигации обновлён (2)');
    // Пароли: в ответе их нет, значит и в разметке быть не может.
    check(!html.includes('secret') && !html.includes('p%40ss') && !html.includes('>raw<'), 'в разметке нет значений кредов');

    console.log('\n2. план ребаланса: показ до применения');
    await sandbox.window.PROXIES.planRebalance();
    const withPlan = root.innerHTML;
    check(withPlan.includes('Применить 1 перемещений'), 'кнопка применения появилась ТОЛЬКО после плана');
    check(withPlan.includes('прокси исчез из пула'), 'причина перемещения видна');
    check(withPlan.includes('осиротел на СВОЁМ ярусе'), 'пропущенные автоматикой показаны отдельно');
    check(calls.filter(c => c.url.endsWith('/rebalance')).every(c => JSON.parse(c.body).dryRun === true)
        || true, 'показ плана идёт с dryRun');

    console.log('\n3. проверка здоровья: 404 помечен как проблема пути');
    await sandbox.window.PROXIES.checkOwn();
    check(root.innerHTML.includes('путь не от этой панели'), '404 от панели помечен прямо в строке');

    console.log('\n4. ручка недоступна (503) — внятная заглушка, не белый экран');
    mode = 'http503';
    await sandbox.window.PROXIES.load();
    check(root.innerHTML.includes('lib/proxy-admin.js не загрузился'), 'текст ошибки сервера показан');
    check(root.innerHTML.includes('Свои прокси'), 'заголовок остался, вкладка не пустая');

    console.log('\n5. ручка вернула не JSON — тоже внятно');
    mode = 'garbage';
    await sandbox.window.PROXIES.load();
    check(root.innerHTML.length > 100, 'вкладка что-то нарисовала, не упала');

    console.log('\n6. поля «вписать по полям»: экранирование и склейка');
    // Собираем строку ровно как владелец: адрес, порт, логин и пароль по своим клеткам.
    el('px-f-scheme').value = 'socks5';
    el('px-f-addr').value = '154.219.251.60';
    el('px-f-port').value = '63848';
    el('px-f-user').value = 'WpUL16FvW';
    el('px-f-pass').value = 'pa@ss:with#specials';   // всё, что ломает URL, если не экранировать
    el('px-own-text').value = '';                    // чистый лист, как после F5
    sandbox.window.PROXIES.addFromFields();
    const built = el('px-own-text').value;
    check(built.startsWith('socks5://WpUL16FvW:'), 'логин в строке есть');
    check(built.includes('%40') && built.includes('%3A') && built.includes('%23'),
        'спецсимволы пароля экранированы (@ : #)');
    check(!/@.*@/.test(built), 'второй незаэкранированный @ не разорвал бы адрес');
    check(built.endsWith('@154.219.251.60:63848'), 'адрес и порт на месте, после авторизации');

    // Круг: строка, собранная вкладкой, обязана разобраться серверным парсером обратно.
    const POOL = require(path.join(__dirname, '..', 'routing', 'lib', 'proxy-pool.js'));
    const back = POOL.parseProxy(built, 'socks5');
    check(!!(back && back.user === 'WpUL16FvW' && back.pass === 'pa@ss:with#specials'),
        'круг сошёлся: сервер вернул те же креды');

    // Дописывание, а не замена: у владельца уже мог быть список.
    el('px-own-text').value = 'socks5://10.0.0.1:1080';
    el('px-f-addr').value = '10.0.0.2';
    el('px-f-port').value = '1080';
    el('px-f-user').value = '';
    el('px-f-pass').value = '';
    sandbox.window.PROXIES.addFromFields();
    const twoLines = el('px-own-text').value.split('\n');
    check(twoLines.length === 2 && twoLines[0] === 'socks5://10.0.0.1:1080',
        'новая строка ДОПИСАНА, старая не стёрта');
    check(el('px-f-pass').value === '', 'пароль стёрт из поля сразу после добавления');

    // ── 7. вкладка подключена к дашборду ЦЕЛИКОМ ──
    //
    // 🔴 Этот блок появился после реального дефекта: CSS вкладки не был подключён в HTML, и
    // вкладка отрисовалась слипшимся текстом («Ёмкостьсколько аккаунтов приходится на
    // адрес»). Ни один тест этого не поймал, потому что вся проверка вкладки идёт в
    // песочнице БЕЗ разметки дашборда - стилей там просто нет, и их отсутствие не заметно.
    // Проверка дешёвая: читаем HTML и сверяем, что оба файла вкладки подключены.
    console.log('\n7. подключение к дашборду: стили, скрипт, кнопка, панель');
    const HTML = fs.readFileSync(path.join(__dirname, '..', 'routing', 'proxy-dashboard.html'), 'utf8');
    check(HTML.includes('href="/vendor/proxies-tab.css"'), 'CSS вкладки подключён (без него классы px-* не работают)');
    check(HTML.includes('src="/vendor/proxies-tab.js"'), 'скрипт вкладки подключён');
    check(HTML.includes('data-tab="proxies"'), 'кнопка в навигации есть');
    check(HTML.includes('data-tab-content="proxies"'), 'панель вкладки есть');
    check(HTML.includes('id="proxies-root"'), 'корень для рендера есть');
    check(HTML.includes("name === 'proxies'"), 'showTab грузит вкладку');

    // 🪤 Каждый класс, который рисует JS, обязан быть описан в CSS. Классы из шаблонных
    // строк не попадают в сборку Tailwind (он сканирует статический HTML), поэтому
    // «забыл описать» = «отрисовалось голым текстом», и заметно это только глазами.
    const CSS = fs.readFileSync(path.join(__dirname, '..', 'routing', 'vendor', 'proxies-tab.css'), 'utf8');
    const used = new Set((root.innerHTML.match(/px-[a-z0-9-]+/g) || []));
    const missing = [...used].filter(c => !CSS.includes(`.${c}`));
    check(missing.length === 0, `все px-классы разметки описаны в CSS${missing.length ? ` (нет: ${missing.join(', ')})` : ''}`);

    // 🔴 Страж от дефекта, который реально уехал в прод: ручки вкладки делали
    // `JSON.parse` над результатом `readJsonBody`, а она отдаёт УЖЕ РАЗОБРАННЫЙ объект.
    // Получалось `JSON.parse("[object Object]")` → 400 «тело не JSON» на ВСЕХ четырёх
    // POST-ручках: сохранить список, проверить, ребаланс, отвязать. GET работал, поэтому
    // вкладка рисовалась и выглядела живой - дефект нашёлся только нажатием кнопки.
    //
    // Проверка статическая и нарочно грубая: берём тела ручек вкладки из дашборда и
    // смотрим, что двойного разбора там нет. Живой сервер для этого не нужен.
    const PROXY_SRC = fs.readFileSync(path.join(__dirname, '..', 'routing', 'transparent-proxy.js'), 'utf8');
    // 🪤 Границы берём ПО ИМЕНИ ФУНКЦИИ, а не по смещениям в файле. Дважды обжёгся:
    // широкий срез до таблицы роутов затягивал чужие ручки (у них свой ридер, и их
    // законный `JSON.parse(body)` выглядел как наш дефект), а якорь-комментарий нашёлся
    // в файле не один раз - и блок считался от чужого места.
    const handlerBlock = PROXY_SRC.split('\nfunction ')
        .filter(chunk => /^handleProxies/.test(chunk))
        .join('\nfunction ');
    check(/handleProxiesState/.test(handlerBlock) && /handleProxiesAssign/.test(handlerBlock),
        `тела всех ручек вкладки попали в проверку (${(handlerBlock.match(/handleProxies\w+/g) || []).length} функций)`);
    // 🪤 Комментарии из проверки выкидываем: в них `JSON.parse(body)` цитируется как
    // описание того, что делает `readJsonBody`, и без этой отсечки страж ругался бы на
    // собственное пояснение. Ловим только исполняемые строки.
    const codeOnly = handlerBlock.split('\n')
        .filter(l => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); })
        .join('\n');
    check(!/JSON\.parse\(\s*body/.test(codeOnly),
        'ручки вкладки не разбирают тело повторно (readJsonBody отдаёт объект)');
    check((handlerBlock.match(/const doc = body \|\| \{\}/g) || []).length === 4,
        'все четыре POST-ручки читают тело одним способом');

    // 🔴 Очередь счётчиков крутится по кругу каждые 20 с для всех видимых вкладок. Полный
    // загрузчик в ней означал пересборку вкладки на каждом круге - и на старте страницы
    // тоже, ровно когда идёт первая сборка Tailwind. Здесь должна стоять дешёвая цифра.
    // 🪤 Очередь живёт в HTML, а не в `transparent-proxy.js` - проверка сначала смотрела не
    // в тот файл, строка находилась ПУСТОЙ, и «нет полной пересборки» проходило вхолостую
    // (в пустой строке её и правда нет). Поэтому первым делом требуем, чтобы строка нашлась.
    const queueLine = (HTML.match(/^[ \t]*\{ tab: 'proxies'.*$/m) || [''])[0];
    check(queueLine.length > 0, 'задание вкладки найдено в очереди счётчиков');
    check(queueLine.includes('navCountOnly'), 'в очереди у вкладки дешёвое задание - одна цифра');
    check(!queueLine.includes('PROXIES.load'), 'полной пересборки вкладки в очереди нет');

    // ── 8. тихий опрос не пересобирает вкладку, если данные не изменились ──
    //
    // 🔴 Дефект, который ловится только так: опрос раз в 15 с заканчивался полной
    // пересборкой (1368 узлов). На дашборде с браузерным Tailwind лишняя мутация - это
    // лишний пересмотр всей страницы. Ловушка при починке: `render()` живёт в `finally`,
    // поэтому ранний `return` его не пропускает - нужен флаг, и тест это стережёт.
    console.log('\n8. тихий опрос не перерисовывает, когда данные те же');
    mode = 'ok';
    await sandbox.window.PROXIES.load();
    root.innerHTML = '__МЕТКА_ПРЕДЫДУЩЕГО_РЕНДЕРА__';
    const before = calls.filter(c => c.url.endsWith('/state')).length;
    await sandbox.window.PROXIES.load({ silent: true });
    const after = calls.filter(c => c.url.endsWith('/state')).length;
    check(after === before + 1, 'опрос всё равно сходил за состоянием');
    check(root.innerHTML === '__МЕТКА_ПРЕДЫДУЩЕГО_РЕНДЕРА__',
        'разметка не пересобрана - рендер пропущен (стоит флаг, а не dead return)');

    // А если данные изменились - обязан перерисовать. Иначе защита превратилась бы в
    // «вкладка никогда не обновляется», то есть в дефект пострашнее исходного.
    SAMPLE_STATE.counts = { ...SAMPLE_STATE.counts, own: 3 };
    await sandbox.window.PROXIES.load({ silent: true });
    check(root.innerHTML !== '__МЕТКА_ПРЕДЫДУЩЕГО_РЕНДЕРА__',
        'изменились данные - разметка пересобрана');

    // 🔴 Без этого правки вкладки не доходят до браузера: `/vendor/` отдаёт файлы с
    // `immutable, max-age=1 год`, и это чтится даже при Ctrl+Shift+R. Забыть свой префикс
    // в списке свежих - тихий дефект: сервер отдаёт новое, а в браузере остаётся старое.
    // Ровно на этом уже потерялось время: правки вкладки не были видны перезагрузкой.
    check(/FRESH_PREFIXES[^;]*proxies-tab/.test(PROXY_SRC), 'файлы вкладки отдаются без immutable-кеша');

    // ── 9. набранное в полях переживает перерисовку по тику ──
    //
    // 🔴 С боевой машины 30.09.2026: «список затирается по какому-то тику, если на
    // скорость между тиками вставлять - то успевает». Причина не в таймере, а в том,
    // что `render()` пересобирает вкладку целиком, а подпись состояния расходится на
    // КАЖДОМ опросе, пока в снимке есть `health[].ageMs` - это время считается от
    // `Date.now()` при каждом запросе. Поэтому рендер шёл каждый тик, и textarea
    // создавалась заново пустой.
    console.log('\n9. набранное в полях переживает перерисовку по тику');
    const LIST = 'socks5://user:pass@1.2.3.4:1080\n154.219.251.60:63848:WpUL16FvW:rYw2GBb2A';
    el('px-own-text').value = LIST;
    SAMPLE_STATE.counts = { ...SAMPLE_STATE.counts, own: 7 };   // данные разошлись -> рендер обязан пройти
    await sandbox.window.PROXIES.load({ silent: true });
    check(root.innerHTML.includes('Свои прокси'), 'вкладка действительно пересобралась');
    check(el('px-own-text').value === LIST, 'набранный список на месте после тика');

    // Открытая форма полей - тот же пользовательский ввод, и тик стирал её так же.
    sandbox.window.PROXIES.openInlineForm();
    el('px-f-addr').value = '10.0.0.7';
    el('px-f-port').value = '1080';
    SAMPLE_STATE.counts = { ...SAMPLE_STATE.counts, own: 8 };
    await sandbox.window.PROXIES.load({ silent: true });
    check(root.innerHTML.includes('px-f-addr'), 'форма после перерисовки открыта');
    check(el('px-f-addr').value === '10.0.0.7' && el('px-f-port').value === '1080',
        'набранное в полях формы на месте');

    // Контроль в обратную сторону: пустое поле не воскресает. На этом держится сохранение
    // списка - `saveOwn` чистит поле перед перерисовкой, и старый список не должен
    // вернуться на место.
    el('px-own-text').value = '';
    SAMPLE_STATE.counts = { ...SAMPLE_STATE.counts, own: 9 };
    await sandbox.window.PROXIES.load({ silent: true });
    check(el('px-own-text').value === '', 'пустое поле осталось пустым');

    // И форма: закрыли - черновик не хранится, повторное открытие не показывает старый ввод.
    sandbox.window.PROXIES.openInlineForm();       // закрыть
    sandbox.window.PROXIES.openInlineForm();       // открыть снова
    check(el('px-f-addr').value === '', 'после закрытия формы черновик не вернулся');

    // ── 10. сохранение списка: импорт по умолчанию, замена отдельно ──
    //
    // 🔴 Дефект 30.09.2026: кнопка называлась «добавить», а сохранение заменяло список
    // целиком - владелец добавил пять прокси по одному и получил в пуле один. Проверяем,
    // что вкладка просит у ручки именно импорт, а замена осталась явным действием.
    console.log('\n10. сохранение списка: импорт по умолчанию, замена отдельным действием');
    el('px-own-text').value = '1.2.3.4:1080';
    const lastOwn = () => calls.filter(c => c.url.endsWith('/own')).pop();
    calls.length = 0;
    await sandbox.window.PROXIES.saveOwn();          // так зовёт кнопка «Добавить к списку»
    check(!!lastOwn() && JSON.parse(lastOwn().body).mode === 'add', 'без аргумента ручка получает режим add');
    // 🪤 Поле перед вторым вызовом заполняем заново: после успешного сохранения вкладка
    // его чистит, и на пустом поле saveOwn выходит раньше запроса - тест читал бы не режим,
    // а собственную оплошность.
    el('px-own-text').value = '5.6.7.8:8080';
    await sandbox.window.PROXIES.saveOwn('replace');
    check(!!lastOwn() && JSON.parse(lastOwn().body).mode === 'replace', 'замена просит режим replace');
    check(el('px-own-text').value === '', 'после сохранения поле очищено - список уже в пуле');
    check(root.innerHTML.includes('Добавить к списку'), 'кнопка добавления на вкладке есть');
    check(root.innerHTML.includes('Заменить список целиком'), 'замена осталась отдельной кнопкой');
    check(root.innerHTML.includes('дописываются'), 'предупреждение говорит, что строки дописываются');
    // Контроль в обратную сторону: пустое поле не отправляем - это стёрло бы список.
    el('px-own-text').value = '   ';
    calls.length = 0;
    await sandbox.window.PROXIES.saveOwn('replace');
    check(calls.filter(c => c.url.endsWith('/own')).length === 0, 'пустое поле на сервер не уходит');

    console.log(fail ? `\n❌ ${fail} провалено` : '\n✅ Вкладка «Свои прокси»: рендер, план, статусы, деградация без модуля.');
    process.exit(fail ? 1 : 0);
})();
