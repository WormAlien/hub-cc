# 09 — Точки входа, паритет платформ и документация

**Агент:** 9/10 · **Дата:** 2026-09-09 · **Метод:** статический аудит, мака под рукой нет.
**Зона:** `HUB.command`, `DASHBOARD.command`, `HUB.bat`, `START.bat`, `RESCUE.bat`,
`package.json` (`scripts`/`bin`), `opencode.json`, `docs/`, `README.md`, `ARCHITECTURE.md`, `CLAUDE.md`.

Даты правок (`stat`, локальные):

| Файл | mtime | Размер | git mode |
|---|---|---|---|
| `HUB.bat` | 2026-08-25 15:09 | 2757 | 100644 |
| `HUB.command` | 2026-08-24 02:53 | 2347 | 100755 |
| `DASHBOARD.command` | 2026-08-24 02:55 | 1268 | 100755 |
| `START.bat` | 2026-08-24 03:07 | 1082 | 100644 |
| `RESCUE.bat` | 2026-08-24 19:45 | 1107 | 100644 |

---

## А. Паритет функций

### А.1 Что на самом деле изменилось 25.08

Расхождение «батник новее на день» оказалось **не функциональным**. Единственный коммит по
`HUB.bat` после создания мак-лаунчеров — `9c820de` (25.08 15:18), и в нём правка `HUB.bat`
**чисто комментарий** (+7 строк `rem` про `HUB_NO_WT`). Код не тронут:

```
diff --git a/HUB.bat b/HUB.bat
@@ -16,6 +16,13 @@
+rem  HUB_NO_WT is NOT set here on purpose. The hub moves itself from the grey
+rem  conhost window into Windows Terminal ...
```

Реальная работа того дня (111 строк) ушла в `hub.js`: элевация через `Start-Process -Verb RunAs`,
переезд в Windows Terminal, `installCrashLog()`. Проверено — всё, кроме крэш-лога, закрыто
платформенным гардом, то есть **на маке это мёртвый код, а не поломка**:

- `hub.js:740` `findWt()` → `if (!L.IS_WIN) return null;`
- `hub.js:769` `elevateCommands()` → `if (!L.IS_WIN) return [];`
- `hub.js:795` `relaunchElevated()` → `if (!L.IS_WIN) return false;`
- `hub.js:1766` `moveToWindowsTerminal()` → `if (!L.IS_WIN || !TTY) return false;`
- `hub.js:1832` `installCrashLog()` — **без гарда**, работает и на маке (это правильно).

**Вывод: догонять `HUB.command` до `HUB.bat` по этому коммиту не надо.** Дырки в паритете
лежат в другом месте — см. таблицу и §А.3.

### А.2 Таблица паритета `HUB.bat` ↔ `HUB.command`

| Функция | `HUB.bat` | `HUB.command` | Вердикт |
|---|---|---|---|
| Переход в каталог скрипта | `cd /d "%~dp0"` (28) | `cd "$(dirname "$0")" \|\| exit 1` (14) | **паритет**, у мака даже строже (`\|\| exit 1`) |
| Поиск node в PATH | `where node` (31) | `command -v node` (21) | паритет |
| Фолбэки на непрописанный node | 4 шт.: `%ProgramFiles%`, `%ProgramFiles(x86)%`, `%LOCALAPPDATA%\Programs`, `%NVM_SYMLINK%` (32–35) | 3 источника: `/opt/homebrew/bin`, `/usr/local/bin`, `~/.nvm/nvm.sh` (18–19) | **дырка на маке** — нет fnm / volta / asdf / MacPorts, см. Б-5 |
| Сообщение «нет node» + как ставить | есть, `winget install OpenJS.NodeJS.LTS` (39–45) | есть, `brew install node` (24–28) | паритет |
| Пауза перед закрытием окна при ошибке | `pause` (58) | `read -r -p` (41) | паритет |
| Проброс аргументов в hub.js | `%*` (49) | `"$@"` (33) | паритет |
| Сохранение кода возврата | `exit /b %RC%` (60) | `exit $RC` (43) | паритет |
| Заголовок окна | `title ABUSE HUB` (48) | **нет** | **дырка на маке**, COSMETIC — см. Б-7 |
| Изоляция переменных | `setlocal` (27) | — (не нужно: правки PATH живут в подпроцессе) | паритет по смыслу |
| Снятие карантина | — (не нужно) | `xattr -cr .` (15) | mac-only, но см. **Б-1**: себя же не спасает |
| Починка exec-бита | — (не нужно) | `chmod +x "$0" hub.js` (16) | mac-only, но см. **Б-2**: бесполезен на обоих объектах |
| Явный интерпретатор для форвардера | `call ... HUB.bat` | `exec bash HUB.command` | у мака **лучше**: `bash X` не зависит от exec-бита |

Итог по таблице: `HUB.command` **не отстаёт** от `HUB.bat` по логике запуска. Одна косметическая
дырка (заголовок) и одна содержательная (узкий список менеджеров node).

### А.3 `START.bat` и `RESCUE.bat` — мак-аналоги

**`START.bat` — аналог ЕСТЬ, но называется иначе.** Оба файла — форвардеры в `hub start`:

| | Windows | macOS |
|---|---|---|
| Полное меню | `HUB.bat` | `HUB.command` |
| Просто поднять стек | **`START.bat`** → `HUB.bat start` | **`DASHBOARD.command`** → `bash HUB.command start` |

Функция одна, имена разные — `START.command` и `DASHBOARD.bat` не существуют. Это не поломка,
но объясняет, почему инструкции для разных платформ нельзя писать одним текстом.

**`RESCUE.bat` — мак-аналога НЕТ, и он нужен.** Что он делает (`RESCUE.bat` 1–36): меню без агента
поверх `routing/rescue.js` — `doctor` (что живо, что врёт, read-only), `restore good` (откат к
эталону), `list` / `save` / `good` (снапшоты состояния роутинга). Это спасательный круг на случай
«Claude Code перестал отвечать, агента нет».

Проверено: **`routing/rescue.js` кросс-платформенный** — ни `taskkill`, ни `netstat`, ни
`process.platform`; в нём даже стоит самопроверка `assert.ok(!/spawnSync\('taskkill|\bkill\(/...,
'процессы не убиваем')` (`rescue.js:354`). То есть движок на маке заработает как есть, не хватает
только двухстрочной обёртки. **Плюс два дефекта — см. В-3 (текст зовёт `HUB.bat`) и А.4.**

### А.4 `RESCUE.bat` вообще не доезжает до клона — ни на мак, ни на Windows

Отдельная находка, всплывшая при проверке доставки.

### [BROKEN] `RESCUE.bat` игнорируется git и на свежем клоне отсутствует

- **Где:** `.gitignore:124` (`*.bat`), корень репо
- **Что происходит:** `git ls-files --error-unmatch RESCUE.bat` → `did not match any file(s) known
  to git`; `git check-ignore -v RESCUE.bat` → `.gitignore:124:*.bat  RESCUE.bat`. Файл существует
  только на этой машине.
- **Почему:** в `.gitignore` для батников сделан **allowlist**: `*.bat` + `!routing/*.bat` +
  `!HUB.bat` + `!START.bat`. `RESCUE.bat` создан 24.08, в список его не дописали. Комментарий
  прямо над правилом предупреждает ровно об этой ловушке («Так и потерялся SHARE.bat… Добавил
  файл в корень — добавь строку») — `RESCUE.bat` стал следующей жертвой.
- **Следствие для мака:** вопрос «нужен ли мак-эквивалент» частично снимается — спасалки нет
  сейчас **ни у кого, кроме владельца**. Мак-обёртку надо делать сразу вместе с починкой ignore.
- **Фикс:** дописать в `.gitignore` рядом со строкой 127:
  ```
  !RESCUE.bat
  ```
  затем `git add -f RESCUE.bat`. Мак-обёртка `RESCUE.command` под `*.command` не подпадает
  (правила `*.bat` её не трогают) — но проверить `git check-ignore` после создания.
- **Уверенность:** CONFIRMED (обе команды git отработаны на месте).

---

## Б. Корректность `.command` на macOS

### Б.0 Что проверено фактически и оказалось ЧИСТО

Чтобы не тратить внимание на здоровое — четыре пункта из брифа закрыты замером:

| Проверка | Команда | Результат |
|---|---|---|
| CRLF | `python: b.count(b'\r\n')` | `HUB.command` **0**, `DASHBOARD.command` **0**, все `install*.sh` **0** |
| BOM | `b[:3] == b'\xef\xbb\xbf'` | **False** у всех |
| Финальный `\n` | `b.endswith(b'\n')` | True (искл. `install-mac.sh` — без хвостового перевода строки, безвредно) |
| exec-бит в git | `git ls-files -s` | `HUB.command` **100755**, `DASHBOARD.command` **100755** |
| CWD | чтение кода | `cd "$(dirname "$0")" \|\| exit 1` — `HUB.command:14`, `DASHBOARD.command:12` |
| bash 3.2 | grep по `declare -A`, `${v^^}`, `mapfile`, `wait -n`, globstar, `\|&`, `coproc` | **ни одной конструкции**; шебанг `#!/bin/bash` |

🪤 Первый заход через `od -An -tx1 \| grep -o '0d0a'` дал «CRLF есть» у всех шести файлов — **это
был ложный срабат**: байты склеиваются в один hex-поток без разделителя, и, например, `10 d0 a5`
даёт подстроку `0d0a`. Верить только побайтовому подсчёту (`python`/`od` с разделителями).

**`.gitattributes` работает и защищает доставку.** Проверено `git archive` прямо на этой Windows-машине:

```
DASHBOARD.command    mode=0o775 exec=x CRLF=0
HUB.command          mode=0o775 exec=x CRLF=0
install-mac.sh       mode=0o775 exec=x CRLF=0
mac-support/shims/*  mode=0o775 exec=x CRLF=0   (все шесть)
hub.js               mode=0o664 exec=-  CRLF=1908   <-- см. Б-3
```

То есть известные грабли проекта «`git archive` на Windows подмешивает CRLF» для `.command`/`.sh`/
шимов **закрыты** правилами `*.command text eol=lf`, `*.sh text eol=lf`, `mac-support/shims/* text eol=lf`.

---

### [BLOCKER] Карантин: `xattr` внутри скрипта не может снять карантин с самого себя

- **Где:** `HUB.command:15` (`xattr -cr . 2>/dev/null`), `DASHBOARD.command` — вообще без `xattr`
- **Что происходит на маке:** если сам `.command` приехал с `com.apple.quarantine`, двойной клик
  не запускает скрипт — Gatekeeper показывает «"HUB.command" cannot be opened because it is from
  an unidentified developer» (на macOS 15+: «Apple could not verify … is free of malware»).
  Строка 15 **никогда не выполняется**: она внутри файла, который система отказалась запускать.
- **Почему:** классический chicken-and-egg. Снятие карантина обязано происходить **снаружи** —
  до первого запуска. Показательно, что проект это уже знал: старый экспортёр
  `internal/export-for-mac.js:111` делает отдельный `SETUP_CLICK.command` с комментарием
  «один раз запустить чтобы снять блокировку», а его HTML-лаунчер (строка 223) прямо предлагает
  скопировать `xattr -cr ~/Downloads/mac_import`. В `HUB.command` этот урок не доехал.
- **Когда НЕ стреляет:** документированный путь установки (`install-mac.sh` → `git clone`)
  карантин не ставит — git его не проставляет. Поэтому «у меня всё работает» правдиво.
- **Когда стреляет:** GitHub «Download ZIP», AirDrop, почта, Telegram, архив с флешки, любой
  перенос через браузер — карантин ставит **приложение-получатель**, и Archive Utility его
  распространяет на всё содержимое.
- **Фикс:** код не трогать (он полезен для остальных файлов), а дописать в `docs/MAC-SETUP.md`
  раздел «Если двойной клик ругается на неизвестного разработчика»:
  ```bash
  cd "/путь/к/hub-cc"
  xattr -dr com.apple.quarantine .
  chmod +x HUB.command DASHBOARD.command
  ```
  Проверить наличие карантина: `xattr -p com.apple.quarantine HUB.command` (пусто = чисто),
  список целиком — `xattr -l HUB.command`.
  На macOS 15 Sequoia правый клик → «Открыть» больше не обходит Gatekeeper — только
  *Системные настройки → Конфиденциальность и безопасность → «Всё равно открыть»*.
- **Уверенность:** CONFIRMED, что строка 15 недостижима при карантине на самом файле (чтение кода).
  PLAUSIBLE — точная формулировка диалога и поведение по версиям macOS; проверяется на живом маке
  командой `xattr -w com.apple.quarantine "0081;$(printf %x $(date +%s));Safari;" HUB.command`
  с последующим двойным кликом.

### [BROKEN] `chmod +x "$0" hub.js` не чинит ничего — оба объекта выбраны неверно

- **Где:** `HUB.command:16`
- **Что происходит на маке:**
  - `chmod +x "$0"` — если exec-бит потерян, Terminal.app отказывается исполнять файл
    («could not be executed because you do not have appropriate access privileges») и до строки 16
    управление **не доходит**. Самопочинка невозможна по построению — ровно та же ловушка, что и с карантином.
  - `chmod +x hub.js` — бесполезен **всегда**: `hub.js` запускается как `"$NODE" hub.js`
    (`HUB.command:33`), интерпретатор задан явно, exec-бит не участвует. В git у `hub.js` и так
    `100644`, и `git archive` отдаёт `0664` — то есть строка пытается «починить» то, что и не
    должно быть исполняемым.
- **Почему:** строка написана под сценарий «репо приехало zip-ом, биты слетели» — но это ровно тот
  сценарий, в котором она не исполняется.
- **Фикс:** рабочий обходной путь в проекте **уже есть** — `DASHBOARD.command:14` зовёт
  `exec bash HUB.command start`, то есть через явный интерпретатор, которому exec-бит не нужен.
  Это и надо задокументировать как аварийный запуск: `bash HUB.command`. Саму строку 16 можно
  оставить (вреда нет) либо сузить до `chmod +x DASHBOARD.command` — вот ей это осмысленно.
- **Уверенность:** CONFIRMED (чтение кода + `git ls-files -s` + вывод `git archive`).

### [DEGRADED] `xattr -cr .` обходит всё дерево на КАЖДОМ запуске — 145 721 файл

- **Где:** `HUB.command:15`
- **Что происходит на маке:** первое, что делает скрипт, — молчаливый рекурсивный обход всего
  репозитория. Вывода до этого нет никакого, поэтому окно Terminal стоит пустым: снаружи выглядит
  как зависший запуск.
- **Почему:** масштаб растёт без границ, замерено на этой машине:

  | | Файлов |
  |---|---|
  | Свежий клон (`git ls-files`) | **389** |
  | Эта машина сейчас (`find .`, без `.git`) | **145 721** |

  Разница — рантайм-артефакты, которые накапливаются в работе: `gorouter/` 24 974, `tabi/` 24 761,
  `tools/` 18 705, `agentrouter/` 17 156, `justwoker/` 15 759, `kktoken/` 11 426 (в git у каждой из
  них 1–3 файла — это профили браузеров и кеши). То есть на свежей установке пункт незаметен, а
  через пару месяцев работы мак-пользователь ждёт десятки секунд перед пустым окном.
- **Плюс:** `-c` снимает **все** атрибуты, а не только карантин (заодно Spotlight-комментарии,
  `com.apple.macl`). Для задачи «снять карантин» достаточно `-d com.apple.quarantine`.
- **Фикс:** сузить до того, что реально может быть под карантином, и убрать рекурсию по мусору:
  ```bash
  xattr -dr com.apple.quarantine . 2>/dev/null   # вместо -cr
  ```
  а лучше — по списку и один раз, через маркер:
  ```bash
  if [ ! -f .hub-unquarantined ]; then
    xattr -dr com.apple.quarantine HUB.command DASHBOARD.command hub.js routing mac-support 2>/dev/null
    : > .hub-unquarantined
  fi
  ```
  (`.hub-unquarantined` — в `.gitignore`.)
- **Уверенность:** CONFIRMED по числам (`find`/`git ls-files` отработаны). PLAUSIBLE — конкретные
  секунды задержки, мерить на маке: `time xattr -cr .`.

### [DEGRADED] Поиск node уже, чем на Windows: нет fnm / volta / asdf / MacPorts

- **Где:** `HUB.command:18-19`
- **Что происходит на маке:** «Node.js не найден» при живом `node -v` в обычном терминале —
  ровно та путаница, которую шапка файла (строки 10–12) обещает не допустить.
- **Почему:** у GUI-процесса PATH минимальный, и скрипт добирает его вручную — но покрывает только
  Homebrew (`/opt/homebrew/bin`, `/usr/local/bin`) и nvm (`~/.nvm/nvm.sh`). Не покрыты
  распространённые на маке менеджеры: **fnm**, **volta** (`~/.volta/bin`), **asdf**
  (`~/.asdf/shims`), **MacPorts** (`/opt/local/bin`), **n**, npm-global prefix.
  Для сравнения, `HUB.bat:32-35` держит четыре явных фолбэка, включая `%NVM_SYMLINK%`.
- **Фикс:** расширить строку 18 и добавить fnm:
  ```bash
  export PATH="/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:$HOME/.volta/bin:$HOME/.asdf/shims:$PATH"
  [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
  command -v fnm >/dev/null && eval "$(fnm env)" 2>/dev/null
  ```
- **Уверенность:** CONFIRMED (чтение кода обоих лаунчеров).

### [COSMETIC] Нет заголовка окна — на Windows он есть

- **Где:** `HUB.command` (отсутствует), против `HUB.bat:48` `title ABUSE HUB`
- **Что происходит на маке:** вкладка Terminal подписана путём к скрипту или `bash`, а не «ABUSE HUB».
  При нескольких открытых окнах не отличить.
- **Фикс:** после `cd` добавить `printf '\033]0;ABUSE HUB\007'`.
- **Уверенность:** CONFIRMED.

### [COSMETIC] Комментарий про закрытие окна описывает поведение наоборот

- **Где:** `HUB.command:36-37` — «Окно Terminal при двойном клике закрывается вместе с выводом,
  поэтому при ошибке просим Enter»
- **Что происходит на маке:** у профиля Terminal.app по умолчанию *Shell → When the shell exits →
  Don't close the window*, поэтому при чистом выходе окно **остаётся** с «[Process completed]».
  То есть посылка комментария обратная фактическому дефолту.
- **Последствие:** поведения это не ломает (пауза на ненулевом коде безвредна в обоих случаях),
  но даёт расхождение с Windows: `HUB.bat` при чистом выходе окно закрывает, `HUB.command` — нет.
- **Фикс:** поправить комментарий; если хочется паритета — оставить как есть, это ожидаемое для
  мака поведение, менять настройку профиля за пользователя нельзя.
- **Уверенность:** PLAUSIBLE — зависит от профиля Terminal у владельца. Проверить:
  *Terminal → Settings → Profiles → Shell → When the shell exits*.

### [COSMETIC] Латентный CRLF в `hub.js` при архивной доставке

- **Где:** `.gitattributes` (`*.js text` — без `eol=`), проявляется в `git archive`
- **Что происходит:** замер выше — `hub.js` выходит из `git archive` с **1908** парами CRLF
  (потому что `core.autocrlf=true` на машине сборки, а правило для `*.js` не фиксирует eol).
- **Почему это сейчас НЕ стреляет:** `HUB.command:33` зовёт `"$NODE" hub.js` — шебанг не участвует,
  а сам парсер node к CRLF равнодушен.
- **Почему это мина:** у `hub.js` есть шебанг `#!/usr/bin/env node`, и `HUB.command:16` даже ставит
  ему exec-бит. Стоит кому-то запустить `./hub.js` из архивной копии — получит
  `env: node\r: No such file or directory`, сообщение, по которому причину не угадать.
- **Фикс:** дописать в `.gitattributes` `*.js text eol=lf` (или точечно `hub.js text eol=lf`).
- **Уверенность:** CONFIRMED (вывод `git archive` приведён выше).

---

### [OK] Шимы доезжают: оба `.command` идут через `hub.js`, мимо `lifecycle` никто не стартует

Проверка по наводке соседнего агента: `routing/lifecycle.js:464-472` `childEnv()` препендит
`mac-support/shims` в PATH **ребёнка** и выставляет `SQLITE3=/usr/bin/sqlite3`. Значит шимы
(`netstat`, `taskkill`, `curl.exe`, `python`…) есть только у процессов, поднятых через этот путь —
и любая точка входа, зовущая node в обход, осталась бы без них.

**Обхода нет.** Все четыре мак-входа сходятся в `hub.js`:

| Вход | Строка | Куда идёт |
|---|---|---|
| `HUB.command` | `:33` | `"$NODE" hub.js "$@"` |
| `DASHBOARD.command` | `:14` | `exec bash HUB.command start` → тот же `hub.js` |
| `routing/restart-dashboard.sh` | — | `node hub.js restart "$@"` |
| `routing/stop-dashboard.sh` | — | `exec node hub.js stop "$@"` |

Отдельно отмечу намеренную деталь, чтобы её не «починили» как баг: `childEnv()` правит PATH
**только ребёнку**, своему процессу — нет. Комментарий на `lifecycle.js:461-463` объясняет почему:
`lifecycle` сам ищет настоящий `lsof`, а шим `netstat` из той же папки его бы заслонил.

🪤 **Но находка Б-5 (узкий поиск node) шире, чем один файл.** Тот же короткий список
«homebrew + nvm, без volta/asdf/fnm/MacPorts» продублирован в `restart-dashboard.sh` и
`stop-dashboard.sh` — там он к тому же спрятан за `if ! command -v node`. Патч PATH надо
применять во всех **четырёх** местах, иначе «через меню работает, через ярлык нет».

- **Уверенность:** CONFIRMED (прочитаны все четыре файла и `childEnv()`).

---

## В. Документация

Инвентарь: мак-раздел в проекте **один** — `docs/MAC-SETUP.md` (11 842 б, 24.08 03:04, ровно эпоха
`.command`-файлов). Всё, на что он ссылается, существует и лежит в git — проверено поимённо:
`routing/lifecycle.js`, `routing/stop-dashboard.sh`, `routing/restart-dashboard.sh`,
`tools/relocate.js`, `tools/enable-statusline.js`, `tools/mac-balance-probe.js`,
`tools/mac-cookie-probe.js`. URL установки указывает на ветку `master` — ветка репозитория
действительно `master` (`git branch --show-current`), ссылка живая.

### [BROKEN] MAC-SETUP.md противоречит сам себе: «перезапусти DASHBOARD.command» после обновления

- **Где:** `docs/MAC-SETUP.md:137-138` — «Если код дашборда на Windows обновился — на Mac просто
  сделай `git pull` … и перезапусти `DASHBOARD.command`»
- **Что происходит на маке:** пользователь тянет новый код, кликает `DASHBOARD.command` и
  **продолжает работать на старом коде**. Дашборд отвечает, порты слушают, признаков беды нет.
- **Почему:** `DASHBOARD.command:14` — это `hub start`, а `start` **идемпотентен**: занятый порт с
  нашим же node он считает поднятым и не трогает (`routing/lifecycle.js:275-292`, `isOurs()` по
  имени образа). Живые процессы остаются на коде, загруженном при прошлом старте.
  Тот же документ **сам это объясняет** двадцатью строками выше (`:84-86`): «Старт идемпотентен…
  Нужен именно перезапуск — пункт „Перезапустить“ или `node hub.js restart`». Строка 138 написана
  по памяти о старом поведении: до 24.08 `DASHBOARD.command` звал `restart-dashboard.sh`, то есть
  двойной клик действительно означал перезапуск — об этом прямо сказано в шапке
  `DASHBOARD.command:5-8`. Поведение поменяли, доку в этом месте — нет.
- **Цена ошибки:** это ровно та классическая ловушка проекта, где правка лежит в файле, а процесс
  поднят на старом коде: «обновился, а баг на месте» уводит в поиск несуществующей проблемы.
- **Фикс:** заменить строку 138 на:
  ```markdown
  - `git pull` (или кнопка «Обновить» в дашборде), затем **перезапуск**: `HUB.command` →
    «Перезапустить», либо `node hub.js restart`. Клик по `DASHBOARD.command` здесь НЕ поможет —
    `start` идемпотентен и живые процессы со старым кодом не тронет.
  ```
- **Уверенность:** CONFIRMED (прочитаны `DASHBOARD.command`, `lifecycle.js:270-292` и обе строки доки).

### [DEGRADED] `CLAUDE.md` даёт агенту Windows-команду как единственный способ рестарта

- **Где:** `CLAUDE.md:29` (корень репо) — «Рестарт дашборда: `routing/restart-dashboard.bat`»
- **Что происходит на маке:** агент, работающий по этому файлу на маке, зовёт `.bat` — на маке это
  не исполняется ничем. Мак-двойник `routing/restart-dashboard.sh` в инструкции **не упомянут**.
- **Почему:** файл не обновляли после уборки 24.08. Указанный `.bat` жив, но это уже **форвардер**:
  весь его код — `call "%~dp0..\HUB.bat" restart %*`. Канон с 24.08 — `node hub.js restart`,
  одинаковый на обеих системах.
- **Фикс:** заменить строку на кросс-платформенную:
  ```markdown
  - Рестарт дашборда: `node hub.js restart` (одинаково на Windows и mac).
    `routing/restart-dashboard.bat` / `.sh` — легаси-форвардеры для старых ярлыков.
  ```
- **Уверенность:** CONFIRMED (прочитан `restart-dashboard.bat` целиком — три строки).

### [DEGRADED] `rescue.js` на маке советует запустить `HUB.bat`

- **Где:** `routing/rescue.js:198` и `:333`
- **Что происходит на маке:** спасательный сценарий — последнее, что читает человек, когда всё
  сломалось, — печатает «нужен рестарт: `HUB.bat` → „Перезапустить“» и «порты не слушают →
  `HUB.bat` → „Перезапустить“». На маке такого файла нет.
- **Почему:** движок `rescue.js` кросс-платформенный (проверено: ни `taskkill`, ни `netstat`, ни
  `process.platform`; на `:354` даже стоит самопроверка «процессы не убиваем»), а вот
  человекочитаемые подсказки писались под Windows.
- **Фикс:** подставлять имя по платформе, например
  `const ENTRY = process.platform === 'win32' ? 'HUB.bat' : 'HUB.command';` и печатать `${ENTRY}`;
  либо нейтральное `node hub.js restart`, которое верно везде.
- **Уверенность:** CONFIRMED (grep по файлу).

### [COSMETIC] В блоке «дашборд не открылся» мак-читателю предлагают `START.bat`

- **Где:** `README.md:196`
- **Что происходит:** абзац аккуратно разводит платформы («Двойной клик по **`HUB.bat`** (Windows)
  или **`HUB.command`** (mac)»), а следующей фразой говорит «`START.bat` делает то же самое одним
  шагом, без меню» — без мак-двойника. Мак-пользователь пойдёт искать несуществующий `START.bat`.
- **Почему:** имена входов «просто поднять стек» на платформах разные (см. §А.3): `START.bat` против
  `DASHBOARD.command`. В другом месте README это учтено — `:391` даёт правильную пару
  `START.bat / DASHBOARD.command  # = hub start`.
- **Фикс:** `«`START.bat` (mac: `DASHBOARD.command`) делает то же самое одним шагом, без меню.»`
- **Уверенность:** CONFIRMED.

### [COSMETIC] `RESCUE.bat` не описан нигде — ни в README, ни в ARCHITECTURE, ни в docs/

- **Где:** отсутствие записи; `grep -rn RESCUE README.md ARCHITECTURE.md docs/*.md CLAUDE.md` → пусто
- **Что это значит:** вместе с находкой §А.4 (файл под `.gitignore`) получается, что спасалка
  **недоступна и неизвестна никому, кроме владельца** — её нет ни в клоне, ни в документации.
  Это буквальное повторение прецедента, зафиксированного в `.gitignore:117-119` про `SHARE.bat`
  («в README описан, в git его нет вообще»), только в зеркальном виде: в git нет и в README нет.
### [BROKEN] Мак-раздел `ARCHITECTURE.md` описывает лаунчеры до уборки 24.08

- **Где:** `ARCHITECTURE.md:3174-3196` (раздел «macOS: обёртка-совместимость»), таблица файлов
- **Что происходит:** две строки таблицы описывают код, которого больше нет:

  | Строка | Написано | Как на самом деле |
  |---|---|---|
  | `:3194` `DASHBOARD.command` | «двойной клик: `xattr -cr .` + `bash routing/restart-dashboard.sh`» | `xattr` в файле **нет вообще**; зовёт `exec bash HUB.command start` (`DASHBOARD.command:14`). И это **start**, а не restart |
  | `:3193` `routing/restart-dashboard.sh` | «чистит 8 портов через `lsof -ti`, `PATH`+`SQLITE3`, старт fm-rot :20126 / fm-oa :20130 / vyce :20131 / transparent-proxy :8200, poll статуса, `open` UI» | форвардер в три строки: `node hub.js restart "$@"`; вся перечисленная механика уехала в `hub.js` / `routing/lifecycle.js` |

- **Плюс пропажа:** `HUB.command` — по `docs/MAC-SETUP.md:15` «**Основная точка входа**» — в мак-разделе
  `ARCHITECTURE.md` не упомянут **ни разу**. Во всём файле на 376 КБ он встречается один раз, на
  `:37`. То есть канонический код-документ проекта описывает мак через устаревший вход и молчит
  про актуальный.
- **Почему:** 24.08 пять скриптов запуска свели в один хаб (коммит `04eec4f`), `ARCHITECTURE.md`
  в мак-разделе не переписали — правки того дня видны в общей части (`:37`, `:99`, `:266`), но не тут.
- **Фикс:** переписать две строки таблицы и добавить `HUB.command` первой строкой:
  ```markdown
  | `HUB.command` | **основной вход**, двойной клик: `cd` в каталог скрипта, `xattr -cr .`,
    добор PATH (Homebrew/nvm), затем `node hub.js` — меню старт/стоп/рестарт/обновление/доктор |
  | `DASHBOARD.command` | двойной клик = `bash HUB.command start` (идемпотентный старт, без меню) |
  | `routing/restart-dashboard.sh` · `stop-dashboard.sh` | форвардеры в `node hub.js restart|stop`
    (имена сохранены для старых ярлыков); механика портов живёт в `routing/lifecycle.js` |
  ```
- **Уверенность:** CONFIRMED (сверены обе строки таблицы с фактическим содержимым файлов;
  `grep -n "HUB.command" ARCHITECTURE.md` даёт единственное попадание на `:37`).

### [DEGRADED] Ни в одном документе нет раздела про Gatekeeper

- **Где:** `docs/MAC-SETUP.md` (нет раздела), `README.md:138-164` (нет), `ARCHITECTURE.md:3174+` (нет)
- **Что происходит на маке:** пользователь, получивший репо не через `install-mac.sh` (ZIP с
  GitHub, AirDrop, архив от владельца), упирается в «cannot be opened because it is from an
  unidentified developer» и **не находит в документации ни слова** о том, что делать. Единственное
  упоминание карантина — `MAC-SETUP.md:15`, и оно вводит в заблуждение: «`HUB.command` … Снимает
  карантин `xattr`» — снимает, но не с себя (см. Б-1).
- **Почему:** документированный путь установки (`curl` → `git clone`) карантин не ставит, поэтому
  проблема не воспроизводилась у авторов.
- **Фикс:** раздел в `docs/MAC-SETUP.md` — текст патча приведён в Б-1. Плюс поправить строку 15,
  чтобы она не обещала лишнего: «снимает карантин с файлов репозитория (с себя — не может,
  см. раздел про Gatekeeper)».
- **Уверенность:** CONFIRMED (grep по всем трём документам).

### Что в документации ПРАВИЛЬНО (чтобы не «чинили» здоровое)

- `README.md:391` — корректная пара `START.bat / DASHBOARD.command  # = hub start`.
- `README.md:143`, `MAC-SETUP.md:27` — URL установки указывает на ветку `master`; ветка репозитория
  действительно `master` (`git branch --show-current`), ссылка живая.
- Все семь файлов, на которые ссылается `MAC-SETUP.md`, существуют и лежат в git (проверено поимённо).
- `MAC-SETUP.md:52-55` и `README.md:159` — объяснение `bash -c "$(curl …)"` против `curl | bash`
  (занятый stdin ломает интерактивные `read`) верное и важное.
- `MAC-SETUP.md:88-93` — перенос папки проекта: механика указателя
  `~/.claude/autoreger-root.txt` описана верно и совпадает с `lifecycle.js` `preparePlatform()`.
- `ARCHITECTURE.md:3146` честно помечает ТГ-менеджер как «написано вслепую, не проверено на Darwin» —
  такие пометки сохранить.
- `ARCHITECTURE.md:193` — пункт меню `[9]` помечен как Windows-only (AutoHotkey на macOS нет), верно.
- `ARCHITECTURE.md:3226` — фиксирует правила `.gitattributes` для `*.command` и `mac-support/shims/*`;
  замером подтверждено, что они работают (см. Б.0).

---

## Г. `package.json` и `opencode.json`

### [OK] Секция `bin` отсутствует, `scripts` кросс-платформенные

`package.json` **не имеет** ключа `bin` — то есть никаких генерируемых шимов, которые могли бы
разъехаться по платформам, нет. Все десять скриптов — вида `node <путь>` с прямыми слэшами
(работают и на Windows), без `&&`-цепочек, `set VAR=`, `%VAR%`, `.bat`, `powershell`, `rm`/`cp`.
`npm start` / `npm run stop` / `restart` / `status` идут в `hub.js`, то есть через
`lifecycle.childEnv()` — шимы на месте.

`opencode.json` платформо-нейтрален: пять провайдеров, у всех `baseURL` вида
`http://127.0.0.1:<порт>`, ни одного пути файловой системы.

### [BROKEN] `npm run dashboard` поднимает прокси в обход `childEnv()` — на маке без шимов

- **Где:** `package.json` → `"dashboard": "node routing/transparent-proxy.js"`
- **Что происходит на маке:** прокси стартует напрямую, **минуя `hub.js` → `lifecycle.childEnv()`**,
  поэтому в его `PATH` нет `mac-support/shims`, а `SQLITE3` не выставлен. Дальше:
  - `routing/transparent-proxy.js:3835` `execFileSync('netstat', ['-ano'])` и `:3838`
    `execFileSync('taskkill', ['/F','/PID', …])` — на маке без шимов это `ENOENT`. Оба вызова
    обёрнуты в `try {} catch {}`, то есть **падают молча**: порт не освобождается, ошибки не видно.
  - `:102` `SQLITE_EXE = process.env.SQLITE3 || [ …WinGet\sqlite3.exe… ]` — без `SQLITE3` фолбэк
    уходит на **виндовые** пути WinGet, которых на маке нет; `/__switch/api/whoami` теряет
    возможность прочитать `~/.omniroute/storage.sqlite`.
- **Почему:** скрипт `dashboard` старше уборки 24.08 и остался прямым вызовом, тогда как остальные
  (`start`/`stop`/`restart`/`status`) переведены на `hub.js`.
- **Цена:** отладочный запуск «подниму-ка прокси напрямую» на маке даёт тихо деградированный
  дашборд — тот же класс, что «правка в файле, а процесс на старом коде».
- **Фикс:** увести через хаб, как остальные:
  ```json
  "dashboard": "node hub.js start"
  ```
  Если нужен именно одиночный прокси для отладки — оставить, но переименовать в
  `"dashboard:raw"` и приписать в README, что на маке он идёт без шимов.
- **Уверенность:** CONFIRMED (`childEnv()` — `routing/lifecycle.js:464-472`; вызовы `netstat` /
  `taskkill` / фолбэк `SQLITE3` прочитаны в `transparent-proxy.js`).

---

## Итог

**16 находок:** 1 BLOCKER · 5 BROKEN · 5 DEGRADED · 5 COSMETIC.

| Градация | Находки |
|---|---|
| **BLOCKER** (1) | карантин: `xattr` внутри `.command` не снимает карантин с себя |
| **BROKEN** (5) | `RESCUE.bat` под `.gitignore` · `chmod +x "$0" hub.js` не чинит ничего · `MAC-SETUP.md:138` «перезапусти `DASHBOARD.command`» · мак-раздел `ARCHITECTURE.md` описывает лаунчеры до 24.08 · `npm run dashboard` в обход `childEnv()` |
| **DEGRADED** (5) | `xattr -cr .` по 145 721 файлу на каждом запуске · узкий поиск node (нет fnm/volta/asdf/MacPorts) · `CLAUDE.md` даёт `.bat` как единственный рестарт · `rescue.js` советует `HUB.bat` · нигде нет раздела про Gatekeeper |
| **COSMETIC** (5) | нет заголовка окна · комментарий про закрытие окна наоборот · латентный CRLF в `hub.js` при архивной доставке · `README:196` предлагает маку `START.bat` · `RESCUE.bat` не описан нигде |

### Главное

**Сами `.command`-файлы написаны корректно — байты чистые, `cd` на месте, bash 3.2 соблюдён, шимы
доезжают; ломается не код, а доставка и документация: карантин снимать некому, `RESCUE.bat` не
попадает в клон, а два документа описывают лаунчеры, которых нет с 24.08.**

Гипотеза брифа «`HUB.bat` новее на день → в нём есть правки, не доехавшие до мака» **не
подтвердилась**: единственный коммит того дня правит в батнике только комментарий, а вся логика
(элевация, переезд в Windows Terminal) закрыта гардом `L.IS_WIN` и маку не нужна.

### Что дописать в `HUB.command`

```bash
# 1. [DEGRADED] Заголовок окна — паритет с `title ABUSE HUB` в HUB.bat:48.
#    Сразу после `cd "$(dirname "$0")" || exit 1`:
printf '\033]0;ABUSE HUB\007'

# 2. [DEGRADED] Сузить карантин и снять рекурсию по 145k файлов.
#    Заменить строку 15 (`xattr -cr . 2>/dev/null`) на:
if [ ! -f .hub-unquarantined ]; then
  xattr -dr com.apple.quarantine HUB.command DASHBOARD.command hub.js routing mac-support 2>/dev/null
  : > .hub-unquarantined
fi
#    `.hub-unquarantined` — добавить в .gitignore.

# 3. [DEGRADED] Расширить поиск node. Заменить строки 18-19 на:
export PATH="/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:$HOME/.volta/bin:$HOME/.asdf/shims:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
command -v fnm >/dev/null && eval "$(fnm env)" 2>/dev/null
#    ⚠️ Тот же патч нужен ещё в ТРЁХ местах с той же короткой строкой:
#       routing/restart-dashboard.sh, routing/stop-dashboard.sh
#       (там он спрятан за `if ! command -v node`).

# 4. [BROKEN] Строку 16 сузить — `chmod +x hub.js` бесполезен (hub.js зовётся как `"$NODE" hub.js`),
#    `chmod +x "$0"` недостижим. Осмысленно только это:
chmod +x DASHBOARD.command 2>/dev/null

# 5. [COSMETIC] Поправить комментарий на строках 36-37: у Terminal.app по умолчанию
#    «When the shell exits → Don't close the window», окно НЕ закрывается само.
```

### Что дописать в `DASHBOARD.command`

```bash
# 6. [BLOCKER-смежное] Своей защиты от карантина у файла нет вообще — он полагается на
#    HUB.command, который до него может не дойти. Добавить после `cd`:
xattr -dr com.apple.quarantine DASHBOARD.command HUB.command 2>/dev/null

# 7. [COSMETIC] Заголовок окна:
printf '\033]0;ABUSE HUB — старт\007'
```

> ✅ Строку 14 (`exec bash HUB.command start`) **не трогать** — явный интерпретатор снимает
> зависимость от exec-бита. Это единственный вход, переживающий доставку zip-ом, и его же
> надо документировать как аварийный запуск: `bash HUB.command`.

### Чего в `.command` НЕ хватает как файла

- **`RESCUE.command`** — мак-аналога нет вообще, а движок `routing/rescue.js` кросс-платформенный и
  готов. Достаточно обёртки по образцу `DASHBOARD.command`; делать **вместе** с починкой
  `.gitignore` (иначе бессмысленно — см. §А.4).

### Вне моих файлов, но найдено по пути

| Файл | Правка |
|---|---|
| `.gitignore:127` | дописать `!RESCUE.bat`, затем `git add -f RESCUE.bat` |
| `.gitattributes` | дописать `*.js text eol=lf` — иначе `hub.js` уезжает в архив с 1908 CRLF |
| `package.json` | `"dashboard": "node hub.js start"` вместо прямого `transparent-proxy.js` |
| `routing/rescue.js:198,333` | `HUB.bat` → по платформе либо нейтральное `node hub.js restart` |
| `docs/MAC-SETUP.md` | раздел про Gatekeeper; строка 15 (не обещать снятие карантина с себя); строка 138 (start ≠ restart) |
| `ARCHITECTURE.md:3193-3194` | переписать две строки таблицы, добавить `HUB.command` |
| `CLAUDE.md:29` | `node hub.js restart` вместо `routing/restart-dashboard.bat` |
| `README.md:196` | приписать мак-двойник `DASHBOARD.command` рядом со `START.bat` |

### Чем проверить на живом маке (то, что осталось PLAUSIBLE)

```bash
xattr -p com.apple.quarantine HUB.command     # пусто = карантина нет
xattr -l HUB.command                          # все атрибуты
time xattr -cr .                              # цена текущей строки 15
# воспроизвести карантин намеренно:
xattr -w com.apple.quarantine "0081;$(printf %x $(date +%s));Safari;" HUB.command
# поведение окна: Terminal → Settings → Profiles → Shell → When the shell exits
```
