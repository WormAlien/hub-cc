# getunikey — рекогносцировка: порты и регистры имён

Разведчик №1 из десяти. Домен: **порты и регистры имён**.
Живой репозиторий: `C:\Users\WormAlien\Desktop\Autoreger_Clean` (ветка `master`).
Провайдер: `getunikey`, домен www.getunikey.ai, префикс-кандидат `uk`.
Дата: 2026-09-15.

## План пунктов

1. `routing/lib/custom-ports.js` целиком — диапазон портов, занятые, закомментированные 20155–20164, свободен ли 20168, другие свободные номера.
2. `tools/check-custom-ports.js` — что проверяет; прогнать `node tools/check-custom-ports.js`, записать дословный результат.
3. Регистры имён — эталон `kktoken` (5 регистров); для getunikey `uk`/`UK`/`Uk`/`unikey`; проверить по `routing/transparent-proxy.js` вхождения внутри чужих слов (grep -c) и как отдельный токен/префикс; оценить риск коллизии.
4. Полный список префиксов заведённых шлюзов из `tools/gateways.config.json` — пары `p`/`P` таблицей с пометкой занятых портов.
5. Канон `D:\WORMALIENAIGIGANT\wiki\abuse-hub\ADDING-A-GATEWAY.md` — требования к номеру порта/диапазону, дословная цитата.

---

## 1. custom-ports.js

### Факт: назначение файла и диапазон
`custom-ports.js` — список портов, которые аллокатор Custom-провайдеров **не имеет права** отдавать.
Диапазон конвертеров кастомов: `PORT_MIN = 20150`, `PORT_MAX = 20250`.
Keepalive шлюзов живут ВНУТРИ этого диапазона (20155–20165) — отсюда конфликт: аллокатор
проверял занятость бинд-пробой, а keepalive неактивного шлюза не поднят → проба говорит «бери».
Замерено 2026-09-10: провайдер `newapi.makelove.cloud` получил `:20156` (GoRouter) и держал живым
процессом (pid 34940), из-за чего GoRouter не мог стартовать.

### Факт: RESERVED_FALLBACK (жёсткий список в файле)
```
20132, 20133                              // AR-конвертер, AgentRouter keepalive
20155, 20156, 20157, 20158, 20159, 20160  // tabi, gorouter, xpeach, justwoker, seekai, truesota
20161, 20162, 20163, 20164                // kktoken, hcnsec, aipm, wisdomsatan
```
🪤 **Уточнение к брифу:** в брифе 20155–20164 названы «закомментированными» — это неверно.
Это АКТИВНЫЕ элементы массива `RESERVED_FALLBACK`; текст после них (`// tabi, gorouter, ...») —
лишь комментарий-подпись номеров, а не выключение. Файл: `routing/lib/custom-ports.js:27-31`.

### Факт: источник истины — lifecycle.children(), не список
`reservedPorts()` берёт `Set(RESERVED_FALLBACK)` и **дополняет** его портами из
`lifecycle.children()`. Т.е. реальный набор — из `routing/lifecycle.js:137-155`.
Снято 2026-09-15 (`node -e "require('./routing/lifecycle').children()"`):
```
20100 Front Door (порт front-door, настраивается в frontdoor.json)
20132 AR-конвертер          20133 AgentRouter keepalive
20155 Tabi keepalive        20156 GoRouter keepalive    20157 XPeach keepalive
20158 JustWoker keepalive   20159 SeekAi keepalive      20160 TrueSOTA keepalive
20161 KKtoken keepalive     20162 HCNsec keepalive      20163 AIPM keepalive
20164 WisdomSatan keepalive 20165 AIKeysAPI keepalive
8300  Дашборд (легаси)
```
Список шлюз→порт (внутри диапазона 20150–20250):
| Порт | Шлюз |
|---|---|
| 20155 | Tabi |
| 20156 | GoRouter |
| 20157 | XPeach |
| 20158 | JustWoker |
| 20159 | SeekAi |
| 20160 | TrueSOTA |
| 20161 | KKtoken |
| 20162 | HCNsec |
| 20163 | AIPM |
| 20164 | WisdomSatan |
| 20165 | AIKeysAPI |

### Факт: RESERVED_FALLBACK отстал от lifecycle ровно на один шлюз
`20165` (AIKeysAPI keepalive) есть в `children()`, но **отсутствует** в `RESERVED_FALLBACK`.
При живом lifecycle это неважно (20165 придёт из children()), но фолбэк-режим («lifecycle не
читается») 20165 не защитит. Прямой пример, почему новый шлюз надо добавлять в lifecycle, а не
в фолбэк. `routing/lib/custom-ports.js:30` против `routing/lifecycle.js:152`.

### Факт: что занимает диапазон 20150–20250 фактически
- `20150` — конвертер Custom-провайдера `https://agentrouter.org` (единственный с непустым
  `proxyPort` в `routing/custom-providers.json`; у остальных 27 провайдеров `proxyPort: null`).
- `20155–20165` — keepalive 11 шлюзов (таблица выше).
- Далее — свободно.

### Факт: 20168 СВОБОДЕН
`20168` ∈ [20150, 20250], НЕ в `RESERVED_FALLBACK`, НЕ в `children()`, НЕ в `custom-providers.json`.
Свободен. Ближайшие свободные номера:
- `20151, 20152, 20153, 20154` — зазор между кастомом 20150 и keepalive 20155;
- `20166 … 20250` — весь хвост диапазона, начиная сразу после AIKeysAPI (20165).

### Факт: живой снимок LISTENING (netstat, 2026-09-15)
```
:8200 (pid 26536), :20100 (29084), :20132 (28372), :20133 (14352), :20134 (9308)
```
Keepalive 20155–20165 в снимке ОТСУТСТВУЮТ: они `respawn: false` и поднимаются только при
активации бэкенда. Именно поэтому бинд-проба на этих портах врёт «свободно» — см. шапку файла.

**Как проверено:** `Read` `routing/lib/custom-ports.js` (62 строки целиком); `Read`
`routing/lifecycle.js:1-200`; `node -e` dump `lifecycle.children()`/`customPorts()`;
`node -e` по `custom-providers.json`; `netstat -ano -p tcp | grep LISTENING`.

## 2. check-custom-ports.js

### Факт: что проверяет (8 инвариантов, только чтение — ни одного сокета)
Живой стек не трогает: `assert` + чтение таблиц + чистые функции. `exit 1` = резерв сломан.
1. все порты `lifecycle.children()` попадают в `reservedPorts()` — главный инвариант;
2. конкретно `:20156` (GoRouter, порт инцидента) зарезервирован;
3. блок keepalive `20155–20164` закрыт целиком;
4. без lifecycle резерв держится на фолбэке (`reservedPorts({})`);
5. резерв не съел весь диапазон (свободно ≥ 80 портов);
6. `transparent-proxy.js` импортирует диапазон из модуля, а не пишет свою копию `CUSTOM_PROXY_PORT_MIN`;
7. и выдача, и путь повторного использования порта смотрят в резерв (`customReservedPorts()` ≥ 3 вызова);
8. `custom-providers.json` не держит зарезервированных портов (боевое состояние, не код).

### Факт: дословный результат прогона `node tools/check-custom-ports.js` (2026-09-15)
```
check-custom-ports:
  ok  все порты lifecycle.children() попадают в резерв
  ok  :20156 (GoRouter) зарезервирован — тот самый порт инцидента
  ok  блок keepalive 20155–20164 закрыт целиком
  ok  без lifecycle резерв держится на фолбэке
  ok  свободных портов под кастомы остаётся с запасом
  ok  transparent-proxy берёт диапазон из модуля, а не своей копией
  ok  и выдача, и повторное использование порта смотрят в резерв
  ok  custom-providers.json не держит зарезервированных портов

всё зелено (8)
EXIT=0
```

### Факт: точный счёт свободного (уточнение к тесту 5)
`node -e` по `reservedPorts()`: зарезервировано В диапазоне — ровно `20155…20165` (11 портов).
`20150` в резерв НЕ входит (это обычная выдача кастома, не keepalive), хотя фактически занят
конвертером `agentrouter`. Свободно по `reservedPorts()`: **90 из 101**. Практически под новую
выдачу: **89** (20150 занят).
Голова свободного списка, как его отдаёт `reservedPorts()`: `20151,20152,20153,20154,20166,20167,20168,...`
🪤 но `20166`/`20167` — ложные (заняты, но не зарезервированы): см. «ДОПОЛНЕНИЕ» в конце отчёта.
`20168` — **свободен** (`!reservedPorts().has(20168)` → `true`).

**Как проверено:** `Read` `tools/check-custom-ports.js` (117 строк целиком);
`node tools/check-custom-ports.js`; `node -e` пересчёт свободных через `cp.reservedPorts()`.

## 3. Регистры имён

### Факт: эталон kktoken действительно несёт пять+ регистров (замер по transparent-proxy.js)
| Регистр | Роль | Строк | Где |
|---|---|---|---|
| `kktoken` | id провайдера, tag, ключ `CC_MODEL_PREFIX` | 100 | везде |
| `KKtoken` | человекочитаемый label | 15 | UI/логи |
| `KK_` | префикс КОНСТАНТ | 65 | `KK_KEEPALIVE_PORT`, `KK_ACTIVE_KEY_FILE`, `KK_MODELMAP_FILE`, … |
| `kk_` | префикс ключа/сессии (`prefix: 'kk_'`) | 5 | newapi-хелперы |
| `Kk` | сегмент CamelCase в именах функций | 41 | `handleKkActivate`, `keepaliveKk`, `handleKkSessionOpen`, … |
| `kk` (отдельное слово) | короткий алиас + эндпоинт | 44 | `BACKEND_ALIASES.kk`, `ROUTE_EP.kktoken='kk'`, `/__switch/api/kk/…` |

Т.е. короткая форма `kk` живёт в ДВУХ таблицах: `BACKEND_ALIASES` (строка 700, `kk → kktoken`)
и `ROUTE_EP` (строка 877, `kktoken → kk`). Обе — в `routing/transparent-proxy.js`.

### Факт: `uk` НЕ занят как алиас/префикс (нигде)
`grep -rnE "['\"](uk|UK|Uk)['\"]\s*:" routing/*.js` (без `.bak`) → **NONE**.
В `BACKEND_ALIASES` (стр. 698-704) и `ROUTE_EP` (стр. 876-881) записи `uk` нет.
Существующие короткие коды: `ar, go, tb, xp, jw, sk, ts, kk, hn, ap, ak, rm, om, cdt, ot`.
Конфликта `uk` ни с одним нет.

### Факт: `uk` как ПОДСТРОКА — нулевая коллизия в transparent-proxy.js
```
grep -ic  "uk"      routing/transparent-proxy.js  → 0   (любой регистр, любое место)
grep -icE "\buk\b"  routing/transparent-proxy.js  → 0   (отдельное слово)
grep -c   "UK"      routing/transparent-proxy.js  → 0
grep -c   "Uk"      routing/transparent-proxy.js  → 0
grep -ic  "unikey"  routing/transparent-proxy.js  → 0
```
Контроль (доказательство, что grep не врёт): `the` → 61 строка, `token` → 426 строк.
То есть в главном файле роутинга `uk` не встречается вообще НИ РАЗУ — ни как токен, ни внутри слова.

### Факт: во всём репо `uk` встречается лишь 3 раза, и все — не идентификаторы
- `routing/agentrouter-proxy.js:279,289,1042` — base64-магики картинок в регекспе:
  `UklGR` (WebP). Совпадение по `Uk`, регистрозависимая литера регекспа, с префиксным
  роутингом не пересекается.
- `tools/check-league-chat-e2e.js:155` — тот же base64 `UklGR…` в тестовой константе.
- `tools/check-outlook.js:188` — строка-домен `'.ac.uk'` в проверке email. Данные, не код.

### Оценка риска коллизии `uk`
**НИЗКИЙ.** `uk` свободен и как алиас, и как любая подстрока; конфликтов ноль. Единственные
совпадения — base64-магик `UklGR` и домен `.ac.uk`, они в других контекстах и не участвуют
в разборе префикса модели. `unikey` как отдельный токен тоже свободен (в коде не встречается;
в `routing/runtime/faildump/*.json` попал только текстом захваченной сессии, не в логику).

### Факт: SECURITY — в faildump лежит живой ключ getunikey (репо публичный)
`routing/runtime/faildump/fail-perm-2026-09-15T01-11-22-*.json` содержит пользовательский
текст с ключом провайдера `sk-…` и `https://www.getunikey.ai/keys`. **Значение здесь НЕ
приводится** (репо публичный). Отмечено для другого разведчика/владельца — ключ в открытом
виде лежит в файле дампа. Файлы НЕ трогал.

**Как проверено:** `grep -in kktoken` + `-oE` разбор токенов по `routing/transparent-proxy.js`;
`Read` стр. 408-425 (`CC_MODEL_PREFIX`), 680-740 (`BACKEND_ALIASES`), 860-900 (`ROUTE_EP`);
серии `grep -ic/-cE` по `uk`/`UK`/`Uk`/`unikey` с контролем `the`/`token`.

## 4. Префиксы шлюзов

### Факт: `tools/gateways.config.json` — 4 записи, пары p/P
Это конфиг для `tools/add-gateway.js` (заполняется по §0 `ADDING-A-GATEWAY.md`). Эталон сверки —
kktoken. `p` = короткий префикс (lowercase), `P` = его верхний регистр.

| Провайдер (`full`) | `p` | `P` | NAME | HOST | PORT |
|---|---|---|---|---|---|
| kktoken | `kk` | `KK` | KKtoken | kktoken.cc | **20161** |
| hcnsec | `hn` | `HN` | HCNsec | api.hcnsec.cn | **20162** |
| aipm | `ap` | `AP` | AIPM | emtf.aipm9527.online | **20163** |
| fluxnat | `fn` | `FN` | FluxRouter | llm.fluxnat.dev | **20167** |

Все четыре порта — внутри диапазона кастомов 20150–20250. Три первых (20161/20162/20163) уже
в `lifecycle.children()`. Четвёртый (20167, fluxnat) — НЕТ (см. ниже).

### Факт: полный набор занятых коротких префиксов (из ВСЕХ таблиц, не только config)
Сводка `p` из трёх источников: `BACKEND_ALIASES` (`transparent-proxy.js:698-704`),
`ROUTE_EP` (`:876-881`), `CC_MODEL_PREFIX` (`:408-425`), плюс `gateways.config.json`:

```
ЗАНЯТЫ:  ar  go  tb  xp  jw  sk  ts  kk  hn  ap  ak  rm  om  cdt  ot  fn
СВОБОДНЫ (2 буквы, примеры):  uk  aa  ab  ac  ad  ... (кроме перечисленных выше)
```
`uk` — свободен: ни в одной из трёх таблиц его нет. `fn` (fluxnat) занят в config, но ещё не
проведён через runtime-таблицы.

### Факт: 20167 занят fluxnat по конфигу, но НЕ зарезервирован в runtime — мина
- `tools/gateways.config.json:32` — `PORT: 20167`.
- `tools/check-gateway-transform.js:57,97` — тест-фикстура УЖЕ ждёт в сгенерированном
  `lifecycle.js` строки: `FN_KEEPALIVE_PORT || 20167` и
  `{ port: 20167, name: 'FluxRouter keepalive', respawn: false }`.
- Но: `lifecycle.children()` fluxnat НЕ содержит (`node -e ... .some(/flux/i)` → **NO**);
  `CC_MODEL_PREFIX` fluxnat НЕ содержит; папка `fluxnat/` в корне репо ЕСТЬ.
- Следствие: `reservedPorts()` НЕ защищает `20167`. Аллокатор кастомов может выдать 20167
  под чужой провайдер, и при доведении fluxnat до конца будет тот же инцидент, что с
  `:20156`/GoRouter (см. §1), только «заложенный заранее».
- `https://llm.fluxnat.dev/v1` при этом уже числится в `custom-providers.json:548` как кастом
  (proxyPort `null`) — то есть fluxnat полудобавлен: конфиг+тест есть, runtime нет.

**Вывод по 20167/20168:** 20168 свободен; 20167 — «занят на бумаге» fluxnat'ом, но runtime
его не резервирует. Новому шлюзу брать 20168 разумно, 20167 трогать не стоит (занят планом).

**Как проверено:** `Read` `tools/gateways.config.json` (37 строк целиком);
`grep -rin fluxnat routing/`; `grep -rn 20167 routing/ tools/`; `node -e` проверка
`lifecycle.children()` на fluxnat; `ls -d fluxnat`; сводка таблиц префиксов из §3.

## 5. Канон ADDING-A-GATEWAY.md

Файл: `D:\WORMALIENAIGIGANT\wiki\abuse-hub\ADDING-A-GATEWAY.md` (51843 байт, updated 2026-09-13).
Порт/диапазон задан в §0.1 «Найти свободный порт» и §1.1 «Константы»; есть грабля #27.

### Факт: требование к номеру порта — §0.1, дословно
> ### 0.1 Найти свободный порт
>
> Порты keepalive идут подряд: 20155..20162. Занятые — в `routing/lifecycle.js`, массив
> `children` в `bootKeepalives()` (~строка 140). Последний занятый на 2026-09-07:
>
> ```
> 20155  Tabi
> 20156  GoRouter
> 20157  XPeach
> 20158  JustWoker
> 20159  SeekAi
> 20160  TrueSOTA
> 20161  KKtoken
> 20162  HCNsec       ← ЗАНЯТ!
> ```
>
> Следующий свободный: **20163**. Всегда проверяй `grep -n 'port: 201' routing/lifecycle.js`.

🪤 **Канон §0.1 УСТАРЕЛ.** Он написан 2026-09-07 и не переписан: сейчас блок keepalive
идёт до `20166` (добавились 20163 AIPM, 20164 WisdomSatan, 20165 AIKeysAPI, 20166 rumeng).
«Следующий свободный 20163» неверно — 20163..20166 заняты. Единственный надёжный способ —
именно та команда, что в конце §0.1: `grep -n 'port: 201' routing/lifecycle.js`. Именно эту
граблю канон сам и помечает в шапке (стр. 21-22: «номера строк уехали»).

### Факт: форма константы порта — §1.1, дословно
> // Порт — ОДНА из двух форм, обе живут в файле. Сверить с соседями и брать ту же,
> // что у нового эталона (`grep -nE "^const [A-Z]+_KEEPALIVE_PORT" routing/transparent-proxy.js`):
> //   старая, без env:  const KK_KEEPALIVE_PORT = 20161;                     (ar, go, jw, sk, tb, xp, kk, ap)
> //   новая, с env:     const HN_KEEPALIVE_PORT = Number(process.env.HN_KEEPALIVE_PORT || 20162);  (hn, ak, rm, ts)
> // Брать НОВУЮ.
> const XX_KEEPALIVE_PORT = Number(process.env.XX_KEEPALIVE_PORT || PORT);

Грабля #27 (стр. 618) — то же требование с ценой ошибки: «Хендлер §1.2 … читает env всегда;
если константа env не читает, то при заданной переменной хендлер слушает порт из env, а
`XX_KEEPALIVE_PORT` / `XX_KEEPALIVE_URL` и роут Health остаются на `PORT` — отладка через env
молча уезжает в никуда».

### Факт: сверка «двух форм» с живым кодом (2026-09-15) — 12 констант, как в каноне
```
старая (без env): AR=20133, GO=20156, KK=20161, AP=20163, JW=20158, SK=20159, TB=20155, XP=20157  (8)
новая (с env):    HN||20162, AK||20165, RM||20166, TS||20160                                      (4)
```
Совпадает с разбивкой канона (ar/go/jw/sk/tb/xp/kk/ap — старые; hn/ak/rm/ts — новые). Числа не
сверял на дату канона, но состав форм тот же.

### Факт: сколько keepalive реально и требование к имени
Канон (стр. 330): «На 2026-09-13 в живом массиве 12 карт». Порты брать только из
`grep -nE "^const [A-Z]+_KEEPALIVE_PORT" routing/transparent-proxy.js` (12 констант, проверено).

**Как проверено:** `Read` `ADDING-A-GATEWAY.md` §0.1 (стр. 60-75), §1.1 (стр. 123-145),
шапка (14-33); `grep -nE "грабл|#27|KEEPALIVE_PORT"`; сверка с живым кодом
`grep -nE "^const [A-Z]+_KEEPALIVE_PORT" routing/transparent-proxy.js` (12 хитов).

---

## ДОПОЛНЕНИЕ: две непокрытые мины рядом с 20168

Резерв (`reservedPorts()`) защищает только `children()` + фолбэк, т.е. `20155…20165`.
Но фактически заняты ещё два соседних номера, которых в `children()` НЕТ:

| Порт | Кто занял | Где | В `reservedPorts()`? |
|---|---|---|---|
| `20166` | **rumeng keepalive** | `transparent-proxy.js:231,1493,17078` (`RM_KEEPALIVE_PORT`, `http://localhost:20166`) | ❌ НЕТ |
| `20167` | **fluxnat (план)** | `gateways.config.json:32`, фикстура `check-gateway-transform.js:57,97` | ❌ НЕТ |

Следствие: наивный «список свободного» из §2 (`…,20166,20167,20168,…`) даёт ложные 20166 и
20167. По-настоящему свободны: **20151–20154** и **20168 … 20250**. `20168` — первый чистый
номер после плана fluxnat и защищённого блока; брать его разумно.

**Как проверено:** `grep -rn 20166 routing/*.js`; `node -e` dump `children()`;
`Read` `gateways.config.json`; `grep -rn 20168` (в коде нет, только в recon-отчётах).
