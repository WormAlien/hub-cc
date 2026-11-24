# AgentRouter Proxy Pipeline — Handoff

> **Для следующей сессии:** сначала прочитай этот файл целиком, затем живой код. Не делай новый модуль с нуля: половина уже написана. Работай в текущем дереве, без worktree и без commit; рядом пишут другие сессии.

## Цель в десяти строках

1. Архив — проверяльщик, не источник.
2. Добавь три новых списка прокси.
3. Сначала почини врущий проверяльщик.
4. Проверяй прокси прямо на AgentRouter.
5. Плохие и нестабильные сразу выбрасывай.
6. Каждому аккаунту закрепи один прокси.
7. Умер прокси — аккаунт останавливается.
8. Напрямую тайно никогда не ходи.
9. Два отказа — пачка останавливается.
10. Кнопка стоп отменяет всю очередь.

## Почему это делаем

Замер 10.09: седьмой подряд автоподарок получил **пустое тело** от публичной
`GET https://agentrouter.org/api/status`. Авторизация ни при чём — край/WAF режет домашний
IP, с которого идут 20+ аккаунтов. Старый текст врал «шлюз переделал страницу входа».
`open-session.js` уже разводит случаи: код `4` = страница/конфиг OAuth правда изменились,
код `6` = край не ответил вовсе (пусто или не-JSON).

Прокси должны обслуживать:

- точные проверки баланса (`routing/lib/newapi-account.js`);
- видимый Chromium автоподарка (`agentrouter/open-session.js`);
- один и тот же аккаунт всегда через один адрес.

## Источники истины

- Репозиторий: `C:\Users\WormAlien\Desktop\Autoreger_Clean` — **живая копия**.
- Вика: `D:\WORMALIENAIGIGANT\wiki\entities\WisdomSatan.md:283-357`.
- Общий разбор: `D:\WORMALIENAIGIGANT\wiki\abuse-hub\Автоподарок AgentRouter — очередь и GitHub-сессия.md`.
- Архив: `C:\Users\WormAlien\Downloads\AyuGram Desktop\Proxy.rar`.
- Уже распаковано: `C:\Users\WormAlien\AppData\Local\Temp\proxyrar`.

`AppData\Local\Temp\proxyrar` — временная копия. После ремонта не оставляй единственный
исправленный код только там: положи устойчивую рабочую копию в репозиторий, например
`tools/proxy-validator/` (код + README + конфиги, но не гигантские выгрузки прокси).

## Что уже написано — не переписывать

### `routing/lib/proxy-pool.js`

Файл существует, синтаксис проходит. Уже реализовано:

- `parseProxy`, `parseList`, `loadFile`, `schemeFromFilename`;
- HTTP/HTTPS CONNECT и SOCKS4/SOCKS5;
- `fetchVia()` с формой ответа, совместимой с нужной частью Fetch API;
- строгий preflight: только HTTP 200 + непустой JSON, HTML/пусто/не-JSON = отказ;
- `forAccount(key, {host, force, usePreflight})`;
- липкая запись `routing/proxy-assign.json`;
- least-loaded первичное назначение;
- fail-closed: мёртвый/пропавший назначенный прокси не заменяется и не падает на direct;
- `release()` / `reassign()` только для явного решения владельца;
- env-конфиг и `routing/proxy-pool.json`.

Проверить реализацию ревью и тестом, а не переписывать.

### `routing/lib/newapi-account.js`

Частичная интеграция существует:

- `PROXY = require('./proxy-pool.js')`;
- `accountProxy(...)`;
- `apiFetch(..., proxy)` умеет `PROXY.fetchVia()`.

🔴 **Но интеграция сейчас мёртвая:** `accountProxy()` нигде не вызывается, а все вызовы
`apiFetch()` идут без `proxy`. `apiFetchRawAuth()` вообще использует голый `fetch`.

### Пачка и стоп

В `routing/transparent-proxy.js` и `routing/proxy-dashboard.html` уже есть:

- `POST /__switch/api/ar/checkin-all`;
- `POST /__switch/api/ar/checkin-cancel`;
- кнопки `⚡ Забрать у всех (N)` и `⏹ Стоп`;
- состояние `cancelled`;
- автопредохранитель после двух последовательных кодов `4/5/6`.

Не дублировать. Добавить тест `tools/check-checkin-batch.js`, которого ещё нет.

### Скорость автоподарка

`agentrouter/open-session.js` уже ускорен:

- `GH_BTN_WAIT_MS = 8000`;
- `GH_POPUP_WAIT_MS = 6000`;
- `CONSOLE_GATE_MS = 8000`;
- `BASELINE_SELF_MS = 3000`;
- `consoleGate()` рано видит `/login`;
- `watchOauthState()` прекращает ожидание попапа по доказанному отказу;
- лог прогона имеет префиксы `[+N.Ns]`.

Регресс `tools/check-checkin-speed.js` зелёный. Не возвращать старые 15–20 секунд.

## Решение по `Proxy.rar`

Это **валидатор**, не надёжный источник. Прошлый экспорт дал ноль живых; 15 342 строки
оказались 170 IP, 92,3% — одна `/24`. Однако владелец принёс три новых источника, их
нужно добавить и проверить, а не отвергать заранее:

```text
https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/all/data.txt
https://raw.githubusercontent.com/proxmint/free-proxy-list/main/proxies/all.txt
https://raw.githubusercontent.com/dinoz0rg/proxy-list/main/checked_proxies/http.txt
```

На 10.09 URL доступны: примерно 2000 + 1200 + 3000 строк. Метка `checked` в имени
источника ничего не доказывает.

## План выполнения

### 1. Скопировать валидатор в репозиторий

**Файлы:**

- Source: `C:\Users\WormAlien\AppData\Local\Temp\proxyrar`
- Create: `tools/proxy-validator/`
- Не копировать в git: `export/**`, большие runtime-выгрузки, секреты.

Добавить `.gitignore` внутри инструмента для `export/`, `*.tmp`, `__pycache__/`.
Сохранить исходный `README.md`, затем обновить команды под AgentRouter.

### 2. Добавить три источника

**Modify:** `tools/proxy-validator/config/proxy_services.json`

Добавить три записи. Для mixed-list источников (`proxifly/all`, `proxmint/all`) парсер обязан
сохранять схему из каждой строки (`http://`, `https://`, `socks4://`, `socks5://`), а не
навязывать одну схему записи источника. Dinoz0rg — голые `ip:port`, явно `HTTP`.

Перед добавлением проверить дубли: в текущем конфиге уже есть отдельные Proxifly по
протоколам и Dinoz0rg SOCKS4. Новый URL считается дублем только при совпадении URL.

### 3. Починить загрузку целей

**Modify:**

- `tools/proxy-validator/config/domain_targets.json`
- `tools/proxy-validator/proxy_scraper/domain_mode.py`
- Test: `tools/proxy-validator/tests/test_agentrouter_validation.py`

Сейчас файл начинается байтами `d0 b9` перед `[`. `utf-8-sig` их не лечит; JSON падает,
а `load_targets()` молча подставляет дефолт. Исправить файл и убрать опасный fallback:
битый пользовательский JSON должен завершать режим ошибкой с путём и причиной, а не
проверять другие сайты.

Цель:

```json
[
  {
    "name": "agentrouter_status",
    "url": "https://agentrouter.org/api/status",
    "enabled": true,
    "response": "newapi_status"
  }
]
```

### 4. Починить критерий успешности

**Modify:** `tools/proxy-validator/proxy_scraper/domain_checker.py`

Сейчас `_is_success_status()` считает 403/404/429 успехом. Для `newapi_status` требуется:

1. HTTP `200`;
2. тело непустое;
3. тело — JSON object;
4. не HTML/WAF;
5. `success !== false`;
6. есть `data` object.

Проверить тестами: `200 JSON` PASS; `200 empty`, `200 HTML`, `403`, `404`, `429`, broken JSON,
`{"success":false}` — FAIL.

`_recv_text()` должен вернуть не только status-line, но и тело ответа. Если текущий socket
reader обрезает/не декодирует chunked transfer, починить его или добавить узкий HTTP body
parser. Не принимать статус без проверки body.

### 5. Поддержать hostname

**Modify:** `tools/proxy-validator/proxy_scraper/proxy_io.py` и модели/туннели при необходимости.

Сейчас парсер принимает только IPv4 literal; купленный `gate.provider.com:7000` исчезает
молча. Разрешить DNS hostname по RFC-практическому шаблону: ASCII labels, `-` не на краях,
общая длина ≤253; IPv4 оставить. Невалидные строки должны попасть в счётчик `bad`, не direct.

Тесты: IPv4, hostname, hostname+auth, IPv6 только если текущий формат модели уже поддерживает;
не расширять scope ради IPv6, если нет.

### 6. Трёхкратная стабильность и `/24`

**Create/Modify:** в валидаторе отдельный узкий AgentRouter pipeline.

Требования:

- три успешных прогона на `agentrouter.org/api/status`;
- интервал 20–30 секунд между прогонами;
- один и тот же proxy URI должен пройти все три;
- финальный файл атомарно: `export/agentrouter/stable.txt`;
- отчёт JSON: проходы, latency p50/p95, failures, source URL, ASN/гео не требуются;
- максимум **2 адреса на IPv4 `/24`** в финальном пуле, сначала меньшая медианная latency;
- hostname не резать по `/24`; оставить максимум 1 запись на hostname:port;
- Ctrl+C сохраняет текущий отчёт, но файл `stable.txt` формируется только из трёх проходов.

Не гонять тысячи адресов с домашнего IP без ограничителя. Сначала cap 500 уникальных,
workers 40, timeout 8 секунд. Увеличивать только если ноль результатов и после проверки
самого валидатора локальным mock.

### 7. Закрыть интеграцию точного баланса

**Modify:**

- `routing/lib/newapi-account.js`
- `routing/transparent-proxy.js`
- Test: `tools/check-proxy-pool.js`

Добавить `accountId = null` в контракт `accountSelfInner/accountSelf`, вызвать один раз:

```js
const px = await accountProxy({ host, profileDir, accountId, force });
if (!px.ok) return { ok: false, error: px.error, proxyError: true };
const proxy = px.proxy;
```

Передать `proxy` во **все** сетевые операции одного accountSelf:

- `statusMeta/GET /api/status`;
- refresh JWT;
- `/api/user/self`;
- classic raw auth (`apiFetchRawAuth` надо перевести на общий `apiFetch` либо добавить proxy);
- повтор после cookie userId.

Важно: сейчас `statusMeta(host)` кешируется только по host. Если запросы стали per-account
proxy, кеш результата допустим (метаданные одинаковы), но сам первый запрос не должен
случайно назначать `host:agentrouter.org` вместо account id. Назначение прокси делается ДО
statusMeta, по accountId.

В `newapiBalance()` передать `target.id` в `lib.accountSelf({ accountId: target.id, ... })`.
Проверить все прочие вызовы `accountSelf`: `accountId` опционален, путь без конфига прокси
остаётся прежним.

🪤 Usage `/dashboard/billing/usage` в `newapiBalance()` сейчас идёт прямым `fetch` в
`transparent-proxy.js`, мимо `newapi-account.js`. Если для AgentRouter включён прокси, этот
запрос тоже должен идти через **тот же назначенный proxy**, иначе один аккаунт светится двумя
IP в рамках одного чека. Лучший узкий путь: экспортировать из `newapi-account.js` обёртку
`accountFetch({host, accountId, profileDir, url, options, force})`, которая резолвит sticky
proxy один раз и fail-closed; использовать её и для usage, и для self. Не экспортировать
внутренности `accountProxy` без контракта.

### 8. Подключить тот же прокси к подарку

**Modify:**

- `routing/transparent-proxy.js`
- `agentrouter/open-session.js`
- Test: extend `tools/check-proxy-pool.js` or create `tools/check-checkin-proxy.js`

Прокси выбирает родитель до spawn по `target.id` и `agentrouter.org`. Если назначение не
готово/прокси мёртв — job получает `state:error`, браузер не запускается, direct запрещён.

Передать в child без секрета в командной строке: временный JSON seed-файл в ignored runtime
каталоге либо env (`AR_PROXY_JSON`) — но env виден процессам владельца. Предпочтительно
ignored файл `routing/runtime/ar-proxy/<label>.json`, атомарная запись, child читает и удаляет
после parse; пользовательские файлы не удалять намертво, но этот runtime-файл создаёт текущая
сессия и он пересоздаваемый, прямое удаление допустимо.

Playwright:

```js
const launch = {
  headless: false,
  viewport: null,
  args: [...],
  ...(proxy ? { proxy: {
    server: `${proxy.scheme}://${proxy.hostname}:${proxy.port}`,
    username: proxy.user || undefined,
    password: proxy.pass || undefined,
  }} : {}),
};
await chromium.launchPersistentContext(profileDir, launch);
```

🪤 Playwright может не принимать `socks4://` и auth на SOCKS. Проверить локальным launch-
smoke до обещаний; неподдержанное сочетание fail-closed с понятной ошибкой. Не менять прокси
автоматически.

После запуска весь Chromium (AgentRouter + GitHub OAuth popup) идёт через один sticky proxy.
Это и есть требование: не только `/api/status`, а весь подарок с одного IP.

### 9. Согласовать со стопом пачки

**Modify:** `routing/transparent-proxy.js`

Уже существующий fuse считает коды 4/5/6. Добавить proxy failures как отдельную причину:

- один assigned proxy dead → остановить только этот job, не весь пул;
- два последовательных proxy/WAF failure на разных assigned proxies → остановить batch;
- `checkin-cancel` очищает queued jobs; текущий по умолчанию доигрывает, чтобы не оставить
  аккаунт разлогиненным;
- `killRunning:true` остаётся явным аварийным действием.

UI должен показать `proxy label` без credentials и конкретный аккаунт.

### 10. Регрессы

**Create:**

- `tools/check-proxy-pool.js`;
- `tools/check-checkin-proxy.js`;
- `tools/check-checkin-batch.js` (отсутствует, хотя реализация batch уже лежит).

Минимальная матрица:

1. parse URL/голого host:port/auth/hostname;
2. mixed protocols сохраняются;
3. stable id не зависит от порядка списка;
4. account A повторно получает proxy X;
5. account B получает least-loaded Y;
6. proxy X пропал/умер → A FAIL, не Y и не direct;
7. пул выключен → direct как раньше;
8. config есть, module broken/empty → FAIL;
9. preflight: 200 JSON PASS, empty/HTML/403/404/429 FAIL;
10. параллельные назначения не теряются (сейчас `writeAssign` делает read-modify-write без
    межпроцессного lock; тест обязан решить, достаточно ли одного процесса или нужна атомарная
    очередь записей);
11. `newapiBalance` передаёт `target.id`;
12. usage и self получают один proxy id;
13. Playwright launch получает proxy, креды не попадают в лог/status;
14. cancel: очередь из трёх → все `cancelled`, ничего не стартовало;
15. два WAF/proxy отказа → batch fuse.

Запуск финальной проверки:

```bash
node --check routing/lib/proxy-pool.js
node --check routing/lib/newapi-account.js
node --check agentrouter/open-session.js
node --check routing/transparent-proxy.js
node tools/check-proxy-pool.js
node tools/check-checkin-proxy.js
node tools/check-checkin-batch.js
node tools/check-checkin-speed.js
node tools/check-checkin-queue.js
node tools/check-ar-gh-fallback.js
node tools/check-checkin-balance.js
```

После статических тестов — локальный mock proxy/target. Только затем живой preflight на 5
кандидатах. Не запускай сразу 6000 прокси против AgentRouter.

## Включение

До валидного `stable.txt` конфиг **не создавать**: отсутствие `routing/proxy-pool.json` =
старое direct-поведение. Когда есть минимум 5 стабильных и достаточно разных адресов:

```json
{
  "enabled": true,
  "file": "C:/Users/WormAlien/Desktop/Autoreger_Clean/tools/proxy-validator/export/agentrouter/stable.txt",
  "hosts": ["agentrouter.org"],
  "preflightTtlMs": 600000
}
```

`routing/proxy-pool.json`, `routing/proxy-assign.json`, `routing/runtime/` добавить в
`.gitignore`; креды/список не коммитить.

Если стабильных меньше 5, **не включать**. Оставить ускоренные таймауты, batch fuse и stop.

## Границы и безопасность сессий

- Никаких сырых проб `github.com` с фейковым UA — так уже погасили три сессии.
- Не менять назначенный proxy автоматически.
- Не делать fallback direct при настроенном прокси.
- Не логировать user/pass.
- Не считать бесплатный список «живым» по имени репозитория.
- Не доверять `checked_in` из OAuth callback без подтверждения балансом.
- Не перезапускать `:8200` без владельца — рвёт front-door текущей Claude-сессии.
- Не `git checkout`, не `stash`, не массовая перезапись грязных файлов.

## Готовность

Готово только когда:

- валидатор самотестом доказывает строгий критерий;
- есть `stable.txt` после трёх проходов;
- минимум 5 адресов и не больше 2 на `/24`;
- один аккаунт дважды получает один proxy;
- usage, self, браузер и GitHub popup одного аккаунта идут через него;
- мёртвый proxy не вызывает direct/reassign;
- кнопка Stop и batch fuse проверены;
- живой одинарный подарок забран;
- только после этого запускать пачку максимум 3 аккаунта, затем весь пул.

## Wiki bookkeeping

Обновить после факта, не заранее:

- `wiki/entities/WisdomSatan.md` — валидатор и реальный результат трёх новых источников;
- `wiki/abuse-hub/Автоподарок AgentRouter — очередь и GitHub-сессия.md` — data flow и замер;
- `wiki/meta/Known Issues.md` — снять только реально принятые проблемы;
- `wiki/log.md` — wip по шагам → done;
- `wiki/abuse-hub/hub-tasks.md` — закрыть с доказательством или переписать под остаток.

Найденное и не сделанное — новой короткой строкой с датой и `#inbox`, без эссе.
