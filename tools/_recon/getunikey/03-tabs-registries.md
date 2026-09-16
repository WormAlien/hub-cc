# getunikey (prefix-кандидат `uk`) — обязательные реестры вкладки

Разведка 2026-09-15. Живой репозиторий: `C:\Users\WormAlien\Desktop\Autoreger_Clean`.
Канон (только чтение): `D:\WORMALIENAIGIGANT\wiki\abuse-hub\ADDING-A-GATEWAY.md` §3,
`add-gateway — заведение вкладки шлюза (инструмент).md`.

Домен этого разведчика: **обязательные реестры вкладки** —
`DEFAULT_TABS_VISIBLE`, `NAV_COUNT_JOBS`, `ref-codes.default.json` (+ связанные:
`ref-codes.js` SHAPES, флаг `ref` в конфиге шлюза, кейс aikeysapi).

Код не пишем. В репозитории не меняем ничего, кроме этого файла отчёта.

## План

- [x] 1. `DEFAULT_TABS_VISIBLE` — файл:строка, формат, запись kktoken, что вписать для getunikey, грабля «кнопка в DOM есть, а вкладки нет» из вики
- [x] 2. `NAV_COUNT_JOBS` — файл:строка, формат, нужна ли запись
- [x] 3. `ref-codes.default.json` — путь, схема, записи, где читается; правило «ключ = полное имя»
- [x] 4. Флаг `ref: true|false` — что включает; кейс aikeysapi (код снимали)
- [x] 5. Полный список реестров по §3 канона с пометкой «есть/нет у getunikey» и «что вписать»

Итог: все 5 пунктов закрыты. Ни один из 11 реестров §3 у getunikey не заведён.

---

## Пункт 1. DEFAULT_TABS_VISIBLE

**ФАКТ.** Живёт в `routing/proxy-dashboard.html:28195` (одна строка-массив). Формат — массив
строк `data-tab` (полное имя вкладки), в порядке сайдбара:

```js
const DEFAULT_TABS_VISIBLE = ['fin', 'league', 'github', 'outlook', 'agentrouter', 'gorouter', 'justwoker', 'kktoken', 'aipm', 'hcnsec', 'aikeysapi', 'rumeng', 'tabi', 'custom', 'media', 'plugins', 'health', 'models', 'routes', 'settings'];
```

- Запись эталона: `'kktoken'` стоит 8-м, сразу после `'justwoker'`. **Идентификатор — полное
  имя вкладки** (= значение `data-tab` кнопки), НЕ префикс `kk`. Префикс в этом массиве не
  встречается ни разу.
- Это **whitelist**: `effectiveHiddenSet()` (строка ~28225) добавляет в hidden всё, чего нет
  в массиве. Значит для getunikey вписать `'getunikey'` в массив (полное имя, не `uk`).
- Массив читается ещё в 3 местах того же файла: `loadTabsConfig` (28204, 28211 — дефолт
  свежей установки), `applyTabsOrder` (28253–28263 — вставка новой вкладки на дефолтную
  позицию). Отдельно править их не надо: они ходят по массиву.
- 🪤 **Массив продублирован в `tools/check-hub.js`** — правится **только парой** (канон:
  `wiki/log.md:5329`). Проверить `grep -n 'DEFAULT_TABS_VISIBLE' tools/check-hub.js`.

**ГРАБЛЯ «кнопка в DOM есть, а вкладки нет» — цитаты вики:**

1. `D:\WORMALIENAIGIGANT\wiki\entities\ABUSE HUB.md:121-122`:
   > 🪤 **Новая вкладка обязана попасть в `DEFAULT_TABS_VISIBLE`.** Без этого кнопка есть в DOM,
   > но получает `hidden`: первая проверка упёрлась в Playwright `element is not visible`.

2. `D:\WORMALIENAIGIGANT\wiki\entities\ABUSE HUB.md:2217-2219`:
   > **`DEFAULT_TABS_VISIBLE` — whitelist, а не blacklist.** Новая вкладка, не попавшая в
   > список, по умолчанию **скрыта** — рядом в коде это прямо написано. Кнопка в сайдбаре есть,
   > панель есть, а вкладки не видно.

3. Первоисточник - `D:\WORMALIENAIGIGANT\wiki\log.md:4678` (вкладка MEDIA, 10.09):
   > 🪤 **Точка шва, которую едва не забыл: белый список `DEFAULT_TABS_VISIBLE`.** Без него
   > кнопка есть в DOM, но с классом `hidden` и нажать на неё физически нельзя. Поймано живой
   > проверкой — Playwright упёрся в «element is not visible», а глазами разметка кнопки
   > выглядела правильной

**КАК ПРОВЕРЕНО.** `Grep DEFAULT_TABS_VISIBLE routing/proxy-dashboard.html` (4 хита: 28195,
28204, 28211, 28225/28253/28263) + `Grep` по вики. `getunikey`/`uk` в репо отсутствуют (см. п.3),
значит записи нет — вписать надо.

## Пункт 2. NAV_COUNT_JOBS

**ФАКТ.** Живёт в `routing/proxy-dashboard.html:28581` — массив объектов, длиной 25+ записей.
Формат: `{ tab: '<полное имя>', fn: () => load<Xx>SessionsLight(), mark: '<имя>'? }`.

- `tab` — **полное имя вкладки** (как в `DEFAULT_TABS_VISIBLE`).
- `fn` — «дешёвый» загрузчик-счётчик для сайдбара (локальный JSON, без `?probe=1`/`?balance=1`).
- `mark` — опционален: если есть, `navCountPick` (28694) пропускает задание, когда
  `showTab` уже отработал полным загрузчиком (флаг `state.loaded[mark]`).
- Запись эталона: `{ tab: 'kktoken',     fn: () => loadKkSessionsLight() },` (строка 28587,
  после `truesota`). **Без `mark`.** Лоадер — `loadKkSessionsLight`, форма `loadXxSessionsLight`
  (грабля из канона §2.10, подтверждена).

**НУЖНА ЛИ ЗАПИСЬ ДЛЯ GETUNIKEY — да, если у вкладки будет счётчик в сайдбаре.** Само
отсутствие записи не ломает вкладку (счётчик просто останется `—`), но это полуработа:
цифра сессий в сайдбаре не появится. Условие: вкладке нужен свой `loadUkSessionsLight()`.

**КАК ПРОВЕРЕНО.** `Grep NAV_COUNT_JOBS routing/proxy-dashboard.html` → объявление 28581,
потребитель 28697 (`navCountPick`). `getunikey` в файле отсутствует.

🪤 Побочно: `xpeach` есть в `NAV_COUNT_JOBS` (28593), но **убран** из `DEFAULT_TABS_VISIBLE`
(перенесён в «Чтим память») — два массива живут независимо, и это нормально.

## Пункт 3. ref-codes.default.json

**ФАКТ. Полный путь:** `C:\Users\WormAlien\Desktop\Autoreger_Clean\routing\ref-codes.default.json`
(в корне `routing/`, НЕ в `routing/lib/`). Найден в коде так: `routing/lib/ref-codes.js:21-23`
(`DIR = path.join(__dirname, '..')` → `routing/`).

**СХЕМА.** Плоский JSON-объект; первый ключ `_` — комментарий для человека (не читается:
`defaults()` гоняет только по `PROVIDERS`). Ключ = **полное имя шлюза**, значение = сам реф-код.
Значение чистится регуляркой `CODE_RE = /^[A-Za-z0-9_-]{2,32}$/` (ref-codes.js:95): не прошло —
эквивалентно «пусто», то есть «взять дефолт».

**СПИСОК ЗАПИСЕЙ НА 15.09 (10 штук):**

```json
"agentrouter": "oUm3",   "gorouter": "dzj0",  "hcnsec": "u4eN",
"justwoker": "IFYf",     "kktoken": "Sog2",   "seekai": "prEx",
"tabi": "cUG3",          "xpeach": "0lre",    "aipm": "NS3L",
"wisdomsatan": "DWWi"
```

**ГДЕ ЧИТАЕТСЯ В КОДЕ:**

| Место | Что делает |
|---|---|
| `routing/lib/ref-codes.js:101-106` `defaults()` | читает файл, гоняя по `PROVIDERS` |
| `routing/transparent-proxy.js:23159` `GET /__switch/api/settings/ref-codes` | `for (const p of rc.PROVIDERS) urls[p] = rc.url(p)` — строка настройки в UI |
| `routing/transparent-proxy.js:23181` `POST` тот же путь | запись в `routing/ref-codes.json` (пользовательский, в .gitignore) |
| `routing/proxy-dashboard.html:5386-5404` | блок «Реф-коды» в «Настройках» (`#ref-codes-box`, `#ref-codes-rows`) |
| `<провайдер>/open-session.js` | `require("../routing/lib/ref-codes.js").url("<full>")` → `REGISTER_URL` |
| `<провайдер>/auto-add.js:129` | `.code('<full>')` → `aff_code` в теле регистрации |

**🔴 ГЛАВНОЕ ПРАВИЛО КАНОНА ПОДТВЕРЖДЕНО, И ОНО СТРОЖЕ, ЧЕМ В ПРОЗЕ.** Ключ — **полное имя**
(`getunikey`), не префикс (`uk`) — в файле все 10 ключей полные (`kktoken`, не `kk`). Но проза
§3.5 недоговаривает второй половины:

> `defaults()` (ref-codes.js:104) гоняет **не по ключам JSON, а по `PROVIDERS = Object.keys(SHAPES)`**.

Значит запись в `ref-codes.default.json` **без записи в `SHAPES` (`routing/lib/ref-codes.js:25`)
не читается вообще** — и наоборот, запись в `SHAPES` без кода в JSON даёт `null` (шлюз в UI есть,
ссылка — корень сайта). **Файлы правятся парой:** `routing/lib/ref-codes.js` (точка 3.5 канона)
+ `routing/ref-codes.default.json` (точка 3.6). Одной записи мало.

Второе следствие: `PROVIDERS` питает **список в UI** — шлюз без `SHAPES` не появится в
«Настройках» ни строкой.

**ЧТО ВПИСАТЬ ДЛЯ GETUNIKEY** (по образцу, значение — из HANDOFF, не проверено мной):
- `routing/lib/ref-codes.js` → `SHAPES`:
  `getunikey: { host: 'www.getunikey.ai', path: '/sign-up?aff=', label: 'UniKey' },`
  (форма `/sign-up?aff=` — если у панели она как у восьми соседей; у AgentRouter/AIKeysAPI/
  WisdomSatan/TrueSOTA — `/register?aff=`. **Проверить живой ссылкой, а не угадать.**)
- `routing/ref-codes.default.json`: `"getunikey": "6ssC"` — **полным именем**.

**🪤 `ref-codes.json` (пользовательский) — в `.gitignore`** (`.gitignore:356`); `default.json`,
наоборот, **коммитится намеренно** (`.gitignore:354-355`: «без него форк регистрировал бы…»).
Переносить коды из дефолта в пользовательский файл при заведении не нужно.

**КАК ПРОВЕРЕНО.** `Read` обоих файлов целиком; `Grep "ref-codes"` по репо (живой код, не
`.git/clean-stage/`); чтение `ref-codes.js:101-120` (перебор по `PROVIDERS`).

## Пункт 4. Флаг `ref: true|false` — что включает; кейс aikeysapi

### Что флаг включает в коде

**ФАКТ.** `ref` — один из четырёх флагов инструмента: `tools/add-gateway.js:394`
`const FLAGS = ['github', 'ref', 'flatRate', 'anthropic'];`. В конфиге шлюза
(`tools/gateways.config.json`) у kktoken `"ref": true`, у fluxnat `"ref": false`.

Механика (`add-gateway.js:185-186`, `245-246`, `300-302`, `608-610`): флаг **только гасит точки
спеки**, у которых в `when` он указан. Таких ровно две:

| Точка | Что проверяет | `when` |
|---|---|---|
| 3.5 | `routing/lib/ref-codes.js` → `SHAPES` содержит `%full%:` | `["ref"]` |
| 3.6 | `routing/ref-codes.default.json` содержит `"%full%":` | `["ref"]` |

При `ref: false` обе выходят со статусом «ослабление: нет ref» (`p.note = "ослабление: нет ref"`)
и в прогоне печатаются отдельным списком, а не пропуском.

**🔴 ЧЕГО ФЛАГ НЕ ДЕЛАЕТ: он НЕ влияет ни на вкладку, ни на пул, ни на баланс.** Никакого
`if (gw.ref)` в рантайме нет — это флаг **генератора**, а не шлюза. Вкладка и пул живут
независимо; реф-код на них не влияет вообще. Формулировка задачи «как он влияет на вкладку и
пул» — неверная посылка: влияет только на две точки §3 при заведении.

**Что реально включает реф-механика в рантайме** (три потребителя, все — из `ref-codes.js`):
1. **Регистрация по рефке при первом входе.** `<провайдер>/open-session.js` берёт
   `url('<full>')` → `REGISTER_URL`; при отсутствии ключа открывается страница регистрации с
   `?aff=` (`transparent-proxy.js:15614`: «Ключа ещё нет → гоним на регистрацию по рефке»).
2. **Авторега.** `<провайдер>/auto-add.js` → `code('<full>')` → `aff_code` в теле регистрации.
3. **Строка в UI.** Блок «Реф-коды» в «Настройках» дашборда строится по `rc.PROVIDERS`;
   при пустом коде `url()` отдаёт **корень сайта** (`ref-codes.js:130`), а не ссылку с пустым
   `aff=` — намеренно, «битый параметр панель может принять за код и потерять кредит вообще».

**КАК ПРОВЕРЕНО.** `Read routing/lib/ref-codes.js` целиком (строки 25-84 — SHAPES/legacy,
126-131 — `url()`, 101-120 — перебор по PROVIDERS); `Grep` `ref`/`FLAGS`/`when` по
`add-gateway.js`; `sed` по трём местам `ref-codes` в `transparent-proxy.js`.

### Кейс aikeysapi — код снимали

**ФАКТ.** `wiki/abuse-hub/hub-tasks.md:133`:

> ✅ **Реф-код AIKeysAPI снят** (решение владельца: бонусов за рефералов у панели нет).
> `aikeysapi: "vsFh"` убран из `routing/ref-codes.default.json`; проверено — `code('aikeysapi')`
> → `null`, `affCode()` авторега → `''`, в теле регистрации `aff_code: ""`. Соседи не тронуты.
> 🪤 Побочно `rc.url('aikeysapi')` отдаёт корень сайта — строка в «Настройках» выглядит
> ненастроенной, это ожидаемо

Подтверждено на живом файле: `aikeysapi` **отсутствует** в `ref-codes.default.json`, хотя запись
в `SHAPES` **оставлена** (`ref-codes.js:35`, `www.aikeysapi.com`). Это и есть шаблон поведения для
«панель без бонуса»: снимается **только код**, `SHAPES` остаётся (нужен для `url()` у
`open-session.js`). Смежное: `wiki/entities/AIKeysAPI.md:14,253`.

### 🔴 Находка сверх задания: снятие кода у aikeysapi НЕПОЛНОЕ

`aikeysapi/open-session.js:21` до сих пор держит **литерал**:

```js
const REGISTER_URL = 'https://www.aikeysapi.com/register?aff=vsFh';
```

и ходит по нему (строки 189, 204 — `page.goto(REGISTER_URL, ...)`). То есть из центральной точки
код убран, а захардкоженная копия в `open-session.js` продолжает регистрировать по `aff=vsFh`.
Шапка `ref-codes.js:3-6` прямо называет этот класс: «код рефки был захардкожен в ДЕСЯТИ точках —
пять `<prov>/open-session.js`…». **aikeysapi в миграцию не попал.** Для getunikey — брать
`require('../routing/lib/ref-codes.js').url('getunikey')` (как `kktoken/open-session.js:47`),
а не литерал по образцу `aikeysapi/open-session.js`.

⚠️ Не чинил: домен разведки — реестры, а репозиторий трогать запрещено. Отметить владельцу.

**КАК ПРОВЕРЕНО.** `grep -n "ref-codes\|REGISTER_URL"` по папкам шлюзов; `Read`
`aikeysapi/open-session.js:21` и `kktoken/open-session.js:43-47`.

## Пункт 5. Полный список реестров §3

Канон `ADDING-A-GATEWAY.md` §3 («Shared файлы, 7 файлов по 1–3 строки») нумерует подпункты
3.1–3.9; машиночитаемая спека `tools/gateways.spec.json` разворачивает тот же раздел в **11 точек
3.1–3.11 по 10 файлам**. Ниже — объединённый список, проверенный по живому репо.

**Проверка «есть ли у getunikey сейчас»:** `grep -c "getunikey\|unikey"` по каждому файлу дал
**0 везде**, кроме двух отсутствующих вовсе. То есть **ни одного из 11 реестров у getunikey нет**.

| # спеки | Файл | Что вписать | Сейчас у getunikey |
|---|---|---|---|
| 3.1 | `routing/keepalive-proxy.js:1132` `GW_BY_HOST` | `'www.getunikey.ai': 'uk',` | ❌ нет (0 хитов) |
| 3.2 | `routing/keepalive-proxy.js:558` `FLAT_RATE_HOSTS` | **НЕ вписывать** — только если `flatRate: true`. У getunikey тариф токенный → флаг `false`, точка ослаблена | ❌ нет (и не надо) |
| 3.3 | `routing/lifecycle.js:137` `children()` | `{ port: 20168, name: 'UniKey keepalive', respawn: false },` | ❌ нет (0 хитов) |
| 3.4 | `routing/keepalive-restart.ps1:33` `$perPort` | `20168 = @{ UPSTREAM = 'https://www.getunikey.ai'; KEY_FILE = "$profileDir\.claude\getunikey-active-key.txt"; MODELMAP_FILE = (Join-Path $dir 'getunikey-modelmap.json') }` | ❌ нет |
| 3.4b | тот же файл, строка 76 | `Write-Error "Unknown port …"` — **дописать порт в список известных** (грабля #6) | ❌ нет (список кончается `20165`) |
| 3.5 | `routing/lib/ref-codes.js:25` `SHAPES` | `getunikey: { host: 'www.getunikey.ai', path: '<форма>?aff=', label: 'UniKey' },` | ❌ нет |
| 3.6 | `routing/ref-codes.default.json` | `"getunikey": "6ssC"` — **полным именем** | ❌ нет (10 записей) |
| 3.7 | `routing/lib/newapi-account.js:196` `HOST_AUTH` | `'www.getunikey.ai': '<jwt\|classic>',` — **только по живому профилю**, не копией (грабля #24) | ❌ нет |
| 3.8 | `internal/hub-balance.js:22` `POOLS` | `{ id: 'uk', file: 'getunikey-sessions.json', name: 'UniKey' },` — ключ здесь **префикс** | ❌ нет |
| 3.9 | `routing/getunikey-modelmap.json` (**новый**) | `{ "opus": …, "sonnet": …, "haiku": … }` — значения по каталогу | ❌ **файла нет** |
| 3.10 | `getunikey/open-session.js` (**новый**) + `getunikey/sessions`, `getunikey/profiles` | копия **свежего** `kktoken/open-session.js` (грабля #17: `viewport: null`, `--window-size=600,1000`, `raiseBrowserWindow()`) | ❌ **папки нет** |
| 3.11 | `.gitignore` | блок на 4 строки: `getunikey/profiles/`, `getunikey/sessions/`, `getunikey/gh-sessions/`, `routing/getunikey-sessions.json` | ❌ нет |

**Отдельно — три фронтовых реестра, которых в §3 канона НЕТ** (они в §2, но по факту обязательные
и живут в `routing/proxy-dashboard.html`): `DEFAULT_TABS_VISIBLE` (п.1 выше), `NAV_COUNT_JOBS`
(п.2), плюс `LABELS`/`COLORS`/`KEEPALIVE_API`/`MONEY_PROVIDERS`/`state.loaded` (это не мой домен).

### 🪤 Расхождение: имя файла тир-карты — полное, а не префикс

Спека (точка 3.9) требует `routing/%full%-modelmap.json`, то есть **`getunikey-modelmap.json`**.
HANDOFF (Шаг 3 п.2) говорит про `uk-modelmap.json` — **это неверно**. Живая сверка 12 констант
в `transparent-proxy.js`:

```
ar-modelmap.json          ← ЕДИНСТВЕННЫЙ на префиксе (легаси)
gorouter, kktoken, aipm, hcnsec, aikeysapi, rumeng, justwoker,
seekai, truesota, tabi, xpeach  ← 11 из 12 на ПОЛНОМ имени
```

Проверка: `grep -n "modelmap.json'" routing/transparent-proxy.js`. Брать **полное имя**
(`getunikey-modelmap.json`) — как спека, а не как HANDOFF. То же для
`getunikey-routes-modelmap.json` (HANDOFF зовёт его `uk-routes-modelmap.json`; на диске у всех
девяти — полное имя).

### 🪤 Флаг `ref` и точки 3.5/3.6

Единственное, на что влияет `ref: true|false` — эти две точки (§ п.4). `ref: false` их **гасит**,
и в UI шлюз просто не появится строкой реф-кода (`PROVIDERS` = ключи `SHAPES`). На вкладку, пул,
баланс, keepalive и тир-карту флаг не влияет никак.

**КАК ПРОВЕРЕНО.** Цикл `grep -c "getunikey\|unikey"` по 12 путям (все нули / `MISSING`);
`sed`/`grep` по каждому из 10 файлов §3 (`GW_BY_HOST` 1132, `FLAT_RATE_HOSTS` 558,
`children()` 137, `$perPort` 33 + `Write-Error` 76, `SHAPES` 25, `HOST_AUTH` 196, `POOLS` 22,
`.gitignore` 425-480); `node -e` дамп 93 точек спеки; `ls routing/*modelmap*.json`.
