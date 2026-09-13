'use strict';

// Offline/static CI guard for the rumeng (如梦AI) integration.
//
// Аналог `tools/check-aikeysapi-safe.js`: вкладка rumeng — структурная копия вкладки
// AIKeysAPI, и этот файл сторожит ровно те места, где копия 1:1 ЛОМАЕТСЯ. Каждое из них
// стоило живого замера, и каждое отказывает молча — 401 вместо ошибки, «$—» вместо цифры,
// 404 вместо отказа. Проверка без комментария здесь бесполезна: через месяц никто не
// вспомнит, почему UA кабинета не такой, как у соседних вкладок.
//
// Зависимостей нет, читаются только файлы репозитория.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let failures = 0;
let checks = 0;

function check(condition, message) {
  checks += 1;
  if (condition) console.log(`ok ${checks} - ${message}`);
  else {
    failures += 1;
    console.error(`not ok ${checks} - ${message}`);
  }
}

function read(rel) {
  const file = path.join(ROOT, rel);
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) {
    check(false, `${rel} is readable (${error.code || error.message})`);
    return '';
  }
}

function has(text, regex, message) { check(regex.test(text), message); }
function count(text, regex) { return [...text.matchAll(regex)].length; }

// Комментарии вырезаются перед НЕГАТИВНЫМИ утверждениями. 🪤 Это не педантизм: пояснения
// в коде называют сломанный вызов текстом («здесь стояло `access_token`»), и без зачистки
// проверка срабатывает на собственном объяснении, а не на коде. У образца этот приём
// поймал ошибку дважды на разных файлах.
function stripComments(text) { return String(text).replace(/\/\/[^\n]*/g, ''); }

const proxy = read('routing/transparent-proxy.js');
const proxyCode = stripComments(proxy);
const validatorCli = read('tools/proxy-validator/proxy_scraper/find_for_host.py');

// ─────────────────────────── 1. Личность провайдера ───────────────────────────
has(proxy, /rumeng:\s*\{[\s\S]*?label:\s*['"]rumeng['"][\s\S]*?base_url:\s*['"]http:\/\/localhost:20166['"]/,
  'transparent proxy defines rumeng on local port 20166');
has(proxy, /makeKeepaliveHandlers\(Number\(process\.env\.RM_KEEPALIVE_PORT \|\| 20166\)\)/,
  'rumeng keepalive handlers use port 20166');
// 🪤 Спавнер обязан стоять в общем списке: на него завязаны И кнопка «перезапустить» в
// Health, И boot-респавн активного бэкенда. Функция, определённая, но не внесённая сюда,
// не падает — просто активация вкладки поднимала бы мост «успешно» на мёртвом порту.
has(proxy, /\[RM_KEEPALIVE_PORT\]:\s*\{\s*name:\s*'rumeng',\s*spawn:\s*rmKeepaliveSpawn\s*\}/,
  'rumeng keepalive is registered in the shared spawner table (Health restart + boot respawn)');
has(proxyCode, /async function rmKeepaliveSpawn[\s\S]{0,700}?UPSTREAM:\s*RM_UPSTREAM/,
  'the keepalive child gets the gateway upstream, not the panel base');
// 🪤 Порт обязан быть СВОБОДНЫМ: 20155–20165 заняты соседями (20164 WisdomSatan,
// 20165 AIKeysAPI). Совпадение не падает, а тихо уводит запросы на чужой шлюз.
check(!/RM_KEEPALIVE_PORT \|\| 2016[0-5]\b/.test(proxy) && !/RM_KEEPALIVE_PORT \|\| 2015\d\b/.test(proxy),
  'rumeng keepalive port does not collide with the 20155–20165 range already taken');

// ───────────────── 2. ДВЕ БАЗЫ: шлюз /v1, кабинет /api/v1 ─────────────────
//
// Замеры 2026-09-13: `GET /v1/models` → 401 API_KEY_REQUIRED (наш шлюз),
// `GET /api/v1/models` → 404 page not found, `GET /api/v1/settings/public` → 200.
// Склеить их в одну константу — значит получить 404 на каждом пинге и «unknown» у
// живых ключей, то есть вкладку, которая врёт молча.
has(proxy, /const RM_BASE_URL = `https:\/\/\$\{RM_HOST\}\/v1`/,
  'gateway base is /v1 (models and messages live there)');
has(proxy, /const RM_PANEL_API = `https:\/\/\$\{RM_HOST\}\/api\/v1`/,
  'panel base is /api/v1 and is a SEPARATE constant from the gateway base');
check(RegExp('RM_BASE_URL').test(proxy) && !/RM_BASE_URL = `https:\/\/\$\{RM_HOST\}\/api\/v1`/.test(proxy),
  'the gateway base is never set to /api/v1 — that returns 404 page not found');
has(proxy, /const RM_HOST = 'api\.rumeng-ai\.com'/, 'rumeng host is pinned');
has(proxy, /fetch\(`\$\{RM_BASE_URL\}\/models`/, 'the key probe uses the GATEWAY base');
has(proxyCode, /rmPanelApi[\s\S]{0,600}?fetch\(`\$\{RM_PANEL_API\}\$\{pathname\}`/,
  'panel calls go through the PANEL base');

// ─────────────── 3. sub2api-конверт: code сравнивается ЧИСЛОМ ───────────────
//
// На успехе `code` — число 0, на ошибке строка (`UNAUTHORIZED`, `API_KEY_REQUIRED`).
// Тип поля меняется, поэтому `code === 0` на строке не сработает и наоборот.
has(proxyCode, /Number\(env\.code\) === 0/,
  'sub2api envelope success is compared numerically (code flips between number and string)');

// ─────────── 4. JWT привязан к User-Agent — главное отличие от ak ───────────
//
// В токене кабинета есть claim `bnd` (отпечаток клиента), и панель сверяет его на каждом
// запросе. Замер 13.09 одним и тем же токеном на `GET /api/v1/auth/me`:
//     UA аккаунта (Chrome/151…)   → 200 code=0
//     без UA                      → 401 SESSION_BINDING_MISMATCH
//     claude-cli/2.1.158          → 401 SESSION_BINDING_MISMATCH
// Значит CC-заголовки, которыми ходят ВСЕ соседние вкладки, здесь дают 401 на каждой
// ручке кабинета: баланс навсегда «$—», а причина читается как «токен истёк» — и лечится
// перевыпуском токена, который не помогает.
has(proxy, /function rmPanelHeaders\(userAgent\)/,
  'panel requests build their own headers instead of reusing the CC set');
has(proxyCode, /function rmPanelHeaders[\s\S]{0,400}?'User-Agent':\s*String\(userAgent \|\| RM_PANEL_UA_FALLBACK\)/,
  'panel User-Agent comes from the account record, with a browser UA as fallback');
const panelApiBody = (proxy.match(/async function rmPanelApi\([\s\S]*?\n\}/) || [''])[0];
check(panelApiBody.length > 0, 'rmPanelApi() is found');
check(!/RM_CC_HEADERS/.test(stripComments(panelApiBody)),
  'rmPanelApi never sends the claude-cli headers — they trigger SESSION_BINDING_MISMATCH');
has(proxyCode, /SESSION_BINDING_MISMATCH/,
  'the binding failure is recognised and reported as its own cause, not as a generic 401');
// UA обязан доехать до КАЖДОЙ ручки кабинета, включая продление: привязка сверяется и там.
for (const fn of ['rmRefreshTokens', 'rmListKeys', 'rmSubscriptionSummary', 'rmWallet', 'rmTokenAlive']) {
  has(proxyCode, new RegExp(`(async )?function ${fn}\\([^)]*userAgent`),
    `${fn}() accepts the account User-Agent`);
}
has(proxyCode, /rmTokenAlive\(rec\.accessToken, ua\)/, 'the liveness check passes the account UA');
has(proxyCode, /rmListKeys\(t\.token, t\.userAgent\)/, 'the key listing passes the account UA');
has(proxyCode, /rmWallet\(t\.token, t\.userAgent\)/, 'the wallet read passes the account UA');
// 🪤 Шлюз привязки НЕ имеет (замер: `/v1/models` с claude-cli → 200), и CC-заголовки там
// обязаны остаться: это они делают запрос похожим на Claude Code.
has(proxyCode, /async function rmProbe[\s\S]{0,400}?RM_CC_HEADERS/,
  'the gateway probe KEEPS the claude-cli headers — only the panel needs the browser UA');

// ───── 5. Имя ключа в localStorage — auth_token, а не access_token ─────
//
// По проводу ручка отдаёт поле `access_token`, но SPA кладёт значение под именем
// `auth_token` (замер бандла `assets/index-BY5fm1HP.js`: `setItem("auth_token")`).
// Ключа `access_token` в localStorage нет вообще: читая снимок по имени поля из HTTP,
// токен не найдёшь никогда и покажешь «токена нет» на исправном аккаунте.
has(proxy, /const RM_TOKEN_KEY = 'auth_token'/,
  "snapshot token key is 'auth_token' (the HTTP field name access_token is NOT the storage key)");
const snapReader = (proxy.match(/function rmTokensFromSnapshot\([\s\S]*?\n\}/) || [''])[0];
check(snapReader.length > 0, 'rmTokensFromSnapshot() is found');
check(!/['"]access_token['"]/.test(stripComments(snapReader)),
  "the snapshot reader never looks for an 'access_token' localStorage key — it does not exist");

// ───── 6. Живость токена — только запросом, не наличием строки ─────
//
// С мёртвым токеном кабинет держится ~16 секунд, потом 401 и редирект на логин. Правило
// «строка в снимке есть → залогинен» поэтому врёт, и врёт в сторону молчаливого отказа.
has(proxy, /async function rmTokenAlive\([\s\S]{0,300}?rmPanelApi\('\/auth\/me'/,
  'token liveness is proven by GET /auth/me, never by the presence of a stored string');
has(proxyCode, /rmTokenFor[\s\S]{0,900}?rmTokenAlive\(/,
  'the token resolver verifies liveness before handing the token out');

// ───── 7. Срок жизни токена читается в ОБЕИХ формах ─────
//
// Продление здесь пишет готовый штамп `tokenExpiresAt`, а авторег — то, что отдала
// панель: `tokenExpiresIn` (сек) + `tokenIssuedAt` (ISO). Обе формы лежат в живом пуле.
// Читая только первую, мы считали бы свежий суточный токен протухшим и дёргали
// /auth/refresh на каждый чек баланса.
has(proxy, /function rmTokenExpiresAt\(rec\)/, 'token expiry has a dedicated reader');
has(proxyCode, /function rmTokenExpiresAt[\s\S]{0,500}?tokenExpiresIn[\s\S]{0,200}?tokenIssuedAt/,
  'the expiry reader understands the autoreg form (tokenExpiresIn + tokenIssuedAt) too');

// ───── 7a. refresh_token ОДНОРАЗОВЫЙ — чиним входом по паролю ─────
//
// 🔴 Не запасной путь, а основной способ починки на этой панели. Выданный при регистрации
// refresh к моменту первого 401 уже потрачен перехватчиком SPA. Живой замер 13.09 родным
// UA аккаунта:
//     POST /auth/refresh → 401 "invalid refresh token"
//     POST /auth/login   → 200 code=0, новая пара access+refresh, expires_in 86400
// Без этой ветки аккаунт «умирал» через сутки после автореги, хотя пароль лежит в той же
// записи пула, и лечилось бы это ручным заходом в ЛК на каждый аккаунт.
has(proxy, /async function rmLoginWithPassword\(email, password, userAgent\)/,
  'password re-login exists — the single-use refresh token cannot repair a stale session');
has(proxyCode, /rmLoginWithPassword[\s\S]{0,300}?rmPanelApi\('\/auth\/login'/,
  'password re-login posts to /auth/login');
const tokenForBody = (proxy.match(/async function rmTokenFor\([\s\S]*?\n\}/) || [''])[0];
check(tokenForBody.length > 0, 'rmTokenFor() is found');
// Две ветки обязательны: refresh отвергнут И refresh'а не было вовсе (ручные/импортные
// записи). «Хотя бы одна» пропускала бы снятие второй.
check(count(tokenForBody, /rmLoginWithPassword\(/g) >= 2,
  'password re-login covers BOTH a rejected refresh and a record that never had one');
// 🪤 Форму автореги при перезаписи надо СНЯТЬ: иначе rmTokenExpiresAt увидит старый
// tokenIssuedAt раньше нового штампа и вход по паролю повторялся бы на каждый чек.
check(count(tokenForBody, /delete live\.tokenIssuedAt;/g) >= 2,
  'the stale autoreg expiry form is cleared when a fresh token is stored');

// ───── 8. Деньги живут в КОШЕЛЬКЕ, а не в подписке ─────
//
// Движок тот же, что у TrueSOTA, но конфигурация другая. Замер 13.09 на трёх аккаунтах:
//     /subscriptions/summary → {"active_count":0,"subscriptions":[]}   пусто
//     /keys                  → quota: 0, quota_used: 0                 (0 = без лимита)
//     /auth/me               → balance: 1                              ← вот они, деньги
// Слепая копия пути TrueSOTA отдала бы `balance: null` и «нет подписки» на исправном
// аккаунте, то есть «$—» у всех и всегда.
has(proxy, /async function rmWallet\(token, userAgent\)/, 'the wallet reader exists');
has(proxyCode, /async function rmWallet[\s\S]{0,500}?rmPanelApi\('\/auth\/me'/,
  'the wallet is read from /auth/me');
has(proxyCode, /balance:\s*Number\(d\.balance\)/, 'the wallet reader takes the balance field');
has(proxyCode, /rmBalance[\s\S]*?rmWallet\(/,
  'rmBalance falls through to the wallet when there is no key quota and no subscription');
// Порядок источников обязан быть именно таким: квота ключа — потолок, подписка — окно,
// кошелёк — предоплата. Кошелёк ПОСЛЕ подписки, но ДО отказа.
const balBody = (proxy.match(/async function rmBalance\([\s\S]*?\n\}/) || [''])[0];
check(balBody.length > 0, 'rmBalance() is found');
check(balBody.indexOf('rmListKeys') < balBody.indexOf('rmSubscriptionSummary')
  && balBody.indexOf('rmSubscriptionSummary') < balBody.indexOf('rmWallet'),
  'balance sources are ordered key quota → subscription → wallet');
// 🪤 Цифру НЕ выдумываем: «угадать грант», как у New-API, здесь нечем.
check(!/guessGrant/.test(balBody),
  'rmBalance never guesses a grant — there is nothing to extrapolate from on this panel');

// ───── 9. Баланс НЕ копируется с New-API-пути ak ─────
//
// У ak цифра берётся кукой (`/api/user/self` + `New-Api-User`, кванты /500000). У rumeng
// нет ни куки, ни этой ручки: скопированный дословно akBalance дал бы 404 и «прикидку»
// из делённого на 500000 нуля — уверенную неправду в таблице.
check(!/New-Api-User/.test(balBody), 'rmBalance does not send the New API cookie header');
check(!/api\/user\/self/.test(stripComments(balBody)), 'rmBalance does not call the New API self endpoint');
check(!/newapiBalance\(/.test(balBody), 'rmBalance does not fall back to the New API balance helper');
check(!/500000/.test(balBody), 'rmBalance does not use New API quota quanta');

// ───── 10. Авторег: протокол маркеров и его отделение от человеческого лога ─────
has(proxy, /line\.startsWith\('RM_STAGE '\)[\s\S]{0,400}?rmAutoreg\.stage = \{ \.\.\.s,/,
  'RM_STAGE is parsed as protocol, not scraped from prose');
has(proxy, /line\.startsWith\('RM_STAGE '\)[\s\S]{0,500}?continue;\s*\n\s*\}/,
  'RM_STAGE markers are kept out of the human-facing log buffer');
has(proxy, /line\.startsWith\('RM_AUTOADD_RESULT '\)[\s\S]{0,160}?continue;/,
  'RM_AUTOADD_RESULT is kept out of the human-facing log buffer');
// Битый маркер не должен ломать чтение лога — разбор обязан быть в try/catch.
has(proxy, /RM_STAGE '\.length\)\);[\s\S]{0,300}?\} catch \{/,
  'a malformed marker cannot break log reading');
has(proxy, /stage:\s*rmAutoreg\.stage,/, 'the autoreg status endpoint exposes the current stage');
has(proxy, /handleRmAutoregStop[\s\S]{0,700}?taskkill\.exe[\s\S]{0,200}?\/T[\s\S]{0,80}?\/F/,
  'autoreg stop kills the whole process tree');
has(proxy, /rumeng['"], ['"]auto-add\.js['"]/, 'autoreg launches rumeng/auto-add.js');
has(proxy, /body\.useProxy\s*!==\s*false[\s\S]{0,300}?args\.push\('--no-proxy'\)/,
  'the proxy/direct choice is honoured by passing --no-proxy');

// ───── 11. Поиск прокси: прерываемый, с прогрессом, с доливом ─────
has(proxy, /'\/__switch\/api\/rm\/autoreg\/find-proxy\/stop'\) return handleRmFindProxyStop/,
  'proxy search has a stop endpoint');
has(proxy, /if \(req\.method === 'GET'\s*&& req\.url === '\/__switch\/api\/rm\/autoreg\/find-proxy'\)/,
  'proxy search exposes a progress endpoint');
has(proxy, /function handleRmFindProxyStop[\s\S]{0,700}?taskkill\.exe[\s\S]{0,200}?\/T[\s\S]{0,80}?\/F/,
  'stopping the search kills the whole validator tree');
has(proxy, /rmFindProxy\.stopRequested\) \{[\s\S]{0,700}?akCommitPartialProxyLines\([\s\S]{0,200}?rmFindProxy\.found/,
  'a stopped search commits already verified proxies without replacing the live pool');
has(proxyCode, /rmFindProxyLaunch[\s\S]{0,900}?'-u',/,
  'the validator runs unbuffered so progress arrives during the run');
has(proxy, /rmFindProxy\.found\.push\(m\[1\]\)/, 'validator output is parsed for live progress');
has(proxy, /rmFindProxy\.log\.push\(s\)/, 'every validator line is captured before parsing');
has(proxy, /'--out', RM_PROXY_TMP_FILE/, 'the validator writes to a temp file, never over the live pool');

// ───── 12. Пул ДОЛИВАЕТСЯ и общий с ak ─────
//
// 🔴 Замена файла осиротила бы привязки: `forAccount()` на исчезнувший адрес отвечает
// `needsReassign`. И 🪤 пул общий с вкладкой ak — второй список под тот же валидатор
// означал бы двух писателей в один конфиг, затирающих находки друг друга.
has(proxyCode, /function rmMergeProxyLines\(fresh, old, cap = RM_PROXY_CAP\)/,
  'the pool file is merged, not overwritten');
has(proxyCode, /rmMergeProxyLines\(fresh, old\)[\s\S]{0,200}?writeFileSync\(RM_LIVE_PROXY_FILE/,
  'merged lines are what gets written back to the live pool file');
has(proxy, /const RM_LIVE_PROXY_FILE = AK_LIVE_PROXY_FILE/,
  'rumeng shares the single live-proxy pool file with the ak tab');
has(proxyCode, /rmFindProxy\.running \|\| akFindProxy\.running/,
  'the background refill yields to the ak search too — they share one validator and temp file');

// ───── 13. Фоновый долив под длинный прогон ─────
has(proxy, /const RM_REFILL_RESERVE = (\d+)/, 'background refill keeps a reserve ahead of the queue');
check((proxy.match(/const RM_REFILL_RESERVE = (\d+)/) || [, '0'])[1] >= 5,
  'the refill reserve is meaningful (at least 5 live proxies in front of the queue)');
has(proxy, /if \(useProxy\) rmRefillStart\(\);/, 'the refill starts with the run, only in proxy mode');
// Оба места обязательны: страж в тике и крючок на выходе прогона. «Хотя бы одно»
// пропускало снятие второго — поймано саботажем у образца.
check(count(proxy, /rmRefillStop\('прогон завершён'\)/g) === 2,
  'the refill stops when the run ends — both on exit and in the tick guard');
has(proxy, /const done = Number\(\(rmAutoreg\.stage && rmAutoreg\.stage\.i\)/,
  'the refill budget is computed from real run progress, not a guess');

// ───── 14. Маршруты: зеркало ak один в один ─────
const RM_ROUTES = [
  'sessions', 'autoreg/status', 'autoreg/start', 'autoreg/stop', 'autoreg/find-proxy',
  'autoreg/find-proxy/stop', 'refill', 'proxy-lines', 'proxy-pool', 'ping', 'balance',
  'models', 'active-model', 'modelmap', 'add', 'key', 'rename', 'delete', 'activate',
  'set-model', 'set-balance', 'session/open', 'share', 'import',
];
for (const route of RM_ROUTES) {
  check(proxy.includes(`'/__switch/api/rm/${route}'`),
    `route /__switch/api/rm/${route} is registered`);
}
has(proxy, /'\/__switch\/api\/rm\/keepalive\/state'\)\s*return keepaliveRm\.state/,
  'rumeng keepalive state endpoint is routed');
has(proxy, /'\/__switch\/api\/rm\/keepalive\/config'\)\s*return keepaliveRm\.config/,
  'rumeng keepalive config endpoint is routed');

// ───── 15. Пул, профиль и денежный реестр подключены ─────
has(proxy, /const RM_SESSIONS_FILE = path\.join\(__dirname, 'rumeng-sessions\.json'\)/,
  'rumeng sessions file is wired');
has(proxy, /const RM_MODELMAP_FILE = path\.join\(__dirname, 'rumeng-modelmap\.json'\)/,
  'rumeng modelmap is wired');
has(proxy, /'api\.rumeng-ai\.com':\s*path\.join\(__dirname, '\.\.', 'rumeng', 'profiles'\)/,
  'rumeng browser profiles have a directory mapping');
has(proxy, /rm:\s*\{\s*tag:\s*'rumeng',[\s\S]{0,200}?host:\s*'api\.rumeng-ai\.com'[\s\S]{0,200}?balanceFn:\s*rmBalance/,
  'rumeng is registered in the money gateway table with its own balance function');
has(proxy, /const rmLkPids\s*=\s*new Map\(\)/, 'rumeng browser PIDs have a dedicated rmLkPids map');
has(proxy, /\[arLkPids,[\s\S]*?rmLkPids[\s\S]*?\]/,
  'rmLkPids participates in shared browser-process checks');
has(proxy, /rm: 'rumeng'/, 'rm alias resolves to the rumeng backend');
has(proxy, /rumeng: 'rm'/, 'rumeng maps to the rm endpoint prefix');

// ───── 16. Кнопка 🌐 зовёт скрипт сессий согласованной сигнатурой ─────
has(proxy, /'rumeng', 'open-session\.js'\), label, 'console'\]/,
  'session-open launches rumeng/open-session.js <label> console');
has(proxy, /RM_LK_EMAIL:\s*String\(target\.email \|\| ''\),\s*RM_LK_PASS:\s*String\(target\.password \|\| ''\)/,
  'credentials reach the session script only through the child environment');
// 🪤 newapiSyncProfile переносит КУКИ, а у sub2api куки нет вовсе — вход на JWT в
// localStorage. Вызов был бы работой с пустым результатом и ложным «сессия перенесена».
const openBody = (proxy.match(/async function handleRmSessionOpen\([\s\S]*?\n\}/) || [''])[0];
check(openBody.length > 0, 'handleRmSessionOpen() is found');
check(!/newapiSyncProfile\(/.test(stripComments(openBody)),
  'session-open does not sync cookies — sub2api keeps the login in localStorage, not a cookie');

// ───── 17. Секреты не утекают ─────
//
// Известная дыра образца: 404 под /__switch/api/ печатал URL с api_key в теле ошибки.
// Свои ручки этот шаблон не повторяют.
check(!/error:[^\n]*\$\{api_key\}/.test(proxy) && !/error:[^\n]*\$\{apiKey\}/.test(proxy),
  'no handler interpolates an API key into an error message');
const safeBody = (proxy.match(/function rmSafe\([\s\S]*?\n\}/) || [''])[0];
check(safeBody.length > 0, 'rmSafe() is found');
// Пароль И ОБА токена обязаны сниматься: у sub2api JWT — такой же пропуск, как пароль.
for (const secret of ['password', 'accessToken', 'refreshToken']) {
  check(new RegExp(`\\b${secret}\\b`).test(safeBody),
    `rmSafe strips ${secret} before the record leaves the backend`);
}

// ───── 18. У лога поиска есть ИСТОЧНИК: валидатор не глохнет под `--json` ─────
//
// 🔴 Секция 11 выше проходила на мёртвом коде: «validator output is parsed for live
// progress» доказывала лишь наличие парсера в JS, но не то, что источник вообще что-то
// печатает. Замер 13.09: `find_for_host.py` подменял свой логер пустышкой
// (`log=(lambda *_a, **_k: None) if args.json else print`) — а `--json` это ровно тот
// режим, в котором его запускает `rmFindProxyLaunch`. Парсер кормить было нечем: панель
// минутами показывала «ищу…» с пустым логом и нулями в счётчиках. Скрипт общий с вкладкой
// ak, поэтому возврат бага ослепил бы обе вкладки сразу.
check(!/lambda[^\n]*:\s*None/.test(validatorCli),
  'the shared validator never swaps its progress logger for a no-op — that blinded the panel');
has(validatorCli, /file=sys\.stderr[^\n]*\bif args\.json\b|\bif args\.json\b[^\n]*file=sys\.stderr/,
  'under --json the validator sends progress to stderr instead of muting it');
has(validatorCli, /flush=True/,
  'progress lines are flushed, so they arrive during the run and not in one lump at the end');
// 🪤 Обратная сторона той же правки: увести в stderr ВСЁ — значит отобрать у бэкенда итог.
// Результат он берёт из строки, начинающейся с `{`, поэтому машинный JSON обязан остаться
// на stdout. Смотрим построчно: `file=` рядом с json.dumps — уже перекос.
const jsonSummaryLines = validatorCli.split('\n')
  .filter(line => /json\.dumps\(|ensure_ascii=False\)\)/.test(line));
check(jsonSummaryLines.length > 0 && jsonSummaryLines.every(line => !/file=/.test(line)),
  'the machine-readable summary still goes to stdout — that is where the backend reads the result');
// Оба потока обязаны разбираться: прогресс идёт по stderr, итоговый JSON по stdout.
// Снять один листенер — снова ослепить вкладку, и снова молча.
const rmLaunchBody = (proxy.match(/function rmFindProxyLaunch\([\s\S]*?\n\}/) || [''])[0];
check(rmLaunchBody.length > 0, 'rmFindProxyLaunch() is found');
check(/proc\.stdout\.on\('data'/.test(rmLaunchBody) && /proc\.stderr\.on\('data'/.test(rmLaunchBody),
  'the launcher parses BOTH stdout and stderr — progress and the final JSON travel separately');

// ───── 19. Стоп-ручка зовёт ОБЪЯВЛЕННУЮ функцию и не молчит о провале ─────
//
// 🔴 Замер 13.09: `handleRmFindProxyStop` звал сырой `execFile(...)`, которого в модуле
// нет — объявлены только `execFileSync` (стр. 17) и `execFileAsync` (стр. 27).
// ReferenceError падал в соседний `catch { }`, ручка отвечала `{ok: true, stopped: true}`,
// а валидатор продолжал работать. Правильный приём стоял в `handleRmAutoregStop` парой
// сотен строк выше — то есть «кнопка стоп существует» никогда не было тем утверждением,
// которое стоило проверять.
const rmStopBody = (proxy.match(/function handleRmFindProxyStop\([\s\S]*?\n\}/) || [''])[0];
const rmStopCode = stripComments(rmStopBody);
check(rmStopBody.length > 0, 'handleRmFindProxyStop() is found');
has(rmStopCode, /execFileAsync\('taskkill\.exe'/,
  'the search stop kills the validator through execFileAsync — the helper the module actually declares');
check(!/(^|[^A-Za-z])execFile\(/.test(proxyCode),
  'no handler calls a bare execFile() — it is not imported, and the ReferenceError died inside a catch');
has(rmStopCode, /execFileAsync\([\s\S]{0,240}?\.catch\(\([^)]*\)\s*=>\s*logLine\(/,
  'a taskkill that fails to kill is reported through logLine, not swallowed');
check(!/catch\s*(\([^)]*\))?\s*\{\s*(\/\*[\s\S]*?\*\/)?\s*\}/.test(rmStopBody),
  'the stop handler has no swallowing catch — a failed kill must not read as stopped: true');

console.log(`\n${checks - failures}/${checks} assertions passed`);
if (failures > 0) {
  console.error(`FAIL: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('PASS: rumeng integration is wired safely');
process.exit(0);
