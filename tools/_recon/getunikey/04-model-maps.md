# getunikey — префиксный путь `/model uk` и тир-карты

Разведчик: агент 04 (домен: префиксный путь + тир-карты). Кода не пишу.
Живой репо: `C:\Users\WormAlien\Desktop\Autoreger_Clean` (зеркало `D:\WORMALIENAIGIGANT\Autoreger_Clean` не трогаю).
Канон (читаю, не правлю): `wiki/abuse-hub/ADDING-A-GATEWAY.md`, «Маршруты — мэппинг тиров...», «Маршруты — своя тир-карта...».

## План

- [x] 1. `CC_MODEL_PREFIX` в `routing/transparent-proxy.js`: файл:строка, формат, сборка `/model <p>`, поведение при отсутствии записи
- [x] 2. Живые образцы карт: `*-modelmap.json` / `*-routes-modelmap.json` (kktoken, aipm) — структура JSON, обязательные ключи, смысл `default`
- [x] 3. `routeWriteTier` (`POST /__switch/api/routes/modelmap`): чтение/правка/запись, «соседа не стереть», mtime-чтение с диска
- [x] 4. Список моделей getunikey для тир-карты (только измеренные) + решение случая «нет sonnet» по образцу aikeysapi
- [x] 5. Проверка отсутствия `uk-modelmap.json` / `uk-routes-modelmap.json` в репо
- [x] 6. ФИНАЛ: обе готовые карты JSON + чем грозит пропуск

## Журнал

### Предстарт
- Факт: git status до работы — сторонние незакоммиченные правки уже есть (`routing/transparent-proxy.js`, `routing/lib/*` и др., включая новые файлы других агентов). Их не трогаю.
- Где: `C:\Users\WormAlien\Desktop\Autoreger_Clean` (branch `master`).
- Как проверено: `git status --porcelain`.

### Пункт 1. `CC_MODEL_PREFIX` и префиксный путь `/model <p>`
- Факт: таблица `CC_MODEL_PREFIX` — литерал-объект «длинное имя шлюза → короткий префикс файлов карт».
  Формат записи — плоская пара `имя: 'префикс'` (ключ = имя бэкенда в реестре, значение = префикс
  имён файлов `<prefix>-modelmap.json`). На 15.09 в таблице 16 записей, включая АЛИАС-ключи
  (`ak: 'aikeysapi'`), т.е. ключом может быть и короткий префикс.
- Факт: имя файла тир-карты выводится ЕДИНСТВЕННОЙ функцией `tierMapFile(name, routes)`
  (`transparent-proxy.js:896-900`): `CC_MODEL_PREFIX[name]` → `` `${prefix}${routes ? '-routes' : ''}-modelmap.json` ``.
  Больше нигде имя карты не собирается — второй таблицы имён намеренно нет.
- Факт: `/model <p>` без слэша разворачивается в front-door: `routeByModel()`
  (`frontdoor-proxy.js:381-422`) берёт `bare = model.trim().replace(/\s*\[[^\]]*\]\s*$/, '')` и ищет
  `reg.get(bare.toLowerCase())` в реестре `~/.claude/backends.json`. Нашлось → тир `default` →
  цель из `routesMapFor(state)`.
- Факт: реестр `backends.json` строит `writeBackendsRegistry()` (`transparent-proxy.js:737-800`);
  ключи = имена из `BACKENDS`, плюс алиасы из `BACKEND_ALIASES` (`transparent-proxy.js:698-704`,
  короткий → длинное имя, пишутся только если провайдер существует). Поле `modelmap` записи =
  `` `${prefix}-modelmap.json` `` (вывод из `CC_MODEL_PREFIX`, `registrySeedEntry()` `:723-732`).
  Значит `/model uk` требует ДВУХ вещей: ключ `uk` в реестре (через `BACKEND_ALIASES`) и запись
  `getunikey` в `CC_MODEL_PREFIX` со значением `uk` (иначе `tierMapFile` вернёт null).
- Факт: если запись в `CC_MODEL_PREFIX` отсутствует — `tierMapFile()` возвращает `null`,
  `registrySeedEntry()` кладёт `modelmap: null` в реестр (`:727`), и `routesMapFor()` возвращает
  `null` → `noMap: true`. То же самое, если записи `CC_MODEL_PREFIX` хватает, но ФАЙЛА
  `<prefix>-routes-modelmap.json` на диске нет: `readModelMap()` (`frontdoor-proxy.js:263-276`)
  на любую ошибку чтения (в т.ч. `ENOENT`) возвращает `null`.
- Факт: дословный текст 400 при `noMap` (`frontdoor-proxy.js:581-587`):
  `front-door: шлюз «<backend>» выбран префиксом, но реестр <REGISTRY_FILE> не указывает его тир-карту (modelmap: null), поэтому файл <префикс>-routes-modelmap.json не адресуется. Вкладка «Маршруты» тут НЕ виновата — значение default она читает напрямую и покажет его на месте. Починит запись переактивация шлюза в дашборде :8200 после перезапуска дашборда. Пока обходной путь — назвать модель явно: /model <backend>/<модель>`
- Факт: дословный текст 400 при «карта адресуется, но `default` пуст» (`frontdoor-proxy.js:590-593`):
  `front-door: шлюз «<backend>» выбран префиксом, но модель по умолчанию у него не задана. Открой дашборд :8200 → вкладка «Маршруты» → строка <backend> → селект «default». Либо назови модель явно: /model <backend>/<модель>`
  🪤 Нюанс: при ОТСУТСТВУЮЩЕМ файле routes-карты (но непустом `modelmap` в реестре) срабатывает
  ИМЕННО первый текст с формулировкой «реестр ... не указывает его тир-карту (modelmap: null)» —
  хотя `modelmap` в реестре не null, а файла просто нет. Диагноз в тексте неточен (в коде это один
  и тот же `mm === null`).
- Как проверено: `Read` `transparent-proxy.js:370-433, 697-800, 860-931, 976-992`;
  `Read` `frontdoor-proxy.js:205-282, 358-422, 570-608`; `grep -n "CC_MODEL_PREFIX\|tierMapFile\|BACKEND_ALIASES"`.

### Пункт 2. Структура тир-карт (живые образцы)
- Факт: карт ДВЕ на шлюз, форма одинаковая: `default`, `opus`, `sonnet`, `haiku`, `gpt`
  (`ROUTE_TIERS`, `transparent-proxy.js:871`).
  - `<prefix>-modelmap.json` — читается keepalive при запросе БЕЗ префикса (активный шлюз),
    правит вкладка ШЛЮЗА.
  - `<prefix>-routes-modelmap.json` — читается при запросе ЧЕРЕЗ префикс, правит вкладка «Маршруты».
- Факт: живые образцы (kktoken — репрезентативный, aikeysapi — случай «нет sonnet», aipm — «два разных»):
  - `routing/kktoken-modelmap.json`: `{"opus":"claude-opus-5","sonnet":"claude-opus-4-8","haiku":"claude-opus-4-8"}`
  - `routing/kktoken-routes-modelmap.json`: `{"default":"claude-opus-5","opus":"claude-opus-5","sonnet":"claude-opus-4-8","haiku":"claude-opus-4-8"}`
  - `routing/aikeysapi-modelmap.json`: `{"opus":"gpt-5.6-terra","sonnet":"gpt-5.6-terra","haiku":"gpt-5.6-terra"}`
  - `routing/aikeysapi-routes-modelmap.json`: то же + `"default":"gpt-5.6-terra"`
  - `routing/aipm-routes-modelmap.json`: `{"default":"claude-opus-4-6","opus":"claude-opus-4-6","sonnet":"claude-opus-4-6-thinking","haiku":"claude-sonnet-4-6"}`
- Факт: смысл ключей. `default` — цель для запроса, назвавшего ТОЛЬКО шлюз (`/model uk`, без модели);
  это ОТДЕЛЬНЫЙ ключ, а не переиспользование `opus` («CC попросил opus» ≠ «модель не названа»).
  `opus`/`sonnet`/`haiku` — цели для сабагентов, классифицируемых по имени запрошенной модели
  (`TIER_RE`, `frontdoor-proxy.js:253-257`). `gpt` — тир для gpt-подобных имён (в обычной карте
  заполнен только у `agentrouter`).
- Факт: формат файла — плоский JSON-объект строк; пустой тир пишется как `""`, а НЕ удалением ключа
  (`writeTierMap()`, `transparent-proxy.js:949-962`). Ключ `default` реально присутствует только в
  routes-картах; обычная карта обходится тремя ключами, недостающие `routeTierMap()` добивает пустой
  строкой (`:918-922`). Отсутствие ОБЫЧНОЙ карты = «провайдер не редактируется»; отсутствие
  routes-карты — не повод вернуть null для вкладки, но в front-door файл-то отсутствует и это 400.
- Как проверено: `cat` шести файлов карт в `routing/`; `Read` `transparent-proxy.js:863-923`;
  канон [[Маршруты — мэппинг тиров и каталог моделей]] § «Сделано (2026-09-13 21:14)» и
  [[Маршруты — своя тир-карта и имя без модели]] § «Две карты вместо одной».

### Пункт 3. `routeWriteTier` — ручка записи
- Факт: `function routeWriteTier(provider, tier, value)` — `transparent-proxy.js:976-992`.
  Ручка `POST /__switch/api/routes/modelmap` — `transparent-proxy.js:22898-22910`, тело `{provider, tier, value}`.
- Факт: как читает/меняет/пишет — через `writeTierMap(file, { [tier]: clean }, '')`
  (`transparent-proxy.js:949-962`): читает файл целиком (`JSON.parse`), правит ОДИН ключ, пишет
  назад `JSON.stringify(mm, null, 2) + '\n'`. Именно поэтому «стереть соседа нельзя ПО УСТРОЙСТВУ»
  (комментарий `:964-975`): ручка не собирает объект из тела, а точечно сливает правку с диском —
  промах/гонка двух вкладок не может потерять остальные три тира.
- Факт: право на редактирование даёт наличие ОБЫЧНОЙ карты (`routeTierMap(provider)`), иначе ответ
  `{ok:false, error: "провайдер '<p>' не редактируется: тир-карты у него нет"}` (`:979-981`);
  неизвестный тир → `тир '<t>' неизвестен (можно default, opus, sonnet, haiku, gpt)`.
- Факт: пишет в СВОЙ файл `<prefix>-routes-modelmap.json` (`tierMapFile(provider, true)`, `:980`).
- Факт: «карты читаются с диска по mtime — рестарт не нужен» подтверждается кешем `mapCache`
  (`frontdoor-proxy.js:261-276`): ключ кеша — абсолютный путь, сравнивается `st.mtimeMs`; правка
  файла меняет mtime → данные перечитываются на следующем запросе. То же у keepalive (кеш `Map` по
  пути, канон § «Сделано 2026-09-13»: «**Рестарт `:8200` не нужен**»).
- Как проверено: `Read` `transparent-proxy.js:925-992`; `grep -n "routes/modelmap"` (нашёл
  `:22898`); `Read` `frontdoor-proxy.js:258-276`; канон [[Маршруты — мэппинг тиров и каталог моделей]]
  § «Как писалось».

### Пункт 4. Модели getunikey для тир-карты
- Факт: ГОДНЫЕ (измерены живьём 15.09): `claude-opus-4-8` (потолок, 200), `claude-opus-4-7` (200),
  `claude-opus-4-6` (200), `claude-haiku-4-5-20251001` (200), `gpt-5.6-terra` (200),
  `z-ai/glm-5.2` (200, 1.9 с), `deepseek/deepseek-v4-flash` (200, но 15.3 с — медленно).
- Факт: ВЫКЛЮЧЕНЫ (ratio 37.5, ответ `400 Model ... has not been priced by the administrator yet`):
  `claude-opus-5`, `claude-sonnet-4-6`, `glm-5.2` (bare), `google/gemini-3.1-pro`.
  🪤 `google/gemini-3.1-pro-preview` отвечает 200, но с ПУСТЫМ `content` — в карту не ставить.
- Факт: **Sonnet-тира у провайдера нет вовсе** (оба sonnet-имени выключены), поэтому карта 1:1 не
  соберётся.
- Факт: как решён тот же случай у `aikeysapi` — все три тира (`opus`/`sonnet`/`haiku`) на ОДНУ
  модель: `{"opus":"gpt-5.6-terra","sonnet":"gpt-5.6-terra","haiku":"gpt-5.6-terra"}`
  (файл `routing/aikeysapi-modelmap.json`, вики [[Маршруты — мэппинг тиров и каталог моделей]]:
  строка таблицы «aikeysapi | gpt-5.6-terra | gpt-5.6-terra | gpt-5.6-terra | gpt-5.6-terra»).
  Прецедент «sonnet ведём не на sonnet-модель» есть и у kktoken/go/tabi (sonnet → `claude-opus-4-8`).
- Факт: рекомендация канона для getunikey ([[getunikey - тест ключа, прайс и грабли имен]] § «Грабли», п. 2):
  `opus` → `claude-opus-4-8`, `haiku` → `claude-haiku-4-5-20251001`, а `sonnet` придётся вести
  на `claude-opus-4-8` или на `gpt-5.6-terra` (как у aikeysapi).
- Как проверено: `Read` [[getunikey - тест ключа, прайс и грабли имен]]; `cat` `aikeysapi-modelmap.json`,
  `kktoken-routes-modelmap.json`, `aipm-routes-modelmap.json`; `Read` [[Маршруты — мэппинг тиров и каталог моделей]].

### Пункт 5. Файлов `uk-*` в репо нет
- Факт: `ls *uk*` в `routing/` → `No such file or directory`; `grep -rl "uk-modelmap\|uk-routes-modelmap"`
  по `routing/` → пусто. Ни `uk-modelmap.json`, ни `uk-routes-modelmap.json` не существуют.
- Факт: в `CC_MODEL_PREFIX` (16 записей) и `BACKEND_ALIASES` (15 записей) нет ни `uk`, ни `getunikey`;
  в реестре `~/.claude/backends.json` (провайдеры + алиасы) их тоже нет.
- Как проверено: `ls -la *uk*`, `grep -rl`, `Read` `transparent-proxy.js:408-425, 698-704`,
  `python -c "json.load(open(r'C:/Users/WormAlien/.claude/backends.json'))"` (список ключей).

### Журнал (продолжение)
- Факт: конфиг провайдера в панели отсутствует: `routing/custom-providers.json` его не содержит
  (со слов вики [[getunikey - тест ключа, прайс и грабли имен]]: 28 записей, getunikey = 0).
- Как проверено: чтение вики-страницы (сам файл 16 КБ не открывал — вне моего домена).

### Пункт 6 (финал). Готовые карты getunikey + последствия пропуска

Файлы (имена выводятся из `CC_MODEL_PREFIX['getunikey']`, т.е. значение обязано быть `uk`):

`routing/uk-modelmap.json` — карта вкладки ШЛЮЗА (запрос без префикса), 3 ключа, как у всех девяти:
```json
{
  "opus": "claude-opus-4-8",
  "sonnet": "claude-opus-4-8",
  "haiku": "claude-haiku-4-5-20251001"
}
```

`routing/uk-routes-modelmap.json` — карта вкладки «МАРШРУТЫ» (префиксный путь), 4 ключа,
`default` = цель opus (правило [[Маршруты — мэппинг тиров и каталог моделей]]):
```json
{
  "default": "claude-opus-4-8",
  "opus": "claude-opus-4-8",
  "sonnet": "claude-opus-4-8",
  "haiku": "claude-haiku-4-5-20251001"
}
```

Почему так:
- `opus` → `claude-opus-4-8`: единственный рабочий потолок (opus-5 выключен, а не «дорог»).
- `sonnet` → `claude-opus-4-8`: sonnet-тира у провайдера нет вовсе; прецеденты «тир ведём на
  не-sonnet модель» — aikeysapi (все три на одну) и kktoken/go/tabi (sonnet → opus-4-8).
- `haiku` → `claude-haiku-4-5-20251001`: единственная измеренная дешёвая модель (4.5 кредита/1k
  против 61.1 у opus, т.е. в 13.6 раза дешевле) — «haiku остаётся дешёвым» (вариант A владельца).
- 🪤 Оставлены ЗА БОРТОМ намеренно: `deepseek/deepseek-v4-flash` и `z-ai/glm-5.2` содержат СЛЭШ —
  канон [[Маршруты — мэппинг тиров и каталог моделей]] § «Открытый вопрос» прямо предупреждает,
  что имя со слэшем путается с префиксным роутингом (`aipm/claude-…` ≠ `anthropic/claude-…`).
  К тому же deepseek-4-flash измерен на 15.3 с (медленно). `gpt-5.6-terra` — рабочая альтернатива
  для `sonnet`/`haiku`, если владелец захочет не-opus sonnet (образец aikeysapi); в базовой
  рекомендации не берётся, потому что haiku обязан остаться дешёвым.
- ⚠️ Расхождение с каноном именования: `ADDING-A-GATEWAY.md` § 1.8b предписывает для нового шлюза
  `FULLNAME: 'FULLNAME'` (значение = полное имя, файлы `getunikey-modelmap.json`). Короткие значения
  в таблице есть (`agentrouter: 'ar'`, `ourtoken: 'ot'`, `conduit: 'cdt'`), поэтому `uk` канону не
  противоречит — но ТОГДА файлы обязаны зваться `uk-*`, а не `getunikey-*`, и `BACKEND_ALIASES`
  должен содержать `uk: 'getunikey'`, иначе `/model uk` не найдётся в реестре. Если взять
  полное имя — файлы `getunikey-modelmap.json`/`-routes-`, а команда будет `/model getunikey`.

Чем грозит пропуск (по убыванию тяжести):
1. 🔴 **Нет ключа `uk` в реестре (нет `BACKEND_ALIASES['uk']='getunikey'`) или нет `CC_MODEL_PREFIX['getunikey']='uk'`.**
   `reg.get('uk')` промахнётся → `routeByModel()` вернёт `null` → запрос **молча** уедет на АКТИВНЫЙ
   шлюз, т.е. на чужой баланс (комментарий `frontdoor-proxy.js:392-394`). Плюс без ключа `uk` в
   `CC_MODEL_PREFIX` не повесится `[1m]` → молчаливый даунгрейд окна до 200k.
2. 🔴 **Нет `uk-routes-modelmap.json`.** `readModelMap()` на отсутствующий файл возвращает `null` →
   `mm === null` → `noMap: true` → `/model uk` отвечает **400 «…не указывает его тир-карту
   (modelmap: null)…»** (дословный текст в п.1). Префиксный путь мёртв целиком — ровно то, что было
   у шести шлюзов до 13.09.
3. ⚠️ **Нет `uk-modelmap.json`.** `registrySeedEntry()` положит `modelmap: null` (если нет записи в
   `CC_MODEL_PREFIX`) → тот же 400; дополнительно `routeWriteTier()` откажет
   `провайдер 'getunikey' не редактируется: тир-карты у него нет` — вкладка «Маршруты» не даст
   сохранить ни одного тира, и завести routes-карту через штатную ручку будет нечем.
   🪤 Старый канон `ADDING-A-GATEWAY.md` § 3.9 знает ТОЛЬКО `<prefix>-modelmap.json` (написан до
   раскола карт 12.09) — идущий строго по нему заведёт одну карту из двух и получит сценарий 2.
4. ⚠️ **В карту попали выключенные модели** (`claude-opus-5`, `claude-sonnet-4-6`, `glm-5.2` bare,
   `google/gemini-3.1-pro`): каждый запрос тира → `400 Model … has not been priced by the
   administrator yet`. Хуже всех `google/gemini-3.1-pro-preview`: отвечает 200 с ПУСТЫМ `content` —
   выглядит рабочим, отдаёт пустоту ([[getunikey - тест ключа, прайс и грабли имен]] § Грабли п.5).

Порядок заведения (по канону): сначала обычная карта (§ 3.9, «файл — начальное значение»), затем
тиры routes-карты через `POST /__switch/api/routes/modelmap` (`{provider:'getunikey', tier, value}`) —
но ручка требует непустой обычной карты, поэтому порядок обязателен. Рестарт `:8200` не нужен:
карты читаются с диска по mtime ([[Маршруты — мэппинг тиров и каталог моделей]] § «Как писалось»).

### Проверка «репозиторий не изменён»
- Факт: `git status --porcelain` до и после — набор тот же (шесть чужих `M` + шесть чужих `??`,
  включая мой каталог отчёта `tools/_recon/getunikey/`). Ничего в репо я не правил и не создавал,
  кроме файла отчёта; чужих незакоммиченных правок не откатывал; POST на `/__switch/api/...` не делал.
- Как проверено: `git status --porcelain` (дважды), сравнение списков.


