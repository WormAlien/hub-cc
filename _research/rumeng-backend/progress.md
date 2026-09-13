# rumeng backend (transparent-proxy.js) — ход работы

## Разведка завершена. ГЛАВНОЕ ОТКРЫТИЕ

**rumeng — это sub2api, тот же движок, что у TrueSOTA.** Не New API и не «собственный SPA».
Доказательства (живые замеры 13.09):
- `GET /api/v1/settings/public` → `{"code":0,...,"site_name":"如梦AI"}` — конверт sub2api `{code,message,data}`
- `GET /v1/models` без ключа → `401 {"code":"API_KEY_REQUIRED","message":"API key is required in Authorization header (Bearer scheme), x-api-key header, or x-goog-api-key header"}` — БАЙТ В БАЙТ как у TrueSOTA
- `GET /api/v1/keys` → `401 {"code":"UNAUTHORIZED"}`
- `POST /api/v1/auth/refresh {}` → `400 Key: 'RefreshTokenRequest.RefreshToken'` — Go-структура sub2api
- в бандле SPA: `sub2api_locale`, ручки `/subscriptions/summary`, `/groups/available`, `/keys`

⇒ образец для баланса — НЕ `akBalance` (New API cookie), а `routing/lib/truesota-account.js`.

## 🔴 ДВЕ РАЗНЫЕ БАЗЫ (правка к брифу)

Бриф говорит «база `/api/v1`, не `/api`». Это верно только для ПАНЕЛИ. У шлюза база другая:

| Что | База | Проверено |
|---|---|---|
| Панель (auth/keys/subscriptions) | `https://api.rumeng-ai.com/api/v1` | `/api/v1/settings/public` → 200 |
| Шлюз LLM (models/messages) | `https://api.rumeng-ai.com/v1` | `/v1/models` → 401 API_KEY_REQUIRED |

`GET /api/v1/models` → **404 page not found**. Если сделать RM_BASE_URL = `/api/v1` и ходить
им в `/models`, как делает `akProbe`, — ВСЕ пинги вернут unknown, а вкладка будет молча
показывать мёртвыми живые ключи. Поэтому констант две: RM_BASE_URL и RM_PANEL_API.

## Порт keepalive

20166 — свободен (20155–20165 заняты, 20164 WisdomSatan, 20165 AK).

## Чеклист
- [ ] реестры (6 мест)
- [ ] блок rm (константы + функции)
- [ ] маршруты
- [ ] tools/check-rumeng-safe.js
- [ ] node --check

## Сделано (checkpoint 1, 04:1x)
- [x] реестры: CUSTOM_BACKENDS(rumeng:20166), CC_MODEL_PREFIX, BACKEND_ALIASES(rm), ROUTE_EP(rm),
      newapiProfileDir(api.rumeng-ai.com), keepaliveRm, health-чек, newapiLkBusy(rmLkPids)
- [x] блок rm часть 1: константы RM_*, rmIsRealKey/rmSave/rmLoad/rmReadActiveKey/
      rmReadActiveModel/rmReadModelMap/rmSafe/rmKeepaliveSpawn/rmProbe,
      rmPanelApi/rmRefreshTokens/rmTokenFor/rmListKeys/rmSubscriptionSummary/
      rmTightestWindow/rmBalance/rmApplyBalance/handleRmSessions
- node --check: OK

## Сделано (checkpoint 2)
- [x] блок rm часть 2: rmAutoreg + Public/Start/Status/Stop (маркеры RM_STAGE/RM_AUTOADD_RESULT),
      пул прокси (RM_LIVE_PROXY_FILE = AK_* — файлы ОБЩИЕ, второй пул заводить нельзя),
      rmReadProxyLines/rmMergeProxyLines/handleRmProxyPoolLines/handleRmProxyPool,
      rmFindProxy + Public/Line/Launch/Start/Status/Stop, rmRefill* (RESERVE 10, тик 45с),
      rmFindProxySwitchPool
- 🪤 в rmRefillTick проверяются ОБА поиска (rmFindProxy.running || akFindProxy.running):
  валидатор и временный файл общие, два прогона затёрли бы находки друг друга
- node --check: OK

## Сделано (checkpoint 3)
- [x] блок rm часть 3: handleRmPing/Balance/SetBalance, rmLkPids/rmPidAlive,
      handleRmSessionOpen (rumeng/open-session.js <label> console, env RM_LK_EMAIL/RM_LK_PASS),
      rmB64Url*, handleRmShare/Import/Add/SetKey/Rename/Delete/Activate/Models/SetModel/ModelMap
- 🪤 newapiSyncProfile в session/open НЕ зовём (в отличие от ak): он переносит КУКИ, а у
  sub2api куки нет — вход на JWT в localStorage
- node --check: OK

## ПОПРАВКА КООРДИНАТОРА (принята)
localStorage-ключ называется `auth_token`, НЕ `access_token`. По проводу ручка отдаёт
`access_token`, а SPA кладёт его под `auth_token`. Четыре ключа: auth_token, refresh_token,
token_expires_at, auth_user. Плюс: наличие токена в снимке ≠ живой вход (мёртвый держится
~16 с, потом 401) — живость только `GET /auth/me` с Bearer.
- [ ] добавить мост «снимок сессии → токен» с этими именами + проверку /auth/me

## Сделано (checkpoint 4) — поправка координатора внедрена
- [x] RM_TOKEN_KEY='auth_token' / RM_REFRESH_KEY / RM_EXPIRES_KEY, rmSnapshotFile,
      rmTokensFromSnapshot (читает снимок 🌐 по ПРАВИЛЬНЫМ именам),
      rmTokenAlive (GET /auth/me с Bearer — живость только запросом),
      rmTokenFor теперь: запись → снимок → /auth/me → refresh → отказ с причиной
- node --check: OK

## Сделано (checkpoint 5)
- [x] маршруты: 22 роута /__switch/api/rm/* (зеркало ak) + keepalive state/config/latency
- [x] MONEY_GW.rm (host api.rumeng-ai.com, rmBalance/rmApplyBalance)
- node --check: OK

## Сделано (checkpoint 6) — стык с авторегом
🪤 Живой пул от авторега несёт `tokenExpiresIn` (сек) + `tokenIssuedAt` (ISO), а НЕ
`tokenExpiresAt`. Добавлен rmTokenExpiresAt(rec), понимающий обе формы: иначе свежий
суточный токен считался бы протухшим и /auth/refresh дёргался бы на каждый чек.
Проверено на routing/rumeng-sessions.json (2 записи от 13.09).
- node --check: OK

## 🔴 ЧЕТВЁРТОЕ МЕСТО, ГДЕ КОПИЯ 1:1 ЛОМАЕТСЯ (не было в брифе, найдено живой пробой)

**JWT кабинета ПРИВЯЗАН к User-Agent.** В токене есть claim `bnd`
(`9e740d432db25fba9b06861c481d2243`) — отпечаток клиента. Замер на живой записи пула:

| Заголовки запроса `GET /api/v1/auth/me` | Ответ |
|---|---|
| UA из записи аккаунта (`Chrome/151…`) | **200 code=0** |
| UA из записи + браузерные Accept/Origin/Referer | **200 code=0** |
| без UA | 401 `SESSION_BINDING_MISMATCH` |
| `claude-cli/2.1.158` (наш RM_CC_HEADERS) | 401 `SESSION_BINDING_MISMATCH` |

⇒ `rmPanelApi` НЕЛЬЗЯ звать с RM_CC_HEADERS, как это делает ak со своими запросами:
все ручки кабинета отвечали бы 401, баланс всегда пустой, причина выглядела бы как
«токен истёк» — и лечили бы её перевыпуском токена, который не помогает.

Шлюз (`/v1/models` по api_key) привязки НЕ имеет — там claude-cli UA дал 200.
То есть UA разный на двух базах, и это ещё одна причина держать их раздельно.
- [ ] починить rmPanelApi: UA берётся из записи аккаунта

## 🔴 ПЯТОЕ МЕСТО — у rumeng КОШЕЛЁК, а не подписки (живой замер)

Слепое следование образцу TrueSOTA дало бы «$—» на всех аккаунтах. Реальные ответы:

| Ручка | Что вернула |
|---|---|
| `/subscriptions/summary` | `{"active_count":0,"total_used_usd":0,"subscriptions":[]}` — ПУСТО |
| `/subscriptions`, `/subscriptions/active` | `[]` |
| `/keys` | `items[]`, у ключа `quota: 0`, `quota_used: 0` (0 = без лимита) |
| **`/auth/me`** | **`balance: 1`**, `frozen_balance: 0`, `total_recharged: 0` |

⇒ Деньги живут в КОШЕЛЬКЕ пользователя (`/auth/me` → `data.balance`), а не в подписке и
не в квоте ключа. Это совпадает с тем, что авторег пишет в пул (`"balance": 1` — грант
за регистрацию $1). У TrueSOTA тот же движок продаёт подписки, здесь — предоплату.

Порядок источников в rmBalance: квота КЛЮЧА (если >0) → подписка (если активна) →
**КОШЕЛЁК `/auth/me`** → только живость.
- [ ] добавить ветку кошелька

## ✅ ПРИЁМКА БАЛАНСА НА ЖИВЫХ АККАУНТАХ (checkpoint 7)

rmBalance вырезан из файла и исполнен в песочнице против трёх живых записей пула:

    limy.i.n576@…  {"status":"live","balance":1,"spent":0,"granted":1,
                    "balanceSource":"self","window":"кошелёк","newApiUserId":190}
    aant.onio1.1…  то же, userId 191
    al.junmaval@…  то же, userId 192

Работает весь путь: живость ключа по /v1 → токен из записи → /auth/me с UA аккаунта →
кошелёк. До правки UA все три давали 401 SESSION_BINDING_MISMATCH; до ветки кошелька —
"$—" и «нет подписки».
- [x] ветка кошелька (rmWallet)
- [x] UA-привязка (rmPanelHeaders)
- node --check: OK

## Сделано (checkpoint 8)
- [x] tools/check-rumeng-safe.js — 110/110 проверок PASS
  Сторожит: два базовых URL, Number(code)===0, UA-привязку (5 функций + отсутствие
  RM_CC_HEADERS в rmPanelApi), auth_token vs access_token, живость через /auth/me,
  обе формы срока, порядок источников баланса key→sub→wallet, отсутствие New-API-пути
  (New-Api-User / user/self / 500000 / guessGrant), маркеры RM_STAGE, долив пула,
  общий пул с ak, 24 маршрута, отсутствие newapiSyncProfile, снятие обоих токенов в rmSafe

## ПОПРАВКА КООРДИНАТОРА 2
- UA-привязку он подтвердил независимо (я нашёл её сам живой пробой) — код уже правильный
- Имена полей пула сверены: api_key снейк, accessToken/refreshToken/userAgent кэмел — совпадает
- 🔴 НОВОЕ: `refresh_token` ОДНОРАЗОВЫЙ, выданный при регистрации к первому 401 уже
  потрачен перехватчиком SPA. Протухший вход чинится `POST /auth/login` по паролю.
- [ ] добавить фолбэк логина паролем в rmTokenFor

## Сделано (checkpoint 9) — фолбэк входа паролем
Живой замер подтвердил одноразовость refresh (родным UA):
    POST /auth/refresh → 401 "invalid refresh token"
    POST /auth/login   → 200 code=0, новая пара, expires_in 86400

- [x] rmLoginWithPassword + ДВЕ точки вызова в rmTokenFor (refresh отвергнут / refresh'а не было)
- [x] при перезаписи снимаем tokenExpiresIn/tokenIssuedAt, иначе вход повторялся бы на каждый чек
- [x] check-rumeng-safe.js: 115/115 PASS

Приёмка полного пути на живой панели (пул не менялся):
  1. токен живой          → balance 1, source self, window кошелёк ✅
  2. токен испорчен       → вошёл паролем, токен 388 симв. ✅
  3. токенов нет вовсе    → вошёл паролем, баланс 1 ✅
  4. ни токена, ни пароля → внятный отказ, не молчание ✅

## Сделано (checkpoint 10)
- [x] rmKeepaliveSpawn внесён в keepaliveInstances() — был определён, но не зарегистрирован:
      без этого кнопка «перезапустить» в Health и boot-респавн не знали бы про :20166,
      а активация вкладки рапортовала бы «успешно» на мёртвом порту
- [x] progress-файл убран из корня в _research/rumeng-backend/ (check-hub следит за корнем)
- check-rumeng-safe.js: 118/118 PASS; check-aikeysapi-safe.js 111/111; check-1m OK

## ИТОГ — бэкенд готов

Изменённые файлы (только мои два):
- routing/transparent-proxy.js — +2007 строк, 0 удалений (чисто аддитивно)
- tools/check-rumeng-safe.js — новый, 117 проверок

Приёмка: node --check PASS · check-rumeng-safe 117/117 · check-aikeysapi-safe 111/111
(сосед не сломан) · check-1m OK · rmSync (fs) не тронут, своей функции с таким именем нет.

🔴 ДЛЯ ВЛАДЕЛЬЦА: нужен РЕСТАРТ дашборда, чтобы маршруты /__switch/api/rm/* ожили.
Сам не перезапускал (владелец работает в :8200).
