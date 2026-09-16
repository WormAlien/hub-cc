# 02 — HOST_AUTH (jwt vs classic) — getunikey

**Задача:** определить, как шлюз `getunikey` (`www.getunikey.ai`, кандидат-префикс `uk`) держит сессию —
`jwt` или `classic` — и как это прописывается в таблице `HOST_AUTH`.

**Репозиторий:** `C:\Users\WormAlien\Desktop\Autoreger_Clean` (живой). Зеркало `D:\WORMALIENAIGIGANT\Autoreger_Clean` не трогать.
**Канон:** `D:\WORMALIENAIGIGANT\wiki\abuse-hub\ADDING-A-GATEWAY.md`.

## План
1. `routing/lib/newapi-account.js`: выбор jwt vs classic, где таблица HOST_AUTH, какие хосты уже есть, поведение при отсутствии записи.
2. `git diff routing/lib/newapi-account.js` — что меняет параллельная сессия, пересекается ли с добавлением хоста.
3. Канон §3.4 `ADDING-A-GATEWAY.md` — как проверять HOST_AUTH живым профилем; какой скрипт/команда.
4. Имя куки сессии getunikey: `new_api_refresh` (jwt) vs `session` (classic) — косвенно по коду/фронту.
5. Как другие шлюзы проходили эту проверку — пример из вики.

## Статус
- [x] 1. newapi-account.js
- [x] 2. git diff
- [x] 3. канон §3.4
- [x] 4. имя куки
- [x] 5. пример из вики

---

## 1. Таблица HOST_AUTH и выбор jwt/classic

### Факт
- Таблица `HOST_AUTH` — обычный JS-объект в `routing/lib/newapi-account.js:196-250`.
- Функция-селектор: `authKind(host)` — `routing/lib/newapi-account.js:252-254`:
  ```js
  function authKind(host) {
      return HOST_AUTH[host] || 'classic';
  }
  ```
  **Дефолт при ОТСУТСТВИИ записи — `'classic'`.** Неизвестный хост молча пойдёт classic-веткой.
- Хосты, уже прописанные в таблице (значение → хост):
  - `classic`: `agentrouter.org`, `gorouter.app`, `emtf.aipm9527.online`, `api.wisdomsatan.club`, `www.aikeysapi.com`
  - `jwt`: `tabitoken.com`, `xpeach.codes`, `api.justwoker.icu`, `kktoken.cc`, `api.hcnsec.cn`
- Итоговый путь выбирается НЕ только таблицей. В `accountSelfInner` (`routing/lib/newapi-account.js:1385`) есть override по содержимому профиля:
  ```js
  const kindEff = kind !== 'jwt' && /(?:^|;\s*)new_api_refresh=/.test(cookie) ? 'jwt' : kind;
  ```
  То есть **если в профиле лежит кука `new_api_refresh` — хост пойдёт jwt-веткой даже при `classic` в таблице**. Таблица — подсказка на случай, когда профиля ещё нет (так прямо сказано в комментарии на строках 232-235).
- Ветвление путей:
  - `jwt` (стр. 1387-1411): `POST /api/user/auth/refresh` с кукой `new_api_refresh` → `{ access_token, user }`; дальше `GET /api/user/self` с `Authorization: Bearer`.
  - `classic` (стр. 1413-1450): `GET /api/user/self` с кукой `session` + заголовком `New-Api-User: <id>`; id выковыривается из подписанной gob-сессии (`sessionUserId`, стр. 884).

### Где
- `routing/lib/newapi-account.js:196-250` — таблица.
- `routing/lib/newapi-account.js:252-254` — `authKind`, дефолт `classic`.
- `routing/lib/newapi-account.js:1385` — override `kindEff` по куке `new_api_refresh`.
- `routing/lib/newapi-account.js:1387-1450` — обе ветки.

### Как проверено
- `Read` файла целиком (1622 строки).

---

## 2. Что меняет параллельная сессия (`git diff routing/lib/newapi-account.js`)

### Факт
Диф (131 вставка / 23 удаления) трогает ТРИ области, и **ни одна не касается `HOST_AUTH`/`authKind`**:
1. **Новый шлюз частоты `proxyGate`** (добавлен блок перед `wafBlocked`, вставлен внутрь `directFirstRequest`):
   - было `const retry = await viaProxy(px.proxy);`
   - стало `const retry = await proxyGate(px.proxy.id, host, () => viaProxy(px.proxy));`
   - новый экспорт `proxyGate` в `module.exports`.
   - Смысл: ограничение частоты не только на хост, но на пару «прокси + хост» (инцидент с баном домашнего IP у agentrouter.org, разбор 15.09).
2. **Машиночитаемый вид отказа `selfFailure` + `classifySelfFailure` + `SELF_FAILURE_KINDS`** (новый блок перед `accountSelfInner`): каждый `return { ok:false, error }` заменён на `selfFailure(error[, extra])`, который добавляет поле `failureKind` (12 значений: `deferred`, `no_profile`, `no_cookie`, `login_expired`, `login_dead`, `no_proof`, `waf`, `rate_limited`, `no_uid`, `browser_open`, `transport`, `other`). Оба символа добавлены в экспорт.
3. **Косметика вызовов**: замена сырых объектных литералов отказа на `selfFailure(...)` по всему `accountSelfInner`; текст `error` не менялся.

**Пересечение с добавлением нового хоста:** НЕТ. Правка целиком в области «частота запросов / классификация отказа». Таблица `HOST_AUTH` (стр. 196-250) и `authKind` (252-254) в дифе не появляются. Строку `'www.getunikey.ai': '...'` можно добавлять, конфликта с рабочей копией параллельной сессии не будет.
**Косвенное пересечение:** обе правки рядом в `accountSelfInner`, но в разных строках (диф — вокруг `return`, наш хост — в таблице выше по файлу на 200 строк). Механического конфликта патчей нет.

### Где
- `git diff routing/lib/newapi-account.js` (рабочее дерево живого репо, 15.09).

### Как проверено
- `git diff routing/lib/newapi-account.js` прочитан целиком (238 строк вывода).
- `git status --porcelain` до начала работы: ` M routing/lib/newapi-account.js` (файл уже правился параллельной сессией).
- 🔒 Секретов в дифе нет: изменений в строках с ключами/куками/токенами не обнаружено (только имена кук `new_api_refresh`, `session`, `acw_sc__v2` в комментариях и регулярках).

---

## 3. Канон: как проверять HOST_AUTH живым профилем

### Факт
🪤 **Уточнение по нумерации:** в `ADDING-A-GATEWAY.md` HOST_AUTH — это секция **§3.6**, а не §3.4. §3.4 в каноне — про `routing/lib/ref-codes.js`. Блок HOST_AUTH — `ADDING-A-GATEWAY.md:507-520`, дублирующая грабля #24 — `ADDING-A-GATEWAY.md:616`.

Дословно §3.6 (`ADDING-A-GATEWAY.md:507-520`):
```
### 3.6 `routing/lib/newapi-account.js`

Найти `HOST_AUTH`. Добавить:
'HOST': 'TBD',   // ← определить ПОСЛЕ первого входа (грабля #24)

**Определить тип авторизации (обязательно до первого чека баланса):**
1. Добавь аккаунт, открой ЛК (🌐), войди через GitHub, закрой браузер.
2. Проверь:
node -e "console.log(require('./routing/lib/newapi-account').readProfileCookies(require('path').join(__dirname,'FOLDER','profiles','acct_xx_ID')).filter(c=>c.host.includes('HOST')).map(c=>c.name))"
3. Если видишь `session` → `'classic'`. Если `new_api_refresh` → `'jwt'`. Вписать в `HOST_AUTH`.
```

Дословно грабля #24 (`ADDING-A-GATEWAY.md:616`):
```
24. **`HOST_AUTH` — проверить ЖИВЫМ ПРОФИЛЕМ, не копировать от эталона.** KKtoken = `jwt`
(refresh-кука `new_api_refresh`). Но другой инстанс New API может быть `classic` (кука
`session`). Если поставить `jwt` на classic-панели — код пойдёт в `refreshAccessToken`, не
найдёт `new_api_refresh`, вернёт `refresh: HTTP 404`, и точный баланс навсегда будет `guess`.
**Проверка:** открой ЛК (🌐), войди, закрой. Потом
`node -e "require('./routing/lib/newapi-account').readProfileCookies(dir).filter(c => c.host.includes(HOST)).map(c => c.name)"`.
Если `session` — `classic`, если `new_api_refresh` — `jwt`. Запись: `routing/lib/newapi-account.js`, объект `HOST_AUTH`.
```

**Скрипт/команда для проверки (найдено в репо):**
- **Каноничная команда** — это `node -e`-однострочник выше. Он зовёт `readProfileCookies` (`routing/lib/newapi-account.js:691`), фильтрует куки по хосту и печатает ИМЕНА. Требует, чтобы профиль был залогинен и браузер закрыт (иначе БД куки заперта, см. `cookieDbLocked`).
- **Готовая обёртка в репо** — `tools/probe-account-self.js`: печатает ровно то, что нужно для вердикта — заперта ли БД, список имён кук для хоста (строка 67-68) и ответ `/api/user/self`. Запуск: `node tools/probe-account-self.js <ar|go|jw|tb|xp> <id|подстрока>`. 🪤 В `POOLS` (стр. 17-23) перечислены только 5 пулов — **getunikey туда ещё не добавлен**, для нового шлюза строку надо будет дописать (или звать каноничный `node -e`).
- **Статический чек** — `tools/check-hcnsec.js:453-455`: проверяет регексом `'${H}': '(classic|jwt)'`, что запись в `HOST_AUTH` вообще ЕСТЬ (значение не фиксирует). Это образец для аналогичного `check-<gw>.js` у нового шлюза.

### Где
- `D:\WORMALIENAIGIGANT\wiki\abuse-hub\ADDING-A-GATEWAY.md:507-520` — §3.6.
- `D:\WORMALIENAIGIGANT\wiki\abuse-hub\ADDING-A-GATEWAY.md:616` — грабля #24.
- `C:\Users\WormAlien\Desktop\Autoreger_Clean\routing\lib\newapi-account.js:691` — `readProfileCookies`.
- `C:\Users\WormAlien\Desktop\Autoreger_Clean\tools\probe-account-self.js:17-23,67-68` — готовая обёртка.
- `C:\Users\WormAlien\Desktop\Autoreger_Clean\tools\check-hcnsec.js:449-455` — статический чек наличия строки.

### Как проверено
- `Grep` по `ADDING-A-GATEWAY.md` (HOST_AUTH|3.4|jwt|classic) + `Read` строк 460-620 канона.
- `Grep` по репо `readProfileCookies|HOST_AUTH|authKind` (30 попаданий) + `Read` шапок `tools/probe-account-self.js`, `tools/check-hcnsec.js`, `tools/jw-self-probe.js`, `tools/mac-cookie-probe.js`.

---

## 4. Имя куки сессии getunikey — `new_api_refresh` (jwt) или `session` (classic)?

### Факт
🔴 **НЕ УСТАНОВЛЕНО без живого логина.** Прямого признака (живой ответ `POST /api/user/login` с `set-cookie` или живой профиль) в репозитории/вики нет — владелец войти не пробовал (нужна капча Cloudflare Turnstile), а по правилам этой задачи в сеть к `www.getunikey.ai` я не ходил.

**Косвенные признаки (все указывают на `classic`, но это догадка, а не замер):**
1. getunikey — **обычный New API** с логином/паролем (НЕ GitHub): `/api/user/login`, `/api/user/register` отдают тот же сигнатурный ответ `{"message":"Turnstile token 为空"}` (`06-autoreg-inventory.md:11,61-63`; `getunikey - тест ключа...md:85`). `/api/pricing`, `group_ratio`, `/v1/dashboard/billing/*`, `email_verification: true` — набор свежего New API.
2. **Ближайший родственник — `aikeysapi`** (тоже New API, панель ZhiFlow): его `POST /api/user/login?turnstile=` **ставит куку `session` + `data.id`** (`06-autoreg-inventory.md:53-54`, снято живой записью 12.09). В `HOST_AUTH` aikeysapi стоит `classic` (`newapi-account.js:249`). Тот же путь логина у getunikey ⇒ склоняет к `classic`.
3. `api.user`-ручки getunikey совпадают с параметрическим входом aikeysapi (почта+пароль+код из письма), а не с GitHub-входом jwt-хостов (tabitoken/xpeach/justwoker/kktoken).
4. **Кука `new_api_refresh` / маршрут `POST /api/user/auth/refresh` у getunikey НЕ подтверждены никак.** Это был бы прямой признак jwt — его нет.

🪤 **`version: dd3277f` (из контекста) — git-хэш сборки, офлайн не резолвится, ничего не доказывает.** По коду `newapi-account.js:242-245` jwt-переписка (`new_api_refresh`, `/api/user/auth/refresh`) в релизных тегах New API отсутствует и есть только в неотпущенном `main` — то есть хэш-сборка сама по себе НЕ признак jwt (у classic-хостов сборки тоже с хэшами).

🔑 **Почему при неуверенности безопаснее `classic`, а не `jwt` (и это не «на глаз»):** в `accountSelfInner` путь выбирается по `kindEff` (`newapi-account.js:1385`):
```js
const kindEff = kind !== 'jwt' && /(?:^|;\s*)new_api_refresh=/.test(cookie) ? 'jwt' : kind;
```
Оверрайд работает только вверх (`classic`→`jwt`, если в профиле есть `new_api_refresh`) и **никогда не понижает `jwt`→`classic`**. Значит:
- поставили `classic`, а панель jwt — если в профиле лежит `new_api_refresh`, код сам уйдёт jwt-веткой (безвредно);
- поставили `jwt`, а панель classic — `refreshAccessToken` не найдёт куку → `refresh: HTTP 404` → точный баланс **навсегда** в прикидку `guess` (грабля #24, `ADDING-A-GATEWAY.md:616`; `Known Issues.md:731`).

### Что смотреть в браузере (что именно надо посмотреть в браузере — список, без правок)
1. Открыть ЛК getunikey (кнопка 🌐 / Playwright), войти (Turnstile руками/виджетом), **закрыть окно** (иначе БД куки заперта, `cookieDbLocked`).
2. Посмотреть куки на домене `www.getunikey.ai`: есть ли `new_api_refresh` (⇒ jwt) или `session` (⇒ classic). В DevTools: Application → Cookies.
3. Посмотреть ответ `POST /api/user/login` в Network → заголовок `set-cookie` (какая кука приходит).
4. Проверить, существует ли маршрут `POST /api/user/auth/refresh` (у jwt-сборок он есть; без куки ответит 401/403 — форма маршрута).
5. Затем — каноничная команда из §3 (выше).

### Где
- `C:\Users\WormAlien\Desktop\Autoreger_Clean\tools\_recon\getunikey\06-autoreg-inventory.md:53-54,61-63` — aikeysapi login → `session`; getunikey = тот же New API.
- `D:\WORMALIENAIGIGANT\wiki\abuse-hub\getunikey - тест ключа, прайс и грабли имен.md:77-96` — конфиг `/api/status` getunikey (вход: почта+пароль, Turnstile, Google OAuth).
- `routing/lib/newapi-account.js:1385` — `kindEff` (односторонний оверрайд).
- `routing/lib/newapi-account.js:249` — `'www.aikeysapi.com': 'classic'`.

### Как проверено
- `Grep`/`Read` соседних recon-отчётов `tools/_recon/getunikey/06-autoreg-inventory.md` (строки 1-190).
- `Read` вики-заметок `getunikey - тест ключа...` и `HANDOFF — вкладка getunikey (для агента)`.
- Анализ `kindEff` и ветвей `accountSelfInner` по уже прочитанному `newapi-account.js`.
- 🔒 В сеть не ходил, API провайдера не вызывал, логин/регистрацию не пробовал.

---

## 5. Как другие шлюзы проходили эту проверку — пример из вики

### Факт
Примеры, где `HOST_AUTH` ставили **по факту замера**, а не копированием от эталона:

**Пример 1 — `api.wisdomsatan.club` (эталон «закрыли граблю замером»).**
`wiki/log.md:4591` (запись `[2026-09-10 04:02] wip | Десятый шлюз WisdomSatan`):
```
- Кука входа — `session` ⇒ `HOST_AUTH` = **`classic`**, НЕ `jwt` как у эталона KKtoken
  (грабля #24 канона закрыта замером, а не догадкой)
```
Контекст (`wiki/log.md:4588-4591`): зарегистрировался владелец по рефке, панель New API **v0.11.5**, капчи нет; после входа увидели куку `session` и записали `classic` (не `jwt`). Разбор в коде — комментарий `newapi-account.js:237-248`, где отдельно отмечено, что по флагам сборки напрашивался бы `jwt` (`passkey_login` есть), но замер показал `classic`.

**Пример 2 — `emtf.aipm9527.online` (исправление ошибочного `jwt` → `classic`).**
Комментарий `newapi-account.js:223-226`:
```
// emtf.aipm9527.online — classic: кука `session`, как у agentrouter и gorouter.
// Проверено живой пробой 09.09: в профиле acct_ap_..._0 лежит cookie `session`,
// `new_api_refresh` нет. Первоначально стояло `jwt` от клона kktoken-шаблона.
```
То есть клон-шаблон дал ложный `jwt`, и его **переписали по факту** содержимого живого профиля.

**Контрпример (почему это важно) — `gorouter.app`.** Таблица говорила `classic`, а панель уже отдавала `new_api_refresh` ⇒ умела jwt. Девять дней слали мёртвую session-only куку и получали 401 (`wiki/meta/Debug Reference — приложения и сервисы.md:1708-1734`, `wiki/log.md:7753-7755`). Именно этот случай породил оверрайд `kindEff` (выбор пути по содержимому профиля). Прямое подтверждение приёма: **`HOST_AUTH` — подсказка, а не приговор; при живом профиле решает кука в нём.**

### Где
- `D:\WORMALIENAIGIGANT\wiki\log.md:4584-4604` (пример 1, строка 4591 — цитата).
- `C:\Users\WormAlien\Desktop\Autoreger_Clean\routing\lib\newapi-account.js:223-226` (пример 2), `:237-248` (wisdomsatan).
- `D:\WORMALIENAIGIGANT\wiki\meta\Debug Reference — приложения и сервисы.md:1708-1734` (gorouter, контрпример).
- `D:\WORMALIENAIGIGANT\wiki\meta\Known Issues.md:731` (hcnsec — `jwt` как непроверенная догадка, тот же класс).

### Как проверено
- `Grep` по `D:\WORMALIENAIGIGANT\wiki` (`HOST_AUTH|new_api_refresh`) + `Read` `log.md:4575-4604` и `Debug Reference — приложения и сервисы.md` (цитаты).

---

## Итог для getunikey (сводка)

| Вопрос | Ответ |
|---|---|
| Где таблица | `routing/lib/newapi-account.js:196-250`; селектор `authKind` `:252-254`, дефолт `classic` |
| Что меняет параллельная сессия | `proxyGate` (лимит «прокси+хост») + `selfFailure`/`classifySelfFailure`; **HOST_AUTH не трогает**, конфликта нет |
| Команда проверки | `node -e "...readProfileCookies(dir).filter(c=>c.host.includes(HOST)).map(c=>c.name)"` (канон §3.6); готовая обёртка `tools/probe-account-self.js` |
| Имя куки getunikey | **НЕ УСТАНОВЛЕНО** без живого логина; косвенно всё указывает на `classic` (`session`), прямого признака `new_api_refresh` нет |
| Безопасный placeholder | `'classic'` (при уверенности в обратном — только после живого профиля): `kindEff` умеет classic→jwt сам, но не наоборот |
