# 10 — Файловая система и кодировки: сквозной аудит мак-совместимости

**Агент:** №10 из 10
**Репозиторий:** `C:\Users\WormAlien\Desktop\Autoreger_Clean`
**Дата:** 2026-09-09
**Метод:** статический аудит скриптами, мака под рукой нет. Все выводы подтверждены командами, вывод приведён.

**Зона:** сквозные «физические» несовместимости ФС и кодировок — регистр имён, запрещённые имена, Unicode-нормализация, переводы строк, BOM, права и симлинки. Бизнес-логика — не моя зона.

**Исключения при сканировании:** `node_modules/`, `graphify-out/`, `logs/`, `manual_sessions/`, `*/accounts/`, `*/sessions/`, `.git/`.

---

## Базовая конфигурация (общий контекст для А–Е)

```
$ git remote -v
origin	https://github.com/WormAlien/hub-cc.git (fetch)
origin	https://github.com/WormAlien/hub-cc.git (push)

$ git config --list --show-origin | grep -iE 'autocrlf|eol|safecrlf|symlink|ignorecase|precomposeunicode|longpaths'
file:C:/Program Files/Git/etc/gitconfig	core.autocrlf=true
file:C:/Program Files/Git/etc/gitconfig	core.symlinks=false
file:.git/config	core.symlinks=false
file:.git/config	core.ignorecase=true

$ git config core.hooksPath
.githooks

$ git ls-files | wc -l
389
```

**Путь доставки на мак — `git clone`, не архив.** `install-mac.sh:45,80`:

```
REPO_URL="https://github.com/WormAlien/hub-cc.git"
git clone "$REPO_URL" "$DEST"
```

Это ключевой факт для всего раздела Г: мак получает **содержимое индекса**, а не рабочей
копии Windows. Всё, что `core.autocrlf=true` наделало в `C:\...\Autoreger_Clean`, на мак
не уезжает.

**`core.ignorecase=true`** — записан в `.git/config` при `git init`/`clone` на Windows.
На маке с APFS (case-insensitive по умолчанию) git поставит то же значение, на
case-sensitive томе — `false`. Значение локальное, в репозиторий не коммитится, поэтому
разъехаться конфиги не могут; см. раздел А.

---

## А. Регистр имён

Метод: скрипт строит два инвентаря — (1) реальные имена файлов рабочего дерева с
точным регистром, как их отдаёт ФС, (2) имена, как они записаны в индексе git, — и
затем резолвит каждый `require`/`import`/`import()` в 220 `.js`-файлах по правилам Node
(`p`, `p.js`, `p.json`, `p.cjs`, `p.mjs`, `p/index.js`). Сравнение членством в множестве,
то есть **регистрозависимое**, — на Windows `os.path.exists()` для этой задачи бесполезен,
он вернёт `True` при любом регистре.

Скрипт: `C:\Users\WormAlien\AppData\Local\Temp\mac_audit_case.py`
(вне репозитория — код не трогаю).

```
$ python "C:/Users/WormAlien/AppData/Local/Temp/mac_audit_case.py"
=== inventory ===
files on disk (filtered): 106343
files in git index      : 389
js files scanned        : 220

=== A1. git-index case != on-disk case (0) ===
  NONE

=== A2. names differing only by case (0) ===
  NONE

=== A3. require/import with WRONG CASE (0) ===
  NONE

=== A4. require/import target NOT FOUND at all (5) ===
  freemodel/lib/emailnator.js  ->  ../freemodel/lib/emailnator   (resolved base: freemodel/freemodel/lib/emailnator)
  internal/build-release.js  ->  ./package.json   (resolved base: internal/package.json)
  svrtr/test_auth.js  ->  ./svrtr/lib/svrtr-api   (resolved base: svrtr/svrtr/lib/svrtr-api)
  tools/check-deps-tracked.js  ->  ./x   (resolved base: tools/x)
  tools/check-deps-tracked.js  ->  ./latency-store.js   (resolved base: tools/latency-store.js)
```

### A1 — регистр в индексе совпадает с диском

Ноль расхождений на 389 файлах. Это важнее, чем кажется: `core.ignorecase=true` на
Windows позволяет переименовать `Foo.js` → `foo.js` так, что git продолжит хранить
старое имя, а на маке с чувствительным томом файл разъедется. Здесь такого нет.

### A2 — нет имён, различающихся только регистром

Ноль пар. Значит на case-sensitive томе не появится «двух разных файлов» из одного,
а на case-insensitive — не будет перезаписи при чекауте.

### A3 — ни одного `require`/`import` с неверным регистром

**Ноль на 220 просканированных `.js`.** Это и есть главный ответ раздела: тихой бомбы
«на Windows работает, на маке с чувствительным томом — нет» в графе модулей нет.

### A4 — пять «не найдено», из них четыре ложные

```
$ grep -n "require(.*emailnator" freemodel/lib/emailnator.js
7://   const { createEmail, pollInbox } = require('../freemodel/lib/emailnator');

$ grep -n "require('./package.json')" internal/build-release.js
168:for /f "tokens=*" %%v in ('cd /d "%APPDIR%" ^& node -p "require('./package.json').version" 2^>nul') do …

$ grep -n "'\./x'" tools/check-deps-tracked.js
13://   1. require('./x') в отслеживаемых .js — падение на СТАРТЕ процесса;

$ grep -n "latency-store" tools/check-deps-tracked.js
7:// в master с `require('./latency-store.js')`, а сам модуль лежал untracked. Локально
```

Три из четырёх — текст в комментариях (пример использования, описание бага),
четвёртый — строка внутри шаблона генерируемого `.bat`. К регистру и к маку отношения
не имеют.

### [COSMETIC] `svrtr/test_auth.js` требует несуществующий путь

- **Где:** `svrtr/test_auth.js:3`
  ```js
  const api = require('./svrtr/lib/svrtr-api');
  ```
- **Что происходит:** `require` резолвится относительно **файла**, а не cwd, поэтому путь
  раскрывается в `svrtr/svrtr/lib/svrtr-api` — такого нет. Правильно `./lib/svrtr-api`.
- **Почему:** файл, видимо, писался с расчётом на запуск из корня репозитория.
- **К маку отношения не имеет:** падает одинаково на Windows и на macOS
  (`MODULE_NOT_FOUND`). Записываю, потому что скрипт наткнулся, а не как мак-регрессию.
- **Фикс:** `require('./lib/svrtr-api')`
- **Уверенность:** CONFIRMED
- **Доказательство:** вывод A4 выше; `grep -n` показывает строку кода, а не комментарий:
  ```
  $ grep -n "svrtr-api" svrtr/test_auth.js
  3:const api = require('./svrtr/lib/svrtr-api');
  ```

### A5 — строковые пути (раздача статики, `path.join`, ссылки в HTML/sh)

`require`/`import` — не единственный способ обратиться к файлу. Дашборд читает шаблоны
и отдаёт `vendor/`-ассеты обычными строками, шелл-скрипты дёргают файлы по имени.
Второй скрипт индексирует **все суффиксы** реальных путей по границам `/` и ищет строковые
литералы, которые совпадают с реальным файлом только без учёта регистра.

Скрипт: `C:\Users\WormAlien\AppData\Local\Temp\mac_audit_strpaths.py`

```
$ python "C:/Users/WormAlien/AppData/Local/Temp/mac_audit_strpaths.py"
source files scanned: 1263
paths indexed       : 106343

=== A5. string path exists ONLY with a DIFFERENT CASE (0) ===
  NONE
```

Просмотрены `.js`/`.mjs`/`.cjs`/`.html`/`.sh`/`.command`/`.bat`/`.cmd`/`.ps1`/`.json`
(1263 файла), из них выдернуты все строковые литералы, похожие на путь с известным
расширением; URL, `data:` и `node_modules` отфильтрованы. **Ноль попаданий.**

### Вердикт раздела А

**Чисто.** Ни одного расхождения регистра — ни в графе модулей (220 файлов, A3), ни в
строковых путях (1263 файла, A5), ни между индексом git и диском (A1), ни внутри дерева
имён (A2). Единственная запись раздела — COSMETIC-опечатка пути в `svrtr/test_auth.js`,
которая ломается одинаково на обеих ОС.

Оговорка о полноте: проверка ловит **статические** пути. Пути, собранные во время
выполнения из переменных (`path.join(dir, name)`, где `name` приходит из конфига или
`readdir`), скриптом не покрываются — но для них регистр берётся с самой ФС, а не из
кода, и рассинхронизироваться ему неоткуда.

---

## Б. Запрещённые и опасные имена

### Зарезервированные имена устройств Windows — чисто

```
$ git ls-files | grep -iE '(^|/)(nul|con|prn|aux|com[1-9]|lpt[1-9])(\.|$)'
exit=1 (чисто)

$ find . -path ./node_modules -prune -o -path ./.git -prune -o -path ./graphify-out -prune \
    -o -path ./logs -prune -o -path ./manual_sessions -prune -o -print \
  | grep -iE '/(nul|con|prn|aux|com[1-9]|lpt[1-9])(\.|$)'
exit=1 (чисто)
```

Известные грабли проекта (`joker/nul`, убивавший `commit-and-sync`) в этом репозитории
не повторились — ни в индексе, ни на диске. Обратная сторона тоже проверена: файлов,
созданных на маке с именем, невозможным на Windows, нет.

### Символы, запрещённые на Windows и рискованные в Finder — чисто

```
$ git ls-files | grep -nE '[:*?"<>|\\]'
exit=1 (чисто)

$ git ls-files | grep -E '(^|/)[^/]*[ .](/|$)'        # хвостовой пробел/точка
exit=1 (чисто)

$ git ls-files | grep -E '(^|/)-'                      # компонент, начинающийся с дефиса
exit=1 (чисто)
```

Ни двоеточий (единственный символ, который Finder переписывает в `/`), ни звёздочек,
ни хвостовых пробелов/точек. Имена с ведущим дефисом, ломающие разбор аргументов
в `sh`, тоже отсутствуют.

### Длина путей и глубина — с большим запасом

```
$ git ls-files | awk '{print length($0)"\t"$0}' | sort -rn | head -3
49	routing/vendor/fonts/GeistMono-600-cyrillic.woff2
49	routing/vendor/fonts/GeistMono-500-cyrillic.woff2
49	routing/vendor/fonts/GeistMono-400-cyrillic.woff2

$ git ls-files | awk -F/ '{print NF}' | sort -rn | head -1
4

$ git ls-files | tr '/' '\n' | awk '{print length($0)"\t"$0}' | sort -rn | head -2
37	HANDOFF-dashboard-crash-2026-08-22.md
33	claude-settings.example.README.md
```

Максимум: 49 символов на относительный путь, 4 уровня вложенности, 37 символов на имя.
Лимиты macOS — 255 **байт** на компонент и ~1024 на путь. Запас четырёхкратный.
Против ограничения Windows `MAX_PATH=260` тоже безопасно.

### Вердикт раздела Б

**Чисто.** Ни одной находки.

---

## В. Unicode-нормализация (NFD на macOS)

### В git нет ни одного не-ASCII имени

```
$ git ls-files | grep -P '[^\x00-\x7F]'
exit=1 (чисто)
```

Это снимает весь класс проблемы **для доставки на мак**: NFD/NFC-расхождение возможно
только у файлов, чьи имена содержат не-ASCII, а таких в индексе ноль. `git clone` на
маке не сможет породить «изменённый»/«новый» файл из-за нормализации, потому что
нормализовать нечего. `core.precomposeunicode` (git ставит его в `true` при клоне на
macOS и переводит NFD от APFS обратно в NFC) в этом репозитории даже не понадобится.

### Не-ASCII имена на диске есть, но все они вне git

```
$ find . \( -path ./node_modules -o -path ./.git -o -path ./graphify-out -o -path ./logs \
     -o -path ./manual_sessions -o -name accounts -o -name sessions \) -prune -o -print \
  | grep -cP '[^\x00-\x7F]'
22

$ find … | grep -P '[^\x00-\x7F]' | head -2
./ready_to_sell/1 2026-05-17 18-13 Pro user-1ilrbf25/Инструкция_входа.txt
./ready_to_sell/1 2026-05-17 22-15 Pro user-c36yr36y/Инструкция_входа.txt

$ git check-ignore -v "ready_to_sell/1 2026-05-17 18-13 Pro user-1ilrbf25/Инструкция_входа.txt"
.gitignore:17:ready_to_sell/	"ready_to_sell/…/\320\230\320\275\321\201\321\202\321\200\321\203\320\272\321\206\320\270\321\217_\320\262\321\205\320\276\320\264\320\260.txt"
```

Все 22 — один и тот же файл `Инструкция_входа.txt` в подпапках `ready_to_sell/`,
и вся папка в `.gitignore:17`. На мак не уезжает.

### В коде проекта нет ни одного вызова `.normalize()`

```
$ grep -rn "\.normalize(" --include=*.js --include=*.py --include=*.mjs --include=*.cjs . \
  | grep -v node_modules | grep -v graphify-out
./tools/tg-venv/Lib/site-packages/idna/core.py:215: …
./tools/tg-venv/Lib/site-packages/setuptools/unicode_utils.py:12: …
  (и ещё 15 строк — все внутри tools/tg-venv/)

$ git ls-files tools/tg-venv | wc -l
0
$ git check-ignore -v tools/tg-venv
.gitignore:245:tools/tg-venv/	tools/tg-venv
```

Все 17 попаданий — в вендоренном питоновском venv, который не в git. **В собственном
коде проекта нормализации нет вообще.** Само по себе это не баг: сравнивать имена
файлов проекту почти не приходится.

### Сравнения имён из `readdir` — все по ASCII-шаблонам

81 вызов `fs.readdirSync` в коде проекта. Все проверенные фильтры сравнивают по
ASCII-суффиксам и regex'ам, где не-ASCII не участвует:

```
$ grep -rnE "readdirSync\(.*\)\s*\.(filter|find|map)" --include=*.js . | grep -v node_modules | head
./internal/dashboard-api.js:1651:  .filter(f => /^account_\d+\.json$/.test(f));
./routing/league-receiver.js:547:  .filter(f => f.endsWith('.json'))
./routing/rescue.js:277:  .filter((n) => /-modelmap\.json$/.test(n))
./routing/transparent-proxy.js:2148: .filter(f => f.endsWith('.json') && !f.endsWith('.meta.json'));
  …
```

`endsWith('.json')` и `/^account_\d+\.json$/` NFD не ломает: комбинирующие символы
появляются только там, где есть буквы с диакритикой, а тут их нет. **Не находка.**

### [COSMETIC] Кириллическое имя файла зашито в код двумя местами

- **Где:** `internal/devin-manager.js:64`, `internal/menu.js:1048`
  ```js
  const instrFile = path.join(itemPath, 'Инструкция_входа.txt');
  if (fs.existsSync(instrFile)) { … }
  ```
- **Что происходит на маке:** на APFS по умолчанию (case-insensitive) поиск ещё и
  **normalization-insensitive** — `existsSync` найдёт файл, даже если на диске он лежит
  в NFD, а литерал в исходнике в NFC. На **case-sensitive** томе APFS сравнение
  побайтовое, и NFD-файл (например, распакованный из архива, собранного на старом
  HFS+) не найдётся: `existsSync` вернёт `false`, email из инструкции молча не
  прочитается, поле останется пустым.
- **Почему:** имя сравнивается сырой строкой, без `.normalize('NFC')`. Литерал в
  исходнике — NFC (git хранит содержимое как записали, а редактор на Windows пишет NFC).
- **Фикс:** в обоих местах искать через `readdirSync` с нормализацией:
  ```js
  const want = 'Инструкция_входа.txt'.normalize('NFC');
  const hit = fs.readdirSync(itemPath).find(n => n.normalize('NFC') === want);
  ```
- **Уверенность:** PLAUSIBLE — путь `ready_to_sell/` целиком в `.gitignore`, на мак
  через git не приезжает, и сценарий требует case-sensitive тома. Пишу как известный
  острый угол, а не как живую поломку.
- **Доказательство:**
  ```
  $ grep -rn "Инструкция_входа" --include=*.js . | grep -v node_modules
  ./internal/devin-manager.js:64:    const instrFile = path.join(itemPath, 'Инструкция_входа.txt');
  ./internal/menu.js:1048:    const instrFile = path.join(itemPath, 'Инструкция_входа.txt');
  ```

### Вердикт раздела В

**Практически чисто.** Не-ASCII имён в git нет вовсе, поэтому главный мак-специфичный
риск (NFD-churn при клоне) исключён конструктивно. Одна COSMETIC-запись про
захардкоженное кириллическое имя в ignored-ветке кода.

---

## Г. Переводы строк

### Что в индексе (то, что получит мак)

```
$ git ls-files --eol | awk '{print $1, $2, $3}' | sort | uniq -c | sort -rn
    245 i/lf w/lf attr/text
     59 i/lf w/crlf attr/text
     37 i/lf w/lf attr/
     31 i/-text w/-text attr/
      8 i/lf w/crlf attr/
      3 i/none w/none attr/
      3 i/lf w/mixed attr/text
      1 i/-text w/-text attr/text
      1 i/none w/none attr/text
      1 i/lf w/mixed attr/

$ git ls-files --eol | grep -c 'i/crlf'
0
```

**Ни одного файла с CRLF в индексе.** Всё текстовое лежит в LF. Это главный результат
раздела: `git clone` на маке отдаёт LF независимо от того, что творится в рабочей копии
Windows (59 файлов там раздуты до CRLF автоматикой `core.autocrlf=true`).

### Unix-скрипты: и в индексе, и в рабочей копии LF

```
$ git ls-files --eol | grep -E '\.(sh|command)$|mac-support/shims/'
i/lf    w/lf    attr/text eol=lf      	DASHBOARD.command
i/lf    w/lf    attr/text eol=lf      	HUB.command
i/lf    w/lf    attr/text eol=lf      	install-deps.sh
i/lf    w/lf    attr/text eol=lf      	install-lib.sh
i/lf    w/lf    attr/text eol=lf      	install-mac.sh
i/lf    w/lf    attr/text eol=lf      	install.sh
i/lf    w/lf    attr/text eol=lf      	mac-support/shims/clip.exe
i/lf    w/lf    attr/text eol=lf      	mac-support/shims/curl.exe
i/lf    w/lf    attr/text eol=lf      	mac-support/shims/netstat
i/lf    w/lf    attr/text eol=lf      	mac-support/shims/python
i/lf    w/lf    attr/text eol=lf      	mac-support/shims/python.exe
i/lf    w/lf    attr/text eol=lf      	mac-support/shims/taskkill
i/lf    w/lf    attr/text eol=lf      	routing/ctx-probe.sh
i/lf    w/lf    attr/text eol=lf      	routing/restart-dashboard.sh
i/lf    w/lf    attr/text eol=lf      	routing/statusline-autoreger.sh
i/lf    w/lf    attr/text eol=lf      	routing/statusline-shim.sh
i/lf    w/lf    attr/text eol=lf      	routing/stop-dashboard.sh
i/lf    w/lf    attr/text eol=lf      	routing/vision_stats.sh
i/lf    w/lf    attr/text eol=lf      	tools/clean-camoufox-profiles.sh
i/lf    w/lf    attr/text eol=lf      	tools/doctor.sh
i/lf    w/lf    attr/text eol=lf      	tools/share.sh
```

21 из 21 — `eol=lf` явным атрибутом. `.gitattributes` тут работает правильно и, что важнее,
**переживает мак-клон с дурным `core.autocrlf=true`**: атрибут `eol=lf` перебивает
`core.autocrlf`, поэтому даже пользователь, скопировавший себе виндовый совет
`git config --global core.autocrlf true`, получит `.sh` в LF.

### Байтовая проверка шебангов (MSYS-grep не доверяем)

```
$ git ls-files -z | while IFS= read -r -d '' f; do [ -f "$f" ] || continue;
    if head -c2 "$f" | grep -q '#!'; then
      firstline=$(head -c 200 "$f" | od -An -tx1 -v | tr -d ' \n' | sed 's/0a.*//');
      case "$firstline" in *0d) echo "CR-in-shebang: $f";; esac; fi; done
CR-in-shebang: internal/export-cookies.js
CR-in-shebang: internal/export-for-mac.js
CR-in-shebang: tools/check-after-restart.js
CR-in-shebang: tools/check-hub.js
CR-in-shebang: tools/check-kktoken.js
CR-in-shebang: tools/check-league-chat.js
CR-in-shebang: tools/check-ref-codes.js
CR-in-shebang: tools/git-pull-safe.js
```

Восемь `.js` c CR после шебанга — **только в рабочей копии Windows** (`attr/text` +
`core.autocrlf=true`), в индексе они `i/lf`. Плюс ни один из них не запускается как
`./file.js`:

```
$ grep -rnE '(^|[^a-zA-Z0-9_/.])\./(tools|routing|internal)/[a-zA-Z0-9_-]+\.(js|py)' \
    --include=*.sh --include=*.command --include=*.md --include=*.js .
(пусто)
```

Вердикт: **не находка**. Ни один `.sh`, `.command` или shim CR в шебанге не имеет — ни на
диске, ни в индексе.

### Смешанные переводы строк в рабочей копии

```
$ git ls-files --eol | grep 'w/mixed'
i/lf    w/mixed attr/                 	.gitignore
i/lf    w/mixed attr/text             	internal/hub-balance.js
i/lf    w/mixed attr/text eol=crlf    	routing/keepalive-restart.ps1
i/lf    w/mixed attr/text             	routing/tokenrouter/omniroute-api-client.js
```

В индексе все четыре — `i/lf`, значит на мак приедут чистым LF. Косметика Windows-копии.

### [COSMETIC] `.gitattributes` не покрывает Unix-скрипты без расширения и `.py`

- **Где:** `.githooks/pre-push` (`#!/bin/sh`), `tools/tg-open.py` (`#!/usr/bin/env python3`)
- **Что происходит на маке:** при дефолтной конфигурации git (`core.autocrlf=false`) —
  ничего, файлы приезжают LF. Ломается только если у пользователя мака выставлен
  `core.autocrlf=true` глобально: тогда эти два файла станут CRLF, а `.sh` — нет
  (их защищает явный `eol=lf`).
- **Почему:** в `.gitattributes` нет ни базовой строки `* text=auto`, ни правил на
  `.py`/extensionless. `mac-support/shims/*` покрыт отдельной строкой — то есть про
  проблему знали, но закрыли только один каталог.
- **Фикс:** добавить в `.gitattributes`
  `.githooks/* text eol=lf` и `*.py text eol=lf` (либо базовую строку `* text=auto`).
- **Уверенность:** CONFIRMED (по `git check-attr`), сценарий поломки — PLAUSIBLE
  (нужен нестандартный конфиг у пользователя мака).
- **Доказательство:**
  ```
  $ git check-attr text eol -- .githooks/pre-push tools/tg-open.py mac-support/shims/python
  .githooks/pre-push: text: unspecified
  .githooks/pre-push: eol: unspecified
  tools/tg-open.py: text: unspecified
  tools/tg-open.py: eol: unspecified
  mac-support/shims/python: text: set
  mac-support/shims/python: eol: lf
  ```

### Проверено и опровергнуто: генератор мак-бандла и CRLF

`internal/export-for-mac.js` на 100% CRLF в рабочей копии и порождает мак-скрипты
шаблонными литералами:

```
$ python -c "d=open(r'internal/export-for-mac.js','rb').read(); print('CRLF:', d.count(b'\r\n'), 'lone LF:', d.count(b'\n')-d.count(b'\r\n'))"
CRLF: 408 lone LF: 0

$ sed -n '113,116p' internal/export-for-mac.js
    const setupScript = `#!/bin/bash
# Первый запуск - снимает блокировку и создаёт ярлык
cd "$(dirname "$0")"
```

Выглядит как гарантированный `bad interpreter: /bin/bash^M` на маке —
`fs.writeFileSync(setupPath, setupScript)` без нормализации. **Но это не так.**
ECMAScript нормализует `<CR><LF>` внутри шаблонного литерала в `<LF>` (TRV
LineTerminatorSequence). Проверено живьём:

```
$ # исходник tl.js записан в CRLF: 'const s = `#!/bin/bash\r\nline2\r\n`;'
$ node tl.js
"#!/bin/bash\nline2\n"
$ node -v
v24.16.0
```

Значит `SETUP_CLICK.command`, встроенный в него heredoc `RUN.command` и
`restore_session.py` выходят из генератора с LF даже при CRLF-исходнике. **Чисто.**

`internal/build-release.js` (тоже CRLF) собирает самораспаковывающийся `.bat` и явно
приводит вывод к CRLF (`bat.replace(/\r?\n/g, '\r\n')`, строка 330) — артефакт
Windows-only, мака не касается.

### Вердикт раздела Г

Переводы строк **чисты для мака**. Единственная запись — COSMETIC-пробел в
`.gitattributes`. Схема «`eol=lf` явным атрибутом на все Unix-скрипты» здесь сделана
правильно и защищает даже от кривого конфига на принимающей стороне.

---

## Д. BOM

### Проверка 1 — по всему дереву (1624 текстовых файла)

```
$ python - <<'PY'   # первые три байта == EF BB BF
  SKIP_DIRS = node_modules .git graphify-out logs manual_sessions accounts sessions
              .venv tg-venv __pycache__ .cache .playwright-mcp ready_to_sell vendor
  EXT = .ps1 .bat .cmd .sh .command .js .mjs .cjs .json .md .py .txt .html .css .yml .yaml .ts
        + всё в */shims/* + pre-push
PY
scanned files: 1624

=== FILES WITH BOM (7) ===
  ./routing/.rescue/GOOD/routing/transparent-proxy.js
  ./routing/.rescue/after-rename/routing/transparent-proxy.js
  ./routing/.rescue/after-resets-probe/routing/transparent-proxy.js
  ./routing/.rescue/before-timeout-knob/routing/transparent-proxy.js
  ./routing/.rescue/handoff-corrections/routing/transparent-proxy.js
  ./routing/tokenrouter/omniroute-api-client.js
  ./routing/transparent-proxy.js

=== .ps1 WITHOUT BOM (6) ===
  ./install.ps1
  ./routing/cleanup-reg-procs.ps1
  ./routing/keepalive-restart.ps1
  ./routing/update-omniroute.ps1
  ./tools/fix-paths-after-move.ps1
  ./tools/make-hub-shortcut.ps1
```

Пять из семи BOM-файлов — снапшоты в `routing/.rescue/`, а он в `.gitignore`:

```
$ git check-ignore -v routing/.rescue
.gitignore:402:routing/.rescue/	routing/.rescue
```

### Проверка 2 — только tracked-файлы (это и есть то, что приедет на мак)

```
$ python - <<'PY'  # git ls-files -z → первые 3 байта на диске + первые 3 байта блоба из индекса
PY
tracked files checked: 389
=== TRACKED WITH BOM (2) ===
  routing/tokenrouter/omniroute-api-client.js | BOM in index: True
  routing/transparent-proxy.js | BOM in index: True
```

BOM у обоих **закоммичен**, не наведён локальной правкой:

```
$ git show HEAD:routing/transparent-proxy.js | head -c 3 | od -An -tx1
 ef bb bf
```

### Проверка 3 — опасные расширения по отдельности: ни одного BOM

```
$ python - <<'PY'   # git ls-files по маске → первые 3 байта
PY
*.json                   checked=31   BOM=NONE
*.sh                     checked=13   BOM=NONE
*.command                checked=2    BOM=NONE
*.bat                    checked=7    BOM=NONE
*.cmd                    checked=1    BOM=NONE
*.md                     checked=35   BOM=NONE
*.py                     checked=24   BOM=NONE
*.html                   checked=4    BOM=NONE
*.css                    checked=1    BOM=NONE
mac-support/shims/*      checked=6    BOM=NONE
```

**Главный мак-риск закрыт:** ни один `.sh`, `.command` и ни один shim BOM не несёт, значит
`bad interpreter` из-за BOM перед шебангом невозможен. Ни один `.json` не несёт BOM,
значит `JSON.parse` от него не упадёт.

### [COSMETIC] BOM закоммичен в двух `.js`, включая ядро дашборда

- **Где:** `routing/transparent-proxy.js` (главный сервер `:8200`),
  `routing/tokenrouter/omniroute-api-client.js`
- **Что происходит на маке:** ничего. Node срезает BOM сам —
  `Module._extensions['.js']` вызывает `stripBOM()` и для CommonJS, и для ESM.
  Шебанга у файла нет (после BOM идёт `// Switcher panel for Claude Code's s…`),
  поэтому и `bad interpreter` неоткуда взяться; запускается он всё равно как
  `node transparent-proxy.js`.
- **Почему:** файл когда-то сохранили редактором, дописавшим BOM, и так закоммитили.
  Поведение при этом **одинаково на Windows и на маке** — это не мак-регрессия, а грязь.
- **Побочный эффект (OS-независимый, чужая зона):** девять `tools/check-*.js` читают этот
  файл как текст (`readFileSync(..., 'utf8')`), а Node при `utf8`-чтении BOM **не** срезает —
  строка начинается с `﻿`. Регексы без якоря `^` на нулевой позиции это не задевает,
  но любой будущий `/^\/\/ Switcher/` (без флага `m`) молча не сматчится.
- **Фикс:** `python -c "p='routing/transparent-proxy.js'; d=open(p,'rb').read(); open(p,'wb').write(d[3:])"`
  (то же для `omniroute-api-client.js`), затем коммит.
- **Уверенность:** CONFIRMED (BOM есть и в HEAD, и в индексе), но безвредность на маке —
  тоже CONFIRMED.
- **Доказательство:**
  ```
  $ head -c 40 routing/transparent-proxy.js | od -An -tx1 -c | head -2
    ef  bb  bf  2f  2f  20  53  77  69  74  63  68  65  72  20  70
   357 273 277   /   /       S   w   i   t   c   h   e   r       p
  ```

### `.ps1` без BOM — разбор всех шести, находка одна

| Файл | non-ASCII строк | Как запускается | Вердикт |
|---|---|---|---|
| `install.ps1` | 37 | `irm <url> \| iex` | **не находка, так и надо** |
| `routing/update-omniroute.ps1` | 12 | `#!/usr/bin/env pwsh` | не находка (pwsh читает UTF-8 без BOM) |
| `routing/cleanup-reg-procs.ps1` | 1 | `powershell -File` (PS 5.1) | COSMETIC, ниже |
| `routing/keepalive-restart.ps1` | 0 | — | не находка (чистый ASCII) |
| `tools/fix-paths-after-move.ps1` | 0 | — | не находка (чистый ASCII) |
| `tools/make-hub-shortcut.ps1` | 0 | — | не находка (чистый ASCII) |

`install.ps1` — известное исключение проекта, зафиксированное в `CLAUDE.md`:
`Invoke-RestMethod` BOM не срезает, U+FEFF склеился бы с первой командой и установка
упала бы с «Термин "?…" не распознан». Проверено, что он именно без BOM:

```
$ head -c 16 install.ps1 | od -An -tx1 -c | head -2
  23  20  e2  94  80  e2  94  80  e2  94  80  e2  94  80  e2  94
   #     342 224 200 342 224 200 342 224 200 342 224 200 342 224
$ grep -cP '[^\x00-\x7F]' install.ps1
37
```

Первые байты — `# ────` (U+2500), не BOM. Три ASCII-скрипта тоже не нарушители: по
правилу проекта «надёжный выход — держать `.ps1` в ASCII, тогда кодировка не важна».

### [COSMETIC] `cleanup-reg-procs.ps1`: одно тире вне ASCII при отсутствии BOM

- **Где:** `routing/cleanup-reg-procs.ps1`, строка 1
- **Что происходит:** к маку отношения не имеет — скрипт Windows-only (убивает
  `chrome`/`camoufox`). PowerShell 5.1 без BOM прочитает файл как ANSI (Windows-1251),
  и `—` (U+2014, байты `e2 80 94`) превратится в три мусорных символа. Это **комментарий**,
  синтаксис не ломается.
- **Почему:** файл писали как ASCII-скрипт, но одно длинное тире просочилось в шапку.
- **Фикс:** заменить `—` на `-` (дешевле, чем добавлять BOM и тянуть его дальше).
- **Уверенность:** CONFIRMED
- **Доказательство:**
  ```
  $ grep -nP '[^\x00-\x7F]' routing/cleanup-reg-procs.ps1
  1:# cleanup-reg-procs.ps1 — kill orphaned browser zombies left by autoregers / LK sessions.
  ```

### Вердикт раздела Д

**Для мака — чисто.** Ни одного `.sh`, `.command`, shim-а или `.json` с BOM. Две
COSMETIC-записи: закоммиченный BOM в двух `.js` (Node его срезает, вреда нет ни на одной
ОС) и одно тире в Windows-скрипте.

---

## Е. Права и симлинки

### Симлинков в репозитории нет

```
$ git ls-files -s | awk '{print $1}' | sort | uniq -c
    368 100644
     21 100755

$ git ls-files -s | awk '$1=="120000"'
(пусто)
```

Ни одного режима `120000`. Классическая виндовая порча («симлинк превратился в текстовый
файл с путём внутри») здесь невозможна — симлинков не было изначально. `core.symlinks=false`
и в системном, и в локальном конфиге, но чинить нечего.

### Исполняемый бит: 21 файл, и он корректен

```
$ git ls-files -s -- '*.sh' '*.command' 'mac-support/shims/*' | awk '$1!="100755"'
100644 243db21eaecf480fff24911a97057a908f128e5b 0	install-lib.sh
```

Единственный `.sh` без бита — `install-lib.sh`, и он **не запускается, а подключается**:

```
$ grep -rn "install-lib.sh" --include=*.sh .
./install-deps.sh:20:. ./install-lib.sh
./install.sh:27:. ./install-lib.sh
./install-mac.sh:27:# Свой ask() из install-lib.sh тут не берём: …
```

`. ./install-lib.sh` исполняемого бита не требует. **Не находка.**

Остальные 20 — все `.sh`, `.command` и все шесть shim-ов — `100755`. Плюс
`install-mac.sh` дополнительно страхуется:

```
$ sed -n '84,91p' install-mac.sh
  chmod +x "$DEST/install-mac.sh" 2>/dev/null
  # Права на файлы git с Windows не хранит (всё приезжает как 100644), а на маке мы
  # их доставляем сами — chmod'ом здесь и в restart-dashboard.sh для shim-ов. …
  git -C "$DEST" config core.fileMode false 2>/dev/null
```

⚠️ Комментарий в установщике **фактически неверен**: git с Windows бит `100755` хранит
и отдаёт (см. вывод выше — 21 файл), просто на Windows его нельзя выставить обычным
`chmod`. Ошибка безобидная — `chmod +x` идемпотентен, а `core.fileMode=false` полезен
сам по себе.

### [DEGRADED] pre-push хук на маке не запустится: нет исполняемого бита

- **Где:** `.githooks/pre-push` (режим в индексе `100644`)
- **Что происходит на маке:** после `git config core.hooksPath .githooks` (ручной шаг,
  предписанный `ARCHITECTURE.md:528`) git при `git push` напечатает
  `hint: The '.githooks/pre-push' hook was ignored because it's not set as executable`
  и **молча пропустит проверку**. На Windows бит игнорируется, поэтому хук там работает —
  расхождение заметят только на маке, и то в виде hint'а, который легко проскроллить.
- **Почему:** хуку никогда не выставляли бит в индексе. На Windows это не мешает: git
  для Windows не проверяет права на хуках. На Unix — проверяет.
- **Фикс:** `git update-index --chmod=+x .githooks/pre-push && git commit -m "chmod +x pre-push"`
- **Уверенность:** CONFIRMED
- **Доказательство:**
  ```
  $ git ls-files -s .githooks/pre-push
  100644 … 0	.githooks/pre-push
  $ git config core.hooksPath
  .githooks
  $ head -1 .githooks/pre-push
  #!/bin/sh
  ```

### `.js` без исполняемого бита — не проблема

59 файлов с шебангом `#!/usr/bin/env node` лежат как `100644` (`hub.js`, все
`tools/check-*.js`, `routing/league-receiver.js` и т.д.). Прямых вызовов `./file.js`
в репозитории нет (проверка в разделе Г), все запускаются как `node file.js` — шебанг там
декоративный. Исключение `tools/relocate.js` — единственный `.js` с битом `100755`,
что тоже безвредно.

### Длина путей и глубина

```
$ git ls-files | awk '{print length($0)"\t"$0}' | sort -rn | head -3
49	routing/vendor/fonts/GeistMono-600-cyrillic.woff2
49	routing/vendor/fonts/GeistMono-500-cyrillic.woff2
49	routing/vendor/fonts/GeistMono-400-cyrillic.woff2

$ git ls-files | awk -F/ '{print NF}' | sort -rn | head -1
4
```

Максимум 49 символов на путь при лимите macOS ~1024 и 4 уровня вложенности —
лимитов не достигает ни один файл. Подробности в разделе Б.

---

## Итог

| Градация | Кол-во | Что именно |
|---|---:|---|
| **BLOCKER** | 0 | — |
| **BROKEN** | 0 | — |
| **DEGRADED** | 1 | `.githooks/pre-push` без exec-бита → на маке хук молча пропускается |
| **COSMETIC** | 5 | BOM в `transparent-proxy.js` и `omniroute-api-client.js`; кириллическое имя файла в `devin-manager.js`/`menu.js`; пробел в `.gitattributes` (extensionless + `.py`); тире вне ASCII в `cleanup-reg-procs.ps1`; опечатка пути в `svrtr/test_auth.js` |

### По темам

| Тема | Вердикт |
|---|---|
| **А. Регистр имён** | чисто: 0 расхождений на 220 модулях и 1263 файлах со строковыми путями |
| **Б. Запрещённые имена** | чисто: ни `nul`/`con`/`com1`, ни `:*?"<>\|`, ни хвостовых точек; пути ≤49 символов |
| **В. Unicode-нормализация** | чисто: **ноль** не-ASCII имён в git, NFD-churn конструктивно невозможен |
| **Г. Переводы строк** | чисто: **ноль** файлов с CRLF в индексе, все 21 Unix-скрипт с явным `eol=lf` |
| **Д. BOM** | чисто для мака: ни одного `.sh`/`.command`/shim/`.json` с BOM |
| **Е. Права и симлинки** | почти чисто: 20 из 21 Unix-скрипта с `100755`, симлинков нет вовсе |

### Главное

**Физический слой — файловая система и кодировки — мак-совместим; ни одной блокирующей
или ломающей находки нет.** Это не везение: `.gitattributes` в этом репозитории закрывает
именно те случаи, которые обычно и убивают перенос на Unix (`eol=lf` явным атрибутом на
все `.sh`, `.command` и шимы — он перебивает `core.autocrlf` даже если тот выставлен в
`true` на принимающей стороне), а exec-биты в индексе проставлены. Единственное реальное
последствие для мака — молча не запускающийся pre-push хук.

### Три вещи, которые проверены и оказались НЕ багами

Пишу отдельно, чтобы никто не «чинил» их повторно:

1. **`export-for-mac.js` (100% CRLF) не порождает CRLF-скрипты для мака.** ECMAScript
   нормализует `<CR><LF>` внутри шаблонного литерала в `<LF>` — проверено на Node v24.16.0.
2. **`install-lib.sh` без exec-бита — так и надо**, он подключается через `. ./install-lib.sh`.
3. **`install.ps1` без BOM — так и надо**, он ставится через `irm | iex`, где BOM ломает
   установку.

### Оговорки о полноте

- Мака под рукой нет: всё, что помечено CONFIRMED, подтверждено байтами/командами на
  Windows и правилами git/Node/ECMAScript; поведение самой APFS (нормализация имён на
  case-sensitive томе) помечено PLAUSIBLE.
- Проверялись **статические** пути. Пути, собранные в рантайме из переменных, скриптом
  не покрываются — но регистр для них берётся с самой ФС, а не из кода.
- Исключены из сканирования: `node_modules/`, `.git/`, `graphify-out/`, `logs/`,
  `manual_sessions/`, `*/accounts/`, `*/sessions/`, `tools/tg-venv/`, `routing/.rescue/`,
  `ready_to_sell/`, `.cache/`, `.playwright-mcp/`.
- Использованные одноразовые скрипты лежат вне репозитория:
  `C:\Users\WormAlien\AppData\Local\Temp\mac_audit_case.py`,
  `C:\Users\WormAlien\AppData\Local\Temp\mac_audit_strpaths.py`.

