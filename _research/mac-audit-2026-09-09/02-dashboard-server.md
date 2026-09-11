# Аудит мак-совместимости: `internal/dashboard-api.js` (серверная часть дашборда :8200)

**Агент:** №2 из 10
**Дата:** 2026-09-09
**Зона:** `internal/dashboard-api.js` — только backend/Node. Фронтенд не мой.
**Метод:** статический аудит, мака под рукой нет.
**Файл:** 1663 строки, `C:\Users\WormAlien\Desktop\Autoreger_Clean\internal\dashboard-api.js`

## Шимы (`mac-support/shims/`) — что реально прикрыто

| Шим | Оборачивает | Покрытие |
|---|---|---|
| `clip.exe` | `pbcopy` | полное (stdin→буфер) |
| `curl.exe` | `curl "$@"` | полное |
| `netstat` | `lsof -nP -iTCP -sTCP:LISTEN` → формат `TCP <local> 0.0.0.0:0 LISTENING <pid>` | **частичное**: флаги игнорируются целиком (`-ano` просто съедается), UDP не отдаётся, ESTABLISHED не отдаётся, foreign address всегда `0.0.0.0:0` |
| `python` / `python.exe` | `python3 "$@"` | полное |
| `taskkill` | `/PID n → kill -9`, `/IM n → pkill -9 -x` | **частичное**: `/T` (дерево процессов) игнорируется, код возврата всегда 0 — «процесс не найден» неотличим от «убит» |

⚠️ Шим-каталог покрывает только вызовы **по имени** (через PATH). Всё, что зовётся абсолютным путём к `.exe`, шим не перехватит.

---

## Находки

> **Важный контекст, снижающий тяжесть части находок.** Дашборд (`routing/transparent-proxy.js`)
> поднимается через `routing/lifecycle.js` → `startService()`, а тот на POSIX передаёт
> `env: childEnv()` (`routing/lifecycle.js:583-588`). `childEnv()` (`:464-475`) прeпендит
> `mac-support/shims` в `PATH` и выставляет `SQLITE3=/usr/bin/sqlite3`, если файл есть.
> **Поэтому** внутри дашборда `python`/`netstat`/`taskkill`/`curl.exe` резолвятся в шимы,
> а `sqlite3` — в системный.
> ⚠️ Это верно **только** для запуска через `HUB.command` / `hub.js`. Прямой
> `node routing/transparent-proxy.js` или запуск `internal/menu.js` руками из терминала
> шимов и `SQLITE3` не получают.

### [DEGRADED] `sqlite3` ищется только как `sqlite3.exe` в Windows-путях — спасает лишь env от `childEnv()`

- **Где:** `internal/dashboard-api.js:29-34`, использование — `sqliteJson()` / `sqliteExec()` (`:36-55`)
- **Что происходит на маке:** при запуске **через хаб** — работает: `process.env.SQLITE3` уже равен `/usr/bin/sqlite3`, ветка `.exe` не выполняется. При запуске **мимо хаба** (прямой `node routing/transparent-proxy.js`, `node internal/menu.js`, `node freemodel/freemodel_autoreger_v3.js` из терминала) `SQLITE_EXE` резолвится в `~/bin/sqlite3.exe` — это **не** результат `.find()`, а безусловный дефолт последней строки. Файла нет → каждый вызов бросает `sqlite3 not found at /Users/<user>/bin/sqlite3.exe (set SQLITE3 env var)`. Мертвы `listOmniAccountsWithQuotas()` и `toggleOmniAccount()`.
- **Почему:** кандидаты жёстко Windows-овые, POSIX-путей в списке нет вообще:
  ```js
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'sqlite3.exe'),
  path.join(os.homedir(), 'bin', 'sqlite3.exe'),
  ```
  `LOCALAPPDATA` на маке не определён → первый кандидат вырождается в **относительный** путь `Microsoft/WinGet/Links/sqlite3.exe` (проверяется относительно `process.cwd()`, а не безопасно отбрасывается). На macOS системный sqlite3 лежит в `/usr/bin/sqlite3` из коробки.
- **Фикс:** не полагаться на то, что кто-то снаружи выставит `SQLITE3`, — добавить POSIX-кандидатов:
  ```js
  const WIN = process.platform === 'win32';
  const SQLITE_EXE = process.env.SQLITE3
      || [
          ...(WIN ? [
              path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'sqlite3.exe'),
              path.join(os.homedir(), 'bin', 'sqlite3.exe'),
          ] : [
              '/usr/bin/sqlite3',
              '/opt/homebrew/opt/sqlite/bin/sqlite3',
              '/usr/local/opt/sqlite/bin/sqlite3',
              path.join(os.homedir(), 'bin', 'sqlite3'),
          ]),
      ].filter(p => p && path.isAbsolute(p)).find(p => fs.existsSync(p))
      || (WIN ? path.join(os.homedir(), 'bin', 'sqlite3.exe') : '/usr/bin/sqlite3');
  ```
- **Проверить на маке:** `node -e "require('./internal/dashboard-api')"` из чистого терминала, затем дёрнуть роут OmniRoute; и `which sqlite3`.
- **Уверенность:** CONFIRMED (для случая «мимо хаба»); PLAUSIBLE, что штатный путь всегда идёт через хаб

### [BROKEN] `launchScript()` на POSIX запускает всё со `stdio: 'ignore'` — интерактивные скрипты умирают немо

- **Где:** `internal/dashboard-api.js:985-987` (POSIX-ветка `launchScript`)
- **Что происходит на маке:**
  ```js
  spawn(exe, finalArgs, { cwd: PROJECT_ROOT, detached: true, stdio: 'ignore' }).unref();
  ```
  Ни окна, ни лога, ни stdin. API отвечает `{ ok: true, kind, args }` **всегда** — спавн отсоединённого процесса «успешен» по определению. Фронт рисует зелёное «запущено», а на деле:
  - `menu` (`internal/menu.js`) — readline-TUI: без stdin первый же `question()` получает EOF, меню либо падает, либо уходит в бесконечный цикл;
  - `freemodel-login` (`create_first_session.js`), `conduit-login` (`record_conduit.js`), `conduit-create` (gramjs device-code) — все просят ввод с клавиатуры. Ввести некуда;
  - любая ошибка (`cannot find module`, упавший Playwright, отсутствующий `python`) уходит в `/dev/null` — причины не узнать вообще.

  Это **ровно та же ловушка**, которую в `launchBatFile` уже разобрали и починили комментарием на `:806-813` («падал отсоединённо в `stdio:'ignore'`, то есть в никуда, API отвечал `{ok:true}`»), но в `launchScript` фикс не перенесли.
- **Почему:** на Windows ветка даёт настоящее окно с `cmd /k` — человек видит ход и вводит ответы. На POSIX аналога `cmd /c start` нет, и его просто не сделали.
- **Фикс (минимум — логировать, как в `launchBatFile`):**
  ```js
  fs.mkdirSync(path.join(PROJECT_ROOT, 'logs', 'hub'), { recursive: true });
  const log = fs.openSync(path.join(PROJECT_ROOT, 'logs', 'hub', `launch-${kind}.log`), 'a');
  const ch = spawn(exe, finalArgs, { cwd: PROJECT_ROOT, detached: true, stdio: ['ignore', log, log] });
  ch.unref();
  fs.closeSync(log);
  ```
  **Правильно (для интерактивных `menu` / `*-login` / `conduit-create`) — открыть настоящее окно Terminal.app**, как это делает `cmd /c start` на Windows:
  ```js
  const sh = [exe, ...finalArgs].map(a => `'${String(a).replace(/'/g, `'\\''`)}'`).join(' ');
  const osa = `tell application "Terminal"
      do script "cd ${PROJECT_ROOT.replace(/"/g, '\\"')} && ${sh.replace(/"/g, '\\"')}"
      activate
  end tell`;
  spawn('osascript', ['-e', osa], { detached: true, stdio: 'ignore' }).unref();
  ```
  (или `open -a Terminal <wrapper.sh>` — вариант без AppleScript, но требует временного файла).
- **Проверить на маке:** нажать «Autoreger Menu» на дашборде — ничего не произойдёт, а `ps aux | grep menu.js` покажет живой процесс-зомби без tty.
- **Уверенность:** CONFIRMED (`stdio: 'ignore'` читается прямо в коде; интерактивность `menu.js` — readline, проверяется грепом `readline` в нём)

### [DEGRADED] `launchBatFile()` на POSIX открывает лог-файл без `mkdir` и не закрывает fd

- **Где:** `internal/dashboard-api.js:851-852`
  ```js
  const log = fs.openSync(path.join(PROJECT_ROOT, 'logs', 'hub', 'launch.log'), 'a');
  spawn('bash', [runPath], { cwd: PROJECT_ROOT, detached: true, stdio: ['ignore', log, log] }).unref();
  ```
- **Что происходит на маке:** две беды.
  1. **Нет `fs.mkdirSync`** перед `openSync`. Соседняя `launchHub()` (`:882`) mkdir делает — асимметрия. `logs/` целиком в `.gitignore` (строка 5), то есть на свежем клоне `logs/hub/` не существует. В штатном сценарии дырку закрывает `lifecycle.rotateLog()` (`routing/lifecycle.js:522-529`), который mkdir'ит `logs/hub` до старта дашборда. Но если дашборд подняли мимо хаба — `openSync` бросит `ENOENT`, роут вернёт 500 с сообщением про несуществующий путь вместо «не смог запустить».
  2. **fd никогда не закрывается.** `lifecycle.startService()` рядом делает это правильно (`finally { fs.closeSync(out) }`, `:592`), здесь — нет. Каждый клик по кнопке в UI на маке навсегда съедает один дескриптор долгоживущего процесса дашборда. На Windows этой ветки нет, поэтому баг чисто мак/линуксовый.
- **Фикс:**
  ```js
  const dir = path.join(PROJECT_ROOT, 'logs', 'hub');
  fs.mkdirSync(dir, { recursive: true });
  const log = fs.openSync(path.join(dir, 'launch.log'), 'a');
  try {
      spawn('bash', [runPath], { cwd: PROJECT_ROOT, detached: true, stdio: ['ignore', log, log] }).unref();
  } finally { fs.closeSync(log); }
  ```
  (тот же `finally` нужен и в `launchHub()` на `:883-886`.)
- **Уверенность:** CONFIRMED (утечка fd и отсутствие mkdir читаются в коде; ENOENT — PLAUSIBLE, зависит от способа запуска)

### [BROKEN] Два `.bat` без `.sh`-двойника на маке недоступны в принципе

- **Где:** `internal/dashboard-api.js:815-821` + `routing/`
- **Что происходит на маке:** `launchBatFile` для не-lifecycle-имён ищет одноимённый `.sh` и, не найдя, честно отказывает словами. В `routing/` лежат два `.bat` без пары:
  - `keepalive-restart.bat` — перезапуск keepalive;
  - `PANIC-restore-omniroute.bat` — аварийное восстановление OmniRoute.

  Через `POST /api/launch-bat` (`routing/transparent-proxy.js:3215`) они на маке недостижимы: `на этой системе нечем запустить keepalive-restart.bat — нет keepalive-restart.sh`.
- **Почему:** мак-слой заморожен 24.08; тогда портировали только четыре скрипта жизненного цикла (`restart-dashboard`, `start-switcher`, `start-proxy`, `stop-dashboard`), а эти два — нет. `PANIC-restore-omniroute` при этом именно та кнопка, которая нужна, когда всё сломалось.
- **Фикс:** либо написать `routing/keepalive-restart.sh` и `routing/PANIC-restore-omniroute.sh`, либо добавить их в `LIFECYCLE_VERBS`, если хаб умеет соответствующие глаголы. Как минимум — скрыть кнопки в UI на не-Windows, чтобы не обещать несуществующее (это зона агента №3, но источник ограничения здесь).
- **Проверить на маке:** нажать соответствующую кнопку — придёт 500 с текстом отказа.
- **Уверенность:** CONFIRMED (список файлов в `routing/` проверен `ls`)

### [DEGRADED] `python` для двух автореогов зависит от того, что шимы попали в `PATH`

- **Где:** `internal/dashboard-api.js:959-960` — `tokenrouter-create` и `ourtoken-create` объявлены с `cmd: 'python'`
- **Что происходит на маке:** команды `python` в macOS нет с 12.3 (Apple выпилила Python 2), есть только `python3`. Спасает шим `mac-support/shims/python` — но **только** если дашборд запущен через хаб, потому что PATH с шимами приходит из `lifecycle.childEnv()`. Мимо хаба → `spawn` падает с `ENOENT`, а из-за `stdio:'ignore'` (см. находку выше) об этом никто не узнает: API всё равно ответит `{ok:true}`.
- **Почему:** зависимость неявная и односторонняя — `dashboard-api.js` нигде не проверяет, что шимы доступны.
- **Фикс:** не полагаться на PATH:
  ```js
  const PY = process.platform === 'win32' ? 'python' : 'python3';
  // ...
  'tokenrouter-create': { title: 'TokenRouter Autoreg', cmd: PY, args: [...] },
  ```
  Плюс проверять результат спавна: повесить `.on('error', ...)` перед `unref()` и писать в лог.
- **Уверенность:** CONFIRMED (отсутствие `python` в macOS ≥12.3 — факт; PATH-цепочка прочитана в `lifecycle.js`)

### [BROKEN] `openTokenrouterSession()` на маке — тот же `python` + `stdio:'ignore'`, но врёт `{ok:true}` без единого шанса на диагностику

- **Где:** `internal/dashboard-api.js:1179-1198`, POSIX-ветка `:1195`
  ```js
  spawn('python', args, { cwd: PROJECT_ROOT, detached: true, stdio: 'ignore' }).unref();
  ...
  return { ok: true };
  ```
- **Что происходит на маке:** отдельная от `launchScript` копия того же антипаттерна, и здесь хуже: возврат `{ ok: true }` **захардкожен** — он не зависит даже от того, удался ли `spawn`. Кнопка «открыть сессию TokenRouter» на маке в худшем случае не делает ничего и рапортует успех. `python` спасает шим только при запуске через хаб (см. предыдущую находку).
- **Почему:** ветка написана по образцу Windows-ветки (`cmd /c start ... cmd /k python`), где окно есть, а POSIX-аналога окна не сделали.
- **Фикс:** `cmd: python3` + слушать `error`:
  ```js
  const py = process.platform === 'win32' ? 'python' : 'python3';
  const ch = spawn(py, args, { cwd: PROJECT_ROOT, detached: true, stdio: ['ignore', log, log] });
  ch.on('error', e => { try { fs.appendFileSync(logPath, `spawn failed: ${e.message}\n`); } catch {} });
  ch.unref();
  ```
  Плюс, как в `launchScript`, — окно через `osascript`/Terminal, если Camoufox в `--open` что-то спрашивает.
- **Проверить на маке:** нажать кнопку, затем `ps aux | grep camoufox_autoreg`. Пусто при зелёном ответе UI = подтверждено.
- **Уверенность:** CONFIRMED

### [DEGRADED] `handleLaunchBat` → `launchBatFile` пускает произвольный путь; на маке это `bash <любой файл>`

- **Где:** `internal/dashboard-api.js:805` (`path.join(PROJECT_ROOT, 'routing', batName)`), вызывается из `routing/transparent-proxy.js:3211-3218` без валидации
- **Что происходит на маке:** `batName` приходит из тела HTTP-запроса как есть. Ни аллоу-листа, ни проверки на `..`, ни требования расширения. Проверка «нужен `.sh`-двойник» срабатывает **только** если имя оканчивается на `.bat`; всё остальное уходит прямо в `spawn('bash', [runPath])`. То есть `{"bat":"../../../../tmp/x"}` на маке исполнит `/tmp/x` шеллом. На Windows та же дыра ведёт в `cmd /c`, но там нужен исполняемый/батник, а `bash` съест любой текстовый файл — на маке эксплуатация проще.
- **Почему:** мак-ветку добавляли 24.08 как заплатку под «.bat не запускается», про валидацию входа не думали ни тогда, ни в исходной Windows-версии.
- **Фикс:** аллоу-лист вместо склейки путей —
  ```js
  const ALLOWED_BATS = new Set([...Object.keys(LIFECYCLE_VERBS),
      'keepalive-restart.bat', 'PANIC-restore-omniroute.bat']);
  if (!ALLOWED_BATS.has(String(batName))) throw new Error(`bat not allowed: ${batName}`);
  ```
  (`LIFECYCLE_VERBS` ловится раньше, так что список нужен только для остатка.) Как минимум — `if (/[\\/]|\.\./.test(batName)) throw`.
- **Оговорка:** дыра **не мак-специфична**, но на маке она острее. Дашборд слушает на `:8200`; насколько это достижимо снаружи — вопрос к биндингу в `routing/transparent-proxy.js` (не мой файл).
- **Уверенность:** CONFIRMED (обе стороны цепочки прочитаны)

### [COSMETIC] Окно Playwright на маке: `--start-maximized` не работает, «фокус существующего окна» — под вопросом

- **Где:** `internal/dashboard-api.js:583` и `:574`
  ```js
  const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
  const context = await browser.newContext({ storageState, viewport: null, ... });
  ...
  await existing.page.bringToFront();
  ```
- **Что происходит на маке:**
  1. `--start-maximized` в Chromium на macOS не поддерживается (это Windows/Linux-флаг; на маке «максимизация» — это зелёная кнопка / zoom, отдельная концепция). В паре с `viewport: null` (размер окна = размер вьюпорта) все сессии откроются маленьким окном по умолчанию вместо «на весь экран». Функционально не ломает, но 8 разных «Открыть в Chrome» будут неудобны.
  2. `page.bringToFront()` (CDP `Page.bringToFront`) активирует **вкладку**; поднятие окна над другими приложениями на macOS оно не гарантирует — Chromium там не сам себе оконный менеджер. Дедупликация окон (`openedBrowsers`, ради которой всё писалось) может выглядеть как «клик ничего не сделал», и человек нажмёт ещё раз.
- **Фикс:**
  ```js
  const MAX_ARGS = process.platform === 'darwin'
      ? [`--window-size=1920,1080`, '--window-position=0,0']
      : ['--start-maximized'];
  const browser = await chromium.launch({ headless: false, args: MAX_ARGS });
  ```
  Для п.2 — после `bringToFront()` дополнительно поднять приложение:
  ```js
  if (process.platform === 'darwin') {
      spawn('osascript', ['-e', 'tell application "Chromium" to activate'], { stdio: 'ignore' }).unref();
  }
  ```
  (имя приложения зависит от того, что тянет Playwright — `Chromium` для встроенного билда).
- **Проверить на маке:** открыть сессию, посмотреть размер окна; открыть вторую, кликнуть по первой ещё раз — поднялась ли.
- **Уверенность:** п.1 — CONFIRMED (флаг платформенный); п.2 — PLAUSIBLE

### [DEGRADED] `notion/config.js` в `.gitignore`, и ни один установщик его не создаёт → карточки Notion мертвы на свежей машине

- **Где:** `internal/dashboard-api.js:746-781` (`NOTION_CONFIG`, `getNotionCards`, `setNotionCardIndex`)
- **Что происходит:** `notion/config.js` игнорируется (`.gitignore:73`), в репо лежит только `notion/config.example.js`. Ни `install-mac.sh`, ни `install.ps1` не копируют пример в рабочий файл (проверено грепом — слова `config.js` в них нет вообще). На чистой машине `getNotionCards()` бросает `notion/config.js not found`, `setNotionCardIndex()` — то же на `fs.readFileSync`.
- **Оговорка:** **не мак-специфично** — на свежем Windows-клоне ровно то же. Попадает в отчёт потому, что задача звучит «чтобы на Маке всё работало идеально», а мак — как раз тот случай, где ставят с нуля.
- **Фикс:** в `install-mac.sh` (и симметрично в `install.ps1`):
  ```sh
  [ -f notion/config.js ] || cp notion/config.example.js notion/config.js
  ```
- **Уверенность:** CONFIRMED

### [DEGRADED] `OMNI_DB` — путь к базе OmniRoute, которой на маке скорее всего нет

- **Где:** `internal/dashboard-api.js:28` — `path.join(os.homedir(), '.omniroute', 'storage.sqlite')`
- **Что происходит на маке:** сам путь платформенно корректен (`path.join`, `os.homedir()`), но OmniRoute — десктопное приложение, и если его на маке не ставили, файла нет. `sqliteJson()` бросит `OmniRoute db not found at /Users/<user>/.omniroute/storage.sqlite`, вкладка OmniRoute будет отдавать ошибку.
- **Почему:** это не баг кода, а отсутствующая зависимость. В отчёте — чтобы при тесте на маке «OmniRoute не работает» не приняли за поломку порта.
- **Фикс:** кода не требует. Либо ставить OmniRoute на мак, либо в UI отличать «БД не найдена» (нет приложения) от «sqlite3 не найден» (наша поломка) — сообщения уже разные, этого достаточно.
- **Уверенность:** PLAUSIBLE (зависит от того, есть ли OmniRoute на мак-машине владельца)

---

## Проверено и чисто (мак-специфичных проблем нет)

Прочитаны все 1663 строки. По каждому пункту брифа:

| Категория | Результат |
|---|---|
| `fs.watch` / FSEvents / `recursive` | **вотчеров в файле нет вообще** — ни одного `fs.watch`/`watchFile` |
| `os.tmpdir()` | не используется; все временные файлы — `${file}.tmp-${pid}` рядом с целевым (`writeJsonAtomic`, `:124-129`), `renameSync` в пределах одной ФС — на APFS корректно |
| Биндинг `:8200`, `0.0.0.0` vs `localhost`/`::1` | **в этом файле HTTP-сервера нет** — ни `listen()`, ни упоминания порта, кроме комментария на `:1`. Роуты и биндинг живут в `routing/transparent-proxy.js`. Пункт брифа передаю дальше: `localhost`→`::1` надо проверять именно там |
| Раздача статики, регистр в путях | статики в файле нет |
| Регистр в `require`/`import` | все 17 `require` проверены на диске и в `git ls-files` — совпадают побайтно: `./freemodel-manager`, `./notion-manager`, `./devin-manager`, `../conduit/lib/conduit-manager`, `../svrtr/lib/svrtr-manager`, `../helpcoder/lib/helpcoder-manager`, `playwright`, `notion/config.js`. Промахов по регистру нет — сломается корректно и на case-sensitive APFS |
| Пути: бэкслэши, `C:\`, `D:\`, `%APPDATA%`, конкатенация | конкатенации путей нет ни одной, везде `path.join`. Абсолютных Windows-путей нет. `%APPDATA%`/`USERPROFILE` не используются. Единственный Windows-env — `LOCALAPPDATA` в `SQLITE_EXE` (находка №1) |
| CRLF при чтении конфигов и `.env` | `loadFreemodelEnv` (`:112`) режет по `/\r?\n/` — корректно. Однострочные файлы (`.email_backend`, `.email_domain`, `*-active-key.txt`) читаются с `.trim()` — CR снимается. `setNotionCardIndex` (`:773`) — регекс в пределах строки, перевод строки не трогает. **Чисто** |
| CRLF при записи | `account_info.txt` пишется `lines.join('\n') + '\n'` (`:1321`, `:1445`, `:1567`) — LF. `writeJsonAtomic` — `JSON.stringify` (LF). **Чисто** |
| Права на файлы / исполняемый бит | `chmod` в файле нет, и он **не нужен**: `.sh` запускается как `spawn('bash', [path])`, `hub.js` — как `spawn(process.execPath, [path])`, `.py` — как `spawn(python, [path])`. Ни один спавн не полагается на exec-бит цели. Exec-бит шимов и `routing/*.sh` ставит `install-mac.sh:247` |
| Убийство процессов по PID / порту | **в этом файле их нет** — ни `taskkill`, ни `netstat`, ни `tasklist`, ни `lsof`, ни `process.kill`. Вся работа с портами и PID-ами вынесена в `routing/lifecycle.js` (там же живёт шим-обвязка) |
| `wmic` / `powershell` / `shell: true` | не встречаются. `execFileSync` для sqlite вызывается **без шелла** — цитирование аргументов не нужно |
| Открытие URL (`start`/`open`/`xdg-open`) | в файле не открывается ни один URL. Браузер поднимается через Playwright, хаб зовётся с `--no-open` |
| `windowsHide` / `windowsVerbatimArguments` / `detached` | все четыре вхождения `windowsHide` и оба `windowsVerbatimArguments` — **внутри веток `if (process.platform === 'win32')`**, на маке не исполняются. `detached: true` на POSIX означает `setsid` (своя группа процессов) — это ровно то, что нужно, семантика корректна |
| Загрузка модуля на маке | **BLOCKER'ов нет.** Ни одна строка верхнего уровня не бросает на маке: `path.join('', ...)` при пустом `LOCALAPPDATA` даёт относительный путь без исключения, `loadFreemodelEnv` целиком в `try/catch`, тяжёлые модули (`playwright`, `*-manager`) грузятся лениво |

## Не мак-специфичное, но найдено по пути

Кроссплатформенные баги в этом же файле. В зачёт мак-аудита не идут, но чинить стоит:

- **`deleteSession()` (`:711-740`) сносит каталоги вне песочницы при `name === '..'`.** Гард `/[\\/]/.test(name)` блокирует разделители, но **не** `..`. `deleteSession('notion', '..')` → `path.join(PROJECT_ROOT, 'notion', 'sessions', '..')` = `<repo>/notion` → `fs.rmSync(..., { recursive: true, force: true })` уносит весь каталог `notion/`. Роут достижим: `routing/transparent-proxy.js:1850`. Фикс — `if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '..' || name === '.') throw`.
- **`toggleOmniAccount()` (`:531-562`) склеивает SQL строкой.** `id` прикрыт регексом `/^[0-9a-fA-F-]{8,}$/`, инъекция через него не проходит, но паттерн хрупкий — при малейшем послаблении регекса ломается сразу. Стоит перевести на параметры (`sqlite3` их через CLI не умеет — тогда хотя бы экранировать `'`).
- **Утечка fd в `launchHub()` (`:883`)** — та же, что описана в находке №3, POSIX-ветка открывает `launch.log` и не закрывает.

## Итог

| Градация | Кол-во |
|---|---|
| BLOCKER | **0** |
| BROKEN | **3** — `launchScript` со `stdio:'ignore'`, два `.bat` без `.sh`-двойника, `openTokenrouterSession` |
| DEGRADED | **6** — `sqlite3.exe`, mkdir+fd в `launchBatFile`, `python` через PATH-шим, traversal в `launchBatFile`, `notion/config.js`, отсутствующая база OmniRoute |
| COSMETIC | **1** — окно Playwright (`--start-maximized`, `bringToFront`) |

**Главное:** сам модуль на маке грузится и его «чистая» часть (кэши, мета, HTTPS-проверки ключей, пути, CRLF) написана переносимо — все поломки собраны в одном месте, в **запуске дочерних процессов**: POSIX-ветки `launchScript` и `openTokenrouterSession` отправляют всё в `stdio:'ignore'` без окна и без лога и при этом рапортуют `{ok:true}` — ровно та ловушка, которую в соседней `launchBatFile` уже разобрали 24.08 и починили, но на две другие функции фикс не перенесли.




