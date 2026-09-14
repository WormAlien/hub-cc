# Пробелы спеки `tools/gateways.spec.json` против шести пошлюзовых регрессов

Аудит только на чтение. Вопрос: что шесть существующих чекеров проверяют, а спека
(93 точки) выразить не может. Ищем **пропущенные точки** (реестры, роуты, функции,
константы, инварианты), а не различия формулировок.

Прочитано: `tools/gateways.spec.json`, `tools/add-gateway.js`,
`tools/check-kktoken.js`, `tools/check-justwoker.js`, `tools/check-seekai.js`,
`tools/check-hcnsec.js`, `tools/check-aikeysapi-safe.js`, `tools/check-rumeng-safe.js`.

Обозначения в колонке «какой чекер»: **KK** = check-kktoken, **JW** = check-justwoker,
**SK** = check-seekai, **HN** = check-hcnsec, **AK** = check-aikeysapi-safe,
**RM** = check-rumeng-safe. «все» = все шесть; «все NewAPI» = KK/JW/SK/HN/AK
(у RM нет ни одного из этих утверждений).

---

## 0. Дыры в самом `add-gateway.js` (до всякой спеки)

### `must-not` объявлен в `_readme`, но не реализован — и молча инвертирован

`_readme` спеки объявляет пять `kind`: `must`, `must-not`, `absent`, `file`, `must-any`.
В `checkPoint()` реализованы только `must-not-count`, `file` и хвост (он же `must`).
Ветки `must-not` нет: точка с `kind: "must-not"` проваливается в хвост и проверяется как
**`must`** — то есть чекер потребует, чтобы запрещённая строка **присутствовала**.
Это не «не поддержано», это инверсия смысла на ровном месте. Сейчас таких точек в спеке
нет, но ловушка заряжена: `_readme` прямо велит так писать.
Живая спека использует `must-not-count` (точка 1.35) — в `_readme` этого имени нет вообще.

### Нет зачистки комментариев перед негативными утверждениями

AK и RM явно вырезают `//…` перед каждым негативным ассертом (`stripComments`) — и это
оплачено дважды: пояснение к правке называет сломанный вызов текстом («здесь стояло
`loadAkSessions()`»), и без зачистки проверка срабатывает на собственном объяснении.
Спека этого не умеет вообще: `must-not`/`absent`-точка покраснеет на комментарии, который
её же и объясняет.

### `must-any` прощает новому шлюзу старую форму

Точка 1.1b (`%P%_KEEPALIVE_PORT`) принимает **любую** из двух форм. Но у HN/AK/RM чекеры
требуют именно env-форму (`Number(process.env.X_KEEPALIVE_PORT || N)`) — потому что от неё
зависят спавн, Health и `keepalive-restart.ps1`. Спека молча разрешает новому шлюзу
завести константу по-старому, и это ровно тот промах, который чекеры ловят.

### `within` ищет маркер по всему файлу

`withinMarker()` сканирует все строки, а не вхождения внутри логического блока.
Если маркер (`const pools = [`) встретится в файле ещё раз, окно возьмётся от чужого
места и проверка может зазеленеть не там.

### Спека знает ровно одну базу URL, а их бывает две

`%HOST%` подставляется литералом. У RM баз **две** и обе собраны из константы:
`RM_BASE_URL = \`https://${RM_HOST}/v1\`` и `RM_PANEL_API = \`https://${RM_HOST}/api/v1\``.
Точка 1.1c ожидает `const %P%_BASE_URL = 'https://%HOST%/v1'` — на живом коде RM она
**покраснеет на исправном шлюзе**. То есть спека сегодня не надмножество, а местами
ложный негатив.

---

## 1. Пропущенные точки

### A. Константы шлюза и адреса (все — `routing/transparent-proxy.js`)

| Пропущенная точка | Какой чекер её ловит | В каком файле живёт | Предлагаемая запись в спеку |
|---|---|---|---|
| `const %P%_UPSTREAM = 'https://%HOST%'` — корень БЕЗ `/v1` | KK §1, JW §1, SK §1, HN §1, AK §1 | backend | `{"id":"1.1d","kind":"must","expect":"const %P%_UPSTREAM = 'https://%HOST%'","note":"корень без /v1: POST /v1/v1/messages → 404, а POST /messages отдаёт 200 с HTML"}` |
| `%P%_UPSTREAM` НЕ кончается на `/v1` | HN §1 (два независимых утверждения о хвосте) | backend | `{"id":"1.1e","kind":"must-not","expect":"const %P%_UPSTREAM = 'https://%HOST%/v1'"}` + добавить в спеку kind `ends-with` |
| `%P%_BASE_URL` кончается на `/v1` | HN §1, KK/JW/SK §1 (`eq`) | backend | `{"kind":"ends-with","expect":"/v1'"}` на `1.1c` |
| `const %P%_HOST = '<домен>'` отдельной константой | RM §2 | backend | `{"kind":"must","expect":"const %P%_HOST = '%HOST%'"}` |
| `%P%_BASE_URL` собран ИЗ константы хоста (шаблонная строка), а не литерал | RM §2 | backend | `{"kind":"must-match","regex":"const %P%_BASE_URL = `https://\\$\\{%P%_HOST\\}/v1`"}` — **1.1c сегодня ложный негатив на RM** |
| Вторая база — кабинет: `const %P%_PANEL_API = \`https://${%P%_HOST}/api/v1\`` | RM §2 | backend | `{"kind":"must","expect":"const %P%_PANEL_API"}` + note «кабинет и шлюз — РАЗНЫЕ базы, склеить = 404 на каждом пинге» |
| Ни одна панельная ручка не ходит в шлюзовую базу, и наоборот | RM §2 (`rmPanelApi` → panel, `rmProbe` → gateway) | backend | `{"kind":"must","expect":"fetch(`${%P%_PANEL_API}${pathname}`"}` |
| `%P%_ACTIVE_KEY_FILE` / `%P%_ACTIVE_MODEL_FILE` / `%P%_MODELMAP_FILE` / `%P%_SESSIONS_DIR` / `%P%_SHARE_SCRIPT` / `%P%_KEEPALIVE_URL` | равномощность `GO_*` ⊆ `KK_*`/`JW_*`/`SK_*`/`HN_*` | backend | шесть точек `{"kind":"must","expect":"const %P%_<ИМЯ>"}` — сейчас в спеке 3 из 9 |
| `%P%_KEEPALIVE_URL` собирается ИЗ `%P%_KEEPALIVE_PORT`, а не хардкодит число | KK/JW/SK/HN §1 | backend | `{"kind":"must-match","regex":"const %P%_KEEPALIVE_URL = `[^`]*\\$\\{%P%_KEEPALIVE_PORT\\}"}` |
| `%P%_KEEPALIVE_PORT` в env-ФОРМЕ обязателен (не «любая из двух») | HN §1, AK §3, RM §1 | backend | заменить `must-any` 1.1b на два варианта: для новых шлюзов — `{"kind":"must","expect":"const %P%_KEEPALIVE_PORT = Number(process.env.%P%_KEEPALIVE_PORT || %PORT%)"}` |
| Порт не попадает в уже занятый диапазон | RM §1 (`!/RM_KEEPALIVE_PORT \|\| 2016[0-5]/`) | backend | `{"kind":"global-unique","domain":"keepalive-port"}` (см. §4) |
| Требование возраста GitHub-аккаунта (365 дней) | JW §6 | `%FOLDER%/open-session.js` | `{"kind":"must","expect":"365"}` + note «иначе отказ сайта читается как баг скрипта» |

### B. Хендлеры, хелперы, роуты (`routing/transparent-proxy.js`)

| Пропущенная точка | Какой чекер её ловит | В каком файле живёт | Предлагаемая запись в спеку |
|---|---|---|---|
| Множество `handle%x%*` == множество `handleGo*` | KK §2, JW §2, SK §2, HN §2 | backend | `{"kind":"parity","with":"go","pattern":"function handleGo([A-Za-z0-9]+)\\(","expect":"handle%x%$1"}` — спека перечисляет 21 хендлер списком и не заметит 22-й |
| Множество хелперов `%p%*` == множество `go*` | те же §2 | backend | тот же `parity` |
| Множество роутов `/__switch/api/%p%/*` == `/__switch/api/go/*` | KK §3, JW §3, SK §3, HN §3 | backend | `parity` по домену `routes`, обе стороны |
| Список законных исключений из парности роутов (JW_ONLY, GH_LESS_ROUTES, OL_ONLY_ROUTES, сопоставление профилей) | JW §3, HN §3 | backend | `"exceptions": [...]` у точки парности + **отдельная точка, что каждое исключение существует** (опечатка в списке иначе просто выключает проверку) |
| `handle%x%AutoregStart` / `handle%x%AutoregStop` (с `taskkill /T /F`) | AK §2, RM §10 | backend | две точки `must` + `{"expect":"taskkill.exe","within":"handle%x%AutoregStop"}` |
| Роуты авторега: `autoreg/start`, `autoreg/stop`, `autoreg/status`, `autoreg/find-proxy`, `autoreg/find-proxy/stop`, `refill`, `proxy-lines`, `proxy-pool` | AK §10/§17/§21, RM §14 | backend | восемь точек `{"kind":"must","expect":"'/__switch/api/%p%/autoreg/start'"}` — семейство ручек, которого спека не знает вовсе |
| `handle%x%SetOutlook` / `handle%x%AddOutlook` + их роуты | HN §3 | backend | четыре точки; плюс note «у go пары нет: там аккаунт на GitHub, здесь на почте» |
| Занятость ящиков считает общий `olMarkTag`/`olUsageMap`, а не вторая копия | HN §3 | backend | `{"kind":"must","expect":"olMarkTag"}` — инвариант «не дублировать логику», спекой не выражается |
| `handle%x%ProxyPool` берёт `lib.describe()`, а не подсчёт строк файла | AK §10 | backend | `must` на `lib.describe()` + note «подсчёт строк завышает пул: неразбираемые записи уходят в `bad`» |
| `enabledForHost('%HOST%')` в ручке пула прокси | AK §10 | backend | `must` |
| `handle%x%FindProxyStop` через `execFileAsync('taskkill.exe')` | AK §23, RM §19 | backend | `must` + запрет сырого `execFile(` (см. §4, «объявленный символ») |
| `const %p%LkPids = new Map()` и участие в общем списке `[arLkPids, … %p%LkPids …]` | AK §3, RM §15 | backend | 1.11 знает только объявление; вторая точка — вхождение в массив браузерных PID-карт |
| `%p%Safe()` снимает `password`, `accessToken`, `refreshToken` | RM §17 | backend | три точки `must` в теле `%p%Safe` — спека не знает про гигиену секретов вообще |
| API-ключ не интерполируется в текст ошибки | RM §17 | backend | `{"kind":"must-not","regex":"error:[^\\n]*\\$\\{api_?[kK]ey\\}"}` |

### C. Серверные реестры (`routing/transparent-proxy.js`)

| Пропущенная точка | Какой чекер её ловит | В каком файле живёт | Предлагаемая запись в спеку |
|---|---|---|---|
| `BACKENDS.%full%.base_url = 'http://localhost:%PORT%'` | все, §«реестры» | backend | `{"kind":"must","expect":"base_url: 'http://localhost:%PORT%'","in-block":"BACKENDS"}` — 1.8a знает только `%full%: {` и `label:` |
| `NEWAPI_PROFILE_DIRS` — значение (папка `%p%', 'profiles'`), не только ключ-хост | все, §«реестры» | backend | дополнить 1.8g: `{"expect":"%p%', 'profiles'"}` |
| `keepaliveInstances[%P%_KEEPALIVE_PORT].spawn: %p%KeepaliveSpawn` | все, §«реестры» | backend | дополнить 1.8i полем `spawn: %p%KeepaliveSpawn` |
| `MONEY_GW.%p%.host = '%HOST%'` | все, §«реестры» | backend | дополнить 1.8h полем `host: '%HOST%'` |
| `MONEY_GW.%p%.keyFile / load / save` | все, §«реестры» | backend | `{"kind":"must","expect":["keyFile: %P%_ACTIVE_KEY_FILE","load: %p%Load","save: %p%Save"]}` |
| `MONEY_GW.%p%.applyFn: %p%ApplyBalance` | все, §«реестры» | backend | дополнить 1.8h (сейчас только `balanceFn`) — без `applyFn` ротация не запишет остаток |
| Health-список: `name: 'Keepalive %NAME%'` на нужном порту | все, §«реестры» | backend | `{"id":"1.8k","kind":"must","expect":"name: 'Keepalive %NAME%'"}` — точки нет вообще, а забытая строка = кнопка «перезапустить» не знает про шлюз |
| `pools.%full% =` — сводка шапки | все NewAPI, §«реестры» | backend | `{"kind":"must","expect":"pools.%full% ="}` |
| `ghLkPidsByTag`: `%p%: %p%LkPids` | KK §4, SK §4 | backend | `{"kind":"must","expect":"%p: %p%LkPids"}` — **другое место, чем 1.8j**: там `pools` внутри `newapiLkBusy`, здесь карта тегов |
| `GH_POOL_*` НЕ содержат лишнего ключа шлюза без GitHub-входа | HN §9 (четыре негативных ассерта) | backend | `{"kind":"must-not","expect":"hn:","in-block":"GH_POOL_LOADERS"}` — иначе менеджер гитхабов покажет пул, которого нет |
| `ghLkPidsByTag` без лишнего ключа | HN §9 | backend | `must-not` в блоке `return { github: ghLkPids… }` |
| Роуты авторотации принимают тег (`|%p%`) | KK §4, SK §4, HN §4 | backend | `{"kind":"must-match","regex":"\\((?:[a-z]{2}\\|)*%p%(?:\\|[a-z]{2})*\\)"}` — **в исходнике это regexp-литерал с экранированными слешами**, поиск «чистого» пути не находит ничего |

### D. Внешняя обвязка (файлы вокруг двух главных)

| Пропущенная точка | Какой чекер её ловит | В каком файле живёт | Предлагаемая запись в спеку |
|---|---|---|---|
| `FLAT_RATE_HOSTS`: `%HOST%` НЕ в списке у шлюза с токенным тарифом | HN §9 | `routing/keepalive-proxy.js` | `{"kind":"must-not","expect":"'%HOST%'"}` с `when:["!flatRate"]`. Сейчас точка 3.2 просто становится `absent` при `flatRate:false` — шлюз, случайно попавший в список, спекой не ловится |
| `ALLOW_PAID_HEDGE: '1'` в теле `%p%KeepaliveSpawn` | JW §4 | backend | `{"kind":"must","expect":"ALLOW_PAID_HEDGE: '1'"}` — осознанно разрешённый платный дубль |
| `lifecycle.js`: `respawn: false` у шлюза с респавном по требованию | AK §3 | `routing/lifecycle.js` | дополнить 3.3 полем `respawn` (значение берётся из конфига шлюза) |
| `keepalive-restart.ps1`: `UPSTREAM = 'https://%HOST%'` (БЕЗ `/v1`) | HN §6 | `routing/keepalive-restart.ps1` | 3.4 проверяет только `%PORT% = @{ UPSTREAM` — добавить три поля внутри блока |
| `keepalive-restart.ps1`: `%full%-active-key.txt` | HN §6 | restart | `{"kind":"must","expect":"%full%-active-key.txt"}` |
| `keepalive-restart.ps1`: `MODELMAP_FILE = %full%-modelmap.json` | HN §6 | restart | `{"kind":"must","expect":"%full%-modelmap.json"}` — иначе поднятый руками прокси игнорит тир-карту |
| `HOST_AUTH`: `'%HOST%': 'classic'\|'jwt'` — **значение**, не только ключ | HN §6, AK §4 | `routing/lib/newapi-account.js` | 3.7 знает только `'%HOST%':`; добавить значение (промах по схеме молчаливый: ищется кука `session`, которой у jwt-сборки нет) |
| `hub-balance POOLS`: `{ id, file, name }` целиком | HN §6, AK §4 | `internal/hub-balance.js` | 3.8 знает только `id: '%p%'`; добавить `file: '%full%-sessions.json'` и `name: '%NAME%'` |
| Вотчдог: `{ backend: '%full%', port: %PORT% }` есть / **её нет** у легаси-шлюза | KK §7b, HN §6 / SK §7b | `routing/pool-watchdog.js` | **файла нет в `spec.files`** — завести alias + точки `must` и `must-not` (тревога о шлюзе, которым не пользуются, учит игнорировать вотчдог) |
| Статуслайн, 8 точек: ключ→target, `localhost:%PORT%`, `127.0.0.1:%PORT%`, **порядок ВЫШЕ catch-all `Custom`**, хост→target, target→provider, шкала (кеш + ключ + ручка `%p%/balance`), присутствие в общем списке провайдеров | HN §6 (девять ассертов) | `routing/statusline-autoreger.sh` | **файла нет в `spec.files` вообще**. Плюс нужен новый kind `order-of-lines` (порт обязан стоять выше catch-all, иначе шлюз рисуется как `Custom🧪`) |
| `.gitignore`: `%full%/profiles/`, `%full%/sessions/`, `%full%/gh-sessions/` | все, §`.gitignore` | `.gitignore` | три точки `must` — 3.11 покрывает только `%full%-sessions.json` |
| `.gitignore`: `routing/%full%-sessions.json` с префиксом `routing/` | все | `.gitignore` | 3.11 проверяет подстроку без префикса — запись в корне репо прошла бы |
| `ref-codes`: шлюз в `ACTIVE_PROVIDERS` (живой) / НЕ в нём (легаси) | KK §7b, SK §7b, HN §9 | `routing/lib/ref-codes.js` | `ACTIVE_PROVIDERS = PROVIDERS.filter(p => !SHAPES[p].legacy)` — **нужен per-gateway флаг `legacy`** и точка на его отсутствие/наличие |
| `ref-codes`: шлюз в `PROVIDERS` всегда | KK §7b, SK §7b, HN §9 | ref-codes.js | `must` — резолв рефки нужен `open-session.js` даже у легаси |
| `ref-codes.url('%full%')` без переопределения = ожидаемая строка с непустым `aff` | все (runtime `require` + сравнение) | `routing/lib/ref-codes.js` + `ref-codes.default.json` | статикой не выражается — нужен kind `value-eq` с запуском модуля (см. §3) |
| `ref-codes.SHAPES.%full%.host` и `.path` | HN §9 (`'/sign-up?aff='`, `'api.hcnsec.cn'`) | ref-codes.js | 3.5 знает только `%full%:` в SHAPES; добавить два поля |

### E. Фронтенд (`routing/proxy-dashboard.html`)

| Пропущенная точка | Какой чекер её ловит | В каком файле живёт | Предлагаемая запись в спеку |
|---|---|---|---|
| `COLORS: %full%:` | все, §«вкладка» | frontend | `{"id":"2.3b","kind":"must","expect":"%full%:"}` в блоке `COLORS` — в спеке есть LABELS, COLORS нет вовсе |
| `state.loaded: %full%: false` | все | frontend | отдельная точка; 2.12 (`%full%: []`) — совсем другой объект |
| `state.%full% = []` — список аккаунтов вкладки | HN §5 | frontend | `must` с точной формой строки (2.12 матчит подстроку `%full%: []`, форма иная) |
| `NEWAPI_RERENDER: %p: () => render%x%()` | KK §5, SK §5, HN §5 | frontend | `must` — иначе фильтр и сортировка вкладку не перерисуют |
| Общий цикл по вкладкам-пулам включает `'%full%'` | все | frontend | `{"kind":"must-match","regex":"for \\(const p of \\[[^\\]]*'%full%'"}` |
| `function load%x%Sessions(` | все | frontend | `must` |
| `function load%x%SessionsLight(` | все | frontend | `must` — самый пропускаемый лоадер, он же нужен `NAV_COUNT_JOBS` |
| `function render%x%(` | все | frontend | `must` (2.13 знает только `render%x%Gauge`) |
| Ни один `%p%-*` id не дублируется | все | frontend | **нужен `unique-ids`** — `getElementById` возьмёт первый, и половина вкладки молча перестанет обновляться |
| На каждый `go-*` id есть `%p%-*` **и нет лишних** | все (у HN — в обе стороны с исключениями) | frontend | **`parity` по домену `ids`**, с `exceptions` |
| Кнопка НЕ в группе «Чтим память» (живой шлюз) / лежит в ней (легаси) | KK §5, HN §5 / SK §5 | frontend | **`in-region` / `not-in-region`** по `data-extra-nav="memory"` — вернуть вкладку в живые обязано быть осознанной правкой |
| В JS-блоке шлюза нет вызовов чужих функций | KK §5, SK §5, HN §5 | frontend | **`not-in-region`** с границами `// ═══ <TAG>` … следующий `// ═══ ` — ровно этот баг 24.08 уцелел в шести местах без единой ошибки в консоли |
| В РАЗМЕТКЕ вкладки нет чужих id (`go-`, `kk-`, `jw-`…) | HN §5 | frontend | вторая `not-in-region`, по границам `<!-- ═════════ TAB: <TAG>` |
| `data-tab="%full%"` и `data-tab-content="%full%"` — **ровно один раз** | AK §5 (`count(...) === 1`) | frontend | 2.1/2.2 используют `includes` — дубль кнопки или панели пройдёт |
| Панель вкладки ровно одна, и в ней нет GitHub/Outlook-обвязки | AK §5/§6 | frontend | `must-not` в регионе панели |
| `NAV_COUNT_JOBS`: запись есть и зовёт `load%x%SessionsLight` | KK §5, SK §5, HN §5 | frontend | **`js-literal`** — литерал вырезается и разбирается, а не матчится построчно; построчный регексп уже дважды зеленел вхолостую |
| Согласованность четырёх точек сопоставления профилей: роут ∧ хендлер ∧ функция фронта ∧ кнопка тулбара — всё или ничего | HN §9 | frontend + backend | **`all-or-none`** на группу точек; половина = 404 по клику |
| `const AK_MODELS = [...]` — белый список моделей вкладки | AK §6 | frontend | `must` + данные (см. тир-карту) |
| `id="%p%-add-gh-hint"` отсутствует у шлюза без GitHub-входа | HN §9 | frontend | `must-not` |
| GH-реестры фронта (`GH_USE_META`, `ghAddPick`, `NEWAPI_SEED_PROV`) без лишнего ключа | HN §9 | frontend | три `must-not` |
| `id="%p%-autoreg-log"` и `id="%p%-autoreg-stage"`; прогон рендерится (`d.stdout`/`out.join`) | AK §9 | frontend | три `must` |
| Дашборд шлёт выбор прокси: `body: JSON.stringify({ count, useProxy })` | AK §6 | frontend | `must` (и обратная сторона — `args.push('--no-proxy')` в backend) |
| Бейдж пула прокси + янтарная подсветка при нехватке | AK §10 | frontend | две точки `must` |

### F. Скрипты шлюза (`%FOLDER%/…`)

| Пропущенная точка | Какой чекер её ловит | В каком файле живёт | Предлагаемая запись в спеку |
|---|---|---|---|
| `REGISTER_URL = require('../routing/lib/ref-codes.js').url('%full%')` | все, §«open-session» | `%FOLDER%/open-session.js` | `must` — 3.10 проверяет только существование файла |
| Литеральной реф-ссылки в скрипте больше нет | HN §9 | open-session.js | `must-not` |
| `CONSOLE_URL` и `ROOT_URL` на `%HOST%` | KK §6, JW §6, SK §6 | open-session.js | две точки `must` |
| `poolFile` указывает на `%full%-sessions.json` | KK §6, JW §6, SK §6 | open-session.js | `must` — иначе ручной GitHub-вход осядет в чужом пуле |
| Свои `PROFILES_DIR` / `SESSIONS_DIR` | HN §6b | open-session.js | две `must` |
| `localStorage.getItem('aff')` — проверка, что реф-код осел | HN §6b/§9 | open-session.js | `must` — одного захода по реф-ссылке не хватает |
| Креды ТОЛЬКО из env (`%P%_LK_EMAIL` / `%P%_LK_PASS`), НИКОГДА из argv | AK §8, RM §16 | open-session.js | `must` + `{"kind":"must-not","regex":"process\\.argv\\s*\\[\\s*[2-9]\\s*\\][^\\n]*(EMAIL|PASS)"}` |
| `headless: false`, `viewport: null`, `--window-size=WxH`, `bringToFront()`, `raiseBrowserWindow()` | AK §8 | open-session.js | пять `must` — «окно настоящего браузера» это пять отдельных свойств, а не одно |
| `MAIL_HOSTS` — в профиль подкладываются только почтовые куки | HN §6b | open-session.js | `must` |
| `openMailTab` объявлен И вызван; вторая вкладка открывается при любом состоянии снимка | HN §6b | open-session.js | две `must` + `must-not` на «выйти, если снимка нет» — первая версия давала одну вкладку вместо двух |
| Живые селекторы формы Microsoft | HN §6b | open-session.js | `must` |
| Контракт env: `HN_OL_EMAIL` / `HN_OL_SNAPSHOT` / `HN_OL_PASS` в скрипте ⟷ те же ключи в backend | HN §6b | open-session.js + backend | **две стороны одной точки** — спека умеет только одну сторону |
| `%FOLDER%/share-session.js` существует | все | файловая система | `{"kind":"file","expect":""}` |
| auto-add: маркер `%P%_STAGE `, полная последовательность `STAGES`, отмечена каждая ступень, есть терминальная `done` | AK §9 | `%FOLDER%/auto-add.js` | четыре `must` — индикатор не должен залипать и не должен выводиться из русской прозы лога |
| auto-add: `poolAppend([rec])` ПОСЛЕ `if (res.ok)` и ДО `await sleep(GAP_MS)` | AK §2 | auto-add.js | **`order`** — «каждый успешный аккаунт записан до старта следующего» |
| auto-add: `!written = poolAppend(created)` — запрет отложенной записи на конец батча | AK §2 | auto-add.js | `must-not` |
| auto-add: `MAIL_PROVIDERS` — guerrillamail НЕ первый, порядок instanttempemail → mail.tm → guerrillamail | AK §12 | auto-add.js | **`order`** + `must-not` — мёртвый провайдер в голове списка оплачивается КАЖДЫМ аккаунтом (25 с из 48) |
| auto-add: `acquireProxyFor` ждёт на сухом пуле, перечитывает пул в цикле (2 места), ступень `wait_proxy` | AK §20 | auto-add.js | три точки; «хотя бы одно место» недостаточно — без второго ожидание крутится по устаревшему снимку |
| refresh-sessions: `snapshotHasSpaUser` + пересборка снимка без SPA-логина | AK §14 | `%FOLDER%/refresh-sessions.js` | две `must` |
| Валидатор прокси: логер не подменяется пустышкой; прогресс в stderr под `--json`; `flush=True`; итоговый JSON остаётся на stdout | AK §22, RM §18 | `tools/proxy-validator/proxy_scraper/find_for_host.py` | пять точек, включая `must-not` на `lambda …: None` и tail-проверку. **Скрипт общий у AK и RM — возврат бага ослепил бы обе вкладки сразу** |
| `%p%RefillStop('прогон завершён')` — ровно ДВА вызова | AK §19, RM §13 | backend | `must-not-count` с `max:2`+`expectMin:2` — «хотя бы один» пропускало снятие второго, поймано саботажем |
| `%p%MergeProxyLines` + запись слитого в живой файл + валидатор пишет в temp | AK §19, RM §12 | backend | три `must` — замена файла осиротила бы привязки аккаунтов |
| `%P%_LIVE_PROXY_FILE = AK_LIVE_PROXY_FILE` — общий пул с вкладкой ak | RM §12 | backend | **`identical`** — тождество двух констант разных шлюзов |
| `%p%FindProxy.running \|\| akFindProxy.running` — взаимное исключение | RM §12 | backend | `must` — один валидатор и один temp-файл на двоих |
| `%P%_REFILL_RESERVE` ≥ 5, `AK_FIND_FLOOR` ≥ 10 | AK §18, RM §13 | backend / frontend | **`min-value`** — спека не сравнивает числа |

### G. Тир-карта

| Пропущенная точка | Какой чекер её ловит | В каком файле живёт | Предлагаемая запись в спеку |
|---|---|---|---|
| Три тира (`opus`/`sonnet`/`haiku`) непусты | KK §7b, HN §7 | `routing/%full%-modelmap.json` | **`json-tiers`** — 3.9 это `existsSync`, то есть пустой тир проходит |
| Значение тира ∈ белый список годных моделей каталога | KK §7b, HN §7, AK §6 | modelmap | `json-tiers` + поле `catalog: [...]` в конфиге шлюза |
| Значение тира ∉ чёрный список негодных | HN §7 (восемь моделей с причинами) | modelmap | `json-tiers` + `banned: { "DeepSeek-V4-Pro": "подменяет модель при наличии tools", … }` |
| В имени модели нет `opus`/`sonnet`/`haiku` | HN §7 | modelmap | `must-not` с regex — `TIER_RE` в keepalive определяет тир по этим словам, эхо-подмена закольцевала бы резолв |
| Тир-карту правит дашборд, а не файл: роут `%p%/modelmap` существует | HN §7 | backend | 1.9f покрывает роут, но не смысл — добавить `note` |
| `AK_MODELS` во фронте ⊆ тот же белый список | AK §6 | frontend | вторая сторона той же точки |

### H. Коллизии, уникальность, гигиена (межшлюзовые)

| Пропущенная точка | Какой чекер её ловит | В каком файле живёт | Предлагаемая запись в спеку |
|---|---|---|---|
| Порт keepalive уникален среди ВСЕХ шлюзов | все, §«коллизии» | backend | **`global-unique`, домен `keepalive-port`** |
| На порт смотрит ровно один backend | все | backend | `count == 1` по всему файлу |
| Тег `%p%` нигде не подцеплен к чужим `Load`/`Save`/`Balance` | все | backend | **`no-foreign-fn`** — тег, ведущий к чужой функции, читался бы как «шлюз работает, но ключи чужие» |
| Правка HN не задела HelpCoder: `HC_BASE_URL` прежний, ни одна `HC_*` не упоминает `hcnsec` | HN §8 | backend | **`cross-prefix`** — два шлюза различаются одной буквой |
| Каждое ослабление обязано быть проверено НА ОТСУТСТВИЕ | HN §9 (24 ассерта) | backend + frontend | **мета-инвариант**: точка «ослаблено» без парной `must-not` — это дырка, через которую «дополнить копию до GoRouter» никто не остановит |
| Отсутствие выдачи: `%P%_GRANT_STEP`, `%P%_DEFAULT_GRANT` | HN §9 | backend | две `must-not` с флагом `grant: false` |
| Цифру баланса не выдумывать: `guessGrant` в `%p%Balance` | RM §8 | backend | `must-not` в теле функции |

### I. Контракты между файлами (протоколы, env, потоки вывода)

| Пропущенная точка | Какой чекер её ловит | В каком файле живёт | Предлагаемая запись в спеку |
|---|---|---|---|
| Маркеры `%P%_STAGE ` НЕ попадают в человеческий лог (`continue;` внутри ветки разбора) | AK §9, RM §10 | backend | **`not-in-region`** — иначе одна шумная строка на каждую ступень в панели владельца |
| Маркер разбирается тем же приёмом, что `%P%_AUTOADD_RESULT` | AK §9 | backend | `must` на `line.startsWith('%P%_STAGE ')` + присвоение `stage = { ...s,` |
| Битый маркер не ломает чтение лога (разбор в try/catch) | RM §10 | backend | `must` |
| Статус-ручка отдаёт `stage:` | AK §9, RM §10 | backend | `must` |
| Лончер разбирает `proc.stdout` И `proc.stderr` | AK §22, RM §18 | backend | две `must` — прогресс и итоговый JSON едут разными потоками, снятие одного листенера снова ослепляет панель |
| sub2api-конверт: `Number(env.code) === 0` — `code` меняет тип между числом и строкой | RM §3 | backend | `must` — `code === 0` на строке не сработает |
| Кабинет: `%p%PanelHeaders(userAgent)` строит СВОИ заголовки | RM §4 | backend | `must` |
| UA доезжает до КАЖДОЙ панельной ручки: `%p%RefreshTokens`, `%p%ListKeys`, `%p%SubscriptionSummary`, `%p%Wallet`, `%p%TokenAlive` принимают `userAgent` | RM §4 | backend | **`signature`** — на каждой функции из списка обязан быть параметр |
| Вызовы передают UA: `rmTokenAlive(rec.accessToken, ua)`, `rmListKeys(t.token, t.userAgent)`, `rmWallet(t.token, t.userAgent)` | RM §4 | backend | **`call-site`** — параметр объявлен, но не передан, — тот же 401 |
| `%p%PanelApi` НЕ шлёт CC-заголовки, `%p%Probe` их СОХРАНЯЕТ | RM §4 | backend | пара `must-not` + `must` — шлюз привязки не имеет, кабинет имеет |
| `SESSION_BINDING_MISMATCH` распознаётся как отдельная причина, а не общий 401 | RM §4 | backend | `must` |
| Ключ в localStorage — `auth_token`; читатель снимка НЕ ищет `access_token` | RM §5 | backend | `must` + `must-not` (и оба — на тексте без комментариев) |
| Живость токена доказывается запросом `GET /auth/me`, не наличием строки | RM §6 | backend | две `must` |
| Срок жизни читается в ОБЕИХ формах (`tokenExpiresIn` + `tokenIssuedAt`) | RM §7 | backend | `must` внутри `%p%TokenExpiresAt` |
| `%p%LoginWithPassword` — ≥2 вызова; `delete live.tokenIssuedAt;` — ≥2 | RM §7a | backend | две точки с `expectMin:2` — refresh одноразовый, а форма автореги обязана сниматься |
| `%p%Balance`: порядок источников квота → подписка → кошелёк | RM §8 | backend | **`order`** — кошелёк после подписки, но до отказа |
| `%p%Balance` без `New-Api-User`, `api/user/self`, `newapiBalance(`, `500000` | RM §9 | backend | четыре `must-not` в теле функции |
| `%p%Wallet` читает `/auth/me`, `balance: Number(d.balance)` | RM §8 | backend | две `must` |
| `handle%x%SessionOpen` НЕ зовёт `newapiSyncProfile(` | RM §16 | backend | `must-not` в теле функции — у sub2api логин в localStorage, куки нет |
| argv-контракт запуска скрипта: `'%full%', 'open-session.js'), label, 'console']` | RM §16 | backend | `must` |
| Ни один хендлер не зовёт сырой `execFile(` — только объявленные `execFileAsync`/`execFileSync` | AK §23, RM §19 | backend | **`declared-symbol`** — ReferenceError died inside a catch, ручка отвечала `stopped: true` на живом валидаторе |
| Стоп-хендлер: `execFileAsync(...).catch(... logLine(` и НЕТ глотающего `catch {}` | AK §23, RM §19 | backend | две точки — «упавший taskkill обязан быть слышен» |
| `handle%x%AutoregStatus()` зовёт `load%x%SessionsLight(` и НЕ зовёт `load%x%Sessions(` | AK §11 | frontend | `in-function` positive + negative — замыкание цикла давало двадцать рендеров в секунду и клики по отцепленным узлам |

---

## 2. Нужен новый `kind`

Сгруппировано по тому, что именно требуется выразить. В скобках — сколько пропущенных
точек закрывает каждый вид.

### 2.1. Регион файла (≈15 точек)

| kind | Что делает | Кто без него не выражается |
|---|---|---|
| `in-region` / `not-in-region` | ожидание/запрет внутри ЛОГИЧЕСКОГО блока, границы которого заданы маркерами (регион есть: `data-extra-nav="memory"`, `// ═══ <TAG>` … следующий `// ═══ `, `<!-- ══ TAB: <TAG>`, тело функции `function X(` … `\n}`) | «кнопка НЕ в „Чтим память“», «в JS-блоке шлюза нет чужих имён», «в разметке вкладки нет чужих id», «маркеры не попадают в человеческий лог», «панель без GitHub/Outlook» |
| `in-block` | то же, но для реестра `const X = {` … `\n};` | `BACKENDS.%full%.base_url`, «GH_POOL_* без лишнего ключа», `MONEY_GW` |
| `in-function` | то же для тела функции | порядок источников баланса, запрет `newapiSyncProfile(`, запрет `loadAkSessions(` |

Сегодняшний `within` — слабая аппроксимация: он ищет маркер по всему файлу и берёт
скользящее окно в 6 строк, то есть не знает ни начала, ни конца блока.

### 2.2. Отсутствие, а не присутствие (≈10 точек)

`must-not` — **объявлен в `_readme`, не реализован, молча инвертирован** (см. §0).
Сверх реализации нужны его варианты: `must-not-regex` (запрет формы, а не строки) и
`must-not-count` с обязательным `max` (сегодня `max` необязателен — точка без `max`
вырождается в «не больше бесконечности» и всегда зелёная).

### 2.3. Порядок и относительное расположение (≈6 точек)

| kind | Что выражает | Кто просит |
|---|---|---|
| `order` | `A` стоит раньше `B` по индексу в тексте региона | `poolAppend` между `if (res.ok)` и `sleep(GAP_MS)`; квота → подписка → кошелёк; `instanttempemail` → `mail.tm` → `guerrillamail` |
| `order-of-lines` | строка с `%PORT%` стоит ВЫШЕ catch-all-шаблона | статуслайн: иначе шлюз рисуется как `Custom🧪` |
| `before` | вызываемая функция определена раньше точки вызова | косвенно — `declared-symbol` |

### 2.4. Значения, а не подстроки (≈12 точек)

| kind | Что выражает | Кто просит |
|---|---|---|
| `value-eq` | точное значение константы/поля, полученное **запуском** модуля | `ref-codes.url('%full%')` = ожидаемая ссылка; `HOST_AUTH` = `classic`/`jwt` |
| `ends-with` / `starts-with` | утверждение о хвосте/начале значения | `UPSTREAM` не кончается на `/v1`; `BASE_URL` кончается на `/v1` |
| `must-match` | регулярное выражение вместо подстроки | роуты авторотации как regexp-литерал; `KEEPALIVE_URL` из порта |
| `min-value` | числовое `>=` у константы | `REFILL_RESERVE >= 5`, `AK_FIND_FLOOR >= 10` |
| `identical` | две константы в разных шлюзах равны | `RM_LIVE_PROXY_FILE = AK_LIVE_PROXY_FILE` |
| `json-tiers` | JSON-файл: три тира непусты, значения ∈ `catalog`, ∉ `banned`, не матчат regex | вся секция «тир-карта» (KK/HN/AK) |

### 2.5. Уникальность и счёт (≈6 точек)

| kind | Что выражает | Кто просит |
|---|---|---|
| `unique-ids` | ни один `id="%p%-*"` не повторяется | все шесть чекеров, `getElementById` берёт первый |
| `count-eq` | ровно N вхождений | `data-tab="%full%"` ровно один раз; на порт ровно один backend; `RefillStop(...)` ровно два раза |
| `global-unique` | значение уникально СРЕДИ ВСЕХ шлюзов | порт keepalive не пересекается ни с кем |
| `no-foreign-fn` | тег не ведёт к чужим `Load`/`Save`/`Balance` | все шесть |
| `cross-prefix` | правка шлюза `hn` не задела шлюз `hc` | HN §8 |
| `signature` / `call-site` | у каждой функции из списка есть параметр; в вызовах он передан | UA кабинета (RM §4) |
| `declared-symbol` | вызывается только то, что модуль объявил (`execFileAsync`, не `execFile`) | AK §23, RM §19 |
| `all-or-none` | группа точек либо вся, либо никакая (роут ∧ хендлер ∧ функция ∧ кнопка) | сопоставление профилей у HN |
| `js-literal` | вырезать литерал и РАЗОБРАТЬ его, а не матчить строкой | `NAV_COUNT_JOBS` — построчный регексп уже дважды зеленел вхолостую |

### 2.6. Гигиена источника (≈8 точек)

| kind | Что выражает | Кто просит |
|---|---|---|
| `strip-comments` | флаг у точки: негативные утверждения выполняются на тексте без `//…` | AK и RM делают это везде; без флага `must-not` сработает на собственном объяснении |
| `exceptions` | список законных исключений у парности/запрета + отдельная точка «каждое исключение существует» | JW_ONLY, GH_LESS_*, OL_ONLY_ROUTES, HN_ONLY_IDS |
| `count-pairs` | «оба места обязательны» (страж в тике И крючок на выходе) | `RefillStop` — снятие одного из двух уже было поймано саботажем |
| `after-negative` | утверждение «правка не оставила хвоста»: парная точка существует ⟺ негативная точка существует | HN §9 целиком (24 ассерта) |

---

## 3. Структурные проверки (сравнение множеств против эталона `go`)

Это отдельный класс и главная ценность шести чекеров. Все они построены на одном:
**взять множество у эталонного шлюза `go` (динамически, парсером по файлу) и сравнить
с множеством у проверяемого**. Такая проверка переживает переименования и ловит то,
чего ни в какой спецификации не было. Спека не умеет этого вообще — она перечисляет
конкретные строки, поэтому 22-й хендлер или 19-й роут пройдут мимо.

| Что сравнивается с эталоном | Где | В каком файле | Направление |
|---|---|---|---|
| Константы: `GO_([A-Z0-9_]+)` → `%P%_$1` | KK §1, JW §1, SK §1, HN §1 (с исключениями `GRANT_LESS`) | backend | односторонне (новых у шлюза быть не мешает) |
| Хендлеры: `handleGo([A-Za-z0-9]+)` → `handle%x%$1` | KK/JW/SK/HN §2 (у HN — минус `GH_LESS_HANDLERS`) | backend | односторонне |
| Хелперы: `go([A-Za-z0-9]+)` → `%p%$1` | KK/JW/SK/HN §2 | backend | односторонне |
| Функции фронта: `(render\|load)?Go…` → `…Hn…` | HN §5 (у go их 28, порог `>= 25` — «парсер жив») | frontend | односторонне, минус `GH_LESS_FRONT` |
| Роуты: `/__switch/api/go/([a-z0-9/_-]+)` → `%p%/$1` | KK §3, JW §3, SK §3, HN §3 | backend | **в обе стороны** + список исключений |
| id разметки: `id="go-([a-z0-9-]+)"` → `id="%p%-$1"` | KK §5, JW §5, SK §5, HN §5 | frontend | у KK/JW/SK односторонне, **у HN в обе стороны** (лишний id = скопированный чужой узел) |
| Порт: `([A-Z]{2})_KEEPALIVE_PORT` — множество всех значений | все, §«коллизии» | backend | **на уникальность, глобально** |
| Теги реестров: `\b%p%: …` не должен вести к чужим `Load`/`Save`/`Balance` | все, §«коллизии» | backend | негативная, по всем реестрам сразу |

Три вещи, которые делают эти проверки честными и которые спека обязана унаследовать:

1. **Роуты берутся только со строк диспетчера** (фильтр `line.includes('req.url')`):
   те же адреса стоят в комментариях над обработчиками, и без фильтра комментарий
   сошёл бы за реализованный роут.
2. **Есть положительный якорь «парсер жив»** (`go.size >= 20`, `goFront.size >= 25`,
   `goIds.size > 0`). Без него чекер, переставший что-либо находить, зеленеет сам —
   в этом репо такой промах ловили дважды, оба раза это записано в комментариях.
3. **Исключения проверяются на существование** (`check([...JW_ONLY].every(r => jw.has(r)))`):
   опечатка в списке исключений иначе просто отключила бы проверку.

---

## 4. Сводка

* **Найдено 138 пропущенных точек** против 93 в спеке (таблицы разделов A–I).
  Спека покрывает только «New-API-образную» вкладку и только в одном файле из пяти:
  она ничего не знает про авторег, прокси-пул, статуслайн, вотчдог, HOST_AUTH-значение,
  hub-balance-поля, тир-карту как данные и содержимое `open-session.js`.
* **Два файла вообще не заведены в `spec.files`**: `routing/pool-watchdog.js` и
  `routing/statusline-autoreger.sh`. Второй — девять ассертов только у HN.
* **`must-not` не работает**: объявлен в `_readme`, не реализован, проверяется как `must`.
  Это надо чинить первым — иначе первая же негативная точка будет утверждать
  противоположное.
* **Спека сегодня не надмножество**: точка 1.1c (`const %P%_BASE_URL = 'https://%HOST%/v1'`)
  покраснеет на живом RM, где база собрана шаблонной строкой из `RM_HOST`, а баз две.
* **Самый ценный непереносимый класс — парность с `go`.** Пока её нет, спека ловит
  «забыл конкретную строку, о которой мы вспомнили», но не ловит «сделал 27 функций
  фронта из 28». Второе — это ровно тот вид недокопии, при котором вкладка открывается
  и выглядит целой.
* **Второй по ценности — «ослабление обязано быть проверено на отсутствие»** (HN §9,
  24 ассерта). Без парных негативных точек исключение из парности превращается в дырку,
  через которую «дополнить копию до GoRouter» никто не остановит.

