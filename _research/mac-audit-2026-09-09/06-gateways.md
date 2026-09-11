# Аудит мак-совместимости — зона 6: денежные шлюзы и провайдеры

**Агент:** 6/10
**Дата:** 2026-09-09
**Зона:** `agentrouter/`, `gorouter/`, `justwoker/`, `anymodel/`, `aipm/`, `freemodel/`, `ourtoken/`, `kktoken/`, `vyceai/`, `seekai/`, `truesota/`, `helpcoder/`, `svrtr/`, `tabi/`, `cun/`, `hcnsec/`
**Исключено по заданию:** `xpeach/` (легаси), `*/accounts/`, `*/sessions/`, `*/gh-sessions/` (личные данные)
**Метод:** статический аудит по коду, Мака под рукой нет.

---

## Что уже прикрыто шимами

`mac-support/shims/` содержит: `clip.exe` → `pbcopy`, `curl.exe` → `curl`, `netstat` → `lsof`-эмуляция формата `-ano`,
`python`/`python.exe` → `python3`, `taskkill` → `kill -9` / `pkill -9 -x`.

**НЕ прикрыто шимами:** `tasklist`, `wmic`, `powershell`, `cmd /c`, `chcp`, `where.exe`, `findstr`, `start`,
пути к браузерам, пути к профилям Chrome, DPAPI-шифрование в профилях.

---

## Карта платформозависимого кода (план)

Главный вывод карты: **в самих каталогах шлюзов платформозависимого кода почти нет.**
`grep` по `process.platform|win32|darwin` во всех 16 каталогах даёт **одно** попадание —
`ourtoken/camoufox_autoreg.py:27`. Ни одного `taskkill`/`wmic`/`powershell`/`chrome.exe`/`C:\`
в JS-коде шлюзов. Пути везде через `path.join(__dirname, ...)`.

Поэтому риск сместился в три места, и аудит идёт по ним:

| Слой | Где | Почему опасен |
|---|---|---|
| **Профили Chromium на диске** | `*/profiles/<label>/` во всех шлюзах | залиты на Windows, ключ куки — DPAPI |
| **Camoufox + Python** | `anymodel/`, `freemodel/`, `ourtoken/`, `cun/` | свой рантайм браузера, arm64, `sys.platform` |
| **Общая библиотека** | `routing/lib/*.js` (вызывается из шлюзов) | там и живёт весь `powershell`/DPAPI |

Разбор клонов: `open-session.js` / `share-session.js` продублированы в 9 шлюзах
(agentrouter, gorouter, justwoker, aipm, kktoken, seekai, truesota, tabi, hcnsec).
Диффы между ними — только домены, регэкспы и селекторы. **Платформозависимых расхождений
между клонами нет ни одного**, поэтому находки по ним общие для всех девяти.

---

## Находки

### [BROKEN] Профили Chromium зашифрованы Windows-DPAPI — на маке сессии не читаются

- **Где:** `agentrouter/profiles/*/Local State` (и так же в `gorouter/`, `justwoker/`, `aipm/`,
  `kktoken/`, `seekai/`, `truesota/`, `tabi/`, `hcnsec/`); потребитель — `routing/lib/newapi-account.js:626`
  `readProfileCookies()`, вызывается из точного баланса и из `harvestCookiesToJar()`
  (`agentrouter/open-session.js:830`).
- **Что происходит на маке:** перенесённые профили открываются, но все сохранённые куки —
  и GitHub-сессия, и сессия шлюза — не расшифровываются. Точный баланс молча падает в
  прикидку (`guessGrant`), «вход одним кликом» через `user_session` не работает, автоподарок
  `autocheckin` выходит с кодом 3 «GitHub-сессия в профиле мертва».
- **Почему:** замерено на живом профиле — `Local State` → `os_crypt.encrypted_key` после
  base64 начинается байтами `DPAPI`. Это Windows-схема: AES-256-ключ обёрнут
  `CryptProtectData` под учётку **этого** пользователя Windows. На маке Chromium берёт ключ
  совсем иначе — PBKDF2-SHA1 от пароля из Keychain, и значение шифрует AES-128-CBC, а не
  AES-256-GCM. Код это уже знает (`newapi-account.js:431` `IS_MAC`, `macDecryptCookie:445`),
  но подобрать Windows-ключ мак-ветка не может **в принципе**: DPAPI-блоб не расшифровывается
  ничем, кроме исходной Windows-учётки. `macDecryptCookie` требует `v10` + CBC и на
  windows-куке (`v10` + GCM) вернёт `null` по проверке печатного ASCII.
- **Фикс:** профили **не переносить** — это невосстановимо. Перед переездом на маке
  выгрузить сессии в переносимый формат, пока Windows под рукой: для каждого профиля
  прогнать `node <шлюз>/share-session.js <label>` (он снимает `storageState` через
  Playwright — расшифровку делает сам браузер, DPAPI отрабатывает на Windows штатно) и
  забрать `<шлюз>/sessions/<label>.json`. На маке эти файлы подхватит уже существующая
  ветка `loadImportedSession()` / `applyImportedSession()` (`open-session.js:104,124`) на
  **чистом** профиле. Каталоги `*/profiles/` на мак не копировать вовсе.
- **Уверенность:** CONFIRMED (префикс `DPAPI` прочитан из файла; обе схемы шифрования
  описаны и реализованы в `newapi-account.js:415-467`).

### [DEGRADED] `share-session.js` в headless не шифрует куки — снимок для переезда надо делать иначе

- **Где:** `agentrouter/share-session.js:51` (и восемь клонов) — `launchPersistentContext(..., { headless: true })`.
- **Что происходит на маке:** прямого вреда нет, но это единственный штатный путь снять
  сессию перед переездом (см. находку выше), и у него есть своя ловушка.
- **Почему:** при `headless: true` Playwright поднимает `chrome-headless-shell`, который
  `os_crypt` не провизионит вовсе — это уже задокументировано в самом репозитории замером
  2026-08-23 (`newapi-account.js:629-639`): `encrypted_value` 0 байт, значение лежит открытым
  текстом. Для снятия `storageState` это как раз безопасно (Playwright читает через CDP, а не
  из SQLite), но профиль, **созданный** headless-путём, на маке потом даст куки открытым
  текстом там, где код ждёт `v10`.
- **Фикс:** менять код не надо. В рецепт переезда добавить порядок: сначала на Windows
  `share-session.js` по каждому профилю, проверить, что в `sessions/<label>.json` поле
  `cookies` непустое (скрипт для этого уже возвращает код 3 при пустом снимке —
  `share-session.js:77`), и только потом переезжать.
- **Уверенность:** CONFIRMED (поведение headless-shell замерено владельцем и записано в коде).

---

## Camoufox-автореги: `freemodel`, `anymodel`, `ourtoken`, `cun`

### [BROKEN] Camoufox-автореги на маке отключены ОСОЗНАННО — и это не оговорено в задаче владельца

- **Где:** `install-mac.sh:257` («на маке он ставит ТОЛЬКО ТГ-менеджер … Camoufox-автореги
  там **осознанно пропущены**, их пины проверены лишь на Windows»);
  `docs/MAC-SETUP.md:135` («Автореги аккаунтов (Camoufox/rebrowser) … вне охвата этой
  обёртки; они Windows-специфичны и для сценария "свои аккаунты" не нужны»).
  Затронуты: `freemodel/freemodel_autoreger_v3.js`, `anymodel/anymodel_autoreger.js`,
  `ourtoken/camoufox_autoreg.py`, `cun/cun_autoreger.js`.
- **Что происходит на маке:** после `install-mac.sh` дашборд, ЛК и точный баланс работают,
  а **завести новый аккаунт на этих четырёх шлюзах нельзя** — рантайм Camoufox не
  установлен вообще. Скрипт падает на `spawn` питона или на `import camoufox`.
- **Почему:** это не баг, а объявленная граница мак-слоя от 24.08: мак задумывался под
  сценарий «свои аккаунты», а не под массовую авторегистрацию. С тех пор постановка
  изменилась («на Маке всё работало идеально»), а граница осталась.
- **Фикс:** решение продуктовое, не однострочное. Минимальный путь — в `install-mac.sh`
  добавить ветку установки Camoufox (`pip3 install camoufox[geoip]` + `python3 -m camoufox fetch`,
  который тянет мак-сборку Firefox, в т.ч. arm64) и снять оговорку в `docs/MAC-SETUP.md:135`.
  До этого — считать четыре шлюза на маке read-only: работать существующими аккаунтами можно,
  заводить новые нельзя. **Перед фиксом стоит подтвердить у владельца, нужны ли автореги на
  маке вообще** — возможно, граница верна и менять надо только формулировку задачи.
- **Уверенность:** CONFIRMED (исключение написано прямым текстом в двух местах).

### [BROKEN] `spawn("python")` — на маке команды `python` нет, а шим сюда не доезжает

- **Где:** `anymodel/lib/camoufox-anymodel-client.js:35`;
  `freemodel/lib/camoufox-emailnator-client.js:20,34`;
  `freemodel/lib/camoufox-tmailor-client.js:21,38`.
- **Что происходит на маке:** `spawn` падает с `ENOENT`, и падает **тихо**: обработчик
  `this._proc.on("error")` (строка 61) только пишет в логгер, промис `_ready` не
  отклоняется — прогон повисает до таймаута «camoufox python не стартовал за 60с»
  (`camoufox-tmailor-client.js:83`). Причина в логе не видна.
- **Почему:** на macOS есть только `python3`; голого `python` нет с Monterey. Шим
  `mac-support/shims/python` существует и делает ровно `exec python3 "$@"`, но попадает в
  PATH **только** через `childEnv()` (`routing/lifecycle.js:464-470`), а тот вызывается в
  единственном месте — `startService` (строка 587). Автореги через `startService` **не
  запускаются**: `grep` по `routing/` не находит ни одного спавна
  `freemodel_autoreger|anymodel_autoreger|cun_autoreger|camoufox_autoreg`. Значит штатный
  способ их запуска — руками из терминала, где шимов в PATH нет.
- **Фикс:** не полагаться на PATH. В трёх клиентах заменить литерал на выбор по платформе:
  `const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');`
  и передать `PY` в `spawn`. У двух freemodel-клиентов точка расширения уже есть —
  `opts.python || "python"`, достаточно поменять дефолт. Заодно отклонять `_ready` в
  обработчике `on("error")`, чтобы ошибка не превращалась в 60-секундное молчание.
- **Уверенность:** CONFIRMED (отсутствие `python` на macOS и единственный call-site
  `childEnv` проверены).

### [BROKEN] `spawn('curl.exe')` в 10minutemail — тот же разрыв с шимом

- **Где:** `freemodel/lib/10minutemail.js:51` — `spawn('curl.exe', args, { windowsHide: true })`.
- **Что происходит на маке:** `ENOENT`, один из источников временной почты freemodel
  отваливается.
- **Почему:** ровно та же причина, что и с `python`: шим `mac-support/shims/curl.exe` есть,
  но доезжает только до детей `startService`, а freemodel запускается руками.
- **Фикс:** `spawn(process.platform === 'win32' ? 'curl.exe' : 'curl', args, …)`.
  `windowsHide` на маке игнорируется — трогать не нужно.
- **Уверенность:** CONFIRMED.

### [DEGRADED] `sqlite3.exe` жёстко в имени файла — TG-импорт freemodel не найдёт системный sqlite3

- **Где:** `freemodel/lib/tg-session-parser.js:17-22`.
- **Что происходит на маке:** при запуске руками бросает
  `sqlite3.exe не найден (…) — положи sqlite3.exe в ~/bin` (строка 61), хотя на маке
  `/usr/bin/sqlite3` есть всегда. Ломаются разборщики TG-сессий `freemodel/_do_import.js`,
  `_check_one.js`, `_import_sessions_analyze*.js`.
- **Почему:** все три кандидата в списке — с расширением `.exe`, и первый ещё и опирается на
  `process.env.LOCALAPPDATA`, которого на маке нет: `path.join('', 'Microsoft', …)` даёт
  относительный путь. Escape-hatch `process.env.SQLITE3` предусмотрен, и `childEnv()` его
  честно выставляет (`lifecycle.js:469`) — но опять же только детям `startService`.
- **Фикс:** добавить unix-кандидатов в тот же список:
  `'/usr/bin/sqlite3', '/opt/homebrew/bin/sqlite3', '/usr/local/bin/sqlite3'` и брать первый
  существующий. Тогда переменная окружения останется необязательной.
- **Уверенность:** CONFIRMED. Понижено до DEGRADED, потому что потребители — только
  разовые `_*.js`-утилиты импорта, основной путь freemodel их не зовёт.

### [DEGRADED] Окно Camoufox на маке не поднимается на передний план

- **Где:** `ourtoken/camoufox_autoreg.py:26-53` — `focus_browser_window()`, первая же строка
  `if sys.platform != "win32": return`.
- **Что происходит на маке:** функция — no-op. Окно Firefox/Camoufox остаётся в фоне.
- **Почему:** реализация целиком на `ctypes.windll.user32` (`EnumWindows`/`SetForegroundWindow`).
  Ветка для мака не написана. Важно, что по замечанию в самом коде (строка 25) фокус тут не
  косметика: «в фоне вкладка троттлится/крашится» — Firefox душит таймеры фоновых вкладок,
  и длинная регистрация может встать.
- **Фикс:** добавить ветку
  `subprocess.run(['osascript', '-e', 'tell application "System Events" to set frontmost of (first process whose name contains "firefox") to true'])`
  либо проще — `open -a` по бандлу Camoufox. Альтернатива без AppleScript: снять троттлинг
  префами Firefox (`dom.min_background_timeout_value`) при запуске Camoufox.
- **Уверенность:** PLAUSIBLE — что guard корректен, видно из кода (CONFIRMED); а вот
  реально ли троттлинг сорвёт регистрацию на маке, статикой не проверить.
  Как проверить: прогнать `ourtoken/camoufox_autoreg.py` на маке с окном в фоне и
  сравнить с прогоном, где окно поднято руками.

### [BROKEN] `cun` тянет camoufox-клиент freemodel — ломается по той же причине

- **Где:** `cun/cun_autoreger.js:5` — `require("../freemodel/lib/camoufox-emailnator-client")`.
- **Что происходит на маке:** `cun` наследует ровно тот же `spawn("python")` из
  `camoufox-emailnator-client.js:34` и падает так же.
- **Почему:** общий клиент временной почты. Отдельного кода у `cun` нет.
- **Фикс:** отдельного не требуется — чинится вместе с `camoufox-emailnator-client.js`
  (см. находку про `spawn("python")`). Отмечено, чтобы `cun` не потерялся при проверке.
- **Уверенность:** CONFIRMED.

---

## Прочее

### [DEGRADED] `localhost:20128` к OmniRoute — на маке может уйти в `::1`

- **Где:** `ourtoken/add-to-omniroute.js:35` (и тот же дефолт в
  `routing/tokenrouter/omniroute-api-client.js:39`, `routing/transparent-proxy.js:39`).
- **Что происходит на маке:** добавление свежего ourtoken-аккаунта в OmniRoute может падать
  с `ECONNREFUSED ::1:20128` при живом и слушающем сервисе.
- **Почему:** на macOS `localhost` резолвится в `::1` раньше `127.0.0.1`. Если OmniRoute
  слушает только IPv4, соединение отвергается. Смягчение (`autoSelectFamily`, Happy Eyeballs)
  включено по умолчанию только с **Node 20**, а `docs/MAC-SETUP.md:131` требует всего лишь
  «Node.js ≥ 18» — то есть на Node 18 подстраховки нет.
- **Фикс:** самый дешёвый — поднять планку до Node ≥ 20 в `docs/MAC-SETUP.md` и в проверке
  внутри `install-mac.sh`. Точечный — сменить дефолт на `http://127.0.0.1:20128`
  в трёх перечисленных местах; переменная `OMNIROUTE_BASE_URL` остаётся рычагом.
- **Уверенность:** PLAUSIBLE. OmniRoute — сторонний сервис, его адрес привязки по этому
  репозиторию не определить. Как проверить на маке: `curl -sv http://localhost:20128/` рядом
  с `curl -sv http://127.0.0.1:20128/` — расхождение и есть диагноз.

### Что проверено и оказалось чистым

Чтобы следующая сессия не искала это заново:

- **Ни одного** хардкода пути к браузеру (`chrome.exe`, `Program Files`, `%LOCALAPPDATA%\Google\Chrome`)
  во всех 16 каталогах. Playwright везде поднимает свой Chromium: ни `executablePath`,
  ни `channel: 'chrome'` не задаются нигде.
- **Ни одного** `taskkill`/`tasklist`/`wmic`/`powershell`/`cmd /c`/`chcp`/`where.exe`/`findstr`
  в коде шлюзов. Весь Windows-инструментарий вынесен в `routing/lib/` — это зона другого агента.
- **Ни одного** `.bat`/`.cmd`/`.ps1`, вызываемого из JS шлюзов. Единственное упоминание
  `setup-sqlite3.bat` — текст в сообщении об ошибке (`tg-session-parser.js:61`).
- Пути везде через `path.join(__dirname, …)`; конкатенации со слэшами и абсолютных
  `C:\`/`D:\` в коде шлюзов нет.
- Клоны `open-session.js`/`share-session.js` в девяти шлюзах платформозависимо **не
  расходятся** — чинить придётся в одном месте и копировать, но искать в каждом не нужно.
- `helpcoder/`, `svrtr/`, `vyceai/`, `kktoken/`, `seekai/`, `truesota/`, `tabi/`, `hcnsec/`,
  `aipm/` — платформозависимого кода нет вообще.
- Секреты нигде не лежат в Credential Manager / DPAPI / реестре — только файлы
  (`.env`, `sessions/*.json`), это переносится как есть.
- `freemodel/.env` и `.env.example` — LF, путей внутри нет. `freemodel/config.js` в CRLF,
  но это `require`-модуль без shebang: Node читает CRLF нормально, на маке не мешает.
- Нативные модули из `package.json` (`better-sqlite3` 12.x, `node-pty` 1.x, `bufferutil`,
  `utf-8-validate`) собираются на маке из исходников, `install-mac.sh:101` ставит для этого
  Xcode CLT. Отдельной поломки arm64 по коду шлюзов не видно (детальная проверка пинов —
  зона агента по зависимостям).

---

## Итог

**По градациям:** BLOCKER — 0, BROKEN — 5, DEGRADED — 4, COSMETIC — 0.

**По шлюзам:**

| Шлюз | Состояние на маке |
|---|---|
| `agentrouter`, `gorouter`, `justwoker`, `aipm`, `kktoken`, `seekai`, `truesota`, `tabi`, `hcnsec` | код чист; ломается только **перенос профилей** (DPAPI) |
| `freemodel` | `spawn("python")`, `curl.exe`, `sqlite3.exe` + автореги вне охвата установщика |
| `anymodel` | `spawn("python")` + автореги вне охвата установщика |
| `cun` | то же, через общий клиент freemodel |
| `ourtoken` | автореги вне охвата; фокус окна — no-op; `localhost:20128` |
| `helpcoder`, `svrtr`, `vyceai` | чисто, платформозависимого кода нет |

**Главное:** сами шлюзы написаны переносимо — ни одного хардкода браузера, `path.join`
везде, платформозависимых расхождений между девятью клонами `open-session.js` нет; реальных
проблем ровно две, и обе лежат на границе зоны — **профили Chromium с Windows на маке
нерасшифровываемы (сессии надо выгрузить через `share-session.js` ДО переезда, иначе они
потеряны безвозвратно)**, а Camoufox-автореги четырёх шлюзов на маке отключены осознанным
решением от 24.08, которое разошлось с нынешней задачей «на Маке всё работало идеально».
