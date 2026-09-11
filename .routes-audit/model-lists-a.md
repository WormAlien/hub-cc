# Модельные списки в tier-mapping UI — ar / go / kk / ap / hn

Файл: `routing/proxy-dashboard.html` (31806 строк). Read-only разбор.

Общая конструкция у всех пяти: в HTML лежит **пустой контейнер** `XX-modelmap-sel`
с заглушкой «загрузка…», а сами контролы генерит JS-функция `renderXxModelMap()`
строкой innerHTML. Поэтому в HTML искать `id="ar-mm-opus"` бесполезно — id
появляются только в рантайме.

Точка «когда» у всех одна и та же — ленивое открытие вкладки, строки 8607-8614:

```js
8607: if (name === 'agentrouter') { if (!state.loaded.agentrouter) { state.loaded.agentrouter = true; loadArSessions(false); } arLoadKeepalive(); }
8608: if (name === 'gorouter')    { if (!state.loaded.gorouter)    { ... loadGoSessions(false); } goLoadKeepalive(); }
8612: if (name === 'kktoken')     { if (!state.loaded.kktoken)     { ... loadKkSessions(false); } kkLoadKeepalive(); }
8613: if (name === 'aipm')        { if (!state.loaded.aipm)        { ... loadApSessions(false); } apLoadKeepalive(); }
8614: if (name === 'hcnsec')      { if (!state.loaded.hcnsec)      { ... loadHnSessions(false); } hnLoadKeepalive(); }
```

Т.е. **не на загрузку страницы**, а на первое открытие вкладки, и ровно один раз
(флаг `state.loaded.*`). Дальше — только кнопкой ↻.

Функция-хозяин — `showTab(name)` (8552). Оговорка про «не на загрузку страницы»
одна: в конце большого блока скриптов (26975-26986) вкладка восстанавливается из
localStorage —

```js
26978: let _tab = localStorage.getItem('opencode_active_tab') || 'claude';
26984: try { showTab(_tab); }
```

— поэтому если владелец ушёл со страницы, стоя на `kktoken`, то после F5 селекты
именно этой вкладки наполнятся на буте. Для остальных четырёх — нет. Дефолт
`claude`, так что по умолчанию ни один из пяти каталогов не грузится.

Автотик обновления моделей **не** касается намеренно: у каждого провайдера есть
`loadXxSessionsLight()`, и в ar-версии это записано прямым текстом (11871-11873):
«БЕЗ loadArModels/loadArModelMap — они ходят в апстрим, каждые 15с это перегруз
провайдера».

---

## ar — AgentRouter

**1. Контроль.** Четыре `<select>`, генерятся в `renderArModelMap()` (12002-12017):
`ar-mm-opus`, `ar-mm-sonnet`, `ar-mm-haiku`, `ar-mm-gpt` (последний подписан
«(gpt-* → цель)»). Контейнер — `<div id="ar-modelmap-sel">` (HTML, строка 6051).
Пустая опция рендерится как «— как есть —».

**2. Кто наполняет и откуда.** Две функции работают в паре:

| Функция | Строка | Endpoint | Что даёт |
|---|---|---|---|
| `loadArModels(force)` | 11889 | `GET /__switch/api/ar/models?api_key=<key>[&force=1]` | **каталог опций** → `state.arModels` |
| `loadArModelMap()` | 11992 | `GET /__switch/api/ar/modelmap` | текущие значения → `state.arModelMap` |

`loadArModels` перебирает ключи всех сессий (активный первым) и берёт первый
ответ, где `data.models?.length`. Затем `renderArModels()` (11909) в конце
вызывает `renderArModelMap()` (11936) — именно этот вызов наполняет селекты
каталогом.

Опции собираются объединением каталога и сохранённых значений (12006):
```js
const models = (state.arModels || []).map(m => m.id);
const opts = [...new Set(['', ...models, mm.opus, mm.sonnet, mm.haiku, mm.gpt].filter(v => typeof v === 'string'))];
```
Комментарий 12005 объясняет намерение: сохранённая цель всегда остаётся в
опциях, даже если её нет в каталоге.

**3. Когда наполняется.**
- Открытие вкладки `agentrouter` → `loadArSessions(false)` → внутри 11863-11864
  `loadArModels()` + `loadArModelMap()`. Один раз за жизнь страницы.
- Кнопка ↻ в шапке карточки маппинга: `onclick="loadArModels(true)"` (6049) —
  с `force=1`, т.е. мимо кеша сервера.
- Кнопки «↻ Обновить» / «📡 Пинг статусов» (6113-6114) → `loadArSessions()` →
  снова оба загрузчика.
- **Автотик НЕ наполняет намеренно:** `loadArSessionsLight()` (11874) с
  комментарием 11871-11873 «БЕЗ loadArModels/loadArModelMap — они ходят в
  апстрим, каждые 15с это перегруз провайдера».

🪤 **Дырка:** если ключей нет или все ключи не вернули моделей, `loadArModels`
выходит на 11895 (`return $('ar-models-list').innerHTML = 'нет ключей'`) —
`renderArModels` не вызывается, значит и `renderArModelMap()` из 11936 тоже.
Селекты останутся с тем, что нарисовал `loadArModelMap()`: только пустая опция
плюс уже сохранённые значения. Выбрать новую модель будет физически не из чего.

**4. Форма записи каталога.** Объект: `m.id` (11919, 12004) плюс
`m.supported_endpoint_types` — по нему считается бейдж «openai» (11923-11926).
Не строка.

**Сохранение:** `arSaveModelMap()` (12019) → `POST /__switch/api/ar/modelmap`,
тело `{opus, sonnet, haiku, gpt}`.

---

## go — GoRouter

Эталонная реализация: `renderArModelMap` ссылается на неё комментарием, все
остальные — копии с неё.

**1. Контроль.** Три `<select>`: `go-mm-opus`, `go-mm-sonnet`, `go-mm-haiku`
(14951). Тира `gpt`, в отличие от ar, нет. Контейнер `<div id="go-modelmap-sel">`
(HTML 6203).

**2. Кто наполняет и откуда.**

| Функция | Строка | Endpoint | Что даёт |
|---|---|---|---|
| `loadGoModels(force)` | 14523 | `GET /__switch/api/go/models?api_key=<key>[&force=1]` | каталог → `state.goModels` |
| `loadGoModelMap()` | 14929 | `GET /__switch/api/go/modelmap` | значения → `state.goModelMap` |

`renderGoModels()` (14543) завершается вызовом `renderGoModelMap()` (14565) с
прямым комментарием 14563-14564: «список моделей приехал — перерисовать селекты
маппинга, иначе они остаются с одной опцией "— как есть —" и выбрать цель
нечем».

Слияние каталога с сохранёнными значениями — 14946, и комментарий 14942-14945
описывает уже пойманный баг: `/go/models` ходит в апстрим и приезжает **позже**
локального modelmap, а select без своей `option` показывает «— как есть —», и
💾 Сохранить в этот момент затирал `gorouter-modelmap.json` null'ами.

**3. Когда наполняется.**
- Первое открытие вкладки `gorouter` → `loadGoSessions(false)` → 14502-14503
  `loadGoModels()` + `loadGoModelMap()`.
- Кнопка ↻ карточки маппинга — `onclick="loadGoModels(false)"` (6201). ⚠️ **Без
  `force`**, в отличие от ar (там `loadArModels(true)`): у go эта кнопка не
  обходит серверный кеш.
- «↻ Обновить» / «📡 Пинг статусов» (6268-6269) → `loadGoSessions()`.
- `loadGoSessionsLight()` (14510) моделей не трогает — так же, как у ar.

🪤 Та же дырка на 14529: нет ключей / все ключи пустые → `renderGoModels` не
вызывается → в селектах только сохранённые значения.

**4. Форма записи каталога.** Объект с `m.id` (14541, 14553). Бейджа
`supported_endpoint_types`, как у ar, здесь нет.

**Сохранение:** `goSaveModelMap()` (14959) → `POST /__switch/api/go/modelmap`,
тело `{opus, sonnet, haiku}`.

---

## kk — KKtoken

⚠️ **У kk и ap общий скоуп и общие имена функций — см. раздел «Коллизия
kk ↔ ap» ниже. Сначала прочитать его, потом уже эту таблицу.**

**1. Контроль.** Три `<select>`: `kk-mm-opus`, `kk-mm-sonnet`, `kk-mm-haiku`
(15485), рисует `renderKkModelMap()` (15473). Контейнер
`<div id="kk-modelmap-sel">` (HTML 6830). Заголовок карточки честно предупреждает
«каталог opus-only» (6827).

**2. Кто наполняет и откуда.**

| Функция | Строка | Endpoint | Что даёт |
|---|---|---|---|
| `loadKkModels(force)` | 15060 | `GET /__switch/api/kk/models?api_key=<key>[&force=1]` | каталог → `state.kkModels` |
| `loadKkModelMap()` | 15463 | `GET /__switch/api/kk/modelmap` | значения → `state.kkModelMap` |

Но **вызывается не эта `loadKkModelMap`, а её дубль на 15999** — см. ниже.
Каталог в селекты попадает через `renderKkModels()` → `renderKkModelMap()`
(15105).

**3. Когда наполняется.**
- Первое открытие вкладки `kktoken` → `loadKkSessions(false)` → 15040-15041.
- Кнопка ↻ карточки — `onclick="loadKkModels(false)"` (6828), без `force`.
- «↻ Обновить» / «📡 Пинг» (6898-6899).
- `loadKkSessionsLight()` (15048) моделей не трогает.

**4. Форма записи каталога.** Объект `m.id` (15075, 15090).

**Сохранение:** кнопка рисуется с `onclick='kkSaveModelMap()'` (15489) — и это
**не** функция на 15493, а дубль на 16029, пишущий в AIPM.

---

## Коллизия kk ↔ ap (главная находка)

Секция AIPM — копипаст секции KKtoken, в которой **не переименовали две функции и
три поля стейта**. Всё это лежит в **одном** `<script>` (8364-26987), поэтому
декларации функций хойстятся в общий скоуп и **побеждает последняя**:

| Имя | Первое определение (kk) | Второе определение (ap) | Кто реально вызывается |
|---|---|---|---|
| `loadKkModelMap` | 15463 → `/api/kk/modelmap`, рендер `renderKkModelMap` | **15999** → `/api/ap/modelmap`, рендер `renderApModelMap` | всегда 15999 |
| `kkSaveModelMap` | 15493 → читает `kk-mm-*`, POST `/api/kk/modelmap` | **16029** → читает `ap-mm-*`, POST `/api/ap/modelmap` | всегда 16029 |

Общий стейт (ap пишет в kk-переменные): `state.kkModels` (15617-15618),
`state.kkActiveModel` (15619, 15623), `state.kkModelMap` (16004, 16010, 16042).
У ap своих `state.apModels` / `state.apModelMap` **нет**.

Практические следствия:

1. **Открытие вкладки kktoken тянет карту AIPM.** 15041 `loadKkModelMap()` →
   уходит на `/__switch/api/ap/modelmap`, кладёт ответ в `state.kkModelMap`, и
   рисует `$('ap-modelmap-sel')` — контейнер **чужой** вкладки. Карточка на самой
   вкладке KK в этот момент остаётся с «загрузка…», пока её не перерисует
   `renderKkModels()` (15105) — уже значениями AIPM.
2. **💾 Сохранить на вкладке KK пишет файл AIPM.** Кнопка 15489 зовёт
   `kkSaveModelMap` = 16029: читает `$('ap-mm-opus'|'ap-mm-sonnet'|'ap-mm-haiku')`
   и POST'ит на `/__switch/api/ap/modelmap`. Если вкладку AIPM не открывали,
   этих элементов в DOM нет → `?.value || ''` даёт три пустые строки →
   **маппинг AIPM затирается пустым**, а `kktoken-modelmap.json` не меняется
   вообще. Ровно тот сценарий «затирал null'ами», от которого защищались
   комментарием 14942-14945 — защита обойдена мимо, через имя функции.
3. **Каталоги смешиваются.** Чья вкладка открыта второй, та и перетирает
   `state.kkModels`, а селекты обеих карт строятся из него (15475 и 16011).
4. `renderKkModelMap` (15473) и `renderApModelMap` (16009) — имена уникальные,
   поэтому сами рендеры не конфликтуют; ломает только пара load/save.
5. Комментарии в ap-блоке остались kk'шные (16012-16015 «/kk/models»,
   16014 «kktoken-modelmap.json»), title чипа AIPM тоже пишет про
   `kktoken-active-model.txt` (15633) — след копипаста.

---

## ap — AIPM

**1. Контроль.** Три `<select>`: `ap-mm-opus`, `ap-mm-sonnet`, `ap-mm-haiku`
(16021), рисует `renderApModelMap()` (16009). Контейнер
`<div id="ap-modelmap-sel">` (HTML 6989), заголовок тоже «каталог opus-only»
(6986).

**2. Кто наполняет и откуда.**

| Функция | Строка | Endpoint | Что даёт |
|---|---|---|---|
| `loadApModels(force)` | 15596 | `GET /__switch/api/ap/models?api_key=<key>[&force=1]` | каталог → пишет в **`state.kkModels`** (15617) |
| `loadKkModelMap()` (дубль ap) | 15999 | `GET /__switch/api/ap/modelmap` | значения → **`state.kkModelMap`** (16004) |

Своих `state.apModels` / `state.apModelMap` не существует. Каталог доезжает до
селектов через `renderApModels()` → `renderApModelMap()` (15641).

**3. Когда наполняется.**
- Первое открытие вкладки `aipm` (8613) → `loadApSessions(false)` → 15576-15577
  `loadApModels()` + `loadKkModelMap()` (которая = дубль 15999, т.е. по сути
  «loadApModelMap» под чужим именем — здесь она случайно работает правильно).
- Кнопка ↻ карточки — `onclick="loadApModels(false)"` (6987), без `force`.
- «↻ Обновить» / «📡 Пинг» (7057-7058).
- `loadApSessionsLight()` (15584) моделей не трогает.

**4. Форма записи каталога.** Объект `m.id` (15609, 15626).

**Сохранение:** `kkSaveModelMap()` = 16029 → `POST /__switch/api/ap/modelmap`.
Кнопка на вкладке AIPM (16025) работает верно; ломает обратное — кнопка на
вкладке KKtoken зовёт **эту же** функцию.

---

## hn — HCNsec

Единственный из пятёрки, где реализация доработана, а не скопирована один в один.

**1. Контроль.** Три `<select>`: `hn-mm-opus`, `hn-mm-sonnet`, `hn-mm-haiku`
(16757), рисует `renderHnModelMap()` (16738). Контейнер
`<div id="hn-modelmap-sel">` (HTML 7148).

Отличие: текст опции получает префикс-пометку качества (16752-16755) —
`🚫 ` для `HN_MODEL_BAD[id]`, `⚠ ` для `HN_MODEL_WARN[id]`. Комментарий
16750-16751: «селект это второе место, где негодную модель можно выбрать не
глядя». При сохранении негодная модель вызывает `confirm()` со списком причин
(16771-16772) — ни у ar/go/kk/ap такого подтверждения нет.

**2. Кто наполняет и откуда.**

| Функция | Строка | Endpoint | Что даёт |
|---|---|---|---|
| `loadHnModels(force)` | 16136 | `GET /__switch/api/hn/models?api_key=<key>[&force=1]` (16147) | каталог → `state.hnModels` (16198) |
| `loadHnModelMap()` | 16728 | `GET /__switch/api/hn/modelmap` | значения → `state.hnModelMap` |

Список опций строится не из сырого `state.hnModels`, а из `hnModelsSorted()`
(16192, вызов на 16742) — общий ранжир с плашками через `hnModelRank()`,
комментарий 16740-16741: «у трёх селектов и плашек над ними не должно быть двух
разных порядков на одном экране».

**3. Когда наполняется.**
- Первое открытие вкладки `hcnsec` (8614) → `loadHnSessions(false)` →
  16115-16116 `loadHnModels()` + `loadHnModelMap()`.
- Каталог доезжает через `renderHnModels()` (16197) → `renderHnModelMap()`
  (16231).
- Две кнопки ↻ с **разным** поведением: у карточки маппинга 7146
  `loadHnModels(false)` (без force), у карточки списка моделей 7205
  `loadHnModels(true)` (с force, мимо кеша). Единственный провайдер, где
  «force-обновление» спрятано не в той карточке, где селекты.
- «↻ Обновить» / «📡 Пинг» (7214-7215).

**4. Форма записи каталога.** Объект `m.id` (16193-16194, 16742); `id` ещё и
ключ в таблицах `HN_MODEL_BAD` / `HN_MODEL_WARN`.

**Сохранение:** `hnSaveModelMap()` (16765) → `POST /__switch/api/hn/modelmap`,
тело `{opus, sonnet, haiku}`, с предварительным `confirm` на негодные модели.
