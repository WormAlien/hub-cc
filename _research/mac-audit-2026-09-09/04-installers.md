# Аудит мак-совместимости: установщики

**Агент:** №4 из 10
**Зона:** `install-mac.sh`, `install.sh`, `install-deps.sh`, `install-lib.sh`, `install.ps1`
**Дата:** 2026-09-09
**Статус:** готов — 18 находок (2 BLOCKER, 4 BROKEN, 8 DEGRADED, 4 COSMETIC)

Размеры и даты на момент аудита:

| Файл | Байт | mtime | BOM | CRLF |
|---|---|---|---|---|
| `install.sh` | 17833 | 2026-08-24 15:34 | нет | 0 |
| `install-mac.sh` | 18748 | 2026-08-24 15:34 | нет | 0 |
| `install-deps.sh` | 21850 | 2026-08-20 10:11 | нет | 0 |
| `install-lib.sh` | 3582 | 2026-08-20 07:33 | нет | 0 |
| `install.ps1` | 6794 | 2026-08-21 04:59 | нет (намеренно, `irm\|iex`) | 0 |

Проверено байтами: `head -c 3 <файл> | xxd` → `2321 2f` (`#!/`) у всех четырёх `.sh`;
`xxd <файл> | grep -c '0d0a'` → `0` у всех пяти. `file(1)` подтверждает
«Bourne-Again shell script, UTF-8 text executable». **Кодировка и переносы строк — чисто,
находок нет.**

---

## А. Дрейф между установщиками

### Карта шагов (построчная сверка)

| # | `install.sh` (Windows) | `install-mac.sh` | |
|---|---|---|---|
| — | guard: на месте ли `install-lib.sh`/`install-deps.sh` (20–26) | — | мак сам себе lib, ок |
| — | `. ./install-lib.sh` (27) | свои копии `b/ok/warn/err/step/have` (16–21) | осознанно, `install-lib.sh:10-12` |
| — | guard двойной вложенности по двум именам (31–37) | только внутри bootstrap (73–76) | **A6** |
| 0 | — | bootstrap: CLT → git → clone → `exec` (37–92) | аналог `install.ps1` |
| 1 | node/npm/git + winget (46–62) | Xcode CLT (101–113), Homebrew (115–146), brew node/git (148–158) | ✅ |
| 2 | **git identity + `pull.rebase` + credential.helper (64–91)** | **ОТСУТСТВУЕТ** | **A1** |
| 3 | `cat` в системный PATH для apiKeyHelper (93–124) | — | не нужен, см. «проверено» |
| 4 | `npm install` безусловно (126–129) | только если нет `node_modules` (160–166) | **Б4** |
| 5 | `npx playwright install chromium chromium-headless-shell` (131–142) | `npx playwright install chromium` (169–175) | ложная тревога, см. «проверено» |
| 6 | Claude Code: версия, `CLAUDE_CODE_VERSION`, `npm config delete prefix`, `npm approve-scripts`, проверка после (144–172) | Claude Code: `have claude` + фолбэк на `~/.npm-global` (177–205) | **A2**, **A3**, **A4** |
| 7 | `~/.claude/settings.json` + статуслайн (174–198) | то же (207–239) | ✅ паритет |
| 8 | `copy_if_absent` ×5 (200–206) | `copy_example` ×6 (220–225) | паритет, но оба отстали — **Б3** |
| — | — | `chmod +x` + `xattr -cr` (241–251) | **Б1**, **В4** |
| 9 | `AUTO="$AUTO" bash install-deps.sh` (213) | `bash install-deps.sh` — **без `AUTO`** (263, 267) | **A5** |
| 10 | `start … restart-dashboard.bat` (222–226) | `bash routing/restart-dashboard.sh` (276, 280) | **Б1** |
| 11 | шпаргалка (231–247) | шпаргалка (287–305) | **Б1** |
| 12 | `read -p "Enter для выхода"` если не AUTO (251) | — | **A7** |

_(находки ниже)_

### [BROKEN] A1. На маке не настраивается git identity — `git pull` с мержем падает

- **Где:** `install.sh:64-91` есть, в `install-mac.sh` аналога нет вообще
- **Что происходит на маке:** после установки `git pull` (штатное обновление, оно же
  пункт меню `hub.js update`) при разошедшейся истории падает с
  `Committer identity unknown / Please tell me who you are`. Обновление «не приезжает»,
  и текст ошибки говорит про identity, а не про сеть.
- **Почему:** `install.sh` лечит это явно, своим же комментарием на 65–66
  («Без user.name/user.email git pull с merge-коммитом падает»), плюс ставит
  `pull.rebase=false`. Мак-ветка эту секцию не получила ни разу с момента создания
  (18.08).
- **Смягчающее:** репозиторий `WormAlien/hub-cc` **публичный**
  (`gh repo view --json isPrivate` → `false`), поэтому `git clone` в bootstrap
  проходит без креденшелов, и аналог Git Credential Manager для самой установки не
  обязателен. Отсюда BROKEN, а не BLOCKER.
- **Фикс:** перенести блок в `install-mac.sh` перед шагом 3; дефолт имени брать не из
  `$USERNAME` (виндовая переменная), а из `$USER` / `id -un`:
  ```bash
  step "Git identity"
  GIT_NAME=$(git config --global user.name 2>/dev/null || true)
  GIT_EMAIL=$(git config --global user.email 2>/dev/null || true)
  if [ -z "$GIT_NAME" ] || [ -z "$GIT_EMAIL" ]; then
    MACUSER="${USER:-$(id -un)}"
    if noask; then
      git config --global user.name  "${GIT_NAME:-$MACUSER}"
      git config --global user.email "${GIT_EMAIL:-${MACUSER}@local}"
    else
      read -r -p "  Имя для git [${GIT_NAME:-$MACUSER}]: " a
      git config --global user.name "${a:-${GIT_NAME:-$MACUSER}}"
      read -r -p "  Email для git [${GIT_EMAIL:-${MACUSER}@local}]: " a
      git config --global user.email "${a:-${GIT_EMAIL:-${MACUSER}@local}}"
    fi
  fi
  git config --global pull.rebase false 2>/dev/null || true
  git config --global credential.helper osxkeychain 2>/dev/null || true
  ```
- **Уверенность:** CONFIRMED (отсутствие блока); PLAUSIBLE (частота мержа у конечного
  пользователя — на чистом клоне `pull` обычно fast-forward)

### [DEGRADED] A2. Мак не проверяет, что `claude` реально ответил после установки

- **Где:** `install-mac.sh:189` — `if have claude`; сравни `install.sh:151,163-171`
- **Что происходит на маке:** `have claude` = «файл нашёлся в PATH». Битый шим из
  `~/.npm-global/bin` (не выполнился `postinstall`, см. **A3**) эту проверку проходит,
  и установщик печатает `✓ claude уже стоит: ?` — знак вопроса подставляет его же
  `|| echo '?'` на строке 190. Пользователь считает, что всё хорошо.
- **Почему:** `install.sh` ловит это специально, своим комментарием на 162
  («Проверяем результат тут же, а не у друга через неделю»): парсит
  `claude --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+'` до и после установки.
  Мак-ветка ограничилась наличием файла.
- **Фикс:** в `install-mac.sh:189` и `203` заменить `have claude` на проверку вывода:
  ```bash
  CUR=$(claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  if [ -n "$CUR" ]; then ok "claude $CUR"; else … ставим … fi
  ```
- **Уверенность:** CONFIRMED

### [DEGRADED] A3. На маке нет `npm approve-scripts` для Claude Code

- **Где:** `install.sh:161` есть, в `install-mac.sh:192-201` — нет
- **Что происходит на маке:** при npm с включённым гейтом на скрипты `postinstall`
  (`node install.cjs`) пакета `@anthropic-ai/claude-code` не выполняется; `claude`
  либо не заводится, либо тормозит на первом старте. В паре с **A2** это и даёт
  «установщик сказал ок, а `claude` не работает».
- **Фикс:** после каждого `npm install -g @anthropic-ai/claude-code` в мак-ветке
  (строки 192 и 201) добавить
  `npm approve-scripts @anthropic-ai/claude-code >/dev/null 2>&1 || true`.
- **Уверенность:** CONFIRMED (строки нет); PLAUSIBLE (гейт есть не во всех версиях
  npm — поэтому в `install.sh` ошибка и глотается)

### [COSMETIC] A4. `CLAUDE_CODE_VERSION` работает только на Windows

- **Где:** `install.sh:149,152,157`; в `install-mac.sh` переменная не упоминается
- **Что происходит на маке:** задокументированный в `install.sh:149` способ
  («Если зачем-то нужна конкретная — `CLAUDE_CODE_VERSION=2.1.153 bash install.sh`»)
  на маке молча игнорируется, ставится latest.
- **Фикс:** `npm install -g "@anthropic-ai/claude-code${CLAUDE_CODE_VERSION:+@$CLAUDE_CODE_VERSION}"`
  в обеих ветках шага 6 мак-установщика.
- **Уверенность:** CONFIRMED

### [BROKEN] A5. `AUTO` не пробрасывается в `install-deps.sh` — авто-обновление на маке залипает

- **Где:** `install-mac.sh:263` и `install-mac.sh:267` — `bash install-deps.sh`
  (сравни `install.sh:214` — `AUTO="$AUTO" bash install-deps.sh`)
- **Что происходит на маке:** `AUTO=1 bash install-mac.sh` (так его зовёт `update.sh`)
  доходит до шага 9, `noask` истинно → запускается `bash install-deps.sh` **дочерним
  процессом без переменной**. Внутри `install-lib.sh:26` делает `AUTO=${AUTO:-0}` →
  **0**, и `ask()` на `install-deps.sh:139` («Поставить ТГ-менеджер?») уходит в `read`
  на живом tty. **Автообновление встаёт насмерть и ждёт Enter.**
- **Почему:** `AUTO` в `install-mac.sh:29` объявлена обычной переменной, без `export`.
  На Windows это лечится явным присваиванием в командной строке вызова; мак-ветку не
  поправили. Это ровно та поломка, от которой предостерегает шапка
  `install-lib.sh:6-8`: «две копии этой функции разъехались бы молча, и обновление у
  друга начало бы залипать на приглашении ввода».
- **Не стреляет ровно в одном случае:** когда tty нет вообще (`! -t 0`) — тогда `read`
  получает EOF, подставляется дефолт. То есть в пайплайне повезёт, в терминале — нет.
  А `noask()` в `install-mac.sh:30` истинно в обоих случаях, поэтому расхождение и
  осталось незамеченным.
- **Фикс:** обе строки привести к виду
  ```bash
  AUTO="$AUTO" bash install-deps.sh
  ```
- **Уверенность:** CONFIRMED

### [COSMETIC] A6. Guard двойной вложенности на маке не срабатывает при ручном клоне

- **Где:** `install.sh:31-37` (после `cd`, по двум именам: `hub-cc` и
  `vibe-code-account-creator-manager`), `install.ps1:83-94` (то же);
  `install-mac.sh:73-76` — только внутри bootstrap и только по `$DEST/$REPO_NAME`
- **Что происходит на маке:** если человек склонировал репо руками внутрь другого
  клона, мак-установщик пройдёт мимо и создаст venv с путями внутрь вложенной копии —
  ровно то, от чего предупреждает `install.sh:34` («Python запомнит старые пути»).
- **Смягчающее:** вход в bootstrap у мака устроен **надёжнее** виндового: он проверяет
  наличие `package.json` + `routing/restart-dashboard.sh` (строка 48), а не имя папки,
  поэтому «уже внутри репо» определяется правильно даже после переименования. Легаси-имя
  `vibe-code-account-creator-manager` маку поэтому и не нужно.
- **Фикс:** после `cd "$SELF_DIR"` (строка 94) добавить цикл из `install.sh:31-37`.
- **Уверенность:** CONFIRMED

### [COSMETIC] A7. Нет финальной паузы

- **Где:** `install.sh:251` — `[ "$AUTO" = "1" ] || read -r -p "Enter для выхода..." _`;
  в `install-mac.sh` нет
- **Что происходит на маке:** штатные пути (`bash install-mac.sh` в Terminal,
  однострочник `bash -c "$(curl …)"`) окно не закрывают, вреда нет. Станет проблемой,
  если появится `INSTALL.command` — двойной клик схлопнет окно вместе с выводом, как
  это уже учтено в `HUB.command:38-42` и `DASHBOARD_WAIT_ENTER`
  в `routing/restart-dashboard.sh:26-28`.
- **Уверенность:** CONFIRMED (значимость низкая)

### Что есть в `install.ps1`, но не имеет мак-аналога

| `install.ps1` | Мак-аналог | Вердикт |
|---|---|---|
| проверка `winget` (25–27) | `have brew` + автоустановка (138–146) | ✅ есть |
| `Set-ExecutionPolicy RemoteSigned` (33–41) | — | не нужен |
| `winget install Git.Git` / `OpenJS.NodeJS.LTS` (44–62) | CLT + `brew install node git` (101–157) | ✅ есть |
| обновление `$env:Path` в сессии (50–51, 60–61) | `brew_shellenv` + `~/.zprofile` (123–136) | ✅ есть, **и лучше**: Windows-вариант правит PATH только в текущей сессии, мак дописывает навсегда |
| поиск `bash.exe` по трём путям (66–71) | — | не нужен |
| легаси-имя папки `vibe-code-account-creator-manager` (83) | — | **A6** |
| запуск в login-shell (`bash -lc`, 106) | `exec bash "$DEST/install-mac.sh"` (91) | ⚠️ мак **не** login-shell: `~/.zprofile`, куда он сам же дописал brew, в этом процессе не перечитывается. Спасает `eval "$("$p" shellenv)"` на 127 — покрыто, но случайно, а не по замыслу |

### Проверено и НЕ является находкой (секция А)

1. **`chromium-headless-shell` на маке не пропущен.** `install.sh:139` ставит
   `chromium chromium-headless-shell`, `install-mac.sh:174` — только `chromium`, и это
   выглядит дырой: код действительно зависит от headless-shell
   (`routing/lib/newapi-account.js:630`, замер 23.08 — при `headless: true`
   поднимается именно `chrome-headless-shell`, и куки лежат открытым текстом).
   Но в Playwright 1.60 (пин в `package.json`) CLI **сам разворачивает алиас** —
   `node_modules/playwright-core/lib/coreBundle.js:29536-29541`:
   ```js
   if (alias === "chromium" || chromiumAliases.includes(alias)) {
     if (options2.shell !== "only") handleArgument("chromium");
     if (options2.shell !== "no")   handleArgument("chromium-headless-shell");
   }
   ```
   `npx playwright install chromium` тянет оба бинаря. Избыточен явный список
   в `install.sh`, а не мак-ветка неполна.
   *Остаточный нюанс (COSMETIC):* проверка «уже стоит?» в `install-mac.sh:171` смотрит
   только `p.chromium.executablePath()`, поэтому при частичной установке от более
   старой версии второй бинарь не доставит.
2. **`cat` в системном PATH (`install.sh:93-124`) маку не нужен.** Шаблон
   `docs/claude-settings.example.json` использует `ANTHROPIC_AUTH_TOKEN: "dummy"`,
   а не `apiKeyHelper`; `cat` на macOS всегда в `/bin`.
3. **`git clone` в bootstrap не требует авторизации** — репо публичный.
4. **Все пути из шпаргалки существуют** (проверено `ls`): `tools/mac-balance-probe.js`,
   `tools/enable-statusline.js`, `tools/doctor.sh`, `routing/restart-dashboard.sh`,
   `routing/stop-dashboard.sh`, `mac-support/shims/{netstat,python,python.exe,taskkill,curl.exe,clip.exe}`,
   `tools/tg-venv-requirements.txt`, `tools/tg-venv-python.js`.

---

## Б. Отставание от текущего состояния проекта

### Точная дата заморозки

Последний коммит, тронувший `install-mac.sh`, — `04eec4f` от **2026-08-25 07:42**,
но он поменял там **ровно две строки путей**: `claude-settings.example.json` →
`docs/claude-settings.example.json` и `bash doctor.sh` → `bash tools/doctor.sh`
(проверено `git show 04eec4f -- install-mac.sh` — диффа больше нет).
**Логика заморожена на 2026-08-24 15:34.**

Ирония в том, что это тот же самый коммит, который принёс `hub.js`,
`routing/lifecycle.js`, `HUB.command` и `HUB.bat`: мак-установщику подправили пути,
но не сказали про новую точку входа. Это корень находок Б1 и Б2.

С 24.08 15:35 по 09.09 — **75 коммитов**. Каталоги по числу тронутых файлов:
`routing` 153, `tools` 96, `internal` 15, `hcnsec` 5, `docs` 5, `outlook` 3,
`truesota`/`seekai`/`kktoken`/`justwoker` по 2, `aipm`/`agentrouter`/`notion`/`ourtoken` по 1.

_(находки ниже)_

### [DEGRADED] Б1. Установщик не знает про `hub.js` / `HUB.command` — новую точку входа

- **Где:** `install-mac.sh:247` (список `chmod`), `install-mac.sh:276,280-281`
  (шаг запуска), `install-mac.sh:287-305` (шпаргалка)
- **Что происходит на маке:** `HUB.command` и `HUB.bat` появились 2026-08-25 07:42
  (`04eec4f`, «HUB.bat / HUB.command — двойной клик, всё остальное форвардеры»).
  Установщик про них не знает нигде:
  - `chmod +x … DASHBOARD.command install-mac.sh` — `HUB.command` **не в списке**;
  - шаг 10 зовёт `bash routing/restart-dashboard.sh`;
  - шпаргалка учит `двойной клик DASHBOARD.command` и `bash routing/stop-dashboard.sh`.

  Мак-пользователь после установки не узнаёт про хаб вообще — а это единственное
  место, где на маке есть меню «стоп / рестарт / обновление / диагностика».
- **Почему не BLOCKER:** `DASHBOARD.command:14-15` сам делает `chmod +x HUB.command`
  и зовёт его через `exec bash HUB.command start`, а `routing/restart-dashboard.sh`
  и `stop-dashboard.sh` с 25.08 — форвардеры в `node hub.js restart|stop`. Всё
  работает, просто через легаси-двери. Плюс в индексе git `HUB.command` лежит
  как `100755` (`git ls-files -s` → `100755 … HUB.command`), и `core.fileMode=false`
  влияет на сравнение, а не на checkout — свежий клон получает exec-бит сам.
  Ломается только «репо приехало не через git» (zip, AirDrop, копия папки).
- **Отдельная неточность:** шаг 10 делает `restart` (гасит живой стек целиком),
  хотя правильный шаг установки — идемпотентный `start`. Именно это и переписали
  в `DASHBOARD.command` («Раньше звал routing/restart-dashboard.sh — то есть на маке
  двойной клик всегда означал ПЕРЕЗАПУСК… Теперь это `start`»), но в установщик
  правку не занесли.
- **Фикс:**
  ```bash
  # строка 247
  chmod +x mac-support/shims/* routing/*.sh tools/*.sh \
           HUB.command DASHBOARD.command install-mac.sh install-deps.sh 2>/dev/null
  # строки 276 и 280 — start вместо restart
  bash HUB.command start
  # шпаргалка, первой строкой:
  #   Меню       двойной клик HUB.command  ·  node hub.js
  #   Запуск     node hub.js start   ·  Стоп  node hub.js stop
  ```
- **Уверенность:** CONFIRMED

### [BROKEN] Б2. `SQLITE3` на маке держится только на `lifecycle.js` — установщик его не закрепляет

Запрос координатора: «проверь, ставит ли `install-mac.sh` то, на что рассчитывает
`childEnv()`». Ответ: **не ставит ничего, и это работает по счастливой случайности.**

- **Где:** `routing/lifecycle.js:469`, `routing/transparent-proxy.js:102-107`,
  `freemodel/lib/tg-session-parser.js:17`, `install-deps.sh:32-35`
- **Как устроено сейчас:**
  ```js
  // routing/lifecycle.js:464-471 — childEnv(), только для ДЕТЕЙ, которых спавнит хаб
  if (!IS_WIN) {
      const shims = path.join(ROOT, 'mac-support', 'shims');
      if (fs.existsSync(shims)) env.PATH = shims + path.delimiter + (env.PATH || '');
      if (fs.existsSync('/usr/bin/sqlite3')) env.SQLITE3 = '/usr/bin/sqlite3';
  }
  ```
  ```js
  // routing/transparent-proxy.js:102-107 — фолбэк, когда SQLITE3 в env нет
  const SQLITE_EXE = process.env.SQLITE3
      || [ path.join(process.env.LOCALAPPDATA || '', 'Microsoft','WinGet','Links','sqlite3.exe'),
           path.join(os.homedir(), 'bin', 'sqlite3.exe') ].find(p => fs.existsSync(p))
      || path.join(os.homedir(), 'bin', 'sqlite3.exe');
  ```
- **Что происходит на маке:** весь фолбэк — **виндовые пути с `.exe`**. Если процесс
  поднят НЕ через `lifecycle.js`, `SQLITE3` пуст, `LOCALAPPDATA` не существует, и
  `SQLITE_EXE` становится `/Users/<имя>/bin/sqlite3.exe`. Дальше
  `transparent-proxy.js:1152` кидает
  `sqlite3 not found at /Users/…/bin/sqlite3.exe (set SQLITE3 env var)` — сообщение
  показывает на несуществующий виндовый путь в домашней папке мака.
  Ломаются: вкладка OmniRoute (`/__switch/api/whoami`) и разбор `.session` для
  TG-пула (`freemodel/lib/tg-session-parser.js`, тот же фолбэк).
- **Когда стреляет:** любой запуск мимо хаба — в первую очередь
  **`npm run dashboard`** (`package.json:13` → `node routing/transparent-proxy.js`),
  а также ручной `node routing/transparent-proxy.js` при отладке. Через
  `HUB.command` / `restart-dashboard.sh` → `hub.js` → `childEnv()` всё в порядке.
- **Почему установщик виноват:** `install-deps.sh:32-35` мак-ветка sqlite3 только
  **констатирует**:
  ```bash
  if have sqlite3; then ok "sqlite3 системный: $(command -v sqlite3)"
  ```
  — не проверяет именно `/usr/bin/sqlite3` (на который смотрит `lifecycle.js`), и
  никуда не записывает. `install-mac.sh` про sqlite3 не знает вовсе.
- **Фикс (дёшево и надёжно):** `routing/.env` читается `transparent-proxy.js:35`
  ДО вычисления `SQLITE_EXE` на 102 — значит достаточно закрепить путь там.
  В `install-mac.sh` после копирования конфигов (после строки 225):
  ```bash
  # SQLITE3 фолбэк в transparent-proxy.js — виндовый (~/bin/sqlite3.exe).
  # childEnv() в lifecycle.js закрывает это только для детей хаба; `npm run dashboard`
  # и ручной запуск остаются без sqlite3. Закрепляем путь в routing/.env.
  if [ -x /usr/bin/sqlite3 ] && [ -f routing/.env ] && ! grep -q '^SQLITE3=' routing/.env; then
    printf '\nSQLITE3=/usr/bin/sqlite3\n' >> routing/.env
    ok "SQLITE3=/usr/bin/sqlite3 закреплён в routing/.env"
  fi
  ```
  (именно `>>`, а не `set_env` — тот на маке сломан, см. **В1**)
- **Уверенность:** CONFIRMED для кодового пути; PLAUSIBLE для частоты — зависит от
  того, зовёт ли пользователь `npm run dashboard`. `/usr/bin/sqlite3` на macOS
  присутствует всегда (системный), так что сам путь верный.

### [DEGRADED] Б3. Шесть новых провайдеров после 24.08 — установщик не знает ни одного

- **Где:** `install-mac.sh:220-225` (весь блок конфигов), `install.sh:202-206`
- **Что появилось после заморозки** (`git log --since='2026-08-24 15:35' --diff-filter=A`):

  | Модуль | Новые файлы | Тир-карта | Приватные каталоги в `.gitignore` |
  |---|---|---|---|
  | `aipm/` | `open-session.js` | `routing/aipm-modelmap.json` | `aipm/profiles/`, `aipm/sessions/`, `aipm/gh-sessions/`, `routing/aipm-sessions.json` |
  | `hcnsec/` | `open-session.js`, `share-session.js` | `routing/hcnsec-modelmap.json` | `hcnsec/profiles/`, `hcnsec/sessions/`, `routing/hcnsec-sessions.json` |
  | `kktoken/` | `open-session.js`, `share-session.js` | `routing/kktoken-modelmap.json` | `kktoken/profiles/`, `kktoken/sessions/`, `kktoken/gh-sessions/`, `routing/kktoken-sessions.json` |
  | `seekai/` | `open-session.js`, `share-session.js` | `routing/seekai-modelmap.json` | — |
  | `truesota/` | `open-session.js`, `share-session.js` | `routing/truesota-modelmap.json` | `truesota/profiles/`, `truesota/sessions/`, `truesota/gh-sessions/` |
  | `outlook/` | `open-session.js`, `read-code.js`, **`accounts.example.json`** | — | `outlook/accounts.json`, `outlook/profiles/`, `outlook/sessions/` |

- **Что происходит на маке:** свежая мак-установка получает код всех шести, но
  ни одного шаблона конфига. Самый явный промах — **`outlook/accounts.example.json`,
  добавленный 2026-09-05** (за 4 дня до аудита): установщик копирует шесть шаблонов
  из пятнадцати существующих, и этот в список не попал ни в мак-, ни в win-ветке.
- **Почему это мак-специфично, хотя дыра общая:** на Windows у владельца рабочие
  конфиги уже лежат с прошлых установок и `copy_if_absent` по ним и не должен
  срабатывать. **Свежий мак — единственная конфигурация, где отсутствие шаблона
  видно**, потому что там нет ничего, кроме клона.
- **Полный список некопируемых шаблонов** (`git ls-files | grep example`, 15 файлов,
  копируется 6):

  | Шаблон | mac | win | Добавлен |
  |---|---|---|---|
  | `docs/claude-settings.example.json` | ✅ | ✅ | — |
  | `routing/.env.example` | ✅ | ✅ | — |
  | `routing/al-sessions.example.json` | ✅ | ✅ | 2026-06-23 |
  | `routing/video-keys.example.json` | ✅ | ✅ | — |
  | `routing/image-keys.example.json` | ✅ | ✅ | 2026-06-30 |
  | `tgbot/.env.example` | ✅ | ✅ | — |
  | `outlook/accounts.example.json` | ❌ | ❌ | **2026-09-05** |
  | `routing/github-accounts.example.json` | ❌ | ❌ | 2026-08-13 |
  | `routing/custom-providers.json.example` | ❌ | ❌ | 2026-08-11 |
  | `freemodel/.env.example` | ❌ | ❌ | 2026-08-11 |
  | `routing/cun-sessions.example.json` | ❌ | ❌ | 2026-07-11 |
  | `routing/evomap-sessions.example.json` | ❌ | ❌ | 2026-07-02 |
  | `routing/ourtoken-sessions.example.json` | ❌ | ❌ | 2026-07-02 |
  | `notion/config.example.js` | ❌ | ❌ | 2026-05-29 |

- **Фикс:** дописать в блок конфигов `install-mac.sh` (и симметрично в `install.sh`):
  ```bash
  copy_example routing/github-accounts.example.json  routing/github-accounts.json
  copy_example routing/custom-providers.json.example routing/custom-providers.json
  copy_example routing/cun-sessions.example.json     routing/cun-sessions.json
  copy_example routing/evomap-sessions.example.json  routing/evomap-sessions.json
  copy_example routing/ourtoken-sessions.example.json routing/ourtoken-sessions.json
  copy_example outlook/accounts.example.json         outlook/accounts.json
  copy_example freemodel/.env.example                freemodel/.env
  copy_example notion/config.example.js              notion/config.js
  ```
  ⚠️ Перед применением — сверить с владельцем, какие из них дашборд создаёт сам:
  тир-карты `*-modelmap.json` пишет **дашборд** через `POST /__switch/...`, файлом их
  трогать нельзя, и по аналогии часть `*-sessions.json` может создаваться в рантайме.
- **Уверенность:** CONFIRMED (список файлов и даты); PLAUSIBLE (какие именно из
  восьми обязаны существовать на старте — это зона агента по дашборду)

### [BROKEN] Б4. Повторный запуск на маке не доустанавливает новые npm-зависимости

- **Где:** `install-mac.sh:160-166`
  ```bash
  step "npm install"
  if [ -d node_modules ]; then
    warn "node_modules уже есть — пропускаю. При проблемах: rm -rf node_modules && npm install"
  else
    npm install || { err "npm install упал — проверь вывод выше."; exit 1; }
  fi
  ```
- **Что происходит на маке:** после `git pull`, добавившего зависимость в
  `package.json`, повторный `bash install-mac.sh` **не ставит её** — и печатает при
  этом зелёную галочку «нативные модули собираются автоматически». Дашборд падает на
  `Cannot find module …`, а установщик отрапортовал успех.
- **Почему:** `install.sh:126-129` гоняет `npm install` **безусловно**, и это
  правильно: при попадании в `package-lock.json` он идемпотентен и стоит секунды.
  Мак-ветка защищается от несуществующей проблемы и тем самым ломает контракт
  `update.sh` (обновление = `git pull` + доустановка).
- **Пока не стреляет:** `package.json` с 24.08 менял только `main` и `scripts`
  (`04eec4f`: `autoreger.js` → `hub.js`, добавлены `stop`/`restart`/`status`/`check-hub`),
  блок `dependencies` не двигался. Мина заложена, но ещё не сработала.
- **Сверка зависимостей `package.json` ↔ что реально нужно на маке:**

  | Зависимость | Нативная сборка | Покрыто `install-mac.sh`? |
  |---|---|---|
  | `better-sqlite3` ^12.11.1 | да (node-gyp) | ✅ Xcode CLT ставится на шаге 1 |
  | `node-pty` ^1.1.0 | да (node-gyp) | ✅ там же |
  | `bufferutil` ^4.1.0 | да | ✅ там же |
  | `utf-8-validate` ^6.0.6 | да | ✅ там же |
  | `playwright` **1.60.0** (пин) | нет, но нужен браузер | ✅ шаг 5 |
  | `archiver`, `dotenv`, `inquirer`, `telegraf`, `telegram` | нет | ✅ |
  | `interactive-cli-tester` (dev) | нет | ✅ |

  То есть **сам список зависимостей мак-веткой покрыт полностью** — при условии, что
  `npm install` вообще запустится. Дыра ровно в условии на 162-й строке.
- **Фикс:**
  ```bash
  step "npm install"
  npm install || { err "npm install упал — проверь вывод выше."; exit 1; }
  ok "зависимости на месте (нативные модули собраны, Xcode CLT стоит)"
  ```
- **Уверенность:** CONFIRMED

### Б5. Статуслайн и `[1m]` — проверено, мак НЕ отстал

Записываю явно, чтобы соседние агенты не копали повторно.

- **Статуслайн.** `install-mac.sh:233` и `install.sh:193` зовут **один и тот же**
  `node tools/enable-statusline.js` — файл полностью платформонезависимый:
  пишет `~/.claude/autoreger-root.txt` (строка 36), копирует
  `routing/statusline-shim.sh` → `~/.claude/autoreger-statusline.sh` (41) и сам делает
  `fs.chmodSync(shim, 0o755)` (42). Команда в `settings.json` — `bash "<путь>"` (45),
  exec-бит для неё не обязателен. Порядок в `install-mac.sh` тоже верный: шаблон
  `settings.json` копируется на 220, статуслайн включается на 233.
  Рабочий скрипт `routing/statusline-autoreger.sh` получает `+x` на 247
  (`chmod +x … routing/*.sh …`). **Дыры нет.**
- **`[1m]`-суффикс.** Живёт в `docs/claude-settings.example.json`
  (`"model": "claude-opus-5[1m]"`), который мак копирует на строке 220. Коммит
  `4eabf25` (2026-08-21) правил **обе** ветки — `install-mac.sh` там 16 строк, это был
  переезд `vibe-code-account-creator-manager` → `hub-cc` вместе с фиксом. Мак не отстал.
  *Общий нюанс (не мак-специфичный):* `copy_example` не перезаписывает существующий
  `~/.claude/settings.json` (строки 211-213), ровно как `install.sh:177-181`, — значит
  на **обновляемой** установке `[1m]` в старый settings.json не доедет. Симметрично
  на обеих платформах, дрейфом не является.
- **Тир-карты `*-modelmap.json`.** Пять новых (`aipm`, `hcnsec`, `kktoken`, `seekai`,
  `truesota`) лежат в git и их пишет **дашборд** через `POST /__switch/...`.
  Установщику здесь делать нечего — правка файлом запрещена конвенцией проекта.

---

## В. Корректность bash под macOS

### Автоматический скан

По всем четырём `.sh` прогнан grep на GNU-только и bash-4-только конструкции:

```
sed -i · readlink -f · date -d · date --… · stat -c · grep -P · sort -V · base64 -w
cp --… · mktemp · xargs -r · find -printf · declare -A · ${var^^} · ${var,,}
mapfile · readarray · &>> · wait -n · globstar/shopt · realpath · tac · seq
timeout · md5sum · sha256sum · nproc · free · getopt · sed -E/-r
```

**Совпадений всего два.** Оба разобраны ниже (**В1**, **В2**).
Ассоциативных массивов, `${var^^}`, `mapfile`, `&>>`, `wait -n`, globstar,
`readlink -f`, `stat -c`, `date -d`, `base64 -w0`, `grep -P`, `sort -V`,
`cp --parents`, `find -printf` — **нет ни одного**. Скрипты написаны в POSIX-стиле
и на bash 3.2 разбираются. Шебанг у всех четырёх — `#!/usr/bin/env bash`,
`set -euo pipefail` **нигде не используется** (везде только `set -u`), так что
известной проблемы «pipefail в bash 3.2» тоже нет.

### [BLOCKER] В1. `sed -i` без суффикса — на macOS `set_env` не пишет НИЧЕГО

- **Где:** `install-lib.sh:50-60`, ключевая строка **`install-lib.sh:56`**
  ```bash
  set_env() {
    local file="$1" key="$2" value="$3"
    [ -f "$file" ] || return 1
    if grep -qE "^${key}=" "$file"; then
      local esc; esc=$(printf '%s' "$value" | sed -e 's/[\/&|]/\\&/g')
      sed -i "s|^${key}=.*|${key}=${esc}|" "$file"     # ← BSD sed это не так поймёт
    else
      printf '\n%s=%s\n' "$key" "$value" >> "$file"
    fi
  }
  ```
- **Что происходит на маке:** у BSD `sed` флаг `-i` **обязательно требует аргумент** —
  расширение бэкапа (`-i ''` для «без бэкапа»). Разбор аргументов идёт так:
  `-i` съедает **следующий аргумент** как суффикс, то есть суффиксом становится
  сама программа `s|^BOT_TOKEN=.*|BOT_TOKEN=123|`. Дальше остаётся один аргумент —
  `tgbot/.env`, и он берётся **как скрипт**, а входных файлов не остаётся вовсе →
  sed читает stdin. BSD sed на этом отвечает `sed: -i may not be used with stdin`
  и выходит с ошибкой. **Файл не изменяется.**
- **Где это стреляет** (`set_env` вызывается ровно четыре раза, все — вне мак-ветвления,
  то есть исполняются и на macOS):
  - `install-deps.sh:326` — `OMNIROUTE_API_KEY` в `routing/.env`
  - `install-deps.sh:337` — `BOT_TOKEN` в `tgbot/.env`
  - `install-deps.sh:338` — `ALLOWED_USERS` в `tgbot/.env`
  - `install-deps.sh:340` — `DEFAULT_CWD` в `tgbot/.env`
- **Ветка `sed` действительно берётся, а не `>>`:** условие — `grep -qE "^${key}="`.
  Проверено содержимое шаблонов: `tgbot/.env.example` содержит строки
  `BOT_TOKEN=123456:ABC-DEF...`, `ALLOWED_USERS=111111111`, `DEFAULT_CWD=`;
  `routing/.env.example` содержит `OMNIROUTE_API_KEY=sk-...`. Все четыре ключа
  присутствуют → **всегда идёт `sed`, никогда `>>`**.
- **Почему это BLOCKER, а не BROKEN:** установщик при этом **врёт**.
  `install-deps.sh:337-341`:
  ```bash
  [ -n "$TOK" ] && set_env tgbot/.env BOT_TOKEN "$TOK"
  [ -n "$USR" ] && set_env tgbot/.env ALLOWED_USERS "$USR"
  …
  ok "tgbot/.env заполнен"          # ← печатается БЕЗУСЛОВНО
  ```
  Пользователь ввёл токен бота и ID, увидел зелёное «tgbot/.env заполнен», а в файле
  остались `123456:ABC-DEF...` и `111111111` из шаблона. Бот не заведётся, и место
  поломки не там, где сообщение. Для `OMNIROUTE_API_KEY` чуть мягче — там
  `&& ok "ключ записан"`, галочка не появится, но и явной ошибки не будет, кроме
  строки `sed: -i may not be used with stdin` в потоке вывода.
- **Фикс (переносимый, работает и на GNU, и на BSD — без `sed -i` вообще):**
  ```bash
  set_env() {
    local file="$1" key="$2" value="$3" tmp
    [ -f "$file" ] || return 1
    if grep -qE "^${key}=" "$file"; then
      tmp="$file.tmp.$$"
      # значение подставляем через awk-переменную: никакого экранирования для sed
      awk -v k="$key" -v v="$value" \
        'BEGIN{FS=OFS="="} $0 ~ "^" k "=" {print k "=" v; next} {print}' \
        "$file" > "$tmp" && mv "$tmp" "$file"
    else
      printf '\n%s=%s\n' "$key" "$value" >> "$file"
    fi
  }
  ```
  Минимальная альтернатива, если хочется оставить `sed`: развилка по платформе —
  `sed -i '' …` на BSD и `sed -i …` на GNU. Хуже: нужно определять платформу
  и `''` ломает GNU sed.
- **Уверенность:** CONFIRMED — и то, что ветка `sed` берётся (шаблоны проверены),
  и то, что `set_env` вызывается на macOS (все четыре вызова вне `IS_MAC`-ветвления).
  Точный текст ошибки BSD sed — PLAUSIBLE (проверяется на маке одной строкой:
  `printf 'A=1\n' > /tmp/t && sed -i "s|^A=.*|A=2|" /tmp/t; echo "rc=$?"; cat /tmp/t`
  → ожидается `rc≠0` и `A=1`).

### [BLOCKER] В2. Установка Homebrew в авто-режиме зависает на «Press RETURN»

- **Где:** `install-mac.sh:138-146`
  ```bash
  if ! have brew; then
    step "Homebrew"
    warn "Homebrew не найден — ставлю (понадобится пароль sudo)."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || exit 1
  ```
- **Что происходит на маке:** официальный установщик Homebrew по умолчанию
  **интерактивен** — печатает список того, что создаст, и ждёт
  `Press RETURN/ENTER to continue or any other key to abort`, а затем запрашивает
  пароль `sudo`. `install-mac.sh` умеет отличать авто-режим (`noask()` на строке 30) и
  честно делает это для Xcode CLT (строки 58–61, 106–109: «CLT подтверждаются в GUI,
  а в авто-режиме ждать некому» → `exit 1`), но **для Homebrew такой проверки нет**.
  В режиме `AUTO=1` при живом tty установка виснет на приглашении навсегда.
- **Почему пропущено:** блок Homebrew писался раньше, чем `noask()` (комментарий на
  25–28 прямо говорит, что авто-режим доклеивали позже — «до сих пор неинтерактивность
  определялась ТОЛЬКО отсутствием tty»), и до Homebrew правку не донесли.
- **Фикс:**
  ```bash
  if ! have brew; then
    step "Homebrew"
    if noask; then
      # NONINTERACTIVE=1 снимает "Press RETURN", но sudo без пароля всё равно нужен —
      # поэтому падаем внятно, а не виснем.
      NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
        || { err "Homebrew не поставился в авто-режиме (нужен sudo). Поставь вручную и запусти снова."; exit 1; }
    else
      warn "Homebrew не найден — ставлю (понадобится пароль sudo)."
      /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || exit 1
    fi
  ```
- **Уверенность:** CONFIRMED (в коде нет ни `noask`, ни `NONINTERACTIVE` вокруг
  установки brew); PLAUSIBLE (что переменная называется именно `NONINTERACTIVE` —
  это документированный контракт установщика Homebrew, проверяется на маке:
  `NONINTERACTIVE=1` в их `install.sh`)

### [DEGRADED] В3. `brew upgrade node` падает, если node пришёл не из brew

- **Где:** `install-mac.sh:150-157`
  ```bash
  if ! have node || ! have npm || ! have git; then
    brew install node git
  fi
  NODE_MAJOR="$(node -e '…' 2>/dev/null || echo 0)"
  if [ "$NODE_MAJOR" -lt 18 ]; then
    warn "Node.js >= 18 обязателен (у тебя $NODE_MAJOR). Обновляю..."
    brew upgrade node
  fi
  ```
- **Что происходит на маке:** node на маке чаще всего ставят через **nvm** или
  pkg-установщик с nodejs.org, а не через brew. Если такой node старше 18,
  `brew upgrade node` отвечает `Error: node not installed` (или обновляет **другой**,
  brew-овский node, который в PATH стоит ниже nvm-шима) — и установщик едет дальше
  как ни в чём не бывало, печатая `ok "node $(node -v)"` со старой версией.
  Заявленное требование «Node ≥ 18» не выполняется, но красная строка не появляется.
  Что `HUB.command:20-21` и `routing/restart-dashboard.sh:15-18` подхватывают nvm
  (`. "$HOME/.nvm/nvm.sh"`) — прямое подтверждение, что nvm-сценарий считается живым.
- **Второй, более редкий случай там же:** ветка `brew install node git` срабатывает,
  если отсутствует **любой** из трёх. То есть при живом nvm-node и отсутствующем git
  ставится ещё и brew-node, который может перекрыть nvm-шим в новой сессии.
- **Фикс:** проверять источник и падать внятно вместо «Обновляю…»:
  ```bash
  if [ "$NODE_MAJOR" -lt 18 ]; then
    if brew list --formula node >/dev/null 2>&1; then
      brew upgrade node
    else
      err "Node $NODE_MAJOR < 18, и он пришёл не из brew ($(command -v node))."
      err "Обнови сам: nvm install --lts   или   brew install node"
      exit 1
    fi
    NODE_MAJOR="$(node -e 'process.stdout.write(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
    [ "$NODE_MAJOR" -lt 18 ] && { err "node всё ещё $NODE_MAJOR — открой новый терминал и проверь: node -v"; exit 1; }
  fi
  # git ставить отдельно от node
  have git || brew install git
  have node || brew install node
  ```
- **Уверенность:** CONFIRMED (логика в коде именно такая); PLAUSIBLE (точный текст
  ошибки brew — проверяется на маке: `brew upgrade node` при node не из brew)

### [DEGRADED] В4. `mktemp -d` без шаблона — мина в общем коде, пока прикрытая ветвлением

- **Где:** `install-deps.sh:50` — `SQLITE_TMP="$(mktemp -d)"`
- **Что происходит на маке:** BSD `mktemp` требует шаблон:
  `usage: mktemp [-d] [-q] [-u] template …` — `mktemp -d` без аргумента отвечает
  usage и возвращает ошибку, `SQLITE_TMP` становится пустой строкой. Дальше
  `curl -fL -o "$SQLITE_TMP/sqlite-tools.zip"` пишет в `/sqlite-tools.zip`, а
  `rm -rf "$SQLITE_TMP"` на строке 60 превращается в **`rm -rf ""`** (безвредно, но
  показательно).
- **Почему сейчас не стреляет:** строка находится в ветке `else` от
  `if [ "$IS_MAC" = "1" ]` (`install-deps.sh:32`, `36`), то есть на macOS
  недостижима — там sqlite3 системный. Классифицирую как DEGRADED, потому что это
  **общий файл двух платформ**, и первая же попытка расширить sqlite-ветку на мак
  наступит на это.
- **Фикс (переносимо на GNU и BSD):**
  ```bash
  SQLITE_TMP="$(mktemp -d "${TMPDIR:-/tmp}/sqlite.XXXXXX")"
  ```
- **Уверенность:** CONFIRMED (строка и её недостижимость на маке); поведение BSD
  `mktemp -d` без шаблона — PLAUSIBLE, проверяется `mktemp -d; echo "rc=$?"`.

### [DEGRADED] В5. Карантин: снимается не вовремя и не спасает путь «скачал ZIP»

- **Где:** `install-mac.sh:249-251`
  ```bash
  # Карантин (com.apple.quarantine) вешается на всё, что скачано: .command тогда не
  # запускается двойным кликом вообще, без внятной ошибки.
  xattr -cr . 2>/dev/null && ok "карантин снят"
  ```
- **Проблема 1 — порядок.** Строка стоит **шагом 8**, то есть уже после
  `npm install` (165) и `npx playwright install chromium` (174). К этому моменту в `.`
  лежит `node_modules` на десятки тысяч файлов, и `xattr -cr .` рекурсивно обходит их
  все. На маке это минуты работы с нулевой пользой: файлы, созданные `npm`, карантина
  не имеют. Правильное место — **до** `npm install`, сразу после `cd "$SELF_DIR"`.
- **Проблема 2 — `-c` вместо `-d`.** `-c` стирает **все** расширенные атрибуты, а не
  только `com.apple.quarantine` (комментарий на 249–250 говорит именно про карантин).
  Точечно: `xattr -d com.apple.quarantine`, а не «снести всё».
- **Проблема 3, главная — курица и яйцо.** Карантин ставит LaunchServices, когда файл
  скачан **браузером**. В задокументированном пути установки браузера нет:
  однострочник `bash -c "$(curl …)"` → `git clone` — ни `curl`, ни `git` карантин не
  вешают, так что снимать нечего. А в пути, где карантин реально появляется —
  «скачал ZIP репо с GitHub в Safari, распаковал, двойной клик по `HUB.command`» —
  установщик **не запускался**, и Gatekeeper отказывает с «не удаётся открыть, так как
  этот файл от неустановленного разработчика». Собственный `xattr -cr .`
  в `HUB.command:16` тут не помогает: он внутри файла, который Gatekeeper и отказался
  выполнять.
- **Фикс:** (а) перенести снятие карантина в начало, сразу после `cd "$SELF_DIR"`
  (строка 94), и сузить до точечного удаления:
  ```bash
  xattr -dr com.apple.quarantine . 2>/dev/null && ok "карантин снят"
  ```
  (б) в шпаргалку и в `docs/MAC-SETUP.md` добавить строку выхода из тупика ZIP:
  ```
  Если macOS отказывается открывать HUB.command («неустановленный разработчик»):
      xattr -dr com.apple.quarantine "/путь/к/папке"   (или один раз: bash HUB.command)
  ```
- **Уверенность:** CONFIRMED (порядок строк, флаг `-c`); PLAUSIBLE (что при ZIP-пути
  Gatekeeper блокирует именно так — проверяется на маке: скачать ZIP браузером,
  `xattr -p com.apple.quarantine HUB.command`, двойной клик)

### [COSMETIC] В6. Homebrew: пути разобраны верно, но `~/.zprofile` — единственный адресат

- **Где:** `install-mac.sh:123-136` (`brew_shellenv`), `197-200`
- **Что сделано правильно** (записываю, чтобы не переделывали): функция перебирает
  **оба** префикса — `/opt/homebrew/bin/brew` (Apple Silicon) и `/usr/local/bin/brew`
  (Intel), — берёт первый существующий, делает `eval "$("$p" shellenv)"` в текущую
  сессию и дописывает то же в `~/.zprofile`. Это ровно тот случай, который чаще всего
  ломается на маках, и он закрыт. Комментарий на 117–122 объясняет причину верно.
  Тот же приём повторён для `~/.npm-global/bin` на 197–200. **Классической поломки
  `/usr/local` vs `/opt/homebrew` здесь нет.**
- **Что не покрыто:** записи идут **только** в `~/.zprofile`. Если у пользователя
  оболочка bash (мак до Catalina, либо `chsh` на bash) — brew и `~/.npm-global/bin`
  в новых сессиях не появятся, и `claude` снова «command not found». Комментарий на
  122 честно оговаривает «zsh — дефолтный шелл macOS с Catalina», то есть случай
  осознан и отброшен.
- **Чего нет вовсе:** проверки архитектуры (`uname -m` → `arm64` / `x86_64`) и
  Rosetta. Если на Apple Silicon в PATH оказался x86_64-node (Rosetta), `npm install`
  соберёт нативные модули (`better-sqlite3`, `node-pty`) под x86_64, и они не
  подхватятся arm64-node'ом после его установки. Диагностики на это нет.
- **Фикс:** (а) дописывать в оба профиля:
  ```bash
  for rc in "$HOME/.zprofile" "$HOME/.bash_profile"; do
    [ -e "$rc" ] || [ "$rc" = "$HOME/.zprofile" ] || continue
    grep -qs "$p shellenv" "$rc" || printf '\neval "$(%s shellenv)"\n' "$p" >> "$rc"
  done
  ```
  (б) одна строка диагностики после шага 3:
  ```bash
  if [ "$(uname -m)" = "arm64" ] && [ "$(node -p 'process.arch' 2>/dev/null)" = "x64" ]; then
    warn "node собран под x86_64 и идёт через Rosetta на arm64-маке — нативные модули соберутся не под ту архитектуру."
    warn "Лечится: brew uninstall node && brew install node (или nvm install --lts в arm64-терминале)"
  fi
  ```
- **Уверенность:** CONFIRMED (логика `brew_shellenv` и отсутствие arch-проверки);
  Rosetta-сценарий — PLAUSIBLE

### В7. Exec-бит: проверено по индексу git — критичных дыр нет

`git ls-files -s` по всем точкам входа:

| Файл | Режим в индексе | Комментарий |
|---|---|---|
| `HUB.command` | `100755` | ✅ свежий клон получает `+x` сам |
| `DASHBOARD.command` | `100755` | ✅ |
| `install-mac.sh` | `100755` | ✅ |
| `install.sh` | `100755` | ✅ |
| `install-deps.sh` | `100755` | ✅ (`73a6e99`, «chmod +x: install-deps.sh…») |
| `install-lib.sh` | `100644` | ✅ корректно — файл **подключается** через `. ./install-lib.sh`, не исполняется |
| `routing/restart-dashboard.sh` | `100755` | ✅ |
| `routing/stop-dashboard.sh` | `100755` | ✅ |
| `tools/doctor.sh` | `100755` | ✅ |
| `mac-support/shims/{netstat,python,taskkill}` | `100755` | ✅ — а их `chmod` в установщике (247) страхует «репо не из git» |

**Важно для понимания:** `install-mac.sh:90,97-99` выставляет `core.fileMode=false`, и
может показаться, что это лишит клон exec-бита. Это не так: `core.fileMode` влияет
на **сравнение** рабочего дерева с индексом (`status`/`diff`), а не на checkout —
режим из индекса применяется всегда. Комментарий на 86–89 объясняет мотив верно
(chmod от установщика иначе выглядел бы локальной правкой и ломал `git pull`).
Реальный остаток — `HUB.command` не в списке `chmod` (**Б1**), и это бьёт только по
пути «репо приехало не через git».

### [DEGRADED] В8. `tgbot/.env.example` копируется на мак как есть — внутри виндовые пути

- **Где:** `install-mac.sh:225` (`copy_example tgbot/.env.example tgbot/.env`),
  `install-deps.sh:333` (то же в блоке ТГ-бота), сам шаблон `tgbot/.env.example`
- **Что происходит на маке:** шаблон копируется дословно, а он написан под Windows:
  ```
  # Дашборд авторегера (должен быть запущен: routing/restart-dashboard.bat)
  # Python из venv (по умолч. ../tools/tg-venv/Scripts/python.exe)
  # STT_PYTHON=C:/path/to/python.exe
  # EXTRA_ROOTS=D:/WORMALIENAIGIGANT;D:/work
  ```
  - `Scripts/python.exe` — виндовая раскладка venv. На маке интерпретатор лежит в
    `tools/tg-venv/bin/python`, и `install-deps.sh:168-171` мак-ветка создаёт venv
    именно так. То есть **дефолт голосовых сообщений (faster-whisper) на маке
    показывает в никуда**, и пользователю нужно самому вписать `STT_PYTHON`.
  - `restart-dashboard.bat` в комментарии — на маке такого файла нет (есть `.sh`).
  - `EXTRA_ROOTS` с `D:/…` и разделителем `;` — виндовая форма.
- **Почему это зона установщика:** в репо уже есть платформенный резолвер
  `tools/tg-venv-python.js` (`install-deps.sh:119-122`: «Путь до интерпретатора внутри
  venv платформозависимый: Scripts/python.exe на Windows, bin/python на macOS.
  Резолвер один — tools/tg-venv-python.js»). Установщик его знает и использует для
  проверки, но в `.env` кладёт захардкоженный виндовый дефолт.
- **Фикс:** в мак-ветке после копирования `tgbot/.env` дописать реальный путь:
  ```bash
  if [ -f tgbot/.env ] && ! grep -q '^STT_PYTHON=' tgbot/.env; then
    TGPY="$(node tools/tg-venv-python.js 2>/dev/null)"
    [ -n "$TGPY" ] && printf '\nSTT_PYTHON=%s\n' "$TGPY" >> tgbot/.env
  fi
  ```
  (именно `>>`, не `set_env` — тот на маке сломан, **В1**)
- **Уверенность:** CONFIRMED (содержимое шаблона и мак-раскладка venv);
  PLAUSIBLE (насколько это ломает голосовые — зависит от кода `tgbot/`, чужая зона)

---

## Итог

### Числа

| Градация | Кол-во | Находки |
|---|---|---|
| **BLOCKER** | 2 | В1 (`sed -i` без суффикса), В2 (Homebrew виснет в авто-режиме) |
| **BROKEN** | 4 | A1 (нет git identity), A5 (`AUTO` не пробрасывается), Б2 (`SQLITE3` не закреплён), Б4 (`npm install` пропускается) |
| **DEGRADED** | 8 | A2 (не проверяется версия `claude`), A3 (нет `approve-scripts`), Б1 (не знает про `hub.js`/`HUB.command`), Б3 (6 новых провайдеров и 8 некопируемых шаблонов), В3 (`brew upgrade node` при не-brew node), В4 (`mktemp -d` без шаблона), В5 (карантин не вовремя), В8 (виндовые пути в `tgbot/.env`) |
| **COSMETIC** | 4 | A4 (`CLAUDE_CODE_VERSION`), A6 (guard вложенности), A7 (нет финальной паузы), В6 (только `~/.zprofile`, нет проверки Rosetta) |
| **Всего** | **18** | |

Отдельно **проверено и НЕ является находкой** (чтобы не копали повторно):
кодировка и CRLF всех пяти файлов; `chromium-headless-shell` (Playwright 1.60 тянет
его сам по алиасу `chromium`); `cat` в PATH; приватность репо (публичный);
статуслайн и `[1m]` (мак не отстал); exec-биты в индексе git; пути из шпаргалки;
`/opt/homebrew` vs `/usr/local` (разобрано верно).

### Главное

**Гипотеза владельца подтверждается, но не там, где ожидалось: мак-установщик отстал
не столько от новых модулей, сколько от собственной инфраструктуры — он единственный
из пяти файлов, кто не знает ни про `hub.js`, ни про `AUTO`, ни про то, что его
общая библиотека `install-lib.sh` на macOS физически не работает
(`sed -i` без суффикса — четыре вызова `set_env`, включая запись токена ТГ-бота,
после которых установщик печатает «tgbot/.env заполнен», не записав ничего).**

Иронично, что коммит `04eec4f` от 25.08 — тот самый, что принёс `hub.js` и
`HUB.command`, — **правил `install-mac.sh`**, но только две строки путей.

### Что дописать в `install-mac.sh` (по пунктам, в порядке важности)

1. **Починить `set_env` в `install-lib.sh`** (В1) — заменить `sed -i` на `awk` +
   `mv`. Это не в самом `install-mac.sh`, но без этого мак-ветка `install-deps.sh`
   молча не записывает ни `BOT_TOKEN`, ни `ALLOWED_USERS`, ни `OMNIROUTE_API_KEY`.
   **Единственный BLOCKER, который врёт пользователю в лицо.**
2. **Обернуть установку Homebrew в `noask` + `NONINTERACTIVE=1`** (В2, строки 138–146) —
   иначе `AUTO=1` виснет на «Press RETURN» навсегда.
3. **Убрать условие `if [ -d node_modules ]` вокруг `npm install`** (Б4, строки 160–166) —
   гонять безусловно, как `install.sh:128`.
4. **Пробросить `AUTO` в `install-deps.sh`** (A5, строки 263 и 267):
   `AUTO="$AUTO" bash install-deps.sh`.
5. **Закрепить `SQLITE3=/usr/bin/sqlite3` в `routing/.env`** (Б2) — сейчас путь живёт
   только в `childEnv()` `lifecycle.js`, и `npm run dashboard` остаётся с виндовым
   фолбэком `~/bin/sqlite3.exe`.
6. **Добавить блок git identity** (A1) — `user.name`/`user.email` из `$USER`,
   `pull.rebase=false`, `credential.helper osxkeychain`.
7. **Научить установщик хабу** (Б1):
   - `chmod +x` дополнить: `HUB.command`, `tools/*.sh`, `install-deps.sh`;
   - шаг запуска (276, 280) — `bash HUB.command start` вместо
     `bash routing/restart-dashboard.sh` (идемпотентный `start` вместо `restart`);
   - шпаргалку начать с `HUB.command` / `node hub.js`, старые `.sh` пометить как легаси.
8. **Дописать копирование восьми шаблонов** (Б3) — в первую очередь
   `outlook/accounts.example.json` (появился 05.09), `routing/github-accounts.example.json`,
   `routing/custom-providers.json.example`. Симметрично в `install.sh`.
   Перед применением сверить с владельцем, что из этого создаёт сам дашборд.
9. **Проверять `claude --version`, а не `have claude`** (A2) + добавить
   `npm approve-scripts` (A3) + поддержать `CLAUDE_CODE_VERSION` (A4).
10. **Перенести снятие карантина в начало** и сузить до
    `xattr -dr com.apple.quarantine .` (В5) — сейчас оно после `npm install` обходит
    весь `node_modules` без пользы.
11. **`brew upgrade node` заменить на проверку источника node** (В3) — при nvm-node
    команда падает, а установщик едет дальше со старой версией.
12. **Мелочи:** дописать `STT_PYTHON` из `tools/tg-venv-python.js` в `tgbot/.env` (В8);
    guard двойной вложенности после `cd` (A6); `mktemp -d` с шаблоном (В4);
    диагностика Rosetta и запись в `~/.bash_profile` (В6).

### Что проверить живьём на маке (одной сессией)

```bash
# В1 — главный
printf 'A=1\n' > /tmp/t && sed -i "s|^A=.*|A=2|" /tmp/t; echo "rc=$?"; cat /tmp/t
#   ожидается rc≠0 и A=1  → set_env сломан

# В4
mktemp -d; echo "rc=$?"

# В3
brew list --formula node >/dev/null 2>&1; echo "node из brew? rc=$?"; command -v node; node -v

# В6 — Rosetta
uname -m; node -p 'process.arch'

# Б2
ls -l /usr/bin/sqlite3; node -e "console.log(process.env.SQLITE3 || '(не задан)')"

# В5 — карантин
xattr -p com.apple.quarantine HUB.command 2>&1
```

