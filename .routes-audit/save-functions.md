# Аудит save/load функций modelmap — routing/proxy-dashboard.html

Read-only. Файл: `C:\Users\WormAlien\Desktop\Autoreger_Clean\routing\proxy-dashboard.html` (31682 строк).
Цель: переиспользовать существующие per-provider save-функции во вкладке «Маршруты».

## Предварительная карта объявлений (grep)

```
11081:async function customSaveModelMap(providerId)
11967:async function loadArModelMap()
11994:async function arSaveModelMap()
14904:async function loadGoModelMap()
14934:async function goSaveModelMap()
15404:function kkSetBalance(api_key)          <-- #1
15438:async function loadKkModelMap()        <-- #1
15468:async function kkSaveModelMap()        <-- #1
15940:function kkSetBalance(api_key)         <-- #2 ДУБЛЬ
15974:async function loadKkModelMap()        <-- #2 ДУБЛЬ
16004:async function kkSaveModelMap()        <-- #2 ДУБЛЬ
16703:async function loadHnModelMap()
16740:async function hnSaveModelMap()
17254:async function loadJwModelMap()
17284:async function jwSaveModelMap()
17795:async function loadSkModelMap()
17825:async function skSaveModelMap()
18414:async function loadTsModelMap()
18444:async function tsSaveModelMap()
18943:async function loadTbModelMap()
18970:async function tbSaveModelMap()
19481:async function loadXpModelMap()
19508:async function xpSaveModelMap()
```

**Функций `apSaveModelMap` / `loadApModelMap` НЕ СУЩЕСТВУЕТ.** AIPM-клон переиспользовал имена `kk*` — это и есть коллизия.

---

## 1. agentrouter (ar)

| Поле | Значение |
|---|---|
| SAVE | `arSaveModelMap()` — строка **11994** |
| LOAD | `loadArModelMap()` — строка **11967** |
| Сигнатура | **Без аргументов.** Читает DOM по id: `ar-mm-opus`, `ar-mm-sonnet`, `ar-mm-haiku`, `ar-mm-gpt` |
| Endpoint | `POST /__switch/api/ar/modelmap` |
| Тиры | **Все 4, включая `gpt`** |

Тело запроса (дословно):

```js
body: JSON.stringify({ opus: mm.opus, sonnet: mm.sonnet, haiku: mm.haiku, gpt: mm.gpt }),
```

Сбор значений:

```js
const mm = {
  opus: $('ar-mm-opus')?.value || '',
  sonnet: $('ar-mm-sonnet')?.value || '',
  haiku: $('ar-mm-haiku')?.value || '',
  gpt: $('ar-mm-gpt')?.value || '',
};
```

После успеха:
- пишет `state.arModelMap = data.modelMap || mm`
- `toast('✓ маппинг сохранён — прокси :20132/:20133 применит без рестарта', 'success', 4000)`
- **НЕ вызывает re-render.** `renderArModelMap()` не дёргается → DOM-селекты не перерисовываются.

LOAD `loadArModelMap()`: `GET /__switch/api/ar/modelmap` → `state.arModelMap = data.modelMap || {}` → вызывает `renderArModelMap()`.
Рендер `renderArModelMap()` (11977) пишет в контейнер **`ar-modelmap-sel`** (`$('ar-modelmap-sel').innerHTML`), создаёт селекты `ar-mm-{opus,sonnet,haiku,gpt}` и кнопку `onclick='arSaveModelMap()'`.

⚠️ Для вкладки «Маршруты»: функция жёстко привязана к id `ar-mm-*`. Если на новой вкладке будут другие id — вызов по имени соберёт пустые строки (`?.value || ''`) и **затрёт маппинг пустыми значениями**, ошибки не будет.

---

## 2. gorouter (go)

| Поле | Значение |
|---|---|
| SAVE | `goSaveModelMap()` — строка **14934** |
| LOAD | `loadGoModelMap()` — строка **14904** |
| Сигнатура | **Без аргументов.** DOM по id: `go-mm-opus`, `go-mm-sonnet`, `go-mm-haiku` |
| Endpoint | `POST /__switch/api/go/modelmap` |
| Тиры | **Только 3 — `gpt` НЕТ** |

Тело запроса (дословно):

```js
body: JSON.stringify({ opus: mm.opus, sonnet: mm.sonnet, haiku: mm.haiku }),
```

После успеха:
- `state.goModelMap = data.modelMap || mm`
- `toast('✓ маппинг сохранён', 'success', 4000)`
- **re-render НЕТ.**

LOAD: `GET /__switch/api/go/modelmap` → `state.goModelMap` → `renderGoModelMap()` (14914), контейнер **`go-modelmap-sel`**, селекты `go-mm-*`, кнопка `onclick='goSaveModelMap()'`.

📌 Важный комментарий в коде (14917-14920) — известные грабли этого класса функций:
> «Сохранённые цели держим в опциях ВСЕГДА: /go/models ходит в апстрим и приезжает позже локального modelmap, а select без своей option показывает «— как есть —», т.е. маппинг выглядит выключённым, хотя gorouter-modelmap.json на месте (и 💾 Сохранить в этот момент затирал его null'ами).»

То есть **гонка «каталог моделей ещё не приехал → save затирает конфиг»** уже была и лечилась на уровне рендера, а не save. Автосохранение по выбору наследует тот же риск: если новая вкладка отрисует селекты до загрузки каталога, autosave затрёт маппинг.

---

## 3. kktoken (kk) — ⚠️ ЗАТЕНЁН ДУБЛЁМ

**Реальная KK-версия (kktoken.cc):**

| Поле | Значение |
|---|---|
| SAVE | `kkSaveModelMap()` — строка **15468** (первое объявление) |
| LOAD | `loadKkModelMap()` — строка **15438** (первое объявление) |
| Сигнатура | Без аргументов. DOM: `kk-mm-opus`, `kk-mm-sonnet`, `kk-mm-haiku` |
| Endpoint | `POST /__switch/api/kk/modelmap` |
| Тиры | **Только 3 — `gpt` НЕТ** |
| state | `state.kkModelMap`, `state.kkModels` |

Тело (дословно):

```js
body: JSON.stringify({ opus: mm.opus, sonnet: mm.sonnet, haiku: mm.haiku }),
```

Рендер `renderKkModelMap()` (15448) → контейнер **`kk-modelmap-sel`**, селекты `kk-mm-*`, кнопка `onclick='kkSaveModelMap()'`. После успеха: `toast('✓ маппинг сохранён', 4000)`, re-render НЕТ.

🔴 **ЭТО ОБЪЯВЛЕНИЕ МЁРТВОЕ.** Ниже (15974/16004) идёт второе `function loadKkModelMap`/`kkSaveModelMap` — при дублировании `function`-деклараций побеждает **последнее**. Глобальные `loadKkModelMap` и `kkSaveModelMap` указывают на AIPM-версию. Кнопка KK-вкладки `onclick='kkSaveModelMap()'` (15464) на деле сохраняет в **AIPM** (`/ap/modelmap`), читая `ap-mm-*`. Плюс AIPM-версия пишет в **тот же** `state.kkModelMap` — состояние KK затирается тоже.

**Вывод по KK: вызвать корректную KK-функцию по имени НЕЛЬЗЯ** — имя перехвачено. Нужен либо ренейм (`kkSaveModelMap`→уникальное), либо отдельный путь сохранения для KK.

---

## 4. aipm (ap) — ⚠️ КЛОН, ПЕРЕХВАТИЛ ИМЕНА KK

**Провайдер `emtf.aipm9527.online`. Функции названы как у KK — это и есть источник коллизии.**

| Поле | Значение |
|---|---|
| SAVE | `kkSaveModelMap()` — строка **16004** (второе объявление, ПОБЕЖДАЕТ) |
| LOAD | `loadKkModelMap()` — строка **15974** (второе объявление, ПОБЕЖДАЕТ) |
| SetBalance | `kkSetBalance()` — строка **15940** (второе, побеждает; зовёт `newapiSetBalanceUI('ap', ...)`) |
| Сигнатура | Без аргументов. DOM: `ap-mm-opus`, `ap-mm-sonnet`, `ap-mm-haiku` |
| Endpoint | `POST /__switch/api/ap/modelmap` |
| Тиры | **Только 3 — `gpt` НЕТ** |
| state | `state.kkModelMap`, `state.kkModels` (переиспользует KK-state!) |

Тело (дословно):

```js
body: JSON.stringify({ opus: mm.opus, sonnet: mm.sonnet, haiku: mm.haiku }),
```

Рендер — **`renderApModelMap()`** (15984, имя уникально, не коллидит) → контейнер **`ap-modelmap-sel`** (объявлен в HTML на строке 6964), селекты `ap-mm-*`, кнопка `onclick='kkSaveModelMap()'` (цвет indigo, не emerald). После успеха: `toast('✓ маппинг сохранён', 4000)`, re-render НЕТ.

**Вывод по AIPM: функция вызывается по имени `kkSaveModelMap()`** (не `apSaveModelMap` — такого имени нет). Именно AIPM-версия — «живая» глобальная. Уникальные для AIPM имена: `renderApModelMap`, `apMapProfiles`, `apOpenLk`, `apCopyKey`.

---

## 5. hcnsec (hn) — 🔴 содержит блокирующий `confirm()`

| Поле | Значение |
|---|---|
| SAVE | `hnSaveModelMap()` — строка **16740** |
| LOAD | `loadHnModelMap()` — строка **16703** |
| Сигнатура | Без аргументов. DOM: `hn-mm-opus`, `hn-mm-sonnet`, `hn-mm-haiku` |
| Endpoint | `POST /__switch/api/hn/modelmap` |
| Тиры | **Только 3 — `gpt` НЕТ** |

Тело (дословно):

```js
body: JSON.stringify({ opus: mm.opus, sonnet: mm.sonnet, haiku: mm.haiku }),
```

🔴 **Уникальное отличие — модальный `confirm()` перед отправкой (16746-16747):**

```js
const bad = ['opus', 'sonnet', 'haiku'].filter(t => HN_MODEL_BAD[mm[t]]);
if (bad.length && !confirm(`В тир-карту выбраны негодные модели:\n\n${bad.map(t => `${t} → ${mm[t]}: ${HN_MODEL_BAD[mm[t]]}`).join('\n')}\n\nВсё равно сохранить?`)) return;
```

**Для autosave-по-выбору это мина:** выбор «плохой» модели повесит модальный диалог браузера на каждое изменение селекта, а отказ — тихий `return` без тоста, то есть пользователь увидит выбранное значение в UI, но на диске его не будет.

Рендер `renderHnModelMap()` (16713) → контейнер **`hn-modelmap-sel`**, селекты `hn-mm-*`, кнопка `onclick='hnSaveModelMap()'`. Опции помечаются `🚫`/`⚠` из `HN_MODEL_BAD` / `HN_MODEL_WARN`, порядок — из `hnModelsSorted()`.
После успеха: `state.hnModelMap`, `toast('✓ маппинг сохранён', 4000)`, re-render НЕТ.

---

> ⚠️ **ВНИМАНИЕ по номерам строк.** В начале аудита живой файл был изменён сторонним
> процессом (в `.routes-audit/` параллельно писались `handlers-a.md` / `handlers-b.md` —
> в репо работают другие агенты), и все строки уехали +25. Номера ниже **перепроверены
> против живого `routing/proxy-dashboard.html`** после сдвига: все 17 функций совпадают
> один-в-один (проверка `grep -nE '^(async )?function <имя>'`, 31806 строк,
> mtime 2026-09-11 04:25:37). Промежуточный снимок `_snapshot.html` удалён сторонним
> процессом и больше не нужен.
>
> 🪤 Файл продолжает активно меняться. **Надёжный якорь — имя функции и endpoint, не номер
> строки**: перед правкой перегрепать.

Пересчитанные (и подтверждённые в живом файле) номера для описанных выше: ar load **11992** / save **12019**; go load **14929** / save **14959**; kk load **15463** / save **15493**; ap load **15999** / save **16029**; hn load **16728** / save **16765**.

---

## 6. justwoker (jw)

| Поле | Значение |
|---|---|
| SAVE | `jwSaveModelMap()` — снимок **17309** |
| LOAD | `loadJwModelMap()` — снимок **17279** |
| Сигнатура | Без аргументов. DOM: `jw-mm-opus`, `jw-mm-sonnet`, `jw-mm-haiku` |
| Endpoint | `POST /__switch/api/jw/modelmap` |
| Тиры | **Только 3 — `gpt` НЕТ** |

Тело (дословно):

```js
body: JSON.stringify({ opus: mm.opus, sonnet: mm.sonnet, haiku: mm.haiku }),
```

Рендер `renderJwModelMap()` (снимок 17289) → контейнер **`jw-modelmap-sel`**, селекты `jw-mm-*`, кнопка `onclick='jwSaveModelMap()'`. После успеха: `state.jwModelMap`, `toast('✓ маппинг сохранён', 4000)`, re-render НЕТ. Чистая копия go, без особенностей.

---

## 7. seekai (sk)

| Поле | Значение |
|---|---|
| SAVE | `skSaveModelMap()` — снимок **17850** |
| LOAD | `loadSkModelMap()` — снимок **17820** |
| Сигнатура | Без аргументов. DOM: `sk-mm-opus`, `sk-mm-sonnet`, `sk-mm-haiku` |
| Endpoint | `POST /__switch/api/sk/modelmap` |
| Тиры | **Только 3 — `gpt` НЕТ** |

Тело (дословно):

```js
body: JSON.stringify({ opus: mm.opus, sonnet: mm.sonnet, haiku: mm.haiku }),
```

Рендер `renderSkModelMap()` (17830) → контейнер **`sk-modelmap-sel`**, кнопка `onclick='skSaveModelMap()'`. После успеха: `state.skModelMap`, `toast('✓ маппинг сохранён', 4000)`, re-render НЕТ. Чистая копия go.

---

## 8. truesota (ts)

| Поле | Значение |
|---|---|
| SAVE | `tsSaveModelMap()` — снимок **18469** |
| LOAD | `loadTsModelMap()` — снимок **18439** |
| Сигнатура | Без аргументов. DOM: `ts-mm-opus`, `ts-mm-sonnet`, `ts-mm-haiku` |
| Endpoint | `POST /__switch/api/ts/modelmap` |
| Тиры | **Только 3 — `gpt` НЕТ** |

Тело (дословно):

```js
body: JSON.stringify({ opus: mm.opus, sonnet: mm.sonnet, haiku: mm.haiku }),
```

Рендер `renderTsModelMap()` (18449) → контейнер **`ts-modelmap-sel`**, кнопка `onclick='tsSaveModelMap()'`. После успеха: `state.tsModelMap`, `toast('✓ маппинг сохранён', 4000)`, re-render НЕТ. Структура go; особенности truesota (opus-only, Kiro-реселл) живут в списке моделей, не в save-функции.

---

## 9. tabi (tb)

| Поле | Значение |
|---|---|
| SAVE | `tbSaveModelMap()` — снимок **18995** |
| LOAD | `loadTbModelMap()` — снимок **18968** |
| Сигнатура | Без аргументов. DOM: `tb-mm-opus`, `tb-mm-sonnet`, `tb-mm-haiku` |
| Endpoint | `POST /__switch/api/tb/modelmap` |
| Тиры | **Только 3 — `gpt` НЕТ** |

Тело (дословно):

```js
body: JSON.stringify({ opus: mm.opus, sonnet: mm.sonnet, haiku: mm.haiku }),
```

Рендер `renderTbModelMap()` (18978) → контейнер **`tb-modelmap-sel`**, кнопка `onclick='tbSaveModelMap()'`. После успеха: `state.tbModelMap`, `toast('✓ маппинг сохранён', 4000)`, re-render НЕТ. Чистая копия go.

---

## 10. xpeach (xp) — 🔴 содержит блокирующий `confirm()`

| Поле | Значение |
|---|---|
| SAVE | `xpSaveModelMap()` — снимок **19533** |
| LOAD | `loadXpModelMap()` — снимок **19506** |
| Сигнатура | Без аргументов. DOM: `xp-mm-opus`, `xp-mm-sonnet`, `xp-mm-haiku` |
| Endpoint | `POST /__switch/api/xp/modelmap` |
| Тиры | **Только 3 — `gpt` НЕТ** |

Тело (дословно):

```js
body: JSON.stringify({ opus: mm.opus, sonnet: mm.sonnet, haiku: mm.haiku }),
```

🔴 **Модальный `confirm()` перед отправкой (19540-19542):**

```js
const bad = ['opus', 'sonnet', 'haiku'].filter(t => XP_DEAD_MODELS[mm[t]]);
if (bad.length && !confirm(`Цель ${bad.map(t => `${t}→${mm[t]}`).join(', ')} нерабочая на xpeach.codes:\n\n`
  + bad.map(t => XP_DEAD_MODELS[mm[t]]).join('\n') + `\n\nМаппинг перебьёт выбранную модель. Всё равно сохранить?`)) return;
```

Тот же риск для autosave, что у hcnsec: модалка на каждый выбор мёртвой модели + тихий `return` при отказе.

Рендер `renderXpModelMap()` (19516) → контейнер **`xp-modelmap-sel`**, кнопка `onclick='xpSaveModelMap()'`. Опции метятся `💀 нет канала` из `XP_DEAD_MODELS`, пустая опция подписана `— как есть — (дефолт)`. После успеха: `state.xpModelMap`, `toast('✓ маппинг сохранён', 4000)`, re-render НЕТ.

---

## Бонус: generic `customSaveModelMap(providerId)` — снимок **11106**

**Единственная save-функция, принимающая аргумент.** Не подходит как замена десяти именованных: она обслуживает подсистему «custom» (`state.custom[]`), а не именованные шлюзы.

- Сигнатура: `customSaveModelMap(providerId)` — читает DOM `custom-mm-${providerId}-{opus,sonnet,haiku}` (с `.trim()`).
- Endpoint: `POST /__switch/api/custom/modelmap`, тело `JSON.stringify({ providerId, ...mm })` — **3 тира, без gpt**.
- После успеха: `toast(...)` + **`loadCustomProviders()`** (единственная save-функция с re-render'ом).

Полезна как образец «save с аргументом + перезагрузка», если для вкладки «Маршруты» захочется единый параметризованный сейвер вместо десяти хардкод-функций. Но endpoint у неё общий (`/custom/`), не `/ar/`, `/go/` и т.д.

---

## 🔴 ВЕРДИКТ ПО КОЛЛИЗИИ ИМЁН — ПОДТВЕРЖДЕНО, ХУЖЕ ЧЕМ В ОТЧЁТЕ

AIPM-клон (`emtf.aipm9527.online`) был скопирован из вкладки KKtoken и **три идентификатора не переименовал**. Все объявления — обычные `function`-декларации в **одном** `<script>` (строки 8364–26983 снимка), то есть одна глобальная область: **при дублировании последняя декларация перезаписывает первую.** AIPM идёт ниже KK → **AIPM-версия побеждает во всех случаях.**

Найдено **ЧЕТЫРЕ** дубля, а не три (отчёт пропустил `kkPoolStats`):

| Имя | Объявление #1 (KK, мёртвое) | Объявление #2 (AIPM, живое) | Вред |
|---|---|---|---|
| `kkSetBalance` | **15429** → `newapiSetBalanceUI('kk', state.kktoken)` | **15965** → `newapiSetBalanceUI('ap', state.aipm)` | 🔴 да |
| `loadKkModelMap` | **15463** → `/kk/modelmap`, `renderKkModelMap` | **15999** → `/ap/modelmap`, `renderApModelMap` | 🔴 да |
| `kkSaveModelMap` | **15493** → `/kk/modelmap`, `kk-mm-*` | **16029** → `/ap/modelmap`, `ap-mm-*` | 🔴 да |
| `kkPoolStats` | **14991** | **15527** | 🟢 нет (тела идентичны, чистая функция) |

*(Номера строк подтверждены в живом файле после стороннего сдвига +25; файл продолжает меняться — сверяться по имени функции, а не по номеру.)*

### Что реально сломано на вкладке KKtoken (blast radius)

1. **Баланс.** Карточка KK рисует кнопку `onclick='kkSetBalance(...)'` (общий рендер `newapiBalanceCell`, `prov='kk'`, снимок 13164). Глобальный `kkSetBalance` = AIPM → нажатие правит баланс **аккаунта AIPM** в `state.aipm`, а не KKtoken.
2. **Загрузка маппинга.** KK-вкладка при инициализации зовёт `loadKkModelMap()` (снимок 15041). Глобальный = AIPM (15999): тянет `/ap/modelmap`, кладёт в `state.kkModelMap`, рисует в `ap-modelmap-sel`. Контейнер KK `kk-modelmap-sel` своим загрузчиком не наполняется, а `state.kkModelMap` заражён данными AIPM.
3. **Сохранение маппинга.** Кнопка 💾 KK (`onclick='kkSaveModelMap()'`, снимок 15489) вызывает AIPM-версию (16029): читает `ap-mm-*`, пишет в `/ap/modelmap`. Правки тир-карты KKtoken уходят в AIPM.

> `renderKkModelMap` (15473) НЕ затёрт (имя уникально) и всё ещё вызывается из `renderKkModels` (15105), поэтому селекты KK на экране появляются — но заполняются из заражённого `state.kkModelMap`, а их кнопка/загрузчик ведут в AIPM. Итог — тихая перекрёстная порча, ровно как в отчёте.

### Практический вывод для вкладки «Маршруты»

- **Звать `arSaveModelMap`, `goSaveModelMap`, `hnSaveModelMap`, `jwSaveModelMap`, `skSaveModelMap`, `tsSaveModelMap`, `tbSaveModelMap`, `xpSaveModelMap` по имени — безопасно.** Имена уникальны.
- **`kkSaveModelMap` по имени = сохранит в AIPM (`/ap/`), НЕ в KKtoken.** Для AIPM это и есть штатный вызов (своего `apSaveModelMap` нет). Для KKtoken по имени вызвать корректный сейвер **невозможно** до ренейма.
- **Чтобы починить и получить callable KK-функцию:** переименовать второй блок (AIPM) в `apSetBalance` / `loadApModelMap` / `apSaveModelMap` / `apPoolStats` и поправить его call-sites (15548 `kkPoolStats`→`apPoolStats`, 15577 `loadKkModelMap`→`loadApModelMap`, кнопка 16025 `kkSaveModelMap`→`apSaveModelMap`; карточка AIPM-баланса рисуется с `prov='ap'` → уже ждёт `apSetBalance`). После ренейма имя `kkSaveModelMap` вернётся к KK-версии.
- **Мины автосохранения (не связаны с коллизией):** `hnSaveModelMap` (снимок 16765) и `xpSaveModelMap` (снимок 19533) содержат блокирующий `confirm()` при выборе негодной модели, с тихим `return` при отказе. Autosave-по-выбору с ними даст модалку на каждый select и рассинхрон UI↔диск.

---

## Итоговая таблица (номера строк подтверждены в живом `routing/proxy-dashboard.html`, 31806 строк)

| # | Провайдер | SAVE (строка) | LOAD (строка) | Аргументы | Endpoint | Тиры | `gpt`? | Контейнер / кнопка | После успеха |
|---|---|---|---|---|---|---|---|---|---|
| 1 | agentrouter (ar) | `arSaveModelMap` (12019) | `loadArModelMap` (11992) | нет, DOM `ar-mm-*` | `POST /__switch/api/ar/modelmap` | 4 | ✅ да | `ar-modelmap-sel` / `arSaveModelMap()` | state + toast, без re-render |
| 2 | gorouter (go) | `goSaveModelMap` (14959) | `loadGoModelMap` (14929) | нет, DOM `go-mm-*` | `POST /__switch/api/go/modelmap` | 3 | ❌ | `go-modelmap-sel` / `goSaveModelMap()` | state + toast, без re-render |
| 3 | kktoken (kk) | `kkSaveModelMap` (15493) 🔴 затёрт | `loadKkModelMap` (15463) 🔴 затёрт | нет, DOM `kk-mm-*` | `POST /__switch/api/kk/modelmap` | 3 | ❌ | `kk-modelmap-sel` / `kkSaveModelMap()` | state + toast, без re-render |
| 4 | aipm (ap) | `kkSaveModelMap` (16029) ✅ живой | `loadKkModelMap` (15999) ✅ живой | нет, DOM `ap-mm-*` | `POST /__switch/api/ap/modelmap` | 3 | ❌ | `ap-modelmap-sel` / `kkSaveModelMap()` | state (`kkModelMap`!) + toast, без re-render |
| 5 | hcnsec (hn) | `hnSaveModelMap` (16765) | `loadHnModelMap` (16728) | нет, DOM `hn-mm-*` | `POST /__switch/api/hn/modelmap` | 3 | ❌ | `hn-modelmap-sel` / `hnSaveModelMap()` | 🔴 `confirm()`; state + toast, без re-render |
| 6 | justwoker (jw) | `jwSaveModelMap` (17309) | `loadJwModelMap` (17279) | нет, DOM `jw-mm-*` | `POST /__switch/api/jw/modelmap` | 3 | ❌ | `jw-modelmap-sel` / `jwSaveModelMap()` | state + toast, без re-render |
| 7 | seekai (sk) | `skSaveModelMap` (17850) | `loadSkModelMap` (17820) | нет, DOM `sk-mm-*` | `POST /__switch/api/sk/modelmap` | 3 | ❌ | `sk-modelmap-sel` / `skSaveModelMap()` | state + toast, без re-render |
| 8 | truesota (ts) | `tsSaveModelMap` (18469) | `loadTsModelMap` (18439) | нет, DOM `ts-mm-*` | `POST /__switch/api/ts/modelmap` | 3 | ❌ | `ts-modelmap-sel` / `tsSaveModelMap()` | state + toast, без re-render |
| 9 | tabi (tb) | `tbSaveModelMap` (18995) | `loadTbModelMap` (18968) | нет, DOM `tb-mm-*` | `POST /__switch/api/tb/modelmap` | 3 | ❌ | `tb-modelmap-sel` / `tbSaveModelMap()` | state + toast, без re-render |
| 10 | xpeach (xp) | `xpSaveModelMap` (19533) | `loadXpModelMap` (19506) | нет, DOM `xp-mm-*` | `POST /__switch/api/xp/modelmap` | 3 | ❌ | `xp-modelmap-sel` / `xpSaveModelMap()` | 🔴 `confirm()`; state + toast, без re-render |

**Общее для всех десяти:** без аргументов, значения читаются из DOM `<select>` по фиксированным id; тело POST — `{opus, sonnet, haiku[, gpt]}`; на успехе только `state.<p>ModelMap = data.modelMap || mm` + `toast('✓ маппинг сохранён', 4000)`; **re-render НЕ вызывается** (кроме generic `customSaveModelMap`). Только **agentrouter** отправляет 4-й тир `gpt`; остальные девять — три тира.
