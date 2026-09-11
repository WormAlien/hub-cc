# Как в этом репо УЖЕ устроены автореги

Разведка перед написанием авторега для `api.wisdomsatan.club`
(регистрация логин+пароль, БЕЗ капчи, БЕЗ подтверждения почты, БЕЗ GitHub).

Репо: `C:\Users\WormAlien\Desktop\Autoreger_Clean`
Дата разбора: 2026-09-10

---

## 0. TL;DR для нашей задачи

Забегая вперёд — главные выводы (детали ниже):

| Вопрос | Ответ |
|---|---|
| Что брать за образец | ⭐ **`helpcoder/helpcoder_autoreg.js`** — его шапка дословно описывает нашу задачу: *«Чистый HTTP, без email/капчи/подтверждения. На каждый аккаунт генерируется случайный username+password»*. 146 строк, полностью интегрирован в дашборд |
| Чего **не** брать за образец | `internal/freemodel-creator.js` — это полуручной мастер с человеком в цикле, форму он не заполняет |
| Нужен ли браузер | **Скорее всего нет.** Проверить `curl` по `api.wisdomsatan.club`: если нет `Cf-Mitigated: challenge` / `Just a moment…` — Camoufox не нужен |
| Если браузер всё же нужен | Camoufox (Firefox-форк с антидетектом) через Python-пакет `camoufox`, класс `AsyncCamoufox`; есть готовая Node-обёртка на JSON-lines |
| Прокси | ✅ **Машинерия подстановки есть и работает** (Playwright и Camoufox). ❌ Пула и ротации нет вовсе |
| Где хранятся аккаунты | Каталог на аккаунт `<service>/accounts/<idx>_<ts>_ok_<user>/` + единый пул `routing/<name>-sessions.json` |
| Как попадают в дашборд | manager → `internal/dashboard-api.js` → роуты `/__switch/api/<name>/*` в `routing/transparent-proxy.js` |
| Главные грабли | профили Camoufox на 37 ГБ, модалки-оверлеи, `fill()` не работает в Camoufox, ротация куки New-API |

---

## 1. `internal/freemodel-creator.js` — авторег FreeModel

**Файл:** `C:\Users\WormAlien\Desktop\Autoreger_Clean\internal\freemodel-creator.js` (345 строк)

### 1.1 Главное: это НЕ полностью автоматический авторег

Это **полуручной мастер (wizard) с человеком в цикле**. Шапка файла честно пишет:

> `4. Юзер сам всё делает: signup → ждёт письмо → копирует код/линк → логинится`
> `   (и опционально привязывает Telegram). Скрипт ПОЧТУ не парсит.`

Скрипт делает четыре вещи: заводит одноразовый ящик, открывает браузер на нужном URL,
**в фоне следит за письмом и печатает код в консоль**, а после нажатия клавиши —
проверяет, что человек залогинился, и сохраняет сессию. Форму он **не заполняет**.

Для нашего кейса (нет почты, нет капчи) это означает: **как образец полного авторега
файл не годится**, но из него стоит забрать три приёма — сохранение `storageState`,
генерацию `restore_session.js` и формат `session_info.txt`.

### 1.2 Чем автоматизирует браузер

**Playwright + системный Chromium. Camoufox тут НЕ используется.**

```js
const { chromium } = require('playwright');
...
browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
});
context = await browser.newContext({
    viewport: freemodelConfig.VIEWPORT,
    userAgent: freemodelConfig.USER_AGENT,
    locale: freemodelConfig.LOCALE,
});
await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
});
```

`headless: false` — обязательно, потому что за рулём человек.

### 1.3 Как генерирует данные аккаунта

Практически никак — генерируется только **email**, всё остальное вводит человек.

- **Email** — `new GuerrillaInbox()` из `freemodel/lib/guerrillamail.js`, адрес выдаёт
  сам сервис guerrillamail; скрипт печатает его крупно в консоль, чтобы человек скопировал.
- **Пароль** — не генерируется вообще (его придумывает человек).
- **Имя организации** — производное от почты: `user-<localpart без не-алфанумерики>`.
- **Инвайт-код** — три источника на выбор в меню: реф-цепочка от прошлой сессии
  (`findLatestRefCode()` сканит `manual_sessions/`, берёт свежайшую с валидным `FRE-xxxxxxxx`),
  стартовый `INITIAL_INVITE` из конфига, или ручной ввод.

Реф-цепочка — интересная деталь: каждый новый аккаунт регистрируется по коду предыдущего,
то есть пул сам себя рефералит. Флаг `chainExclude: yes` в `session_info.txt` выключает
конкретную сессию из цепочки.

### 1.4 Как обходит защиту

Минимально, потому что защиту проходит живой человек:

1. `--disable-blink-features=AutomationControlled` — снимает CDP-флаг у Chromium.
2. `addInitScript` с подменой `navigator.webdriver` → `false`.
3. Подстановка `userAgent` / `viewport` / `locale` из `freemodel/config.js`.

Никакого fingerprint-спуфинга, никакого прокси, никакого решателя капчи. Капчу (если она
есть) кликает человек.

### 1.5 Куда сохраняет результат

Каталог `manual_sessions/<MSK-timestamp>-success_user-<localpart>/`, три файла:

| Файл | Содержимое |
|---|---|
| `session.json` | `context.storageState()` — куки + localStorage целиком |
| `restore_session.js` | самодостаточный скрипт: поднимает Chromium с этим `storageState` и открывает dashboard |
| `session_info.txt` | плоский `Ключ: значение` — `URL`, `Email`, `Org`, `Статус`, `InviteUsed`, `RefCode` |

`session_info.txt` парсится обратно функцией `readSessionInfo()` — это де-факто формат
пула для FreeModel-сессий (плоский текст, не JSON).

⚠️ Важная деталь: **сохраняется только при успехе**. Если `isLoggedIn()` не подтвердил
dashboard — каталог не создаётся вообще, работа теряется.

### 1.6 Обработка ошибок и ретраи

Ретраев как таковых нет. Что есть:

- `isLoggedIn(context)` — **2 попытки** с паузой 2 с. Сначала сканирует уже открытые
  вкладки на `freemodel.dev/dashboard`, потом сам открывает новую и ждёт 2.5 с.
  Комментарий в коде: *«иногда первая отдаёт login до пропагации куки»*.
- `grabMyRefCode(context)` — перебирает **три URL** (`/refer`, `/invite`, `/referrals`),
  на каждом сначала ищет `FRE-[a-f0-9]{8}` в тексте `body`, потом в `href` ссылок
  `a[href*="/invite/"]`. Редирект на `/login` → сразу `null`.
- Весь основной блок в одном `try/catch`, ошибка печатается строкой и всё.
- **Пустых `catch {}` очень много** (12+ штук) — ошибки глотаются молча. Для полностью
  автоматического авторега это антипаттерн, повторять не стоит.
- **Браузер намеренно НЕ закрывается** в конце (`// Браузер НЕ закрываем — закроешь сам`).
  Для массовой регистрации это прямая дорога к утечке процессов — см. §5 про
  `cleanup-reg-procs.ps1`.

### 1.7 Что забрать в наш авторег

✅ Формат `session_info.txt` + генерируемый `restore_session.js`
✅ `context.storageState({ path })` как способ сохранить аккаунт
✅ Именование каталога `<timestamp>-success_<org>` — сортируется лексикографически
❌ Человек в цикле, `waitAnyKey`, `headless: false`
❌ Пустые `catch {}`
❌ Незакрытый браузер

---

## 2. Все остальные автореги в репо

Поиск: `grep -ril "camoufox|autoreg|авторег" --include=*.js --include=*.py`
(без `node_modules`, `_research`, `graphify-out`, `.rescue`).

### 2.1 Автореги-точки входа

| Файл | Строк | Назначение |
|---|---|---|
| ⭐ `helpcoder/helpcoder_autoreg.js` | 146 | **helpcoder.cc (New-API). Чистый HTTP, БЕЗ email/капчи/подтверждения, случайный username+password.** Ближайший аналог нашей задачи |
| `svrtr/svrtr_autoreger.js` | 174 | svrtr.org через Telegram-бота. Без браузера: gramjs + cookie-fetch. 1 ТГ = 1 аккаунт |
| `conduit/conduit_autoreger.js` | 217 | Conduit через Telegram device-code (`/api/auth` start→poll). Без браузера и почты |
| `cun/cun_autoreger.js` | 249 | cun.ai — Playwright Chromium + emailnator через Camoufox |
| `ourtoken/ourtoken_autoreg.js` | 230 | ourtoken.ai — Playwright `channel:'chrome'` + instanttempemail |
| `ourtoken/camoufox_autoreg.py` | 652 | То же самое, но на Camoufox (обход Cloudflare). Пишет в `routing/ourtoken-sessions.json` |
| `anymodel/anymodel_autoreger.js` | 373 | anymodel.org — emailnator + **Turnstile через Camoufox** + OTP + привязка Telegram |
| `freemodel/freemodel_autoreger_v3.js` | 970 | FreeModel v5 — самый большой. Playwright Chromium для сайта + Camoufox-демон для почты (tmailor) |
| `routing/tokenrouter-autoreg.js` | 863 | TokenRouter.me — Playwright `channel:'chrome'` (**настоящий Chrome, не Chromium**) + 10minutemail |
| `routing/tokenrouter/camoufox_autoreg.py` | 815 | TokenRouter.me на Camoufox (Firefox + patched Juggler, не CDP) |
| `routing/tokenrouter/rebrowser/autoreg.js` | 281 | TokenRouter.me на `rebrowser-playwright` (пропатченный CDP под обход Cloudflare) |
| `internal/freemodel-creator.js` | 345 | Полуручной мастер FreeModel — см. §1 |

Три реализации TokenRouter (Chrome / Camoufox / rebrowser) — это **след эволюции обхода
Cloudflare**: сначала обычный Chrome, потом rebrowser, потом Camoufox.

### 2.2 Библиотеки-клиенты (переиспользуемые)

| Файл | Назначение |
|---|---|
| `helpcoder/lib/helpcoder-api.js` | HTTP-клиент New-API: `register`, `login`, `getSelf`, `listTokens`, `getTokenKey`, `saveCookies`, `quotaToUsd` |
| `svrtr/lib/svrtr-api.js` | cookie-fetch клиент svrtr |
| `conduit/lib/conduit-api.js` | device-code клиент Conduit |
| `anymodel/lib/camoufox-anymodel-client.js` | Node-обёртка над Python-Camoufox (JSON-lines через stdin/stdout) |
| `anymodel/lib/camoufox_anymodel.py` | Camoufox-демон регистрации anymodel |
| `freemodel/lib/camoufox-emailnator-client.js` + `camoufox_emailnator.py` | emailnator.com через Camoufox |
| `freemodel/lib/camoufox-tmailor-client.js` + `camoufox_tmailor.py` | tmailor.com через Camoufox |
| `freemodel/lib/timeweb-imap-client.js` | свой домен с catch-all + IMAP — **дефолтный** email-бэкенд, без капчи |
| `freemodel/lib/tg-pool.js`, `tg-client.js` | пул Telegram-аккаунтов (gramjs) |
| `freemodel/lib/guerrillamail.js`, `instanttempemail.js`, `10minutemail.js` | одноразовая почта без браузера |

### 2.3 Вспомогательное

| Файл | Назначение |
|---|---|
| `anymodel/recorder.py`, `recorder_bg.py` | Camoufox-рекордер: пишет клики/URL/console/network/скриншоты/DOM в `.jsonl` — **чтобы разобрать чужую форму регистрации** |
| `freemodel/lib/camoufox_recorder.py` | то же для tmailor.com |
| `grok-launcher/camoufox_device.py` | авторизация на accounts.x.ai по кукам (не авторег) |
| `tools/clean-camoufox-profiles.sh` | подметает протёкшие профили Camoufox — см. §7 |
| `routing/cleanup-reg-procs.ps1` | убивает осиротевшие браузеры — см. §5 |
| `logs/.fm-mark-autoban.js` | маркировка забаненных FreeModel-аккаунтов |

💡 **`anymodel/recorder.py` — самый полезный инструмент для старта.** Прежде чем писать
авторег под wisdomsatan, им можно один раз пройти регистрацию руками и получить точные
селекторы, тела запросов и последовательность редиректов.

---

## 3. Camoufox — как запускается в этом проекте

### 3.1 Что это

Camoufox — форк Firefox с антидетектом на уровне сборки (не JS-патчи, а
пропатченный Juggler вместо CDP). В репо используется **Python-пакет `camoufox`**,
класс `AsyncCamoufox` — контекстный менеджер, отдающий Playwright-совместимый browser.

Ставится в `install-deps.sh` (шаг 9 `install.sh` — *«Доп. зависимости
(Camoufox-автореги…)»*). Это **отдельный Python-стек**, не тот же, что
`npx playwright install chromium` на шаге 5 — в `install.sh:132` это явно оговорено.
Бинарник качает сам пакет `camoufox` в свой кэш, в репо его нет.

### 3.2 Канонические параметры запуска

Одинаковы во всех четырёх местах (`ourtoken`, `tokenrouter`, `anymodel`, `emailnator`/`tmailor`):

```python
from camoufox import AsyncCamoufox

async with AsyncCamoufox(
    headless=headless,              # обычно False
    os="windows",                   # профиль ОС для отпечатка
    window=(1280, 720),             # 1900×1040 в tokenrouter под FHD
    persistent_context=True,        # профиль на диске, а не in-memory
    user_data_dir=str(PROFILE_DIR),
    disable_coop=True,              # снять Cross-Origin-Opener-Policy
    humanize=True,                  # human-like мышь; в других местах число: 8.0 / 10.0
    main_world_eval=True,           # eval в main world, а не isolated
    i_know_what_im_doing=True,
    proxy=proxy,                    # ← см. §4
) as browser:
    page = browser.pages[0] if browser.pages else await browser.new_page()
```

`humanize` — либо `True`, либо максимальная длительность движения курсора в секундах
(`8.0` в ourtoken, `10.0` в tokenrouter).

### 3.3 Профили

Каждый запуск создаёт **свой** каталог профиля:

```python
PROFILE_DIR = Path(__file__).parent / f"camoufox_anymodel_profile_{os.getpid()}"
# или
PROFILE_DIR = BASE_DIR / f"camoufox-{uuid.uuid4().hex[:8]}"   # tokenrouter
```

Имя — по PID либо по случайному uuid. ⚠️ Профили **раздувают репо**, см. §7.

Свежие версии (`camoufox_emailnator.py`, `camoufox_tmailor.py`) сами подметают
чужие протухшие профили при старте — **по mtime старше 6 часов, а НЕ по живости PID**
(комментарий в коде объясняет почему — §7).

### 3.4 Готовая обёртка для переиспользования ✅

**Да, есть — и она хорошая.** Паттерн «Node-оркестратор + Python-Camoufox-демон,
общение JSON-lines через stdin/stdout»:

- Python-сторона: `anymodel/lib/camoufox_anymodel.py` — читает `sys.stdin` построчно,
  на каждую строку `json.loads` → команда → `out({...})` в stdout.
  Команды: `register`, `enter_otp`, `navigate`, `click`, `evaluate`, `get_url`,
  `save_session`, `screenshot`, `stop`.
- Node-сторона: `anymodel/lib/camoufox-anymodel-client.js` — класс `CamoufoxAmodel`,
  `spawn("python", [scriptPath], { env, windowsHide: true })`, `readline` по stdout,
  `_send(cmd, timeoutMs)` возвращает промис.

Для wisdomsatan можно скопировать `camoufox-anymodel-client.js` практически как есть,
заменив только набор команд в Python-части.

🪤 **Грабли в этой обёртке, которые стоит починить при копировании:**
- `this._pending` — `Map` с единственным ключом `"_current"`, то есть **конвейер на одну
  команду**. Параллельные `_send` перетрут друг друга. Для последовательного авторега ок.
- `await new Promise(r => setTimeout(r, 2000))` вместо честного ready-хендшейка от Python.
- В комментарии затесался японский текст (`Ждём少し чтобы процесс стартовал`) — опечатка,
  не смысл.
- Обязательный `sys.stdout.reconfigure(encoding="utf-8")` в Python: Windows открывает
  stdin/stdout в cp1251 и кириллица в командах приезжает битой. Это уже сделано во всех
  Camoufox-скриптах репо, **не выкидывать при копировании**.

---

## 4. ПРОКСИ — есть ли поддержка? ✅ ДА

### 4.1 Короткий ответ

**Подстановка прокси в браузерный профиль поддерживается и работает — на обоих движках.**
Чего **НЕТ** — это пула и ротации: прокси один на запуск, задаётся руками.

### 4.2 Playwright-ветка (Chromium)

Конфиг: `freemodel/config.js`

```js
// ── Прокси ─────────────────────────────────────────────────
// строка формата http://user:pass@host:port или null
PROXY: null,
```

Парсер: `freemodel/freemodel_autoreger_v3.js:119`

```js
function parseProxy(s) {
  if (!s) return null;
  const m = s.match(/^https?:\/\/(?:([^:]+):([^@]+)@)?([^:]+):(\d+)$/);
  if (!m) return null;
  const p = { server: `http://${m[3]}:${m[4]}` };
  if (m[1] && m[2]) { p.username = m[1]; p.password = m[2]; }
  return p;
}
```

Применение (`freemodel_autoreger_v3.js:511`):

```js
const proxy = parseProxy(config.PROXY);
if (proxy) launchOpts.proxy = proxy;
browser = await chromium.launch(launchOpts);
```

То есть **прокси идёт в `chromium.launch()`**, а не в `newContext()` — на весь браузер.

🪤 Ограничение регулярки: `^https?://` — **только HTTP/HTTPS-прокси. SOCKS5 не распарсится**
(вернёт `null` молча, и авторег пойдёт с домашнего IP, ничего не сказав). Если нужен
SOCKS5 — расширять регулярку и собирать `server: 'socks5://...'`.

Отдельно `freemodel/lib/tmailor.js:97` умеет прокси на уровне контекста:
`if (opts.proxy) contextOpts.proxy = opts.proxy;`

### 4.3 Camoufox-ветка (Firefox)

Цепочка: **CLI-аргумент → env-переменная `PROXY` → JSON → `AsyncCamoufox(proxy=...)`**.

1. `anymodel/anymodel_autoreger.js:62` — `else if (args[i] === "--proxy") opts.proxy = args[++i];`
2. Прокидывается в оба клиента:
   ```js
   const mailer = new CamoufoxEmailnator({ proxy, headless: false, ... });
   let camoufox = new CamoufoxAmodel({ proxy, logger: ... });
   ```
3. `anymodel/lib/camoufox-anymodel-client.js:27` кладёт в env дочернего Python:
   ```js
   if (this.proxy) {
     if (typeof this.proxy === "string") env.PROXY = this.proxy;
     else env.PROXY = JSON.stringify(this.proxy);
   }
   ```
4. `anymodel/lib/camoufox_anymodel.py:496` разбирает и передаёт в браузер:
   ```python
   proxy_str = os.environ.get("PROXY")
   if proxy_str:
       try: proxy = json.loads(proxy_str)
       except Exception: pass
   ...
   async with AsyncCamoufox(..., proxy=proxy) as browser:
   ```

🪤 **Баг в этой цепочке.** Node умеет отправить прокси **строкой** (`env.PROXY = this.proxy`),
но Python разбирает **только `json.loads`**. Строка `http://user:pass@host:port` не JSON →
`except Exception: pass` → `proxy = None` → **браузер молча идёт напрямую**.
То есть строковая форма прокси в Camoufox-ветке **сломана**, работает только объектная
(`{server, username, password}`). При копировании чинить: либо всегда `JSON.stringify`
на стороне Node, либо `if not JSON → parse as URL` на стороне Python.

Формат объекта — playwright-совместимый: `{"server": "http://host:port", "username": "...", "password": "..."}`.

### 4.4 Чего нет

❌ **Пула прокси нет.** Grep по `PROXY_POOL|proxyPool|proxy_pool|rotateProxy|nextProxy`
даёт **ноль совпадений** во всём репо (кроме node_modules).
❌ **Ротации нет.** Один прокси на весь прогон; `--proxy` задаётся руками при запуске.
❌ **Привязки прокси к аккаунту нет** — в сохранённых `account_info.txt` / `accounts.json`
поле прокси не пишется. Через какой IP зарегистрирован аккаунт — не известно.
❌ **Проверки живости прокси нет** — упавший прокси проявится как таймаут навигации.

⚠️ Не путать: `routing/*proxy*.js` (`transparent-proxy.js`, `keepalive-proxy.js`,
`frontdoor-proxy.js`) — это **LLM-шлюзы дашборда**, к прокси авторегов отношения не имеют.
`routing/pool-watchdog.js` — тоже про пул ключей, а не прокси.

### 4.5 Куда добавлять пул, если понадобится

Минимальная работа (машинерия подстановки уже есть, нужен только источник):

1. Файл пула — например `routing/reg-proxies.json`: массив строк или объектов
   `{server, username, password, lastUsed, dead}`.
2. Хелпер `nextProxy()` — round-robin с пометкой мёртвых. Логичное место —
   `freemodel/lib/` рядом с `tg-pool.js` (там уже есть готовый паттерн пула
   с состоянием и `banned`-статусом — **копировать оттуда**).
3. Точки подключения:
   - Playwright: заменить `parseProxy(config.PROXY)` на `nextProxy()` в
     `freemodel_autoreger_v3.js:511` (и в нашем новом файле);
   - Camoufox: передавать объект в конструктор клиента — **всегда объектом**, см. баг §4.3.
4. Записывать использованный прокси в `account_info.txt` рядом с `Username`/`Password`.

📌 **Для нашей задачи (wisdomsatan, чистый HTTP без браузера) браузерная машинерия прокси
не нужна вовсе** — достаточно `undici.ProxyAgent` / `https-proxy-agent` в fetch-клиенте
по образцу `helpcoder/lib/helpcoder-api.js`.

---

## 5. `routing/cleanup-reg-procs.ps1` — что и зачем чистит

**Файл:** `C:\Users\WormAlien\Desktop\Autoreger_Clean\routing\cleanup-reg-procs.ps1`

Убивает **осиротевшие браузерные процессы**, оставшиеся после авторегов и ЛК-сессий.

### 5.1 Проблема, ради которой написан

Из шапки файла дословно:

> On Windows, when a reg script dies, its Chromium/Camoufox children get reparented
> to explorer.exe and keep eating RAM (**~1.5GB after a few runs**).

Это **прямое следствие граблей §1.6** — авторег падает или его прерывают, а браузер
не закрыт. Windows переподвешивает детей к `explorer.exe`, и они живут вечно.

### 5.2 Как отличает свои браузеры от пользовательских

```powershell
$markerRe = 'ms-playwright|github\\profiles|agentrouter\\sessions|camoufox\\Cache'

$procs = Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -eq 'chrome.exe' -or $_.Name -eq 'camoufox.exe') -and
    $_.CommandLine -match $markerRe
}
```

Фильтр по **командной строке**: путь профиля должен содержать маркер. Настоящий браузер
владельца запущен с другими путями → не матчится → не трогается.

### 5.3 Логика «сирота или нет»

```powershell
$orphan = $Force -or (-not $parentAlive) -or ($p.ParentProcessId -eq $explorerPid)
```

Три условия: родитель мёртв **или** родитель — `explorer.exe` (признак reparenting)
**или** явный `-Force`. Живая сессия (например, открытое окно GitHub-ЛК) по умолчанию
пропускается с `skip ... (live session)`.

Убивает `taskkill /F /T /PID` — с деревом детей.

### 5.4 Вывод для нашего авторега

Наш авторег должен **закрывать браузер в `finally`**, а не полагаться на этот скрипт.
Если браузера не будет вообще (чистый HTTP) — проблема снимается на корню.
Запуск: `powershell -NoProfile -ExecutionPolicy Bypass -File routing\cleanup-reg-procs.ps1`.

---

## 6. Где хранятся аккаунты и как попадают в дашборд

### 6.1 Два разных формата — не путать

**Формат A — каталог на аккаунт** (что пишет авторег):

```
helpcoder/accounts/<index>_<ISO-ts>_ok_<username>/
├── session.json        # storageState (cookies) + user id
└── account_info.txt    # плоский "Ключ: значение"
```

`account_info.txt` (helpcoder):
```
Ident: helpcoder#1
Saved: 2026-08-10T20:46:04.000Z
Username: calmlakedcac7b
Password: <...>
User ID: 12345
API Key: sk-...
Balance: $1.00
Base URL: https://helpcoder.cc
```

Так делают `helpcoder/`, `svrtr/`, `conduit/`, `cun/`, `anymodel/`, `freemodel/` —
у каждого свой каталог `accounts/`. Имя каталога само по себе несёт данные
(индекс, время, `_ok_`/`_err_`, username) и **сортируется лексикографически по дате**.

**Формат B — единый JSON-массив** (пул для роутинга): `routing/<name>-sessions.json`.

```json
[
  { "email": "...", "password": "...", "apiKey": "sk-...",
    "apiKeyName": "k44", "createdAt": "2026-06-15T22:19:56Z", "cookies": [] }
]
```

Вариант с состоянием (`routing/ourtoken-sessions.json`):
```json
[ { "email": "...", "name": "...", "api_key": "...", "active": false, "status": "live" } ]
```

Таких файлов в `routing/` **16 штук** — по одному на провайдера: `agentrouter-`,
`aipm-`, `al-`, `cun-`, `evomap-`, `gorouter-`, `hcnsec-`, `justwoker-`, `kktoken-`,
`ourtoken-`, `seekai-`, `tabi-`, `tokenrouter/accounts.json`, `truesota-`, `xpeach-`.

⚠️ Важно: **`sessions.json` хранит только снимок «здесь и сейчас»** (`transparent-proxy.js:396`) —
`spent`, `balance` и штамп времени, это кэш, а не источник истины.

### 6.2 Как аккаунты попадают во вкладку дашборда

Канонический путь на примере helpcoder (**наш образец**), три слоя:

**Слой 1 — менеджер.** `helpcoder/lib/helpcoder-manager.js` (по образцу `svrtr-manager.js`):
`getHelpcoderAccounts()` читает `accounts/`, для каждого каталога парсит
`account_info.txt` + проверяет `session.json`, возвращает массив объектов
`{ name, path, sessionFile, hasSession, username, apiKey, userId, balance, date, status }`,
отсортированный **новые сверху**. Каталоги `_tmp_*`, `_error_*`, `.*` пропускаются.

**Слой 2 — dashboard-api.** `internal/dashboard-api.js`:
- `helpcoderMod()` — ленивый `require` менеджера (строка 1467);
- `listHelpcoderSessions({ withQuotas })`, `extractHelpcoderApiKey`, `refreshOneHelpcoderQuota`;
- кэш квот `logs/.helpcoder_quota_cache.json`, метаданные `logs/.helpcoder_meta.json`
  (в т.ч. `setHelpcoderBanned`);
- реестр запускаемых скриптов (строка 969):
  ```js
  'helpcoder-create': { title: 'HelpCoder Autoreg',
                        args: [path.join(PROJECT_ROOT, 'helpcoder', 'helpcoder_autoreg.js')] },
  ```

**Слой 3 — HTTP-роуты.** `routing/transparent-proxy.js:20468` — семь эндпоинтов:

| Метод | Роут | Что делает |
|---|---|---|
| GET | `/__switch/api/helpcoder/sessions` | список аккаунтов + активный ключ (`?refresh=1` — обновить квоты) |
| GET | `/__switch/api/helpcoder/active-key` | текущий активный ключ + маска |
| POST | `/__switch/api/helpcoder/refresh-quota` | обновить квоту одного |
| POST | `/__switch/api/helpcoder/activate` | **сделать ключ активным** |
| POST | `/__switch/api/helpcoder/add` | добавить ключ руками |
| POST | `/__switch/api/helpcoder/autoreg` | **запустить авторег из дашборда** (`count` 1..50) |
| GET | `/__switch/api/helpcoder/models` | список моделей (кэш 5 мин) |

Фронт — `routing/proxy-dashboard.html` (2.2 МБ, один файл), дёргает эти роуты.

### 6.3 Что делает «Активировать»

```js
fs.writeFileSync(HC_ACTIVE_KEY_FILE, key);           // ~/.claude/hc-active-key.txt
settings.env.ANTHROPIC_BASE_URL = HC_BASE_URL;
settings.apiKeyHelper = keyHelperCmd('hc-active-key.txt');
delete settings.model;
settings.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS = '0';
delete settings.env.ANTHROPIC_API_KEY;
clearOtEnv(settings);
writeSettings(settings);
```

Ключ ложится в `~/.claude/<xx>-active-key.txt`, а `settings.json` получает
`apiKeyHelper`, который его читает. Перед записью — `makeSettingsBackup('settings-hc')`.

### 6.4 Чеклист интеграции нового шлюза (wisdomsatan)

Чтобы аккаунты появились во вкладке, нужно повторить пять шагов:

1. `wisdomsatan/wisdomsatan_autoreg.js` — авторег, пишет в `wisdomsatan/accounts/<idx>_<ts>_ok_<user>/`
2. `wisdomsatan/lib/wisdomsatan-api.js` — HTTP-клиент (`register`/`login`/`getSelf`/`getTokenKey`)
3. `wisdomsatan/lib/wisdomsatan-manager.js` — `getWisdomsatanAccounts()`, копия `helpcoder-manager.js`
4. `internal/dashboard-api.js` — ленивый `require` + `list*Sessions` + строка в реестре скриптов
5. `routing/transparent-proxy.js` — блок роутов `/__switch/api/wisdomsatan/*` + активатор
   (`~/.claude/ws-active-key.txt`) + регистрация роутов рядом со строкой 20468

📌 **`helpcoder` — эталон для копирования целиком**: он единственный, у кого авторег без
браузера, почты и капчи, и при этом он полностью интегрирован в дашборд.

---

## 7. Известные грабли (из вики `D:\WORMALIENAIGIGANT\wiki`)

Grep: `grep -ril "camoufox|авторег" D:\WORMALIENAIGIGANT\wiki` → 31 файл.
Ниже — то, что стоит держать в голове, начиная новый авторег.

### 7.1 🔴 Профили Camoufox сожрали 37 ГБ — 82% веса репо

Источник: `wiki/runbooks/Workstation Disk Cleanup.md` § «Ловушка 6» (2026-08-21).

`Autoreger_Clean` весила **45.8 ГБ**, из них 82% — **580 каталогов**
`camoufox_{tmailor,emailnator,anymodel}_profile_<PID>`. Причина в одной строке,
одинаковой в трёх скриптах: профиль создаётся на **каждый** запуск (PID новый каждый раз)
и **не убирается никогда**. 50–80 МБ за прогон. Раскладка: `tmailor` 350, `emailnator` 125,
`anymodel` 105. Итог чистки: **45.82 → 7.01 ГБ**.

🪤 **Ловушка внутри ловушки — живость PID негодный критерий:**
- Windows переиспользует номера PID: 2 из 580 мёртвых профилей совпали с номерами живых
  посторонних `python.exe`, и первый сборщик отказался их удалять;
- **`os.kill(pid, 0)` на Windows звать НЕЛЬЗЯ** — Python зовёт под ним `TerminateProcess`,
  то есть «проверка живости» убивает процесс.
- Правильный критерий — **mtime**, порог 6 часов.

➡️ **Вывод для нас:** если берём Camoufox — сразу писать уборку профиля в `finally`
(или подметание по mtime при старте, как в свежих скриптах). Если обойдёмся без
браузера — грабли не наши вовсе.

### 7.2 🔴 Модалка на странице регистрации съедает авторег молча

Источники: `wiki/entities/ABUSE HUB.md` § «Модалка „Объявления“ съела авторег» (2026-08-28)
и `wiki/meta/Debug Reference — приложения и сервисы.md`.

С 27.08 панель JustWoker показывает на регистрации диалог «Объявления» (base-ui,
оверлей `dialog-overlay` на весь экран, `z-50`). Кнопка под ним **видима, включена
и стабильна — все проверки доступности Playwright проходит**, но клик не доезжает:
`<div data-slot="dialog-footer"> … intercepts pointer events`.

Авторег дважды пробовал клик, ждал колбэк 90 с и печатал **«вход не подтвердился за 90 с»** —
то есть выносил вердикт про аккаунт на поломке чужой вёрстки. Профиль у каждого прогона
чистый → «Не показывать сегодня» не действует → модалка встаёт **каждый раз**.
Последний удачный прогон 25.08, следующий 27.08 — провал.

**Таксономия трёх похожих симптомов** (путать дорого):
| Симптом | Причина | Код |
|---|---|---|
| кнопки нет вовсе | селектор / переделанная страница | 4 |
| клик прошёл, но никуда не увело | отказ бэкенда, рейт-лимит, оборванная сеть | 8/9/10 |
| клик не прошёл при живой кнопке | **оверлей** | — |

Читать надо не таймаут, а строку `intercepts pointer events` и **что** в ней названо.

**Лечение** — гасить модалку до поиска кнопки, порядок от независимых от локали к текстовым:
✕ по стабильному атрибуту (`data-slot="dialog-close"`) → `Escape` → кнопка по тексту.
Матчить «Закрыть» первым нельзя — панели переводятся (у JustWoker четыре языка).

💡 **Приём, который надо забрать:** `locator.click({ trial: true })` делает **все** проверки
доступности и **не жмёт** — можно проверять лечение, не тратя аккаунт. Замер: до закрытия
модалки `Timeout 6000ms`, после — кликабельна за **21 мс**.

Это случилось **дважды**: у AgentRouter то же лечилось 22.08 (`dismissModals()`, модалка
`系统公告`, `.semi-modal-wrap`). Общего помощника намеренно нет — совпадают симптом и
порядок действий, а не селекторы.

### 7.3 🟠 Camoufox нужен именно для Cloudflare

`wiki/meta/Debug Reference — приложения и сервисы.md` § «tgstat за Cloudflare → Camoufox» (2026-06-19):

> `curl`/`WebFetch`/Playwright-chromium → HTTP **403**, тело `<title>Just a moment…</title>`,
> заголовок `Cf-Mitigated: challenge`.

Camoufox (`pip` v0.4.11, браузер v135) проходит челлендж автоматически.

➡️ **Признак, что Camoufox нужен:** `Cf-Mitigated: challenge` или `Just a moment…` в ответе.
Если `api.wisdomsatan.club` отдаёт нормальный JSON на `curl` — Camoufox не нужен,
и вся тяжесть §7.1 нас не касается.

### 7.4 🟠 `fill()` не работает в Camoufox

`wiki/domains/AI Business Assistant/ourtoken-autoreg.md` § «Баги, которые убивали»:

- **`locator.fill()` CamoFox игнорирует** → нужен `real_fill`: `click` + `clear` +
  `keyboard.type`. Это не косметика, форма просто остаётся пустой.
- **Unicode → subprocess → cp1251 краш** → обязательно
  `encoding="utf-8", errors="replace"` (уже стоит во всех Camoufox-скриптах репо).
- **OTP-regex брал мета-цифры из заголовков письма** → нужен точный
  `verification\s*code[\s\S]{0,120}?(\d{6})`, а не просто `\d{6}`.
- `baseline_count` для писем **не использовать** — порядок писем непредсказуем.
- Не пересолвивать Turnstile: OTP живёт ~60 с, пересолв 12+ с его убивает.

### 7.5 🟠 Куки New-API ротируются — чекер баланса разлогинивает браузер

`wiki/meta/Debug Reference.md` § «Шестая: чекер баланса разлогинивал браузер» (2026-08-18).

У New-API (а **helpcoder — это тоже New-API**, значит и наш случай вероятен): access-токен
живёт **15 минут**, а refresh-кука `new_api_refresh` **одноразовая** — на каждый
`POST /api/user/auth/refresh` сервер выдаёт новую и гасит старую (refresh token rotation).

Чекер баланса ротировал куку и клал новое значение в jar, а профиль браузера оставался
со старым → открываешь ЛК → refresh по погашенной куке → 401 → разлогин.
Замерено: у **9 из 10** профилей значения расходились.

➡️ Если wisdomsatan окажется на New-API — сохранённые `session.json` протухают не по
времени, а **от нашего же обращения**. Лечение в репо: `writeProfileCookies` /
`syncJarToProfile` в `routing/lib/newapi-account.js`.

**Бонус оттуда же:** профили автореги используют схему шифрования куки `v10`
(не app-bound `v20`), поэтому куки Chromium читаются без браузера через DPAPI.

### 7.6 🟡 Массовые автореги могут привести к бану у реселлера

`wiki/meta/Known Issues.md`: у XPeach все ключи `403 banned`, и одна из версий —
**«реселлер мог порезать за автореги»**. Отдельная запись: XPeach выведен в «Чтим память»,
потому что регистрация больше не проходит.

➡️ Не гнать 50 аккаунтов в первый же прогон. `helpcoder_autoreg.js` держит
`await sleep(3000)` между аккаунтами, и дашборд ограничивает `count` диапазоном 1..50.

### 7.7 🟡 Рестарт дашборда нужен, чтобы появились новые роуты

`wiki/entities/ABUSE HUB.md` (2026-09): разметка вкладки читается с диска по `F5`,
а **серверные роуты — нет**. Замер сразу после правки: `/api/jw/sessions` → **404**
при живом `/api/go/sessions` → **200**. До рестарта вкладка выглядит сломанной,
хотя код целый.

⚠️ И рестарт уносит фронт-дор `:20100`, то есть **все живые сессии Claude Code** —
поэтому он делается отдельной задачей в паузе, а не по ходу работы.

➡️ Планируя интеграцию wisdomsatan в дашборд (§6.4, шаг 5), заложить рестарт как
отдельный пункт и предупредить владельца.

### 7.8 🟡 Прочее

- **Автореги не портированы на macOS** (`wiki/entities/ABUSE HUB.md`): «Что НЕ портировано
  на мак … автореги Camoufox/rebrowser, Telegram-пульт, Python-venv `tools/tg-venv`».
  Живьём на маке не запускалось ни разу.
- **Реф-цепочка Conduit идёт парами 2+2** — первый в паре чистый, второй по рефу первого,
  следующая пара заново: так бан одной пары не тянет всю цепочку. Хороший паттерн,
  если у wisdomsatan будет реферальная программа.
- **Кириллица в `curl -d` из git-bash ломается** — HTTP-тесты с кириллицей слать
  node-скриптом (`JSON.stringify` + `Buffer.byteLength`), не через curl.

---

## 8. Итог: рекомендация по авторегу wisdomsatan

### 8.1 Браузер, скорее всего, не нужен

Условия задачи — логин+пароль, без капчи, без почты, без GitHub — **буквально совпадают
с шапкой `helpcoder/helpcoder_autoreg.js`**:

> Автореги helpcoder.cc (New-API). Чистый HTTP, без email/капчи/подтверждения.
> На каждый аккаунт генерируется случайный username+password.

146 строк, ноль зависимостей от браузера, полная интеграция в дашборд.
Это **прямой шаблон**, а не «похожий пример».

**Проверить перед решением:** отдаёт ли `api.wisdomsatan.club` нормальный ответ на `curl`.
Если в ответе `Cf-Mitigated: challenge` или `Just a moment…` — придётся идти в Camoufox
(§3), и тогда сразу закладывать уборку профилей (§7.1).

### 8.2 Что копировать откуда

| Что | Откуда |
|---|---|
| Скелет авторега (генерация креды, ретраи, сохранение) | `helpcoder/helpcoder_autoreg.js` |
| HTTP-клиент с cookie-jar | `helpcoder/lib/helpcoder-api.js` |
| Менеджер аккаунтов для дашборда | `helpcoder/lib/helpcoder-manager.js` (он сам «по образцу `svrtr-manager.js`») |
| Роуты + активатор | блок helpcoder в `routing/transparent-proxy.js:7182+` |
| Camoufox-обёртка (если понадобится) | `anymodel/lib/camoufox-anymodel-client.js` + `camoufox_anymodel.py` |
| Разбор чужой формы регистрации | `anymodel/recorder.py` |
| Пул с состоянием и `banned` | `freemodel/lib/tg-pool.js` |

### 8.3 Готовые приёмы из helpcoder, которые стоит взять дословно

```js
// Генерация имени: читаемое + случайный хвост (не «user12345»)
function randomUsername() {
    const adj = ['swift','keen','calm','lucky','nova','mint','pine','iris','onix','echo'];
    const noun = ['fox','wolf','bird','hare','owl','koi','lynx','moth','apex','lake'];
    return `${adj[…]}${noun[…]}${crypto.randomBytes(3).toString('hex')}`;
}
function randomPassword() {
    return crypto.randomBytes(12).toString('base64url') + 'A1a';  // хвост под политику паролей
}
```

Два **независимых** цикла ретраев — это важная деталь:
- `RATE_RETRIES = 3`, `retryOnRate()` — **линейный backoff** 15/30/45 с строго на HTTP 429,
  с логом «чтобы не выглядело зависшим»;
- `REG_RETRIES = 4` — на коллизию `aff_code` (`/idx_users_aff_code|Duplicate entry/i`),
  пауза 1200 мс, **новый username каждый раз**.

И обязательный **логин сразу после регистрации** — «гарантирует валидную session cookie»:
регистрация может вернуть 200, но не выдать рабочую куку.

### 8.4 Чего НЕ делать

❌ Не брать за образец `internal/freemodel-creator.js` — человек в цикле
❌ Не оставлять пустые `catch {}` — молча съедят причину провала
❌ Не оставлять браузер незакрытым (§5: ~1.5 ГБ RAM через несколько прогонов)
❌ Не делать профиль Camoufox на PID без уборки (§7.1: 37 ГБ)
❌ Не гнать 50 аккаунтов в первый прогон (§7.6: бан у реселлера)
❌ Не полагаться на строковую форму прокси в Camoufox-ветке — она сломана (§4.3)
