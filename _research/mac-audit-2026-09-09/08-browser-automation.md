# 08 — Браузерная автоматизация: аудит мак-совместимости

**Агент:** №8 из 10
**Зона:** браузерная автоматизация сквозь весь репозиторий (Playwright / Camoufox / rebrowser, профили Chrome, снятие и расшифровка кук, синтез ввода, антидетект)
**Метод:** статический аудит по коду, мака под рукой нет
**Дата:** 2026-09-09

---

## План (карта поиска)

Стартовый грep по `*.js|*.mjs|*.cjs|*.ts` и `*.py` (без `node_modules`, без каталогов с личными данными):

```
executablePath|userDataDir|user_data_dir|chrome\.exe|msedge|playwright|puppeteer|
camoufox|chromium|launchPersistent|\.ahk|robotjs|DPAPI|CryptUnprotect|Safe Storage|saltysalt
```

Найденные кластеры, которые надо разобрать:

| # | Кластер | Файлы | Статус |
|---|---|---|---|
| 1 | Расшифровка кук Chrome (DPAPI vs Keychain) | `routing/lib/newapi-account.js`, `routing/lib/github-session.js`, `routing/gh-index-build.js`, `tools/mac-cookie-probe.js` | ✅ мак-ветка ЕСТЬ; 3 бага рядом |
| 2 | Хардкод путей к `chrome.exe` | `grok-launcher/launcher.py`, `routing/transparent-proxy.js`, `routing/tools/grok_probe*.py` | 🔴 BLOCKER |
| 3 | Профили Camoufox | `*/camoufox_*.py`, `ourtoken/`, `routing/tokenrouter/` | не ставится на маке |
| 4 | `launchPersistentContext` — 15+ модулей `open-session.js` / `share-session.js` | `agentrouter/ aipm/ github/ gorouter/ hcnsec/ justwoker/ seekai/ tabi/ truesota/ xpeach/` | ✅ переносимо (чистый Playwright) |
| 5 | Установка браузеров Playwright | `install-mac.sh`, `install.sh`, `internal/build-release.js`, `mac-support/` | ✅ ОК (Playwright ставится, arm64 нативный) |
| 6 | AutoHotkey / синтез ввода | `internal/dictation-fix.js`, `tools/clip-as-typing/`, `tools/check-hub.js` | ✅ закрыто `IS_WIN` |
| 7 | Антидетект: UA / fingerprint | `*/open-session.js`, camoufox-конфиги, `*/config.js` | 🟠 UA/platform рассинхрон |
| 8 | MCP-браузеры | `mcps/`, `.playwright-mcp/` | ✅ только схемы/артефакты, не код |
| 9 | `internal/export-cookies.js`, `internal/export-for-mac.js` | | ✅ переносимо (JSON + генерят Python) |

---

## Находки

### [BROKEN] Camoufox на мак вообще не ставится — установщик его сознательно пропускает

- **Где:** `install-deps.sh:128-138` (мак-ветка), `install-mac.sh:257-262` (комментарий «Camoufox-автореги там осознанно пропущены»)
- **Что происходит на маке:** ни `camoufox`, ни `playwright==1.60.0` (Python) не устанавливаются. Мак-ветка `install-deps.sh` ставит **только** ТГ-менеджер (venv `opentele`+`tgcrypto`) и `Telegram.app`. Windows-ветка (`install-deps.sh:226-235`) делает `pip install camoufox==0.4.11 requests playwright==1.60.0 && python -m camoufox fetch` — на маке этот блок недостижим.
- **Почему:** осознанное решение авторов, зафиксированное в комментарии: «пины (camoufox 0.4.11 + playwright 1.60.0) подобраны на Windows-машине, мак-колёса никто не проверял». То есть это не баг, а известная дыра — но в отчёте о мак-совместимости она главная по площади.
- **Что от этого мертво (весь Camoufox-слой авторегов):**

  | Модуль | Файл | Что делает |
  |---|---|---|
  | TokenRouter | `routing/tokenrouter/camoufox_autoreg.py` | автореги + `--open <email>` |
  | Ourtoken | `ourtoken/camoufox_autoreg.py` | автореги |
  | AnyModel | `anymodel/lib/camoufox_anymodel.py` (+ `recorder.py`, `recorder_bg.py`) | регистрация |
  | FreeModel | `freemodel/lib/camoufox_tmailor.py`, `camoufox_emailnator.py`, `camoufox_recorder.py` | одноразовая почта, обход Cloudflare Turnstile |
  | Grok | `grok-launcher/camoufox_device.py` | авторизация `accounts.x.ai` по кукам |

  Node-обёртки (`anymodel/lib/camoufox-anymodel-client.js`, `freemodel/lib/camoufox-tmailor-client.js`, `camoufox-emailnator-client.js`) спавнят Python и ждут строку готовности **60 с** (`camoufox-tmailor-client.js:83`, `camoufox-emailnator-client.js:70`), после чего кидают «camoufox python не стартовал за 60с». То есть на маке это не мгновенная ошибка «нет модуля», а минута тишины на каждую попытку.
- **Фикс:** проверить пины на маке и добавить в мак-ветку `install-deps.sh` тот же блок, что в Windows-ветке (`pip install camoufox==0.4.11 requests playwright==1.60.0 && python -m camoufox fetch`), плюс отдельно проверить arm64 (см. находку про arm64 ниже). До этого — в UI дашборда гасить кнопки Camoufox-авторегов на `process.platform === 'darwin'`, чтобы не выглядело как «нажал и ничего».
- **Уверенность:** CONFIRMED (мак-ветка установщика прочитана целиком, блока установки Camoufox в ней нет).

### [DEGRADED] `spawn('python', …)` — спасает только шим, и только у детей дашборда

- **Где:** `internal/dashboard-api.js:959`, `:960`, `:1191`, `:1195`; `internal/menu.js:2008`; `routing/transparent-proxy.js:1874`, `:20951`
- **Что происходит на маке:** имя интерпретатора захардкожено строкой `'python'`, а Apple выпилила `/usr/bin/python` в macOS 12.3 и Homebrew симлинк `python` не кладёт. Спасает шим `mac-support/shims/python` (`exec python3 "$@"`), который `routing/lifecycle.js:464-471` (`childEnv()`) подкладывает в начало `PATH` дочерних процессов, а `startService` (`:587`) применяет при спавне дашборда. Дальше PATH наследуется вниз, поэтому `spawn('python')` из `dashboard-api.js` и `transparent-proxy.js` резолвится.
- **Где не спасает:**
  - **Запуск мимо дашборда.** `HUB.command:19` выставляет `PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"` и шимы **не** добавляет; `install-mac.sh` в `~/.zprofile` пишет только `~/.npm-global/bin`. То есть `node internal/menu.js` из обычного терминала, как и любой ручной запуск скрипта по документации, упрётся в `ENOENT`.
  - **Диагностика.** `internal/dashboard-api.js:983` — не-Windows ветка `launchScript` это `spawn(exe, args, { detached: true, stdio: 'ignore' })`. На Windows скрипт открывается в видимом окне `cmd /k` (`:979`), на маке уходит в фон с выброшенными stdout/stderr. `ENOENT` при этом не увидит никто: кнопка нажата, `{ok:true}` вернулся, ничего не произошло.
- **Фикс:** (1) `HUB.command` — дописать `export PATH="$(dirname "$0")/mac-support/shims:$PATH"` (или, чище, в самом коде `process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')`); (2) не глушить stdio в POSIX-ветке `launchScript` — лить в `logs/`, как это уже делает `lifecycle.startService`.
- **Уверенность:** CONFIRMED для механики шима и для отсутствия шимов в `HUB.command` (оба файла прочитаны).

### [BLOCKER] Пути к Chrome захардкожены под Windows — Grok-сессии на маке не поднимаются

- **Где:** `routing/transparent-proxy.js:2266-2278` (`grokFindChrome`), `grok-launcher/launcher.py:37-47` (`find_chrome`), плюс однострочники в пробниках `routing/tools/grok_probe.py:17-19`, `grok_probe2.py:12`, `grok_probe3.py:13`, `grok_probe_usage.py:11`, `quota_debug.py:8`
- **Что происходит на маке:** список кандидатов — четыре пути вида `C:\Program Files\Google\Chrome\Application\chrome.exe` (+ `%LOCALAPPDATA%`, + Brave). Ни один не существует, `grokFindChrome()` возвращает `null`, ручка `POST /__switch/api/grok/launch-chrome` отвечает `{ok:false, error:'Chrome not found'}`, а `launcher.py:_spawn_chrome_direct` кидает `RuntimeError("Chrome not found")`. Обе половины схемы (node-спавн и python-фолбэк) упираются в одно и то же.
- **Почему:** на маке Chrome лежит в бандле: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` (или `~/Applications/…`), Brave — `/Applications/Brave Browser.app/Contents/MacOS/Brave Browser`. Ни один из этих путей в коде не упомянут ни разу (грep по репозиторию: 0 совпадений на `.app/Contents/MacOS`).
- **Дополнительно:** `_spawn_chrome_direct` (`launcher.py:110-120`) передаёт в `subprocess.Popen` **виндовые флаги** `creationflags=DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`. На POSIX `creationflags` ≠ 0 — это `ValueError: creationflags is only supported on Windows platforms`. То есть даже если путь к Chrome починить, прямой спавн упадёт вторым слоем; на POSIX нужен `start_new_session=True`.
- **Фикс:**
  ```js
  // routing/transparent-proxy.js — grokFindChrome()
  const candidates = process.platform === 'darwin' ? [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ] : [ /* нынешний виндовый список */ ];
  ```
  То же в `launcher.py:find_chrome`, и там же развести флаги спавна:
  `**({'creationflags': DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP} if os.name == 'nt' else {'start_new_session': True})`.
- **Уверенность:** CONFIRMED (списки кандидатов и вызов `Popen` прочитаны; `creationflags` на POSIX кидает `ValueError` — документированное поведение `subprocess`).

### [DEGRADED] `os="windows"` во ВСЕХ запусках Camoufox — на маке это ровно тот рассинхрон, от которого предостерегает сам Camoufox

- **Где (9 мест, ни одного исключения):** `freemodel/lib/camoufox_tmailor.py:686`, `freemodel/lib/camoufox_emailnator.py:385`, `freemodel/lib/camoufox_recorder.py:82`, `anymodel/lib/camoufox_anymodel.py:508`, `anymodel/recorder.py:112`, `anymodel/recorder_bg.py:217`, `ourtoken/camoufox_autoreg.py:596`, `routing/tokenrouter/camoufox_autoreg.py:750` и `:792`, `grok-launcher/camoufox_device.py:85`
- **Что происходит на маке:** Camoufox подставляет Windows-фингерпринт (UA `Windows NT 10.0`, `navigator.platform: Win32`, виндовые шрифты и метрики экрана), а под ним работает macOS-хост. Браузер запустится и внешне будет работать; ловят такое антибот-сервисы уровня Cloudflare Turnstile — а именно его эти скрипты и обходят (`camoufox_tmailor.py:172`, `:254`, `:272` — вся логика построена вокруг «Camoufox решает CF сам»).
- **Почему:** документация Camoufox, § Known Limitations (`docs/per-context-patches.md`), прямым текстом: *«Advanced fingerprinting services can detect mismatches between reported signals (like `navigator.platform` and User-Agent) and underlying OS characteristics, which is a strong bot indicator. It is recommended to run Camoufox on the OS that matches the fingerprint profile»*. Шрифты Camoufox бандлит под все три ОС (§ Anti font fingerprinting), так что дело не в них — течёт всё остальное, что живёт ниже JS: тайминги, WebGL/ANGLE-строки рендерера, аудио-стек.
- **Фикс:** не константа, а платформа хоста. Camoufox принимает `'windows' | 'macos' | 'linux'` (`pythonlib/camoufox/utils.py:check_valid_os`), поэтому достаточно одной общей функции:
  ```python
  # общий хелпер, например freemodel/lib/_cf.py
  import sys
  CF_OS = {"win32": "windows", "darwin": "macos"}.get(sys.platform, "linux")
  ```
  и `os=CF_OS` во всех девяти местах. По умолчанию Camoufox и так берёт ОС системы — то есть корректнее всего просто **убрать** аргумент `os=`.
- **Уверенность:** CONFIRMED (все девять строк прочитаны; ограничение процитировано из документации Camoufox через Context7).

### [DEGRADED] Окно Camoufox на маке никто не поднимает на передний план, а фоновая вкладка троттлится

- **Где:** `ourtoken/camoufox_autoreg.py:26-52` (`focus_browser_window`)
- **Что происходит на маке:** функция начинается с `if sys.platform != "win32": return` — то есть на маке это молчаливый no-op. Комментарий над ней объясняет, зачем она вообще есть: «Вывести окно Firefox/Camoufox на передний план (в фоне вкладка троттлится/крашится)». На маке этой страховки нет, и автореги ourtoken будут ловить ту самую фоновую деградацию, из-за которой функцию писали.
- **Почему:** реализация — чистый Win32 (`ctypes.windll.user32`, `EnumWindows`, `SetForegroundWindow`). Аналога в стандартной библиотеке на маке нет.
- **🔴 TCC-ловушка в фиксе:** очевидный мак-эквивалент — `osascript -e 'tell application "System Events" to set frontmost of process "camoufox" to true'` — требует разрешения **Privacy & Security → Automation** (а `System Events` тянет ещё и Accessibility). При первом вызове macOS показывает **модальный диалог согласия**, и до ответа `osascript` висит. У процесса, запущенного дашбордом в фоне (`spawn(..., {detached:true, stdio:'ignore'})`, `internal/dashboard-api.js:983`), этот диалог может уехать за окна или не показаться вовсе — тогда автореги встают насмерть без единой строки в логе. Такой фикс обязан идти с таймаутом и одноразовым «прогревом» разрешения при установке, а не втихую в рантайме.
- **Фикс:** платформенная ветка + `subprocess.run([...], timeout=5)` и глотание ошибки — падение фокуса не должно валить прогон. Проще и безопаснее: `page.bring_to_front()` средствами Playwright (Camoufox — это Playwright), это не трогает TCC вообще.
- **Уверенность:** CONFIRMED для no-op; PLAUSIBLE для масштаба ущерба от троттлинга (замеров на маке нет, оценка по комментарию авторов).

### ✅ НЕ находка: расшифровка кук на macOS уже реализована (и реализована правильно)

Главное ожидание брифа — «код написан под DPAPI, на маке не расшифрует ничего» — **не подтвердилось**. `routing/lib/newapi-account.js:415-615` содержит полноценную macOS-ветку OSCrypt, написанную по живым замерам 2026-08-20:

- `IS_MAC` (`:431`) разводит `decryptCookieValue` (`:582`) и `encryptCookieValue` (`:605`);
- macOS-схема реализована точно: PBKDF2-SHA1(`saltysalt`, **1003**, 16 байт) → `macKeyFromPassword` (`:469`), `'v10'` + AES-128-**CBC**, IV = 16 пробелов, ручной PKCS#7 → `macDecryptCookie` (`:445`);
- 32-байтный префикс SHA-256(host_key) у Chromium 130+ снимается той же эвристикой, что на Windows (`macStripPrefix`, `:440`);
- `warmAesKeys` (`:367`) на маке не пытается батчить PowerShell, а идёт своим путём (`:370-377`);
- ключ выбирается **проверкой по реальным данным** (`macProfileKey`, `:538`): кандидат считается рабочим, только если им расшифровалась хотя бы одна кука из профиля. Это закрывает главную ловушку CBC — без тега аутентичности неверный ключ отдаёт мусор, а не ошибку (`:456-458`).

Ключевой кандидат — константа `'mock_password'` (`:487`): Playwright запускает Chromium с `--use-mock-keychain`, и `MockAppleKeychain` отдаёт именно её. **Проверено на месте:** флаг присутствует в дефолтных свитчах установленного `playwright-core@1.60.0` (`node_modules/playwright-core/lib/coreBundle.js:33652`, рядом с `--password-store=basic`). То есть для профилей, поднятых нашими `open-session.js`, Keychain не понадобится вообще.

Есть и мак-пробник: `tools/mac-cookie-probe.js` (перебор паролей × итераций × шифров с печатью формы данных). Диагностика на маке предусмотрена.

### [DEGRADED] Keychain-фолбэк в проде и в пробнике спрашивают РАЗНОЕ — прод промахнётся там, где пробник найдёт

- **Где:** `routing/lib/newapi-account.js:497-501` против `tools/mac-cookie-probe.js:53-58` и `:71-73`
- **Что происходит на маке:** два расхождения в одном запросе к Keychain.
  1. **Флаг `-a`.** Прод: `['find-generic-password', '-w', '-s', svc, '-a', svc.split(' ')[0]]` — то есть `-a Chromium` / `-a Chrome`. Пробник ходит **без `-a`**, и его комментарий (`:51-52`) объясняет почему: *«account у Chrome for Testing отличается от имени сервиса, и фильтр по нему давал „нет записи“ там, где она есть»*. Пробник писался ПОСЛЕ прода и по итогам живого прогона — значит правильный он, а в проде остался промах.
  2. **Список сервисов.** Прод перебирает два (`'Chromium Safe Storage'`, `'Chrome Safe Storage'`), пробник — четыре, добавляя `'Chrome for Testing Safe Storage'` и `'Chrome Canary Safe Storage'`. На маке, где владелец пользуется Chrome for Testing (а именно на нём и делались замеры 20.08), прод запись не найдёт.
- **Почему это не заметили:** для профилей, поднятых Playwright, срабатывает дешёвый кандидат `'mock_password'`, и до Keychain дело не доходит. Ветка вылезет ровно тогда, когда профиль сделан НЕ нашим `open-session.js` — например, куки берутся из настоящего Chrome владельца.
- **Фикс:** привести прод к версии пробника — убрать `-a` и расширить список до четырёх сервисов:
  ```js
  for (const svc of ['Chrome for Testing Safe Storage', 'Chromium Safe Storage',
                     'Chrome Safe Storage', 'Chrome Canary Safe Storage']) {
      const pw = execFileSync('security', ['find-generic-password', '-w', '-s', svc], {…});
  ```
- **Уверенность:** CONFIRMED (оба вызова прочитаны построчно, расхождение буквальное).

### [BROKEN] Keychain-диалог блокирует событийный цикл дашборда — на маке это зависание всего `:8200`

- **Где:** `routing/transparent-proxy.js:7822-7843` (`newapiWarmProfileKeys`) → вызовы на `:8124` (внутри HTTP-обработчика чека баланса) и `:21049` (через 2.5 с после старта); дальше `routing/lib/newapi-account.js:370-377` → `:551` → `:545` → `:494-507`
- **Что происходит на маке:** `warmAesKeys` на маке **не батчится** — он в цикле зовёт `profileAesKey(dir)` для каждого профиля прямо в процессе дашборда. Если дешёвые кандидаты не подошли, дело доходит до `macKeychainCandidates()` → `execFileSync('security', 'find-generic-password', …)`. `execFileSync` **синхронный**: пока macOS показывает модальное окно «введите пароль для доступа к связке ключей», дашборд не отвечает ни на один запрос. Таймаут `15000` × два сервиса = до **30 секунд полной глухоты** `:8200`, и это при живом модальном окне, которое в фоновом (`detached`) процессе может не всплыть на передний план вообще.
- **Почему это тот же баг, от которого уже лечились на Windows:** весь `gh-index-build.js` вынесен в отдельный процесс именно ради этого (его шапка: *«он блокирует единственный поток Node… на живой машине такой вызов однажды не вернулся вообще: :8200 слушал, соединения копились в CLOSE_WAIT»*). Но `newapiWarmProfileKeys` в отдельный процесс **не вынесен** — на Windows это оправдано (один короткий батч PowerShell, ~1 с на 40 профилей), а на маке та же функция превращается в потенциально интерактивный вызов. Windows-обоснование в комментарии `:8118-8122` («здесь блокировка событийного цикла безопасна») на маке не действует.
- **Смягчающее обстоятельство:** `MAC_KEYCHAIN` мемоизирован (`:493`), поэтому попытка одна на процесс, а порядок кандидатов (дешёвые → Keychain, `:473-491`) в типовом сценарии до Keychain не доходит.
- **Фикс:** на маке не звать Keychain из процесса дашборда вообще. Либо (а) вынести подбор ключа в тот же отдельный процесс, что и `gh-index-build.js`; либо (б) в `macKeychainCandidates` добавить неинтерактивный режим — проверять `process.env.NAC_ALLOW_KEYCHAIN` и по умолчанию в дашборде пропускать Keychain, оставив его только `tools/mac-cookie-probe.js` и явной кнопке «подобрать ключ». Минимум — срезать таймаут с 15 с до 2-3 с.
- **Уверенность:** CONFIRMED для цепочки вызовов (прочитана целиком); PLAUSIBLE для «диалог реально всплывёт» — зависит от ACL конкретной записи Keychain, проверяется запуском `tools/mac-cookie-probe.js` на живом маке (он про это окно честно предупреждает, `:68`).

### [DEGRADED] На маке банка кук каждого профиля копируется дважды

- **Где:** `routing/lib/newapi-account.js:511-531` (`macSampleEncrypted`) и `:641-647` (`readProfileCookies`)
- **Что происходит на маке:** чтобы подобрать ключ, `macSampleEncrypted` копирует `Cookies` (+ `-wal`/`-shm`) во временный файл, открывает sqlite и берёт 6 записей. Затем `readProfileCookies` копирует **тот же файл ещё раз** для собственно чтения. На Windows первого копирования нет вовсе: ключ там достаётся из `Local State` одним чтением JSON.
- **Масштаб:** по комментарию `routing/lib/github-session.js:8` — 42 профиля, 1.87 ГБ. Копирование кешируется на процесс (`AES_KEY_CACHE`, `:552`), так что это разовая цена за запуск, а не за вызов.
- **Фикс:** держать в `AES_KEY_CACHE` не только ключ, но и снятый образец, либо читать образец из уже сделанной копии — `readProfileCookies` может передать свой `tmp` в подбор ключа.
- **Уверенность:** CONFIRMED (обе копии в коде).

### [DEGRADED] Windows-UA поверх мак-Chromium: `navigator.platform` останется `MacIntel` и выдаст расхождение

- **Где (Playwright-контексты, 11 мест):** `freemodel/create_email.js:143`, `create_first_session.js:103`, `freemodel_autoreger_v3.js:539`, `import_cookies.js:138`, `import_paste.js:182`, `login_and_save_session.js:41`, `restore_existing.js:104`, `restore_session.js:50`, `lib/tmailor.js:93`, `internal/freemodel-creator.js:227`, `ourtoken/ourtoken_autoreg.js:67`. Источник строки — `freemodel/config.js:27` и `anymodel/config.js:27`: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) … Chrome/131.0.0.0 …`
- **Что происходит на маке:** браузер — мак-сборка Chromium, а UA заявляет Windows. Разошлись ровно те три сигнала, которые антибот сверяет первым делом. Механику проверил по установленному `playwright-core@1.60.0`:
  - `navigator.userAgent` → **Windows** (перебит опцией `userAgent`);
  - `navigator.userAgentData.platform` / `Sec-CH-UA-Platform` → **Windows** тоже: `calculateUserAgentMetadata` (`node_modules/playwright-core/lib/coreBundle.js:35785-35826`) вытаскивает платформу **регуляркой из самой UA-строки** и отдаёт её в `Emulation.setUserAgentOverride`;
  - `navigator.platform` → **`MacIntel`**, настоящий. `_updateUserAgent` (`:36607-36613`) шлёт только `userAgent`, `acceptLanguage` и `userAgentMetadata` — **поле `platform` CDP-команды не передаётся вообще**, поэтому `navigator.platform` не перебивается ничем.
- **Почему это не видно сегодня:** на Windows все три сигнала совпадают, и баг невидим. Он существует ровно с момента запуска на маке.
- **Что течёт дополнительно:** `Sec-CH-UA-Arch` уедет в `"x86"` (`:35792` — дефолт метаданных, а ветка `arm` включается только для macOS/iOS/Android-UA), то есть на Apple Silicon мы заявим x86. Плюс `_setDefaultFontFamilies` (`:36615-36617`) берёт семейства шрифтов по **настоящей** платформе браузера — маковские шрифты под виндовым UA.
- **Фикс:** не подставлять чужую платформу. Либо убрать опцию `userAgent` совсем (тогда всё сходится само), либо строить строку от хоста:
  ```js
  // freemodel/config.js
  const UA_BY_PLATFORM = {
      win32:  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      darwin: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  };
  USER_AGENT: UA_BY_PLATFORM[process.platform] || UA_BY_PLATFORM.win32,
  ```
  (`Intel Mac OS X 10_15_7` — то, что настоящий Chrome пишет и на Apple Silicon; это не обман, а нормальная строка.)
- **Отдельно, но НЕ проблема:** тот же Windows-UA в чистых HTTP-вызовах — `routing/lib/newapi-account.js:139`, `routing/lib/truesota-account.js:31`, `helpcoder/lib/helpcoder-api.js:76`, почтовые библиотеки `freemodel/lib/{10minutemail,guerrillamail,instanttempemail,mailgw,mailtm}.js`. Там сверять UA не с чем: браузера в этом пути нет. Риск нулевой, трогать не надо. ⚠️ Исключение, которое авторы уже задокументировали: `routing/lib/github-session.js:330-346` — самодельный UA к `github.com` **погасил три живые сессии**, поэтому GitHub там теперь проверяется только настоящим браузером. Правило «к github.com сырым UA не ходить» на маке действует так же.
- **Уверенность:** CONFIRMED (механика прочитана в исходнике установленного playwright-core, номера строк указаны).

### ✅ НЕ находка: Playwright-браузеры и arm64

Отдельной работы не требуется, проверено по документации Playwright (Context7) и по коду установщика:

- **Кэш браузеров.** Playwright сам держит платформенные каталоги: `%USERPROFILE%\AppData\Local\ms-playwright` на Windows, `~/Library/Caches/ms-playwright` на macOS. `PLAYWRIGHT_BROWSERS_PATH` в репозитории **нигде не выставляется** (грep по `*.js|*.py|*.sh|*.ps1|*.bat|*.json`: единственные совпадения на `ms-playwright` — это regex-маркер в `routing/cleanup-reg-procs.ps1:17` для отстрела зомби-процессов, а он и так Windows-only).
- **Установка на маке есть.** `install-mac.sh:169-175` проверяет `require('playwright').chromium.executablePath()` и при отсутствии зовёт `npx playwright install chromium`.
- **Apple Silicon.** Playwright отдаёт нативные arm64-сборки (`mac-arm64/chrome-mac-arm64.zip`, реестр `packages/playwright-core/src/server/registry/index.ts`); нативная поддержка Apple Silicon есть с 1.7. Rosetta не нужна.
- **Диагностика на месте.** `hub.js:979` проверяет наличие пакета `playwright`, `routing/transparent-proxy.js:5603-5604` ловит «Executable doesn't exist» и печатает готовый рецепт `npx playwright install chromium`. Оба сообщения платформонезависимы.

Единственное «но» — у **Camoufox** сборки под arm64 существуют (`multibuild.py --target macos --arch arm64` в его README), но `python -m camoufox fetch` на маке в этом репозитории не выполняется никогда — см. первую находку.

### [BROKEN] `cookieDbLocked` на маке всегда `false` — исчезает вторая защита от сжигания сессии

- **Где:** `routing/lib/newapi-account.js:75-80`, потребитель — `routing/transparent-proxy.js:8101-8103` (`lkBusy`)
- **Что происходит на маке:** проверка сделана так:
  ```js
  try { fs.closeSync(fs.openSync(src, 'r')); return false; }
  catch (e) { return e && (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES'); }
  ```
  Это опора на **обязательную** блокировку файла, которой на POSIX нет: SQLite в Chromium использует advisory-локи `fcntl`, а они `open(…, 'r')` не запрещают. На маке `openSync` при открытом браузере пройдёт успешно → функция вернёт `false` **всегда**, независимо от того, открыт ЛК или нет.
- **Почему это больно:** `lkBusy` собран из **двух** признаков нарочно, и комментарий над ним (`:8096-8100`) объясняет, зачем второй: *«Одной карты pid'ов мало: она в памяти процесса, и рестарт дашборда её обнуляет — браузер, открытый ДО перезапуска, для неё не существует вовсе (проверено 29.08…). Вторым признаком берём файловый замок БД куки… этот признак не зависит ни от того, кто окно запустил, ни от нашего аптайма»*. На маке остаётся только первый признак — карта pid'ов в памяти. То есть сценарий 29.08 воспроизводится полностью: рестарт дашборда при открытом окне ЛК → `lkBusy === false` → идём читать живую банку кук и ходить прокрученной сессией. Ущерб из того же комментария (`:8091-8092`): «в панели 1752.52, в дашборде 1505.02 с бейджем „точный"», и отдельно — «чтобы не жечь сессию».
- **Вторая потеря:** `cookieFailReason` (`:98-101`) на маке никогда не выдаст честное «браузер этого аккаунта ОТКРЫТ… закрой окно ЛК», а провалится в `«в профиле нет куки для X — сессия не сохранилась, войди в ЛК заново»` — ровно тот совет, который авторы называют «советом, который делает хуже» (`:93-97`) и который стоил владельцу петли 24.08.
- **Тесты это не поймают:** `tools/check-lk-lock.js:36-40` проверяет только отрицательные случаи (`cookieDbLocked(...) === false` для профиля без БД и для свободного файла). На маке набор зеленеет полностью при полностью сломанной функции.
- **Фикс:** на маке спрашивать не файл, а процесс — у Chromium в `user-data-dir` лежит `SingletonLock` (симлинк на `<host>-<pid>`); живость определяется по pid из его цели:
  ```js
  function cookieDbLocked(profileDir) {
      if (process.platform !== 'win32') {
          try {
              const t = fs.readlinkSync(path.join(profileDir, 'SingletonLock'));  // 'host-12345'
              const pid = Number(String(t).split('-').pop());
              if (pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
          } catch {}
          return false;
      }
      /* нынешняя виндовая ветка */
  }
  ```
  И дописать в `tools/check-lk-lock.js` положительный случай под POSIX (создать симлинк `SingletonLock` на свой pid).
- **Уверенность:** CONFIRMED для «на маке вернётся false» (отсутствие mandatory locking на POSIX — свойство платформы, код прочитан); PLAUSIBLE для формата `SingletonLock` в конкретной сборке Playwright-Chromium — проверяется одной командой `ls -l <profile>/SingletonLock` на живом маке.

### [BROKEN] Две ручки Grok спавнят `cmd`/`powershell` вообще без платформенной развилки — отвечают `ok:true`, не делая ничего

- **Где:** `routing/transparent-proxy.js:2455` (`handleGrokLaunchTerminal`) и `:2482` (`handleGrokStartAuth`)
- **Что происходит на маке:** обе строки — `spawn('cmd', ['/c', 'start', '""', 'powershell', '-NoExit', '-Command', psCommand], …)`, а сама команда указывает на `$env:USERPROFILE\.grok\bin\grok.exe`. Ни одной проверки `process.platform` рядом нет (сравни с `internal/dashboard-api.js:977` и `:1190`, где развилка есть). `spawn` на POSIX даст `ENOENT`.
- **Почему это тихо:** ошибка `spawn` приходит **асинхронным событием `'error'`**, а не исключением, поэтому `try/catch` вокруг неё бесполезен — обработчик уже успел ответить `jsonRes(res, 200, { ok: true, pid: child.pid, … })`. Листенера `'error'` на `child` нет (в отличие от `handleGrokLaunchChrome`, `:2305`, где он есть). Процесс при этом не падает — ловит глобальный `process.on('uncaughtException')` (`:21016`), который только пишет строку в консоль. Итог: кнопка отвечает «готово», окна нет, `pid` — `undefined`, причина лежит в логе прокси и никем не связана с кликом.
- **Фикс:** платформенная ветка. На маке эквивалент `cmd /c start` — `osascript -e 'tell application "Terminal" to do script "…"'`, а `grok.exe` заменяется на `~/.grok/bin/grok`. Плюс независимо от платформы повесить `child.on('error', …)` и отвечать честной ошибкой, а не `ok:true`.
- **Уверенность:** CONFIRMED (обе строки и отсутствие развилки/листенера проверены; глобальный `uncaughtException` найден на `:21016`).

### [DEGRADED] `curl.exe` в коде почты — тот же шим и та же дыра, что у `python`

- **Где:** `freemodel/lib/10minutemail.js:51` (`spawn('curl.exe', args, { windowsHide: true })`), `routing/tokenrouter/camoufox_autoreg.py:156`
- **Что происходит на маке:** спасает `mac-support/shims/curl.exe` (`exec curl "$@"`), но ровно на тех же условиях, что шим `python`: только у детей дашборда, где `PATH` подложил `childEnv()`. Из обычного терминала (`node freemodel/…` — а это разрешено прямо в `.claude/settings.json`: `"allow": ["Bash(node freemodel/*)"]`) шим не виден, и будет `ENOENT`. Комментарий самого файла (`:12`) честно пишет требование: «Зависимости: Node >= 18, curl.exe в PATH».
- **Фикс:** тот же, что для `python` — либо шимы в `HUB.command`/`~/.zprofile`, либо `const CURL = process.platform === 'win32' ? 'curl.exe' : 'curl'`.
- **Уверенность:** CONFIRMED.

### [COSMETIC] Мелочи, которые на маке просто работают хуже

- **`--start-maximized` не действует на macOS.** `internal/dashboard-api.js:583` — `chromium.launch({ headless: false, args: ['--start-maximized'] })` вместе с `viewport: null` (`:584`). Флаг реализован для Windows/Linux; на маке окно откроется дефолтного размера. Мак-эквивалент — задавать `--window-size=W,H` или ставить `viewport` явно.
- **`page.bringToFront()` на маке не поднимает окно над чужими приложениями.** `internal/dashboard-api.js:576` — дедуп «Открыть в Chrome» фокусирует существующее окно. На macOS вкладка станет активной, но само приложение поверх других система вывести не даст, пока оно не активное; для этого нужен `osascript`/`open -a`, а это снова TCC. Проявится как «нажал, ничего не всплыло».
- **Свипера зомби-браузеров на маке нет.** `routing/cleanup-reg-procs.ps1` — PowerShell, отстреливает осиротевшие `chrome`/`camoufox` по маркеру в CommandLine (`:17`). Мак-аналога (`pgrep -f` + `kill`) в репозитории нет. Смягчает то, что скрипт с 24.08 и на Windows автоматически не вызывается ниоткуда (ARCHITECTURE.md:302).
- **`routing/tokenrouter/rebrowser/` — мёртвый код на обеих платформах.** `autoreg.js:5` требует `rebrowser-playwright`, которого нет ни в `package.json`, ни в `node_modules`. Инструкция запуска в шапке (`:3`) прибита к виндовому пути `$env:TEMP\node20\node-v20.19.0-win-x64\node.exe`. Чинить под мак нечего — это кандидат на удаление, а не на портирование.

### ✅ НЕ находка: AutoHotkey и синтез клавиш

Бриф просил проверить `.ahk` и хардкод `Control+` — обе темы чисты.

- **AutoHotkey закрыт платформенной развилкой корректно.** `internal/dictation-fix.js:25` (`IS_WIN`), а в UI пункт меню «Фикс диктовки Orca» добавляется только под `if (L.IS_WIN)` (`hub.js:1572`), и в `doCheck` блок проверки тоже под `if (L.IS_WIN)` (`hub.js:1057`). На маке ничего из этого не показывается и не запускается — мёртвой кнопки нет.
- **Хардкода `Control+`/`Meta+` в браузерной автоматизации нет вообще.** Грep по `keyboard.press|Control\+|Meta\+|selectAll` даёт только `Escape` и `Enter` (`agentrouter/open-session.js:392`, `freemodel/freemodel_autoreger_v3.js:282,336,376`, `internal/freemodel-manager.js:768,865`, `justwoker/auto-add.js:295`, `routing/tokenrouter/rebrowser/autoreg.js:156`, `routing/tokenrouter-autoreg.js:525`, `anymodel/lib/camoufox_anymodel.py:438-444`) — это платформонезависимые клавиши. Ни `robotjs`, ни `nut-js`, ни `undetected-chromedriver`, ни Selenium, ни Puppeteer в репозитории **не используются вовсе**.
- **Работа с буфером идёт через веб-API, а не через ОС:** `navigator.clipboard.readText()` (`routing/tokenrouter/camoufox_autoreg.py:665`), `navigator.clipboard.writeText()` (`internal/export-for-mac.js:252`). Мак-специфики нет. Единственный нативный путь — `mac-support/shims/clip.exe` → `pbcopy`, и он уже написан.

### ✅ НЕ находка: MCP-браузеры

`mcps/chrome-devtools/tools/*.json` — это схемы инструментов (описания), не код. `.playwright-mcp/` — каталог артефактов прошлых прогонов (логи консоли и YAML-снимки страниц от 21-22.08). Ни там, ни там нет ни путей к бинарям, ни запуска браузера. Регистрация MCP-серверов в репозитории отсутствует (`.claude/settings.json` содержит только `permissions`).

---

## Итог

| Градация | Штук | Что именно |
|---|---|---|
| 🔴 **BLOCKER** | **1** | Пути к Chrome захардкожены под Windows → Grok-сессии на маке не поднимаются вовсе (`grokFindChrome`, `find_chrome`, плюс виндовые `creationflags` в `Popen`) |
| 🟥 **BROKEN** | **4** | Camoufox не ставится мак-установщиком (мертва вся Camoufox-половина авторегов) · Keychain-диалог блокирует событийный цикл `:8200` · `cookieDbLocked` на маке всегда `false` (исчезает защита от сжигания сессии) · две ручки Grok спавнят `cmd`/`powershell` без развилки и врут `ok:true` |
| 🟠 **DEGRADED** | **7** | `os="windows"` во всех 9 запусках Camoufox · Windows-UA поверх мак-Chromium (`navigator.platform` остаётся `MacIntel`) · Keychain-запрос в проде расходится с проверенным пробником · окно Camoufox на маке не поднимается на передний план · `spawn('python')` спасён шимом только у детей дашборда · `curl.exe` там же · банка кук копируется дважды |
| ⚪ **COSMETIC** | **1** (4 пункта) | `--start-maximized` не действует · `bringToFront` не поднимает окно над другими приложениями · нет мак-свипера зомби-браузеров · `rebrowser/` — мёртвый код на обеих платформах |
| ✅ **НЕ находки** | **4** | Расшифровка кук на macOS уже реализована и реализована грамотно · Playwright-браузеры и arm64 в порядке · AutoHotkey корректно закрыт `IS_WIN` · MCP-каталоги кода не содержат |

### Главное

**Ожидание брифа не подтвердилось, и это хорошая новость: DPAPI-слепоты нет — в `routing/lib/newapi-account.js` уже лежит рабочая macOS-ветка OSCrypt (Keychain / `mock_password` / PBKDF2×1003 / AES-128-CBC), проверенная на живом маке. Настоящая дыра в другом месте: мак-установщик СОЗНАТЕЛЬНО не ставит Camoufox, поэтому на маке мертва вся Camoufox-половина авторегов (TokenRouter, Ourtoken, AnyModel, FreeModel, Grok) — причём мертва молча, минутными таймаутами вместо ошибки.**

### Порядок починки (по отдаче)

1. **`cookieDbLocked`** — самый дешёвый и самый неприятный из тихих: три строки кода, а без него мак жжёт живые сессии ЛК после каждого рестарта дашборда. Плюс возвращается вредный совет «войди в ЛК заново», за который уже платили 24.08.
2. **Keychain вне процесса дашборда** — иначе первая же встреча с не-Playwright-профилем даёт до 30 с полной глухоты `:8200` с невидимым модальным окном.
3. **Пути к Chrome + `creationflags`** — механическая правка, снимает BLOCKER целиком.
4. **UA и `os=` от платформы хоста** — одна константа на репозиторий; без этого автореги на маке детектятся ровно там, где их и ловят (Cloudflare Turnstile).
5. **Camoufox в мак-ветке `install-deps.sh`** — самая большая по площади, но и единственная, которую нельзя закрыть статически: нужны мак и лог живого прогона, чтобы подобрать пины. До тех пор — гасить кнопки Camoufox-авторегов на `darwin`, чтобы отказ был честным.
6. **Шимы в `HUB.command`** и не глушить `stdio` в POSIX-ветке `launchScript` — одна строка и одна строка, но именно они превращают все остальные отказы из «ничего не произошло» в читаемую ошибку.

### Чем проверять на живом маке

- `node tools/mac-cookie-probe.js` — готовый пробник схемы шифрования кук (уже в репозитории).
- `ls -l <profile>/SingletonLock` — подтвердить формат замка для фикса `cookieDbLocked`.
- `node -e "…navigator.platform…"` в поднятом контексте — увидеть рассинхрон UA/platform глазами.
- `security find-generic-password -s 'Chrome for Testing Safe Storage'` (без `-a`) — проверить, есть ли запись, которую прод сейчас не находит.
