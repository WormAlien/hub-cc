# Recon: папка шлюза getunikey и `open-session.js`

Снимок: 2026-09-15 МСК. Репо: `C:\Users\WormAlien\Desktop\Autoreger_Clean` (живая копия).
Задача: разведка папки шлюза по канону [[ADDING-A-GATEWAY]] и
[[HANDOFF — вкладка getunikey (для агента)]]. Код не писался, репо не менялся.
Формат секций: **Факт / Где (файл:строка) / Как проверено**.

---

## 1. Состав папки шлюза

**Факт.** Папка шлюза `<FOLDER>/` — не код шлюза, а «браузерная» часть: всё, что нужно,
чтобы открыть ЛК провайдера живым Chromium с профилем на аккаунт. Обязательный минимум —
три вещи:

| Элемент | Роль | Обязателен? |
|---|---|---|
| `open-session.js` | открывает видимый Chromium с persistent-профилем аккаунта; регистрация по реф-ссылке или страница баланса | **да** |
| `profiles/` | Chrome-профиль на аккаунт (`profiles/<label>/`), пишется на диск целиком | **да** (создаётся в рантайме) |
| `sessions/` | JSON сессии аккаунта (`acct_<p>_<id>.json`) — storageState для импорта/шаринга | **да** |

Опционально, по фичам шлюза:

| Элемент | Роль | Когда нужен |
|---|---|---|
| `gh-sessions/` | пул GitHub-сессий на аккаунт (`acct_<p>_*.json`) | только при GitHub-менеджере (`github: true`) |
| `share-session.js` | шаринг/экспорт сессии (share-код) | только если у вкладки есть фича share/import |
| `auto-add.js` | авторега: создать → войти → добыть ключ → записать в пул | только если авторега реально работает |
| `refresh-sessions.js` | обновление пула сессий | по потребности |

**Как проверено.** Инвентарь папок в живом репо (`ls`):
`kktoken` = `gh-sessions profiles sessions open-session.js share-session.js`;
`aikeysapi` = `profiles recordings sessions auto-add.js open-session.js record-signup.js refresh-sessions.js`;
`aipm` = `gh-sessions profiles sessions open-session.js`;
`hcnsec` = `profiles open-session.js share-session.js` (нет `sessions/` — фича не заведена).

**`kktoken/` полный список файлов (эталон):**
- `open-session.js` — открыватель окна (см. §2);
- `share-session.js` — экспорт/импорт сессии;
- `profiles/acct_kk_*` — Chrome-профили аккаунтов;
- `sessions/acct_kk_*.json` — сессии аккаунтов (формат — §4);
- `gh-sessions/acct_kk_*.json` — GitHub-сессии аккаунтов (пул менеджера).

**`aikeysapi/` полный список файлов:**
- `open-session.js` — тот же открыватель (форк);
- `auto-add.js` — авторега (богатый, 54 КБ) — образец для getunikey;
- `record-signup.js` — записывает флоу регистрации в `recordings/*.jsonl`;
- `refresh-sessions.js` — обновляет пул сессий;
- `recordings/signup-*.jsonl` — записанные флоу;
- `.probe-cookie.sh` — проба куки;
- `.signup-inbox.json` — конфиг почтового ящика для кода регистрации;
- `profiles/`, `sessions/`.

---

## 2. `kktoken/open-session.js` — строки поведения окна

**Факт.** Три строки, задающие поведение окна, живут в `kktoken/open-session.js`:

- **:38** — импорт `raiseBrowserWindow`:
  `const { raiseBrowserWindow } = require('../routing/lib/focus-window.js');`
- **:320** — `viewport: null,` (в объекте launchPersistentContext :318; без него окно заперто в 1280×800)
- **:321** — `args: ['--window-size=600,1000', '--disable-blink-features=AutomationControlled'],`
- **:326** — `raiseBrowserWindow(); // bringToFront поднимает только вкладку — окно ОС наверх выносит WinAPI`

Контекст (:318–322): `chromium.launchPersistentContext(profileDir, { headless: false, viewport: null, args: [...] })`.

**Как проверено.** `Read` файла (строки 1–70 и 295–354); `Grep -n 'viewport|window-size|raiseBrowserWindow|focus-window'`.

---

## 3. Другие копии `open-session.js` — есть ли протухшие

**Факт.** В живом репо **17 копий** `open-session.js` (по одной на папку шлюза).
**Все 17 уже несут все три строки** — протухших копий на диске НЕТ:

| Проверка | Результат |
|---|---|
| `viewport: null` | 1 в каждой из 17 копий |
| `--window-size=600,1000` | 1 в каждой из 17 копий |
| `raiseBrowserWindow` | 2 в каждой (импорт + вызов) |
| `require('../routing/lib/focus-window.js')` | 1 в каждой |

`diff` копий между собой даёт только переименования (хост, `REGISTER_URL('kktoken')`,
`CONSOLE_URL`, `ROOT_URL`, `poolFile`), к блоку launch — ноль расхождений.

**Протухший вариант существует только в истории git.** Достоверная «старая» форма:
`viewport: { width: 1280, height: 800 }` (и никаких `--window-size` / `raiseBrowserWindow`).

**Как проверено.**
- `Grep -c` трёх паттернов по всем `*/open-session.js` — по 1 в каждой.
- `diff` `kktoken` vs `gorouter`/`aipm` — только имена/адреса.
- `git show ec84af4~1:kktoken/open-session.js | grep` → старая форма `viewport: { width: 1280, height: 800 }` на строке 319; `git show HEAD:...` → три свежие строки.
- Коммит, добавивший строки: **`ec84af4` от 2026-09-11 05:12 МСК** («fix(league)… работа параллельных сессий») — тот же коммит, что добавил и `viewport: null`, и `raiseBrowserWindow`.
- `kktoken/open-session.js` в рабочем дереве = HEAD (git status чистый) ⇒ файл-эталон свежий.

**Вывод для Шага 4 хендоффа:** копировать `kktoken/open-session.js` безопасно — на диске
он свежий; бояться нужно только копии из git-истории до `ec84af4` (или из чужого бэкапа).

---

## 4. Формат файла сессии аккаунта

**Факт.** Файл `sessions/acct_<p>_<id>.json` — это Playwright `storageState`
(`cookies[]` + `origins[]`), плюс у «засеянной» GitHub-сессии ещё три мета-поля.
**Только имена полей:**

| Поле верхнего уровня | Тип | Примечание |
|---|---|---|
| `cookies` | `array` из `{name, value, domain, path, expires, httpOnly, secure, sameSite}` | базовое storageState |
| `origins` | `array` из `{origin, localStorage}` | базовое storageState |
| `seed` | `string` | только у засеянной GitHub-сессии (напр. `github`) |
| `ghLogin` | `string` | только у засеянной |
| `seededAt` | `string` | только у засеянной |

Полная форма (`kktoken`): `seed, ghLogin, seededAt, cookies[], origins[]`.
Минимальная форма (`aikeysapi`): только `cookies[], origins[]`.

**Где лежат.** `kktoken/sessions/` и `aikeysapi/sessions/` — по файлу на аккаунт, имя
`acct_<shortprefix>_<timestamp>_<seq>.json`. Аналогичный `gh-sessions/` — пул GitHub-сессий.

**Как проверено.** `node -e` — печать `Object.keys` (рекурсивно по первому элементу массива)
для `kktoken/sessions/acct_kk_1788322340843_21.json` и `aikeysapi/sessions/acct_ak_1789345547380_1.json`.
Значения не читались и не выводились.

---

## 5. `tools/add-gateway.js` — что создаёт, что руками

**Факт.** Спека `tools/gateways.spec.json` — **93 точки** по **10 файлам** (`files` map:
backend, frontend, keepalive, lifecycle, restart, refcodes, refcodesDefault, newapiAccount,
hubBalance, gitignore) + **49 правил вставки** (`inserts`). Точка без правила в
`apply` получает статус **`manual`** — инструмент её не пишет.

**Инструмент пишет САМ (только с `--write`, только точки с правилом — 49):**
- бэкенд: реестры `1.8a–1.8j`, роуты `1.9a–1.9v`, своя `pidAlive` `1.12`;
- фронт: кнопка сайдбара `2.1`, реестры `2.3–2.11`;
- shared: `3.1` GW_BY_HOST, `3.3` lifecycle, `3.4` keepalive-restart.ps1, `3.7` HOST_AUTH,
  `3.8` hub-balance POOLS, `3.11` строка `.gitignore`.

**Инструмент НЕ пишет (44 точки = `manual`, копируются руками из живого эталона):**
- константы `1.1/1.1b/1.1c`, keepalive-хендлер `1.2`, утилиты `1.3–1.11`, хендлеры `1.13–1.31`,
  грабли `1.32–1.35`, **HTML-панель вкладки `2.2`**, фронтовые JS-функции `2.12/2.13`,
  реф-код `3.5/3.6`, `3.2` FLAT_RATE_HOSTS;
- **`3.9` `routing/%full%-modelmap.json`** и **`3.10` `%FOLDER%/open-session.js`** — `kind: file`,
  в `plan` печатаются как «создать файл», но правила вставки нет ⇒ `apply` их **не создаёт**.

**Чего в спеке нет ВООБЩЕ (⇒ целиком руками):** папок шлюза `FOLDER/sessions/`,
`FOLDER/profiles/`, `FOLDER/gh-sessions/` (ни точек, ни mkdir в скрипте — `fs.mkdirSync`
встречается только для `routing/.backup/`). В `.gitignore` автоматом идёт лишь строка
`routing/<full>-sessions.json` (правило `3.11`); строки `FOLDER/profiles/` и
`FOLDER/gh-sessions/` — руками (канон §3.8 просит четыре строки, спека покрывает одну).

**Как проверено.** `node -e` — `Object.keys(spec.files)`, список id точек с `kind/file/when`,
список ключей `spec.inserts` (49); отсутствие правил у `3.9`, `3.10`, `2.2`, `2.13`, `1.1`.
`Read` `tools/add-gateway.js`: `:613` `if (!rule) { p.status='manual'; return p; }`;
`:310–313` `kind:'file'` → `fileOnly` (только печать в `plan`); `runApply` пишет только
`status==='insert'` (`:756–763`); `grep mkdir` → только backupDir (`:753`).

---

## 6. Регистрация / `auto-add.js`

**Факт.** `auto-add.js` — **не обязателен и генератором не создаётся**. В спеке —
**0 упоминаний** `autoreg`/`auto-add`. Файл есть только у четырёх шлюзов:
`aikeysapi`, `justwoker`, `rumeng`, `wisdomsatan`. Смежные: `record-signup.js` + `recordings/`
— только `aikeysapi`; `refresh-sessions.js` — `aikeysapi` и `rumeng`.

**Авторега — это отдельная машинерия на шлюз, а не «скопировать файл».** Каждой рабочей
автогере сопутствует свой бэкенд и свой UI, которых в спеке нет:
- хендлеры/роуты в `transparent-proxy.js`: `ak/autoreg/*`, `rm/autoreg/*`, `jw/auto-add`;
- спавн `<FOLDER>/auto-add.js` и маркер этапа в stdout (`AK_AUTOADD_RESULT`, `RM_AUTOADD_RESULT`,
  `JW_AUTOADD_RESULT`) — парсится именно маркер, не русский текст;
- рукописная UI-панель автореги внутри вкладки (`ak-autoreg-*`, `rm-autoreg-*`).

🪤 `wisdomsatan/auto-add.js` лежит в папке, но бэкендом **не подключён** — спящий файл.

**Должно ли быть у getunikey:** зависит от разведки 2.1 хендоффа (схема регистрации: почта+пароль
с кодом / Google OAuth / капча). Канон §5 прямо говорит: писать `auto-add.js` по итогам 2.1,
образец — `aikeysapi/auto-add.js`. Без пройденной 2.1 файла быть не должно.

**Как проверено.** Инвентарь папок (`ls`); `grep -ciE 'autoreg|auto-add|авторег' tools/gateways.spec.json` → 0;
`Grep` `auto-add|autoAdd|AUTOADD|autoreg` по `routing/transparent-proxy.js` (строки 16435, 17834,
18934 — спавн; 16473/17871/18814 — маркеры) и по `routing/proxy-dashboard.html` (`ak-autoreg-*`,
`rm-autoreg-*`); `grep wisdomsatan.*auto-add` → пусто.

---

## 7. git status

**До работы:** 13 строк (`git status --porcelain`).
**После:** 25 строк. **Я создал ровно один файл** — этот отчёт
(`tools/_recon/getunikey/08-gateway-folder.md`; папка `tools/_recon/` уже была untracked,
поэтому в дельте она не отдельной строкой). Остальные новые строки —
**параллельная сессия** (`routing/event-store.js`, `routing/keepalive-proxy.js`,
`routing/lib/pooldrop.js`, `tools/check-pooldrop.js`, `*.pooldrop-*progress.md`, `*.pd-trim*`);
я их не трогал и не откатывал.

**Как проверено.** `git status --porcelain` до и после, `diff` двух снимков;
дельты не пересекаются с моими путями (кроме `_recon/`).

---

## Итог для Шага 4 хендоффа (папка шлюза)

Создать руками (генератор не умеет): `getunikey/sessions/`, `getunikey/profiles/`,
`getunikey/open-session.js` (копия свежего `kktoken/open-session.js` — он на диске свежий,
§3), при необходимости `getunikey/gh-sessions/` (только если разведка 2.1 даст GitHub-вход)
и строки `.gitignore` `<FOLDER>/profiles/`, `<FOLDER>/sessions/`, `<FOLDER>/gh-sessions/`.
`auto-add.js` — только после разведки 2.1 и вместе со своей бэкенд-обвязкой.
