# 05 — `mac-support/`, шимы, `internal/export-for-mac.js`

Аудит мак-совместимости ABUSE HUB, агент 5/10.
Зона: `mac-support/` целиком + `internal/export-for-mac.js` + полнота покрытия шимами.
Дата: 2026-09-09. Репо: `C:\Users\WormAlien\Desktop\Autoreger_Clean`.

## Что вообще есть в `mac-support/`

`mac-support/` = ровно одна папка `shims/` и шесть файлов в ней. Больше ничего.
Каталог создан коммитом `9700f28` (18.08.2026), тронут один раз — `7b91456` (20.08,
только exec-бит в индексе). С тех пор ноль правок.

```
mac-support/shims/clip.exe      177 B   100755   LF, шебанг есть, BOM нет
mac-support/shims/curl.exe      141 B   100755   LF, шебанг есть, BOM нет
mac-support/shims/netstat       698 B   100755   LF, шебанг есть, BOM нет
mac-support/shims/python        132 B   100755   LF, шебанг есть, BOM нет
mac-support/shims/python.exe    159 B   100755   LF, шебанг есть, BOM нет
mac-support/shims/taskkill      465 B   100755   LF, шебанг есть, BOM нет
```

Проверено побайтово (`git show :<путь> | od -An -tu1`): CR = 0 и в блобе, и на диске,
первые три байта `23 21 2f` = `#!/`. `.gitattributes` держит `mac-support/shims/* text eol=lf`.
Гигиена файлов в порядке — проблемы не здесь.

### 🔑 Как шимы попадают в PATH

Единственное место — `routing/lifecycle.js:464-472`, `childEnv()`:

```js
function childEnv() {
    const env = { ...process.env };
    if (!IS_WIN) {
        const shims = path.join(ROOT, 'mac-support', 'shims');
        if (fs.existsSync(shims)) env.PATH = shims + path.delimiter + (env.PATH || '');
        if (fs.existsSync('/usr/bin/sqlite3')) env.SQLITE3 = '/usr/bin/sqlite3';
    }
    return env;
}
```

`childEnv()` вызывается ровно один раз — в `startService()` (`lifecycle.js:587`).
То есть шимы видит **только то, что поднял хаб**, и всё, что эти процессы породят
дальше (env наследуется). `install-mac.sh` в PATH шимы **не кладёт** — он только
делает им `chmod +x` (строка 247). `HUB.command` / `DASHBOARD.command` про шимы не
знают вовсе. Масштаб дыры — раздел Г.

---

## Таблица покрытия

Grep по всему репо. Исключены `node_modules`, `graphify-out`, `logs`, `manual_sessions`,
`routing/vendor/**` и `routing/.rescue/**` (снапшоты-бэкапы, не живой код). 156 живых
попаданий.

| Windows-команда | Где зовётся (живой код) | Шим? | Флаги покрыты? | Вердикт |
|---|---|---|---|---|
| `netstat -ano` | `routing/transparent-proxy.js:3835,4027,17263,19237`; `routing/keepalive-spawn.js:21`; `tools/check-frontdoor.js:165`; `tools/doctor.sh:62`; `routing/lifecycle.js:201` (под `IS_WIN`) | ✅ `netstat` | ⚠️ аргументы игнорируются целиком, но нужный формат отдаёт | **DEGRADED** — теряет слушателей с пробелом в имени процесса; не отдаёт ESTABLISHED/UDP; `doctor.sh` шима не видит |
| `taskkill /F /PID` | `routing/transparent-proxy.js:3838,17266,19241`; `routing/keepalive-spawn.js:30`; `tools/check-frontdoor.js:169`; `internal/dictation-fix.js:240`; `routing/lifecycle.js:308` (под `IS_WIN`) | ✅ `taskkill` | ⚠️ `/PID`,`/IM` да; `/F`,`/T` игнорируются | **DEGRADED** — игнор `/F` безвреден (шим всегда `-9`), `/T` не убивает дерево |
| `tasklist` | `routing/lifecycle.js:281` (под `IS_WIN`); `tools/clean-camoufox-profiles.sh:32`; `hub.js:848` (текст подсказки) | ❌ | — | **DEGRADED** — `lifecycle` имеет POSIX-ветку (`ps -p`), `clean-camoufox-profiles.sh` — нет |
| `curl.exe` | `freemodel/lib/10minutemail.js:51` | ✅ `curl.exe` | ✅ прозрачный `exec curl "$@"` | **OK** |
| `clip.exe` | `internal/notion-manager.js:58` | ✅ `clip.exe` | ✅ `exec pbcopy` | **OK** |
| `python` | `anymodel/lib/camoufox-anymodel-client.js:35`; `internal/dashboard-api.js:1195` (POSIX-ветка) | ✅ `python` | ✅ `exec python3 "$@"` | ⚠️ ведёт в интерпретатор без camoufox — находка ниже |
| `python.exe` | прямых `spawn('python.exe')` в живом коде нет; путь строится в `install-deps.sh:104` | ✅ `python.exe` | ✅ | **COSMETIC** — шим про запас |
| `powershell` | `hub.js:797`; `routing/lifecycle.js:573`; `routing/lib/newapi-account.js:396,569`; `routing/pool-watchdog.js:236`; `internal/dictation-fix.js:52,220`; `internal/export-for-mac.js:321`; `install.sh:117`; `internal/build-release.js:130` | ❌ | — | смешанно, см. раздел Б |
| `cmd.exe` / `cmd /c` | `internal/dashboard-api.js:841,877,979,1191`; `hub.js:787,1826`; `routing/lifecycle.js:571` (под `IS_WIN`); `routing/statusline-autoreger.sh:63`; `routing/statusline-shim.sh:23`; `tools/doctor.sh:87` | ❌ | — | смешанно, см. раздел Б |
| `schtasks` | `internal/dictation-fix.js:100,211,251` | ❌ | — | Windows-only инструмент (диктовка), на маке не вызывается |
| `where.exe` | `hub.js:741` | ❌ | — | под `IS_WIN` |
| `findstr` | только в комментариях (`routing/lifecycle.js:184,191`) | ❌ | — | **COSMETIC** |
| `chcp` | `internal/build-release.js:65` (внутри генерируемого `.bat`) | ❌ | — | Windows-релиз, на маке не исполняется |
| `attrib` | только в комментарии | ❌ | — | **COSMETIC** |
| `wmic`, `pwsh`, `reg add/query`, `explorer.exe`, `icacls`, `robocopy`, `certutil` | нет попаданий | — | — | **OK** |

---

## А. Что шимы умеют на самом деле

### А.1 `netstat` — главный шим, и он работает

Тело целиком (`mac-support/shims/netstat`, 17 строк):

```bash
#!/usr/bin/env bash
set -u
if ! command -v lsof >/dev/null 2>&1; then
  exit 0
fi
lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | \
sed -n '1d;s/^[^ ]*[[:space:]]*\([0-9][0-9]*\)[[:space:]].*[[:space:]]TCP[[:space:]]*\([^ (]*\)[[:space:]]*(LISTEN)/TCP    \2    0.0.0.0:0    LISTENING    \1/p'
exit 0
```

**Аргументы не разбираются вообще.** `$@` не читается ни разу: `netstat -ano`,
`netstat -ano -p tcp`, `netstat` без аргументов, `netstat -r` — всё даёт один и тот же
вывод «TCP-слушатели». Для наших вызывающих этого достаточно (все зовут `-ano` или
`-ano -p tcp` и хотят ровно слушателей), но это надо знать: шим — не netstat, а
«список TCP-LISTEN в виндовом гриме».

**PID отдаётся в 5-й колонке — ровно там, где его ждут.** Проверено: скормил sed'у
образец вывода `lsof -nP -iTCP -sTCP:LISTEN`, получил

```
TCP    *:8200             0.0.0.0:0    LISTENING    12345
TCP    [::1]:20100        0.0.0.0:0    LISTENING    12345
TCP    127.0.0.1:20133    0.0.0.0:0    LISTENING    12346
```

и прогнал по нему регулярки ВСЕХ пяти живых потребителей (node, не глазами):

| Потребитель | Регулярка | Результат |
|---|---|---|
| `keepalive-spawn.js:22` | `:${port}\s+.*LISTENING\s+([0-9]+)` | ✅ PID найден |
| `transparent-proxy.js:3836` `customKillProxy` | `:${port}\s+\S+\s+LISTENING\s+(\d+)` | ✅ |
| `transparent-proxy.js:17264` `killPortListeners` | то же | ✅ |
| `transparent-proxy.js:19240` health-kill | то же | ✅ |
| `transparent-proxy.js:4029` `handleHealth` | `/:(\d{4,5})\s+\S+\s+LISTENING\s+(\d+)/` | ✅ порт+PID |

Колонка «Foreign Address» подставлена как `0.0.0.0:0` — и это не косметика: она
удовлетворяет `\S+` между адресом и `LISTENING` во всех четырёх регулярках, без неё
они бы не совпали. Форма выбрана правильно.

Ответ на исходное подозрение: **нативный мак-`netstat` PID не отдаёт, и шим это
честно чинит через `lsof`.** Класс «на маке порт занят, а кем — неизвестно» закрыт.

---

### [DEGRADED] `netstat`-шим молча теряет слушателей, у чьего процесса пробел в имени

- **Где:** `mac-support/shims/netstat:15`
- **Что происходит на маке:** порт, занятый `Google Chrome`, `Adobe Desktop Service`,
  `Docker Desktop` и т.п., в выводе шима **отсутствует**. Для вызывающего кода это
  «порт свободен», хотя он занят.
- **Почему:** `sed` разбирает вывод `lsof` по колонкам, а первая колонка (`COMMAND`)
  у lsof **может содержать пробел** — он режет имя до 9 символов, но пробелы внутри
  сохраняет. Шаблон `^[^ ]*[[:space:]]*\([0-9][0-9]*\)` требует, чтобы сразу за первым
  словом шли цифры PID. У `Google Ch  9001 ...` после `Google` идёт `Ch` → совпадения
  нет → строка выброшена. Проверено на образце: из пяти строк прошли четыре, строка
  `Google Ch` исчезла без единого сообщения.
  Ирония: `routing/lifecycle.js:217-220` про эти грабли **знает** и потому зовёт
  `lsof -F pn` (машинный формат). Шим написан на колонках.
- **Последствия:** `portIsFree()` в дашборде вернёт «свободен», старт сервиса упадёт
  на `EADDRINUSE`, а `killPortListeners()` вернёт `killed: 0` и скажет «никто не
  слушает». Диагностика заведёт человека не туда.
- **Фикс:** переписать шим на тот же машинный формат, что уже используется в
  `lifecycle.js`. Текст нового `mac-support/shims/netstat` целиком:

```bash
#!/usr/bin/env bash
# netstat shim для macOS/Linux.
# Дашборд (transparent-proxy.js / keepalive-spawn.js) зовёт `netstat -ano` и парсит
#   <proto> <local>:<port> <foreign> LISTENING <pid>
# Аргументы игнорируются намеренно: всем вызывающим нужны только TCP-слушатели.
#
# 🪤 Колонки вывода lsof разбирать НЕЛЬЗЯ: COMMAND может содержать пробел
# ("Google Ch", "Adobe Desk"), и тогда PID съезжает, а строка молча пропадает.
# Поэтому -F pn — машинный формат: строка `p<pid>`, затем по строке `n<адрес>`.
set -u

command -v lsof >/dev/null 2>&1 || exit 0

lsof -nP -iTCP -sTCP:LISTEN -F pn 2>/dev/null | awk '
  /^p/ { pid = substr($0, 2); next }
  /^n/ { printf "TCP    %s    0.0.0.0:0    LISTENING    %s\n", substr($0, 2), pid }
'

exit 0
```

  `awk` есть на маке из коробки (BSD awk), гарантий про `gawk` не требуется.
- **Уверенность:** CONFIRMED — потеря строки воспроизведена локально на образце
  вывода `lsof`; формат `-F pn` подтверждается тем, что его уже использует
  `lifecycle.js:220` с тем же обоснованием в комментарии.

---

### [DEGRADED] `netstat`-шим отдаёт только TCP-LISTEN: ни ESTABLISHED, ни UDP

- **Где:** `mac-support/shims/netstat:14` (`-sTCP:LISTEN` жёстко зашит)
- **Что происходит на маке:** любой будущий вызов `netstat -ano` ради подсчёта
  установленных соединений вернёт пустоту, и это будет выглядеть как «соединений нет»,
  а не как «шим не умеет».
- **Почему:** фильтр `-sTCP:LISTEN` вшит в тело.
- **Насколько сейчас больно:** сегодня — не больно. Все пять живых потребителей
  ищут строго `LISTENING`, ESTABLISHED из вывода netstat в живом коде никто не
  парсит (`keepalive-proxy.js:655` упоминает netstat только в комментарии про
  ручную диагностику). Это мина на будущее, а не текущая поломка.
- **Фикс:** ничего не менять в коде; дописать в шапку шима строку-предупреждение
  «отдаёт ТОЛЬКО TCP-LISTEN; кому нужны ESTABLISHED — правь здесь», чтобы следующий
  автор не решил, что перед ним настоящий netstat.
- **Уверенность:** CONFIRMED (чтение кода шима + grep по потребителям).

### А.2 `taskkill` — покрывает ровно то, что зовут; всё остальное молча съедает

Тело целиком (`mac-support/shims/taskkill`):

```bash
#!/usr/bin/env bash
set -u
prev=""
for a in "$@"; do
  case "$prev" in
    /PID|/pid) kill -9 "$a" 2>/dev/null || true ;;
    /IM|/im)   pkill -9 -x "$a" 2>/dev/null || true ;;
  esac
  prev="$a"
done
exit 0
```

Разбор по флагам из задания:

| Флаг | Обрабатывается? | Что реально |
|---|---|---|
| `/PID <n>` | ✅ | `kill -9 <n>`. Совпадение точное, но регистр покрыт только двумя формами: `/PID` и `/pid`. `/Pid` (Windows проглотит) шим не узнает |
| `/IM <name>` | ⚠️ формально да | `pkill -9 -x <name>`. `-x` требует **точного** имени процесса, а вызывающий передаёт виндовое `Foo.exe` — на маке такого имени нет, значит никогда не совпадёт. В живом коде `/IM` не зовётся ни разу, так что вреда сейчас нет |
| `/F` | ❌ игнорируется | Безвредно: шим и так всегда бьёт `-9`. Мягкой формы у него просто нет |
| `/T` (убить дерево) | ❌ игнорируется | Умрёт только сам процесс, дети осиротеют. В живом коде `/T` не используется — проверено grep'ом по всем массивам аргументов |

**Все живые вызовы — одной формы.** Grep по репо даёт ровно три варианта, и все они
`['/F', '/PID', <pid>]`:

```
taskkill', ['/F', '/PID', m[1]]          transparent-proxy.js:3838,17266,19241; check-frontdoor.js:169
taskkill', ['/F', '/PID', pid]           keepalive-spawn.js:30
taskkill', ['/F', '/PID', String(st.pid)] dictation-fix.js:240 (Windows-only инструмент)
```

То есть на практике шим покрывает 100% вызовов. `/IM` встречается только в
комментарии-предупреждении (`internal/dictation-fix.js:238` — «никогда не
`taskkill /IM AutoHotkey64.exe`»), и `tools/check-hub.js:581` даже сторожит, чтобы
он не вернулся.

---

### [COSMETIC] `taskkill`-шим всегда возвращает 0 → счётчик убитых на маке завышен

- **Где:** `mac-support/shims/taskkill:21` (`exit 0`) ↔ `routing/transparent-proxy.js:17266`
- **Что происходит на маке:** `killPortListeners()` считает `killed += 1` за каждую
  строку, совпавшую с портом, независимо от того, умер процесс или нет. Чужой
  процесс (другой пользователь, `kill -9` вернул EPERM) будет посчитан как убитый,
  и в лог уйдёт `health kill: killed 1 listener(s)` при живом слушателе.
- **Почему:** на Windows `execFileSync` бросает исключение при ненулевом коде, и
  `killed += 1` не выполняется — счётчик честный. Шим же гасит любую ошибку
  (`2>/dev/null || true`) и выходит с 0, так что бросать нечему.
- **Насколько больно:** только на враньё в логе и в ответе `/__switch/api/health/kill`.
  Реальную свободу порта дашборд перепроверяет отдельно (`portIsFree()`), а
  `lifecycle.js` вообще принципиально не верит кодам возврата убийцы
  (см. комментарий `lifecycle.js:297-303` — там ровно эта мысль).
- **Фикс:** в шиме запомнить результат `kill` и вернуть его наружу:

```bash
rc=0
prev=""
for a in "$@"; do
  case "$prev" in
    /PID|/pid) kill -9 "$a" 2>/dev/null || rc=1 ;;
    /IM|/im)   pkill -9 "$a" 2>/dev/null || rc=1 ;;
  esac
  prev="$a"
done
exit $rc
```

  Заодно у `/IM` снят `-x`: без него `pkill` матчит по подстроке и виндовое имя с
  `.exe` хотя бы имеет шанс совпасть с маковским процессом. Если менять не хочется —
  оставить как есть, класс ошибки чисто отчётный.
- **Уверенность:** CONFIRMED для механики (чтение шима + `transparent-proxy.js:17263-17269`);
  PLAUSIBLE для частоты — сценарий требует чужого процесса на нашем порту.



### А.3 `python` и `python.exe` — оба ведут в `python3`, и это не тот `python3`

Тела (различаются только комментарием):

```bash
#!/usr/bin/env bash
# python shim -> python3 (на macOS нет команды `python`, только `python3`).
exec python3 "$@"
```

```bash
#!/usr/bin/env bash
# python.exe shim -> python3 (запасной вариант, если кто-то зовёт по Windows-имени).
exec python3 "$@"
```

**Отсутствующий бинарь зовётся? Формально нет.** `python3` на macOS есть всегда —
`/usr/bin/python3`. Аргументы прокидываются прозрачно (`"$@"`), `exec` не плодит
лишний процесс. По букве задания шим корректен.

Кто вообще зовёт `python` в живом коде — ровно два места:

```
anymodel/lib/camoufox-anymodel-client.js:35   spawn("python", [camoufox_anymodel.py])
internal/dashboard-api.js:1195                spawn('python', [routing/tokenrouter/camoufox_autoreg.py, '--open', email])
```

Оба — camoufox. И вот здесь шим ломается не синтаксисом, а смыслом.

---

### [BROKEN] `python`-шим ведёт в интерпретатор, где camoufox не установлен

- **Где:** `mac-support/shims/python:3` ↔ `internal/dashboard-api.js:1195`,
  `anymodel/lib/camoufox-anymodel-client.js:35`
- **Что происходит на маке:** обе camoufox-функции падают с
  `ModuleNotFoundError: No module named 'camoufox'`. У `dashboard-api.js` это тихо:
  процесс спавнится `detached` со `stdio: 'ignore'`, функция возвращает `{ ok: true }`,
  и в UI выглядит как «запустил», хотя не запустилось ничего.
- **Почему:** две причины складываются.
  1. `exec python3` резолвится через PATH ребёнка — это `/usr/bin/python3` (системный,
     3.9) либо brew-шный `python3` по умолчанию. Ни тот, ни другой не тот
     интерпретатор, куда что-либо ставилось.
  2. **На macOS camoufox не ставится вообще.** `install-deps.sh:22` вычисляет
     `IS_MAC`, на строке 128 расходится, и мак-ветка (128-191) делает **только**
     `tools/tg-venv` (opentele + tgcrypto). Установка camoufox живёт в `else`-ветке
     (195-243) — то есть исключительно на Windows. Проверено по структуре
     `if/elif/else/fi` файла.
- **Дополнительный риск:** `/usr/bin/python3` на чистом маке — **шим Command Line
  Tools**: файл существует, `command -v` его находит, но при вызове он лишь открывает
  диалог «установить инструменты разработчика» и возвращает ошибку. Этот же класс
  граблей уже описан в `install-mac.sh:51-54` — но там про `git`, и вывод оттуда на
  `python3` не перенесён.
- **Фикс:** шим не должен угадывать интерпретатор — он должен спросить у того же
  резолвера, которым пользуется установщик. Текст нового `mac-support/shims/python`
  (и байт-в-байт такой же `python.exe`):

```bash
#!/usr/bin/env bash
# python shim: на macOS нет команды `python`, а `python3` из PATH — не тот
# интерпретатор, куда ставились зависимости (camoufox, playwright).
#
# 🪤 Порядок важен: сначала venv проекта, потом brew python@3.11 (в него ставит
# install-deps.sh), и только потом системный python3 — он же CLT-шим, который
# на чистой машине лишь открывает диалог установки.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

for cand in \
  "$ROOT/tools/tg-venv/bin/python" \
  "$(brew --prefix python@3.11 2>/dev/null)/bin/python3.11"
do
  [ -x "$cand" ] && exec "$cand" "$@"
done

exec python3 "$@"
```

  Но сам по себе он ничего не чинит: **пока `install-deps.sh` не ставит camoufox на
  маке, любой резолвер приведёт в интерпретатор без нужного пакета.** Порядок работ —
  сначала мак-ветка установщика, потом шим.
- **Уверенность:** CONFIRMED — ветвление `install-deps.sh` прочитано, оба вызывающих
  места прочитаны. PLAUSIBLE только про то, какой именно `python3` окажется первым
  в PATH конкретной машины (зависит от brew/pyenv пользователя) — проверяется на маке
  одной командой: `PATH=mac-support/shims:$PATH python -c 'import camoufox'`.



### А.4 `curl.exe` и `clip.exe` — оба корректны

```bash
# curl.exe
#!/usr/bin/env bash
exec curl "$@"
```

```bash
# clip.exe
#!/usr/bin/env bash
exec pbcopy
```

**Зачем `curl.exe`, если на маке `curl` есть из коробки.** Затем, что в коде зашито
имя с расширением: `freemodel/lib/10minutemail.js:51` — `spawn('curl.exe', args, …)`.
Node ищет буквально `curl.exe`, а такого файла на маке нет → `ENOENT`. Шим — просто
второе имя для системного curl.

**Флаги не ломаются.** `exec curl "$@"` прокидывает аргументы один в один, без
переупаковки и без word-splitting. Реальный набор из вызывающего
(`10minutemail.js:38-48`): `-A <UA> -s -S --max-time N -H … -H … <cookie-jar-args> <url>` —
всё это стандартный POSIX-curl, никаких виндовых особенностей. Маковский curl 8.x
эти флаги понимает. Проверка кода возврата у вызывающего (`code !== 0`) работает,
потому что `exec` подменяет процесс и наружу уходит код самого curl.

⚠️ Единственная тонкость: `--max-time` требует, чтобы аргумент не пришёл склеенным —
он и не приходит, `spawn` передаёт массивом, оболочки в цепочке нет.

**`clip.exe` → `pbcopy` — да, маппинг правильный.** `internal/notion-manager.js:58`
пишет текст в `stdin` и закрывает его; `pbcopy` читает stdin ровно так же, как
виндовый `clip`. `exec pbcopy` **без** `"$@"` — и это верно: виндовый `clip`
аргументов не принимает вовсе, а `pbcopy` со случайным аргументом бы ругнулся.
Код возврата `pbcopy` (0 при успехе) удовлетворяет проверке в `close`-хендлере.

Обе прокладки — **OK**, править нечего.

---

### [DEGRADED] Препенд шимов в PATH перекрывает системные `netstat` и `python` у детей хаба

- **Где:** `routing/lifecycle.js:468` (препенд каталога шимов в PATH ребёнка)
- **Разбор по файлам:**

| Шим | Есть ли на маке одноимённый системный бинарь? | Перебивает? |
|---|---|---|
| `curl.exe` | нет | ❌ безопасно |
| `clip.exe` | нет | ❌ безопасно |
| `python.exe` | нет | ❌ безопасно |
| `taskkill` | нет | ❌ безопасно |
| **`netstat`** | **да, `/usr/sbin/netstat`** | ✅ **перекрывается** |
| **`python`** | **нет в системе, но ЕСТЬ у pyenv/conda/brew-пользователей** | ✅ **может перекрыть** |

- **Что происходит на маке:** любой процесс из-под хаба, зовущий `netstat` для чего-то
  кроме «покажи TCP-слушателей», получит наш урезанный вывод и не узнает об этом.
  Аналогично, если у владельца стоит pyenv, `python` внутри дерева хаба перестаёт быть
  его питоном и становится `python3` из PATH.
- **Насколько это широко:** узко. Препенд действует **только** на детей
  `lifecycle.startService()` и их потомков, а не на shell пользователя — свой PATH
  хаб намеренно не портит (`lifecycle.js:462-463`, комментарий про то, что шим
  `netstat` подменил бы ему настоящий `lsof`… точнее, сломал бы его собственный
  поиск). Так что «весь остальной софт на маке» не задет: терминал, Finder, IDE
  ничего этого не видят.
- **Остаточный риск:** сторонние инструменты, которые ЗАПУСКАЕТ дашборд (например
  `git`, хуки, `npm`-скрипты пользователя), унаследуют подменённый `netstat`/`python`.
- **Фикс:** препендить не весь каталог, а класть шимы в PATH **последним** нельзя
  (тогда системный `netstat` выиграет и всё сломается). Правильный вариант — увести
  подмену из PATH в явные пути: в `childEnv()` добавить
  `env.NETSTAT = shims + '/netstat'`, а вызывающим (`transparent-proxy.js`,
  `keepalive-spawn.js`) звать `process.env.NETSTAT || 'netstat'`. Это ровно тот приём,
  который в том же `childEnv()` уже применён к `SQLITE3` (строка 469) — то есть
  паттерн в проекте есть, просто не распространён на netstat/python.
- **Уверенность:** CONFIRMED для механики препенда и для наличия `/usr/sbin/netstat`
  на macOS; PLAUSIBLE для практического вреда — нужен сторонний потребитель netstat
  внутри дерева процессов хаба, а такого сейчас не видно.



## Б. Дыры в покрытии

### Что появилось ПОСЛЕ 18 августа (дата заморозки шимов)

Три файла, зовущих виндовые бинари, созданы **после** того, как `mac-support/` перестали
трогать. Ни один не учтён ни шимами, ни PATH-механизмом:

| Файл | Создан | Что зовёт | Покрыт? |
|---|---|---|---|
| `tools/check-frontdoor.js` | **2026-08-20** | `netstat -ano` (`:165`), `taskkill /F /PID` (`:169`) | шимы есть, но PATH нет (запуск руками) |
| `tools/clean-camoufox-profiles.sh` | **2026-08-21** | `tasklist /FO CSV /NH` (`:32`) | **шима нет вообще** |
| `tools/doctor.sh` | **2026-08-25** | `netstat -ano`, `LISTENING` (`:62`) | шим есть, PATH нет |

Разбор каждого — в разделе Г (они все одного корня: ручной запуск мимо `childEnv()`).
Здесь важен вывод: **дыры прирастают именно инструментами диагностики**, потому что
они пишутся под Windows-консоль автора и живут вне пути `lifecycle.startService()`.

---

### Что проверено и оказалось НЕ дырой

Чтобы не гонять по ложным следам — вот попадания grep'а, которые при чтении оказались
корректно закрытыми:

| Вызов | Почему не дыра |
|---|---|
| `internal/dashboard-api.js:841,877,979,1191` — `cmd.exe` | у всех четырёх есть явная POSIX-ветка `else` с `bash`/`node`/`python`. `:806` даже несёт разбор граблей 24.08 про «.bat на маке запускать нечем» |
| `routing/lifecycle.js:201,281,308,571,573` | под `IS_WIN`, POSIX-ветки написаны (`lsof -F pn`, `ps -p`, `process.kill`, `spawn detached`) |
| `hub.js:741,787,797,1826` — `where.exe`, `cmd.exe`, `powershell` | всё внутри `relaunchElevated()`, который начинается с `if (!L.IS_WIN) return false` (`hub.js:795`) |
| `routing/lib/newapi-account.js:396,569` — DPAPI через `powershell` | модуль полностью портирован: `IS_MAC` (`:431`) уводит на Keychain + PBKDF2-SHA1/`saltysalt`/1003, и это отдельная рабочая ветка, а не заглушка |
| `routing/lib/github-session.js:212` | это **комментарий** («дашборд не имеет права звать DPAPI»), живого вызова powershell в файле нет |
| `routing/statusline-autoreger.sh:63`, `routing/statusline-shim.sh:23` — `cmd.exe /c echo %USERPROFILE%` | защищено структурно: ветка берётся только если `[ ! -f "$HOME/.claude/settings.json" ]`. На маке файл на месте → до `cmd.exe` не доходит |
| `internal/dictation-fix.js` (`schtasks`, `taskkill`, `powershell`) | инструмент чинит диктовку в AutoHotkey — Windows-only по сути; `IS_WIN` объявлен на `:25` |
| `internal/build-release.js:65,130` (`chcp`, `powershell`) | собирает Windows-релиз, на маке не запускается |
| `install.sh:117` — `powershell` | это git-bash-установщик для Windows; у мака свой `install-mac.sh` |
| `freemodel/lib/10minutemail.js:51` — `curl.exe` | шим есть и прозрачен |
| `internal/notion-manager.js:58` — `clip.exe` | шим есть, `pbcopy` |
| `wmic`, `pwsh`, `reg add/query`, `explorer.exe`, `icacls`, `robocopy`, `certutil` | в репо не встречаются ни разу |

---

### [DEGRADED] `pool-watchdog.js` зовёт `powershell.exe` без проверки платформы

- **Где:** `routing/pool-watchdog.js:236`
- **Что происходит на маке:**

```js
spawn('powershell.exe', ['-NoProfile', '-Command', ps, text], { detached: true, stdio: 'ignore' }).unref();
```

  `ENOENT` → ловится `catch` на `:238` → в лог уходит «всплывашка не вышла:
  spawn powershell.exe ENOENT». Уведомление о проблеме с LLM-пулом до человека
  не доезжает.
- **Почему:** единственная защита — `if (!ALERT_TOAST) return` (`:227`), то есть
  проверка **настройки**, а не платформы. По умолчанию `ALERT_TOAST` выключен
  (`:46`), так что молчание сейчас штатное; включив его на маке, владелец получит
  тишину плюс строку в логе вместо всплывашки.
- **Фикс:** мак-ветка на `osascript` (в системе есть всегда, ставить нечего):

```js
function notifyToast(text) {
    if (!ALERT_TOAST) return;
    try {
        const { spawn } = require('child_process');
        if (process.platform !== 'win32') {
            // osascript берёт текст аргументом ($1), а не подстановкой в тело скрипта —
            // иначе кавычка внутри сообщения ломает AppleScript.
            spawn('osascript', ['-e',
                'on run argv\ndisplay notification (item 1 of argv) with title "LLM-пул"\nend run',
                text], { detached: true, stdio: 'ignore' }).unref();
            return;
        }
        const ps = 'Add-Type -AssemblyName System.Windows.Forms;' /* …как было… */;
        spawn('powershell.exe', ['-NoProfile', '-Command', ps, text], { detached: true, stdio: 'ignore' }).unref();
    } catch (e) { log(`всплывашка не вышла: ${e.message}`); }
}
```

- **Уверенность:** CONFIRMED (файл прочитан, guard'ов по платформе нет).

---

### Полный список `python`-потребителей — их четыре, не два

Важно для оценки веса находки «python-шим ведёт не в тот интерпретатор» (раздел А.3):

```
internal/dashboard-api.js:959    'tokenrouter-create' → cmd: 'python' + routing/tokenrouter/camoufox_autoreg.py
internal/dashboard-api.js:960    'ourtoken-create'    → cmd: 'python' + ourtoken/camoufox_autoreg.py
internal/dashboard-api.js:1195   спавн camoufox_autoreg.py --open <email> (POSIX-ветка)
anymodel/lib/camoufox-anymodel-client.js:35            camoufox_anymodel.py
```

Все четыре — camoufox. То есть **на маке не работает ни одна авторега через camoufox**,
и виноват в этом не шим (он честно ведёт в `python3`), а то, что мак-ветка
`install-deps.sh` (строки 128-191) camoufox не ставит вовсе. Шим лишь делает отказ
тихим: `spawn` в `dashboard-api.js` идёт `detached` со `stdio: 'ignore'`, функция
возвращает `{ ok: true }`, UI рисует успех.

---

## В. `internal/export-for-mac.js`

### Что он на самом деле делает

**Вопреки имени, к переносу проекта на Mac он отношения не имеет.** Это экспортёр
**одной сессии Devin.ai** для запуска на чужом маке. Берёт папку из
`manual_sessions/<стамп>/`, читает `session.json` (Playwright `storageState`) и
складывает рядом `mac_import/`:

| Файл | Что это |
|---|---|
| `session.json` | копия storageState |
| `restore_session.py` | Python + Playwright: открыть Chromium с этой сессией на `https://app.devin.ai/settings/preferences` |
| `SETUP_CLICK.command` | снимает карантин `xattr -cr .`, генерирует `RUN.command`, запускает |
| `OPEN_ME.html` | страница с кнопками «скопировать команду в Terminal» |
| `README.md` | инструкция |
| `<сессия>_mac.zip` | архив: на Windows через `powershell Compress-Archive`, на Unix через `zip` |

Запуск: `node internal/export-for-mac.js <путь>` или без аргументов — интерактивный
выбор из `manual_sessions/` (79 папок на диске).

### Актуален ли — нет

- **Ноль вызывающих.** Grep по всему репо: строка `export-for-mac` встречается только
  в собственном docstring файла (строки 11-12). Ни `internal/menu.js`, ни
  `internal/dashboard-api.js`, ни `package.json`, ни README его не зовут и не
  упоминают. Мёртвая точка входа.
- **Ноль правок с рождения.** `git log --follow` даёт ровно один коммит — `12ccaa1`
  от **2026-05-29**. То есть файл на три месяца старше самого `mac-support/` и вообще
  всей мак-темы; к ней он не относится и никогда не относился.
- Devin как таковой в репо ещё жив (`internal/devin-manager.js`, меню
  `⚙️ DEVIN.AI AUTOREG` в `internal/menu.js:282`), так что удалять файл бездумно
  нельзя — но связи между ним и живым Devin-меню нет.

### «Покрывает ли новые каталоги (`aipm/`, `gorouter/`, `justwoker/`, `routing/`)»

Нет, и **не должен**: он не экспортирует проект, он экспортирует одну cookie-сессию.
Ожидание «он забыл новые каталоги» исходит из имени файла, а не из его содержимого.
Роль «перенести проект на мак» выполняют `install-mac.sh` (клонирует репо целиком с
GitHub) и `tools/relocate.js` — они каталоги не перечисляют, поэтому у них этого
класса проблем нет по построению.

---

### [COSMETIC] `export-for-mac.js` обещает файлы, которых не создаёт

- **Где:** `internal/export-for-mac.js:8` (docstring), `:284` и `:292`
  (текст генерируемого README)
- **Что происходит:** docstring в шапке заявляет `RUN_ME.command (двойной клик на Mac
  для запуска)` — такой файл не создаётся никогда; создаётся `SETUP_CLICK.command`,
  который уже сам порождает `RUN.command`. Сгенерированный README дополнительно
  предлагает «Способ 3: AppleScript → двойной клик на `RUN_ME.applescript`» и
  перечисляет его в списке файлов — этого файла в коде нет вовсе.
- **Почему:** остаток от более ранней версии, вычищенный не до конца; поскольку
  вызывающих нет, никто не заметил.
- **Фикс:** в шапке заменить `RUN_ME.command` на `SETUP_CLICK.command`; из
  генерируемого README вырезать блок «Способ 3: AppleScript» и строку
  `RUN_ME.applescript` из списка файлов.
- **Уверенность:** CONFIRMED (файл прочитан целиком, 409 строк).

---

### [COSMETIC] `SETUP_CLICK.command` делает `chmod +x RUN.command` до того, как файл появляется

- **Где:** `internal/export-for-mac.js:125` (сам `RUN.command` создаётся строками 128-134)
- **Что происходит:** в генерируемом скрипте `chmod +x RUN.command 2>/dev/null` стоит
  раньше, чем `cat > RUN.command`. При первом запуске chmod промахивается.
- **Почему не больно:** после `cat` идёт второй, правильный `chmod +x RUN.command`
  (строка 134), а ошибка первого проглочена `2>/dev/null`.
- **Фикс:** удалить преждевременный `chmod` (строка 125).
- **Уверенность:** CONFIRMED.

---

### [DEGRADED] `restore_session.py` ставит playwright без пина версии

- **Где:** `internal/export-for-mac.js:62-64` (тело генерируемого `restore_session.py`)
- **Что происходит на маке:** при отсутствии playwright скрипт делает
  `os.system(f"{sys.executable} -m pip install playwright")` — **без версии**, в
  системный питон, без venv.
- **Почему это важно именно здесь:** в остальном проекте playwright пинится жёстко и
  с объяснением — `install-deps.sh:238`: «playwright строго 1.60.0: в 1.61
  Firefox-клиент шлёт `viewport.isMobile`, которого juggler Camoufox (FF152) не
  знает → вся авторега умирает». Этот экспортёр ставит что угодно свежее и заодно
  может сломать уже настроенный playwright на машине получателя.
- **Фикс:** `pip install playwright==1.60.0`, ставить в venv, а не в системный
  интерпретатор. Либо, если файл всё равно мёртв, — честно пометить его как legacy.
- **Уверенность:** CONFIRMED для отсутствия пина; PLAUSIBLE для конфликта — зависит
  от того, что стоит у получателя.

---

## Г. Механика подключения шимов

### Как это устроено на самом деле

```
HUB.command  (двойной клик)
   └─ node hub.js start
        └─ lifecycle.start()                       lifecycle.js:704
             ├─ preparePlatform()                  lifecycle.js:483  ← chmod 0755 шимам
             └─ startService(svc) × N              lifecycle.js:565
                  └─ spawn(node, [script], { env: childEnv() })   ← PATH с шимами
                       └─ transparent-proxy.js (дашборд)
                            └─ все его дети наследуют env → шимы видят и они
```

Три отдельных механизма, и все три на месте:

1. **Exec-бит.** В индексе git все шесть шимов лежат как `100755` (проверено
   `git ls-files -s mac-support/`), плюс `preparePlatform()` (`lifecycle.js:503-514`)
   при каждом старте на не-Windows пробегает `mac-support/shims`, `routing/` и корень
   и делает `chmod 0755`. Плюс `install-mac.sh:247` делает то же при установке.
   Тройное перекрытие — **это не сломано.**
2. **Шебанг.** У всех шести `#!/usr/bin/env bash`, первые байты `23 21 2f`, BOM нет.
   **Не сломано.**
3. **PATH.** Единственная точка — `childEnv()`, единственный вызов — `startService()`.

Вывод по букве задания: **шимы живые, BLOCKER'а «все они мертвы» нет.** Но покрытие
у PATH-механизма дырявое, и вот в чём.

---

### 🔻 [BLOCKER] Шимы видят только процессы, поднятые хабом; документированный ручной запуск дашборда их не видит

- **Где:** `routing/lifecycle.js:464-472` (`childEnv`), `lifecycle.js:587`
  (единственный вызов) ↔ `README.md:394`, `README.md:399`
- **Что происходит на маке:** README прямым текстом предлагает два обходных пути:

```
node routing/transparent-proxy.js        # дашборд вручную, без остального стека
node internal/menu.js                    # полное TUI-меню (карты, прокси, локаль)
```

  Запущенный так дашборд шимов **не получает** — его PATH это PATH терминала.
  Дальше внутри него:
  * `handleHealth` (`transparent-proxy.js:4027`) зовёт `execFileSync('netstat', ['-ano'])`
    → попадает в системный `/usr/sbin/netstat`, у которого **нет флага `-o`**. Вызов
    падает, `catch {}` глотает, `listening` остаётся пустой Map → вкладка «Здоровье»
    показывает пустые PID у всех сервисов.
  * `killPortListeners` (`17263`), `customKillProxy` (`3835`), health-kill (`19237`) —
    та же картина: `killed: 0` при живых слушателях.
  * `taskkill` (`3838`, `17266`, `19241`) — `ENOENT`, ловится `catch {}`, тихо.
  * `spawn('python', …)` (`dashboard-api.js:1195`) — `ENOENT`, а функция всё равно
    вернёт `{ ok: true }`, потому что спавн `detached` + `stdio:'ignore'`.
- **Почему:** подмена сделана точечно, в одной функции запуска, а не на уровне входа
  в программу. Всё, что стартует мимо `lifecycle.startService()`, живёт со своим PATH.
  Заодно мимо проходят и `tools/*.sh` (следующие две находки).
- **Насколько широка дыра:** штатный путь (двойной клик по `HUB.command` /
  `DASHBOARD.command` → `hub.js` → `lifecycle`) закрыт полностью, и дети дашборда
  тоже. Открыты: (1) ручной запуск из README, (2) все `tools/*.sh` и `tools/*.js`,
  запускаемые человеком, (3) `internal/menu.js`. То есть дыра не в основном сценарии,
  а в диагностике и в ручном режиме — ровно там, куда человек идёт, когда основное
  уже сломалось.
- **Фикс:** перенести препенд из `childEnv()` в самое начало процесса, чтобы он
  действовал и на прямой запуск:

```js
// Шимы виндовых имён (netstat/taskkill/python/curl.exe/clip.exe) — mac-support/shims.
// Здесь, а не только в lifecycle.childEnv(): README документирует прямой запуск
// `node routing/transparent-proxy.js`, и при нём childEnv() не вызывается вовсе.
if (process.platform !== 'win32') {
    const p = require('path'), f = require('fs');
    const shims = p.join(__dirname, '..', 'mac-support', 'shims');
    if (f.existsSync(shims) && !String(process.env.PATH || '').startsWith(shims))
        process.env.PATH = shims + p.delimiter + (process.env.PATH || '');
}
```

  Альтернатива, более чистая, но дороже: перевести вызывающих на явные пути через
  переменные окружения (`process.env.NETSTAT || 'netstat'`) — приём, который в том же
  `childEnv():469` уже применён к `SQLITE3`.
- **Уверенность:** CONFIRMED для механики (единственный вызов `childEnv` проверен
  grep'ом; строки README прочитаны). PLAUSIBLE для точного поведения
  `/usr/sbin/netstat -ano` — проверяется на маке одной командой:
  `netstat -ano; echo "rc=$?"` (ожидается `illegal option -- o`).

---

### [DEGRADED] `tools/doctor.sh` — диагностика, которая на маке всегда говорит «портов нет»

- **Где:** `tools/doctor.sh:62`
- **Что происходит на маке:**

```bash
netstat -ano 2>/dev/null | grep -E "LISTENING" | grep -E ":(8200|20126|20128) " || echo "порты 8200/20126/20128 никто не слушает"
```

  Скрипт запускается человеком из терминала → PATH без шимов → системный `netstat`,
  который `-ano` не понимает; `2>/dev/null` прячет ругань, пайп отдаёт пусто, и
  доктор печатает «порты никто не слушает» **при полностью живом стеке**. Это хуже
  чем бесполезно: диагностика уводит в ложном направлении.
- **Почему:** тот же корень, что выше. Плюс `LISTENING` — виндовое слово, BSD-netstat
  пишет `LISTEN`.
- **Фикс:** в шапку `doctor.sh` добавить
  `PATH="$(cd "$(dirname "$0")/.." && pwd)/mac-support/shims:$PATH"`, и грепать
  `LISTEN` вместо `LISTENING` (шим печатает `LISTENING`, подстрока `LISTEN` попадёт
  в оба варианта). Тогда одна строка работает на обеих платформах.
- **Уверенность:** CONFIRMED (файл прочитан, механика PATH проверена).

---

### [DEGRADED] `tools/clean-camoufox-profiles.sh` зовёт `tasklist`, а шима `tasklist` нет

- **Где:** `tools/clean-camoufox-profiles.sh:32`
- **Что происходит на маке:** `tasklist: command not found` → переменная `live`
  пустая → скрипт считает, что **ни один** camoufox-профиль не занят живым процессом.
- **Почему:** шима `tasklist` в `mac-support/shims/` нет вовсе.
  `routing/lifecycle.js:281` от этого не страдает — там есть POSIX-ветка
  (`ps -p <pid> -o comm=`); у шелл-скрипта ветки нет.
- **Фикс:** новый шим `mac-support/shims/tasklist`, текст целиком:

```bash
#!/usr/bin/env bash
# tasklist shim для macOS/Linux.
# Зовут в двух формах:
#   tasklist /FO CSV /NH                — дамп всех процессов (clean-camoufox-profiles.sh)
#   tasklist /fi "pid eq N" /fo csv /nh — один процесс (lifecycle.pidImage, win-ветка)
# Формат вывода Windows: "Имя","PID","Сессия","№","Память"
set -u

filter_pid=""
prev=""
for a in "$@"; do
  case "$prev" in
    /fi|/FI) case "$a" in *[Pp][Ii][Dd]*[Ee][Qq]*) filter_pid="${a##* }" ;; esac ;;
  esac
  prev="$a"
done

if [ -n "$filter_pid" ]; then
  ps -p "$filter_pid" -o comm=,pid= 2>/dev/null
else
  ps -axo comm=,pid= 2>/dev/null
fi | awk '{ pid=$NF; $NF=""; sub(/[ \t]+$/,""); n=$0; sub(/.*\//,"",n);
            printf "\"%s\",\"%s\",\"Console\",\"1\",\"0 K\"\n", n, pid }'

exit 0
```

  Половина фикса — сам шим; вторая половина в том, что PATH со шимами
  `clean-camoufox-profiles.sh` всё равно не видит (та же дыра, что у `doctor.sh`),
  поэтому строку с PATH туда тоже надо добавить.
- **Уверенность:** CONFIRMED, что шима нет и что скрипт его зовёт. PLAUSIBLE
  относительно последствий пустого `live` — я читал только вызов, не всю логику
  удаления ниже по файлу.

---

### [COSMETIC] `install-mac.sh` не делает `chmod +x` главному входу `HUB.command`

- **Где:** `install-mac.sh:247`
- **Что:** `chmod +x mac-support/shims/* routing/*.sh DASHBOARD.command install-mac.sh` —
  `HUB.command` в списке нет, хотя с 24.08 именно он стал главным меню
  (`DASHBOARD.command` теперь тонкий форвардер к нему).
- **Почему не BLOCKER:** три страховки перекрывают. В индексе git `HUB.command` лежит
  как `100755`; `DASHBOARD.command:13` сам делает ему `chmod +x` и зовёт через
  `exec bash HUB.command` (exec-бит там не обязателен вовсе); `preparePlatform()`
  чинит права всем `*.command` в корне при каждом старте.
- **Фикс:** дописать `HUB.command` в строку 247.
- **Уверенность:** CONFIRMED.

---

## Итог

### Числа

| Градация | Штук | Находки |
|---|---|---|
| **BLOCKER** | 1 | шимы попадают в PATH только через `lifecycle.childEnv()` → документированный в README ручной запуск (`node routing/transparent-proxy.js`, `node internal/menu.js`) и все `tools/*` их не видят |
| **BROKEN** | 1 | `python`-шим ведёт в интерпретатор без camoufox — на маке не работает ни одна из четырёх camoufox-авторег, и отказ тихий (`{ ok: true }` в UI) |
| **DEGRADED** | 7 | `netstat`-шим теряет процессы с пробелом в имени · `netstat`-шим отдаёт только TCP-LISTEN · нет шима `tasklist` (`clean-camoufox-profiles.sh`) · `doctor.sh` всегда врёт «портов нет» · `pool-watchdog` зовёт `powershell.exe` без проверки платформы · препенд шимов перекрывает системные `netstat`/`python` у детей хаба · `restore_session.py` ставит playwright без пина |
| **COSMETIC** | 4 | `taskkill`-шим всегда `exit 0` → завышенный счётчик убитых · `install-mac.sh` не chmod'ит `HUB.command` · `export-for-mac.js` обещает несуществующие `RUN_ME.command`/`RUN_ME.applescript` · `chmod` до создания файла в `SETUP_CLICK.command` |

### Главное

**Сами шимы почти в порядке — сломана их доставка: они существуют только у процессов,
которых поднял хаб, поэтому вся ручная диагностика на маке (`doctor.sh`,
`check-frontdoor.js`, `node routing/transparent-proxy.js` из README) молча врёт
«портов нет / никого не убил», а `python` ведёт в интерпретатор, куда camoufox на
маке никто и не ставил.**

Отдельно стоит сказать, чего **нет**: BLOCKER'а «шимы мертвы» не существует.
Exec-бит проверен трижды (индекс git `100755`, `preparePlatform()` при каждом
старте, `install-mac.sh:247`), шебанг `#!/usr/bin/env bash` у всех шести, перевод
строк LF, BOM отсутствует, `.gitattributes` это держит. Гигиена файлов образцовая —
проблема этажом выше.

### Шимы, которые надо создать или дописать

| Шим | Действие | Почему |
|---|---|---|
| `mac-support/shims/netstat` | **переписать** на `lsof -F pn` + `awk` (текст целиком — раздел А.1) | текущий разбор по колонкам теряет слушателей, у чьего процесса пробел в имени; `lifecycle.js:217-220` уже знает эти грабли и делает правильно |
| `mac-support/shims/tasklist` | **создать** (текст целиком — раздел Г) | `tools/clean-camoufox-profiles.sh:32` его зовёт, шима нет; файл создан 21.08, то есть после заморозки `mac-support/` |
| `mac-support/shims/python` и `python.exe` | **дописать** резолвер интерпретатора (текст целиком — раздел А.3) | `exec python3` попадает в системный питон; нужен venv проекта → brew `python@3.11` → system. ⚠️ без правки мак-ветки `install-deps.sh` (там нет camoufox) сам по себе не спасёт |
| `mac-support/shims/taskkill` | **дописать** (опционально) возврат кода вместо жёсткого `exit 0` | иначе счётчик «убито N слушателей» на маке всегда оптимистичен |
| `mac-support/shims/curl.exe`, `clip.exe` | **не трогать** | корректны, прозрачны, побочного эффекта на системные бинари не дают (одноимённых на маке нет) |

### Не-шимовые правки, без которых шимы не помогут

1. Препенд `mac-support/shims` в `process.env.PATH` в голове
   `routing/transparent-proxy.js` и `internal/menu.js` — иначе ручной запуск из README
   остаётся слепым (патч — раздел Г).
2. Строка `PATH=…/mac-support/shims:$PATH` в шапки `tools/doctor.sh` и
   `tools/clean-camoufox-profiles.sh`; в `doctor.sh` заодно грепать `LISTEN`, а не
   `LISTENING`.
3. Мак-ветка `install-deps.sh` (строки 128-191) должна ставить camoufox, а не только
   `tg-venv` — сейчас установка camoufox целиком лежит в `else`-ветке для Windows.
4. `HUB.command` — в список `chmod +x` на `install-mac.sh:247`.
5. `routing/pool-watchdog.js:236` — мак-ветка на `osascript`.

### Что проверить на живом маке (одной строкой каждое)

```bash
netstat -ano; echo "rc=$?"                                  # ожидается: illegal option -- o
PATH=mac-support/shims:$PATH netstat -ano | head            # должен дать TCP … LISTENING <pid>
PATH=mac-support/shims:$PATH python -c 'import camoufox'    # ожидается ModuleNotFoundError
lsof -nP -iTCP -sTCP:LISTEN | awk '$1 ~ / /'                # есть ли процессы с пробелом в COMMAND
bash tools/doctor.sh | grep -i порт                         # соврёт ли «никто не слушает» при живом стеке
```


