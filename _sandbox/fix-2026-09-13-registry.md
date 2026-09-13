# `/model agentrouter` → 400: реестр `backends.json` теряет `modelmap` у АКТИВНОГО шлюза

Инкрементальный журнал. Пишется по ходу, не в конце.

## Пункт 1 — кто пишет `backends.json` и почему `modelmap: null`

Писатель — `routing/transparent-proxy.js`, `writeBackendsRegistry(extra)` (`:736`).
Две ветки заполняют `providers`:

| ветка | строки | что кладёт в `modelmap` |
|---|---|---|
| `registrySeedEntry(name, base, label)` — цикл по `BACKENDS` | `:722–731`, вызов `:747` | ✅ **правильно**: `p ? `${p}-modelmap.json` : null`, где `p = CC_MODEL_PREFIX[name]`. Это и есть фикс 12.09 (комментарий `:708` «Поле `modelmap` нужно ОБОИМ путям… исправлено 12.09») |
| `extra` — состояние только что активированного бэкенда | `:750–758` | 🔴 `modelmap: extra.modelmap \|\| null` |

**`extra` идёт ПОСЛЕ цикла и перезаписывает корректную seed-запись целиком**
(`doc.providers[extra.backend] = {…}`), включая `source: 'learned'`.

Откуда берётся `extra` — `frontdoorStateFrom(obj)` (`:786–821`):

```js
let keyFile = null;
let modelmap = null;
if (!isLocalBase(base)) {          // :794
    …keyFile из apiKeyHelper…
    const prefix = keyFile && … ? keyFile.replace(/-active-key\.txt$/, '') : null;
    if (prefix) modelmap = `${prefix}-modelmap.json`;   // :818
}
return { backend, upstream: base, keyFile, modelmap, updatedAt: Date.now() };
```

Для **локального** апстрима (`http://localhost:20133` — это agentrouter) ветка не
выполняется вовсе → `modelmap` остаётся `null`, `keyFile` остаётся `null`. Prefix
выводится **из имени key-файла**, а у локальных шлюзов key-файла нет по устройству
(ключ ставит keepalive) — значит выводить `modelmap` этим способом для них
невозможно в принципе.

### Корень (одной строкой)

Фикс 12.09 закрыл `registrySeedEntry()`, но **не** `frontdoorStateFrom()` / ветку
`extra`. Поэтому запись портится ровно у того шлюза, который **активен**: активация
затирает seed-запись «выученной» с `modelmap: null`. `agentrouter` активен — он и
сломался. Стал бы активным `gorouter` — сломался бы он, с тем же 400.

Симптом соответствует: `source: "learned"` в записи `agentrouter` (а не `"backends"`,
как у 15 остальных) — это подпись именно ветки `extra`.

### Доказательство таймлайном: до активации работало, после — 400

`routing/frontdoor-proxy.log` (живой процесс, не стенд):

```
[2026-09-13T00:23:39.386Z] POST /v1/messages ▸agentrouter (префикс модели): agentrouter → claude-opus-5 → http://localhost:20133
…22 таких строки, последняя 00:29:00.512Z…
[2026-09-13T00:29:15.285Z] backend: agentrouter → http://localhost:20133 (локальный, ключ не трогаем)
[2026-09-13T00:29:15.285Z] реестр провайдеров: 28 имён (…)
[2026-09-13T00:29:22.702Z] POST /v1/messages ▸agentrouter (только шлюз): default не задан → 400
[2026-09-13T00:29:28.193Z] POST /v1/messages ▸agentrouter (только шлюз): default не задан → 400
[2026-09-13T00:30:42.925Z] POST /v1/messages ▸agentrouter (только шлюз): default не задан → 400
```

🎯 **`/model agentrouter` работал 22 запроса подряд** и разворачивался в `claude-opus-5`
из routes-карты. Сломался ровно на первом запросе **после** перезаписи реестра
(00:29:15 → первый 400 в 00:29:22, 7 секунд спустя). Пара строк
`backend: … / реестр провайдеров: …` — это реакция front-door на изменившийся mtime,
то есть та самая перезапись из `applyFrontdoor()`.

Это отвечает и на «я же выбрал модель, а она непонятно куда пошла»: до 00:29 она шла
**правильно**, в `claude-opus-5` на `:20133`. Порча пришла не из выбора модели, а из
переактивации шлюза (клик по шлюзу/аккаунту/чипу на дашборде).

Реестр переписан ещё дважды после: `updatedAt: 1789259827110` = 2026-09-13 03:37:07 MSK,
`active-backend.json.updatedAt` = 03:38:27 MSK. Оба файла на диске сейчас с
`modelmap: null`.

### Живой регресс уже красный на этом

`tools/check-routes-default.js`, проверка №8 (добавлена 12.09 именно под этот баг,
читает боевой `~/.claude/backends.json`):

```
  ok   локальная ветка берёт карту из CC_MODEL_PREFIX, а не хардкодит null
  FAIL в живом реестре у локальных шлюзов с префиксом карта проставлена: без карты: agentrouter
+ [
+   'agentrouter'
+ ]
- []

[FAIL] 1 из 21
```

То есть 12.09 закрыли **исходник** (`registrySeedEntry`, проверка «ok»), а **живой
реестр** снова испортился (проверка «FAIL») — потому что вторая ветка писателя осталась
непочиненной.

## Пункт 2 — аудит всех 16 записей реестра

| провайдер | local | prefix (`CC_MODEL_PREFIX`) | `modelmap` | `keyFile` | `source` |
|---|---|---|---|---|---|
| **agentrouter** | ✅ | `ar` | 🔴 **null** | null | **learned** |
| omniroute | ✅ | — | null | null | backends |
| notion | ✅ | — | null | null | backends |
| fm_openai | ✅ | — | null | null | backends |
| vyce_openai | ✅ | — | null | null | backends |
| tabi | ✅ | `tabi` | `tabi-modelmap.json` | null | backends |
| gorouter | ✅ | `gorouter` | `gorouter-modelmap.json` | null | backends |
| kktoken | ✅ | `kktoken` | `kktoken-modelmap.json` | null | backends |
| aipm | ✅ | `aipm` | `aipm-modelmap.json` | null | backends |
| hcnsec | ✅ | `hcnsec` | `hcnsec-modelmap.json` | null | backends |
| xpeach | ✅ | `xpeach` | `xpeach-modelmap.json` | null | backends |
| justwoker | ✅ | `justwoker` | `justwoker-modelmap.json` | null | backends |
| seekai | ✅ | `seekai` | `seekai-modelmap.json` | null | backends |
| truesota | ✅ | `truesota` | `truesota-modelmap.json` | null | backends |
| aikeysapi | ✅ | `aikeysapi` | `aikeysapi-modelmap.json` | null | backends |
| custom | ❌ remote | — | `custom-modelmap.json` | `custom-active-key.txt` | learned |

Выводы:

- 🔴 **Сломан ровно один — и ровно тот, который активен.** Это не совпадение: портит
  запись только ветка `extra`, а `extra` — это «только что активированный бэкенд».
- ⚠️ **Баг ШИРЕ одного шлюза, но проявляется по одному за раз.** Под удар попадают все
  **11** локальных шлюзов с префиксом (`agentrouter, tabi, gorouter, kktoken, aipm,
  hcnsec, xpeach, justwoker, seekai, truesota, aikeysapi`): у каждого запись корректна,
  **пока его не активируют**. Активация → `modelmap: null` → `/model <шлюз>` даёт 400.
  Сейчас чист `tabi` только потому, что владелец сидит на agentrouter.
- `keyFile: null` у локальных — **это норма, не баг** (`registrySeedEntry` :726 ставит
  так же). Ключ локальным ставит keepalive, а front-door инжект гасит по `!state.local`
  (`frontdoor-proxy.js:600`). Чинить нечего.
- `omniroute / notion / fm_openai / vyce_openai` — `modelmap: null` **штатно**: префикса
  в `CC_MODEL_PREFIX` у них нет, routes-карты тоже нет (комментарий `:720-721`).
- `custom` — `learned` и при этом с картой: он **remote**, и в `frontdoorStateFrom()`
  ветка remote (`:794-818`) выводит имя карты из key-файла. Ровно этой ветки локальным
  и не хватает. Это подтверждает адрес корня.
- `routes`-карта на диске пока одна — `ar-routes-modelmap.json`. Остальным 10 шлюзам
  она не нужна: `routeTierMap(name, true)` (`transparent-proxy.js:888`) отсутствие
  routes-файла НЕ считает ошибкой, а `/model <шлюз>` у них честно ответит 400 «default
  не задан» — это уже правильное поведение, не баг.

Побочно найдено в той же ветке `extra`: `label: extra.backend` **затирает** человеческую
подпись. У `agentrouter` в `BACKENDS` label = `AgentRouter (opus-5 1M)`, а в реестре
лежит `agentrouter` — вкладка «Маршруты» (`handleRoutesInfo`, `v.label || name`) с тех
пор показывает служебное имя. Косметика, но того же происхождения: активация теряет то,
что seed-ветка знала.

## Пункт 4 — куда фактически уходит `/model agentrouter/glm-5.3` при `modelmap: null`

Прослежено по коду; живой front-door подтверждает состояние (запрос локальный, платных
нет):

```
active backend: agentrouter | modelmap: null | local: true
registry_file: C:\Users\WormAlien\.claude\backends.json | err: null
uptime_ms: 28484749 = 7.91 h
routed: {"agentrouter":438}
```

### Ответ: доезжает и уходит правильно. `modelmap: null` на этот путь НЕ влияет

Разбор по хопам для `{"model":"agentrouter/glm-5.3"}`:

| хоп | что делает | зависит от `state.modelmap`? |
|---|---|---|
| `routeByModel()` `frontdoor-proxy.js:409-427` | `slash>0` → `state = reg.get('agentrouter')`, тело переписывается на `glm-5.3`, `tier = tierOfRequest('glm-5.3')` = **`default`** | ❌ нет. `routesMapFor()` в этой ветке **не вызывается вовсе** |
| `forward()` `:590-592` | ставит `x-route-prefixed: 1` и `x-route-tier: default` | ❌ нет |
| `forward()` `:600` | `if (!state.local)` — **пропущено**, апстрим локальный | ✅ поэтому ни `keyFile`, ни `readModelMap(state.modelmap)`, ни `remapForRemote()` не выполняются |
| `forward()` `:627` | `http.request` на `127.0.0.1:20133` | ❌ нет |
| keepalive `:2338` | `viaRoutes = true` из заголовка → `remapHaiku(..., true)` → `readModelMap(true)` = **`ar-routes-modelmap.json`** | ❌ нет: keepalive держит **свои** пути (`AR_MODELMAP_FILE` / `AR_ROUTES_MODELMAP_FILE`, `keepalive-proxy.js:106-111`), реестр не читает |
| keepalive `tierTargetFor('glm-5.3', true)` `:143` | `TIER_RE` — только opus/sonnet/haiku, `glm-5.3` не матчит → **`null`**, подмены нет | — |
| keepalive `:2133` | ключ — `ar-active-key.txt`, читается на каждую попытку | ❌ нет. `keyFile: null` в реестре ни при чём |

### Что это значит для жалобы «модель ушла непонятно куда»

- 🔴 **`keyFile: null` не является багом и никуда запрос не уводил.** Ключ ставит
  keepalive из `ar-active-key.txt`; front-door инжект гасит по `!state.local`.
- 🔴 **Тир-карта к явному имени НЕ применяется** — и это правильно: `glm-5.3` не
  подпадает ни под opus/sonnet/haiku (проверено запуском `TIER_RE`:
  `glm-5.3 → default`, `deepseek-v4-flash → default`, `gpt-6-astra → gpt`,
  `claude-opus-5 → opus`). Ключ `default` keepalive не применяет (его `TIER_RE`
  перечисляет три тира), поэтому явное имя уходит как названо.
- ✅ Лог подтверждает доставку явных имён: `agentrouter/deepseek-v4-flash →
  deepseek-v4-flash → http://localhost:20133` (00:23:34), и то же самое до 00:29 для
  голого имени: `agentrouter → claude-opus-5`.

Итого «непонятно куда» — это **не** второй баг, а тот же первый: сломано **только**
голое имя (единственный путь, читающий `state.modelmap` через `routesMapFor()`), а
владелец видел рядом два разных исхода — явное имя ехало, голое падало в 400.

⚠️ Расхождение двух карт, которое стоит знать владельцу (не баг, но объясняет
«непонятно куда»): у `ar-modelmap.json` **все четыре** тира указывают на
`claude-opus-5` (включая `gpt`), а у `ar-routes-modelmap.json` — `haiku:
claude-opus-4-8` и `gpt: ''`. То есть один и тот же сабагент-haiku через префикс и без
префикса уезжает на **разные** модели. Это ровно та развязка, ради которой карты
разделяли, — но выбрано это должно быть осознанно.

## Пункт 3 — правка. Писатель починен, у читателя — обоснованный отказ от фолбэка

### 3.1 Писатель: `transparent-proxy.js:750-784` (было `:750-758`)

`writeBackendsRegistry()`, ветка `extra`. Присваивание записи **целиком** заменено
слиянием, имя карты выводится из `CC_MODEL_PREFIX` — той же таблицы, что в
`registrySeedEntry()`:

```js
const p = CC_MODEL_PREFIX[extra.backend] || null;
const prev = doc.providers[extra.backend] || {};
doc.providers[extra.backend] = {
    upstream: extra.upstream,
    keyFile: extra.keyFile || prev.keyFile || null,
    // Порядок важен: что знает активация → что было в seed → вывод из префикса.
    modelmap: extra.modelmap || prev.modelmap || (p ? `${p}-modelmap.json` : null),
    label: prev.label || extra.backend,
    source: 'learned',
};
```

Почему так, а не «поле в `frontdoorStateFrom()`»: `frontdoorStateFrom()` выводит имя
карты **из имени key-файла** (`:816`), а у локальных шлюзов key-файла нет по устройству.
Починить там значило бы завести в нём ветку по `CC_MODEL_PREFIX` — то есть **вторую**
точку вывода имени карты. Слияние в писателе оставляет вывод в одном месте и попутно
делает активацию неспособной обеднить запись **любым** полем.

`source: 'learned'` оставлен: это диагностическая пометка «запись пришла из активации»,
её никто не читает (проверено `grep` по `frontdoor-proxy.js` / `transparent-proxy.js` /
`proxy-dashboard.html` — только запись). Заодно перестал затираться `label`.

### 3.2 Читатель: фолбэк по `CC_MODEL_PREFIX` во front-door — 🔴 ОТКЛОНЁН

Бриф предлагал добавить в `routesMapFor()` / `parseStateDoc()` фолбэк по имени бэкенда
через `CC_MODEL_PREFIX` и просил решение обосновать. Обоснование — **против**, по двум
записанным инвариантам, которые фолбэк нарушает сразу оба:

1. **Шапка `frontdoor-proxy.js:56-58`, дословно:** «Апстрим уже разрешён дашбордом
   (transparent-proxy.js → writeSettings), поэтому здесь **НЕТ таблицы провайдеров** и
   знания о портах: прокси только форвардит». То же правило повторено в `:207`:
   «Таблицы провайдеров и портов здесь по-прежнему НЕТ (это правило из шапки файла)».
2. **Инвариант вики** ([[Маршруты — своя тир-карта и имя без модели]], `:88`): «Третьего
   источника истины не появляется — таблица провайдер→префикс остаётся одна
   (`CC_MODEL_PREFIX`, `transparent-proxy.js:347`)».

Импортировать таблицу из `transparent-proxy.js` нельзя: это 23,5 тыс. строк дашборда,
`require` поднял бы его серверы внутри front-door. Значит фолбэк = **копия таблицы** в
front-door, то есть ровно тот второй источник, который инвариант запрещает. Копия
разъедется при добавлении шлюза, и разъедется **молча**: front-door пойдёт по своей
устаревшей копии, а вкладка — по живой.

Угадывать имя файла иначе (glob `*-routes-modelmap.json` по `routing/`) — тот же второй
источник, только неявный. Тоже отклонено.

### 3.3 Читатель: вместо фолбэка починен ДИАГНОЗ (то, из-за чего владелец искал не там)

Настоящий баг читателя — не отсутствие фолбэка, а **врущий текст 400**. При
`modelmap: null` карта не резолвится вовсе, а сообщение утверждало «модель по умолчанию
у него не задана… открой вкладку Маршруты → селект default». Владелец `default`
**уже выбрал** — отсюда дословно его «я уже выбрал через префикс agentrouter модель, а
она непонятно куда пошла». Сообщение отправляло чинить исправное.

Правка различает два разных состояния (см. ниже, файл:строка).

### 3.4 Список правок (файл:строка)

| файл:строка | что изменено |
|---|---|
| `routing/transparent-proxy.js:750-784` | 🔴 **корень.** Ветка `extra` в `writeBackendsRegistry()`: присваивание записи целиком → слияние с seed-записью; `modelmap` выводится из `CC_MODEL_PREFIX`; `label` больше не затирается служебным именем |
| `routing/frontdoor-proxy.js:360-379` | `routesMapFor()`: комментарий-обоснование, почему фолбэка по таблице префиксов здесь НЕТ (правило шапки + инвариант вики) |
| `routing/frontdoor-proxy.js:399-418` | `routeByModel()`: у отказа появилась причина — `noMap: !mm` («карта не адресуется») отдельно от «тир пуст» |
| `routing/frontdoor-proxy.js:562-580` | обработчик `noTarget`: два разных текста 400 и две разные строки лога вместо одной врущей подсказки |
| `~/.claude/backends.json` (данные, не код) | запись `agentrouter` починена на диске: `modelmap: null → "ar-modelmap.json"`, `label: "agentrouter" → "AgentRouter (opus-5 1M)"`. Бэкап: `~/.claude/backends.json.bak-2026-09-13-modelmap` |

🎯 **Реестр починен без рестарта — и это не срезание угла.** `backends.json` это
**данные**, а не код в памяти: front-door перечитывает его по mtime на каждый запрос
(`readRegistry()`, `:213-223`). Запись сделана атомарно (`writeFileSync` в `.tmp` +
`renameSync`) — тем же приёмом, что использует сам `writeBackendsRegistry()` (`:764-766`),
поэтому частично записанный файл прокси увидеть не мог. Имя карты и `label` взяты
**из живого `transparent-proxy.js`** (`CC_MODEL_PREFIX` и `BACKENDS`), а не вписаны
руками, — второго источника истины скрипт починки не создал.

## Регрессы — вывод дословно

Все прогоны локальные, поддельные апстримы. **Платных запросов к шлюзам: 0.**

### `tools/check-routes-default.js` — 21/21 (было 20/21)

До правки (проверка №8 читает боевой реестр):

```
  ok   локальная ветка берёт карту из CC_MODEL_PREFIX, а не хардкодит null
  FAIL в живом реестре у локальных шлюзов с префиксом карта проставлена: без карты: agentrouter
+ [
+   'agentrouter'
+ ]
- []

[FAIL] 1 из 21
```

После правки писателя + починки реестра:

```
  ok   400 объясняет, что чинить
  ok   при 400 наверх не ушло ничего (денег не потрачено)
  ok   обычная модель едет на активный шлюз как есть
  ok   без префикса заголовка нет (keepalive возьмёт обычную карту)
  ok   подделанный клиентом x-route-prefixed снят
  ok   registrySeedEntry найден
  ok   локальная ветка берёт карту из CC_MODEL_PREFIX, а не хардкодит null
  ok   в живом реестре у локальных шлюзов с префиксом карта проставлена

[OK] имя без модели и две тир-карты работают (21 проверок)
```

### Синтаксис и selftest

```
$ node --check routing/frontdoor-proxy.js   → frontdoor OK
$ node --check routing/transparent-proxy.js → transparent OK
$ node routing/frontdoor-proxy.js selftest  → selftest OK
```

### 🎯 Приёмка на ЖИВОМ front-door — уже зелёная, без рестарта

`GET :20100/__frontdoor/api/status` (локальный запрос, денег не тратит):

```
LIVE front-door, agentrouter в реестре:
  modelmap = "ar-modelmap.json"
  local    = true | injectsKey = false
  names    = agentrouter, ar
  → routes-карта резолвится в: ar-routes-modelmap.json
uptime_ms = 29148776 (процесс НЕ перезапускался)
```

Живой процесс (pid 13308, аптайм 8,1 ч) **уже** видит починенную запись: `modelmap`
непустой → `routesMapFor()` вернёт карту → `default` = `claude-opus-5` из
`ar-routes-modelmap.json` найдётся. То есть `/model agentrouter` в сессии владельца
должен заработать **сразу**, без рестарта чего-либо.

### Регресс дорос 21 → 29, и новые проверки доказаны падением на старом коде

`tools/check-routes-default.js` пополнен двумя блоками (проверки 9 и 10):

```
  ok   modelmap: null → 400
  ok   при modelmap: null текст винит РЕЕСТР, а не вкладку
  ok   при modelmap: null наверх не ушло ничего
  ok   карта есть, default пуст → 400
  ok   пустой тир ведёт на вкладку «Маршруты» и НЕ винит реестр
  ok   явное имя при modelmap: null доезжает (200)
  ok   явное имя при modelmap: null не подменено
  ok   ветка extra не обедняет запись: modelmap выводится из CC_MODEL_PREFIX

[OK] имя без модели и две тир-карты работают (29 проверок)
```

🎯 **Почему проверка №10 исполняет функцию, а не грепает её.** Существующая проверка №8
грепает `registrySeedEntry` — и была **зелёной**, пока баг жил во второй ветке. Именно
поэтому 12.09 фикс сочли полным. Новая вырезает блок `writeBackendsRegistry()` из
исходника и прогоняет его в песочнице с поддельными зависимостями (приём из
`check-1m.js`), передавая `extra` ровно как прод: локальный шлюз, `keyFile: null`,
`modelmap: null`.

🪤 **Тест проверен возвратом бага.** Со старой веткой `extra` на месте:

```
  FAIL ветка extra не обедняет запись: modelmap выводится из CC_MODEL_PREFIX: активация снова обеднила карту (modelmap=null) → /model agentrouter вернёт 400
[FAIL] 1 из 29
```

То есть тест воспроизводит боевой симптом дословно, а не просто зелёный. Исходник затем
восстановлен (`node --check` OK, merge-ветка на месте, старой нет, 29/29 снова зелёные).

🪤 **Первый прогон новых проверок был красным по вине теста** — той же породы грабля, что
записана в вике 12.09. Ассерт грепал `backends.json` в тексте 400, но сообщение печатает
путь **реестра**, а под тестом это фикстура `backends-nomap.json` во временной папке.
Признак заменён на `modelmap: null` (имя поля, а не имя файла).

### Остальная батарея — дословно

```
$ node tools/check-frontdoor.js
  ok   тумблер off: детект по settings.json (было xpeach)
check-frontdoor OK (29 проверок)

$ node tools/check-frontdoor-ensure.js
  ok   после провала отбойник глушит повторный ensure (нет 8с на каждый запрос)
[OK] автоподъём keepalive по префиксу работает

$ node tools/check-1m.js
  ok   normalizeCcModel: 29 кейсов
  ok   ccContextTokensFor: 18 кейсов
  ok   resolveCcModel: 6 кейсов
[OK] инвариант 1M держится

$ node tools/check-upstream-model.js
[OK] upstream model suffix boundary: 8 кейсов

$ node tools/check-modelmap-merge.js
  ok   ROUTE_EP покрывает все десять шлюзов и не путается с CC_MODEL_PREFIX
  ok   текущее значение тира всегда остаётся в опциях
[OK] слияние тир-карт держится, gpt не теряется
```

**Платных запросов к шлюзам: 0.** Все апстримы в прогонах поддельные (`127.0.0.1:2142x`,
`:2152x`), живого шлюза не касался ни один тест; единственный запрос к живому процессу —
локальный `GET :20100/__frontdoor/api/status`, который денег не тратит.

## Что осталось за владельцем

| # | что | зачем | обязательно? |
|---|---|---|---|
| 1 | **Проверить `/model agentrouter` в новом окне** | правка реестра уже подхвачена живым front-door (см. приёмку выше) — должно работать сразу | ✅ сделать первым |
| 2 | **Рестарт дашборда `:8200`** | он держит в памяти СТАРЫЙ `transparent-proxy.js`, то есть старую ветку `extra`. До рестарта **следующая активация любого шлюза снова испортит реестр** | ⚠️ да, иначе баг вернётся |
| 3 | Рестарт front-door `:20100` | только чтобы включились новые тексты 400 (диагностика). На работу `/model agentrouter` не влияет | опционально |

🔴 **Ничего не перезапускал сам** — `:20100` (pid 13308) и `:8200` держат живую сессию.
Порядок важен: **до** рестарта `:8200` не активировать шлюзы на дашборде, иначе старый
код в памяти снова положит `modelmap: null` и 400 вернётся.

Бэкап реестра до правки: `C:\Users\WormAlien\.claude\backends.json.bak-2026-09-13-modelmap`.

### Отдельно — на решение владельца, не баг

Две карты `agentrouter` разошлись по `haiku` и `gpt`: у `ar-modelmap.json` (без префикса)
все четыре тира → `claude-opus-5`; у `ar-routes-modelmap.json` (через префикс) —
`haiku: claude-opus-4-8`, `gpt: ''`. Один и тот же сабагент-haiku поедет на разные модели
в зависимости от того, назван ли шлюз префиксом. Развязка штатная (ради неё карты и
разделяли 12.09), но стоит подтвердить, что это выбрано осознанно.

## Финальная проверка состояния

Батарея целиком, один прогон:

```
check-routes-default       [OK] имя без модели и две тир-карты работают (29 проверок)
check-frontdoor            check-frontdoor OK (29 проверок)
check-frontdoor-ensure     [OK] автоподъём keepalive по префиксу работает
check-1m                   [OK] инвариант 1M держится
check-upstream-model       [OK] upstream model suffix boundary: 8 кейсов
check-modelmap-merge       [OK] слияние тир-карт держится, gpt не теряется
frontdoor selftest         selftest OK
```

Сквозная проверка живого пути (без рестартов, локально):

```
реестр modelmap : ar-modelmap.json
routes-файл     : ar-routes-modelmap.json
default в нём   : "claude-opus-5"
→ /model agentrouter развернётся в: claude-opus-5
front-door uptime: 8.19 ч — не перезапускался
```

Гигиена диффа: правки — только `routing/transparent-proxy.js` (ветка `extra`),
`routing/frontdoor-proxy.js` (+39/−1), `tools/check-routes-default.js` (+139/−0).
Переводы строк не испорчены: рабочий файл и блоб `HEAD` оба CR = 0 (проверено байтами по
блобу, а не `grep` — MSYS-грепу про CR верить нельзя). Прочие `M`-файлы в
`git status` — чужая незакоммиченная работа в этом репозитории, я их не касался.
