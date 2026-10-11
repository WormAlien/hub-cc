# gemini/ — вендоренная копия Antigravity-прокси

Это **не наш код**. Здесь лежит копия форка
[`badrisnarayanan/antigravity-claude-proxy`](https://github.com/badrisnarayanan/antigravity-claude-proxy)
версии **2.7.7**, взятая 2026-10-02 из `F:\antigravity-claude-proxy` (локальная копия без git).
Лицензия — MIT, она рядом в `LICENSE`, автор апстрима указан в `package.json`.

**Что это делает:** отдаёт Anthropic-совместимый API (`POST /v1/messages`, `GET /v1/models`)
поверх Google Cloud Code, то есть даёт Claude Code модели Gemini (и Claude) с Google-аккаунтов
по подписке. Порт **20178**, слушает только `127.0.0.1`.

🪤 **Порт сдвинут против апстрима: у него 20176, у нас 20178.** На дереве хаба 20176 занят
`Artbloom keepalive`, а 20177 - `dacall.AI keepalive` (живой процесс), поэтому пара переехала:
движок **20178**, шлюз `keepalive-proxy` перед ним - **20179**.

🪤 **Слушаемый порт берётся из переменной `PORT`, а не из `config.json`.** В `src/index.js` стоит
`process.env.PORT || DEFAULT_PORT`, где `DEFAULT_PORT` - как раз `config.port` из `config.json`.
Хаб всегда выставляет `PORT` при спавне, поэтому в бою побеждает переменная; `config.json` - это
умолчание для ручного запуска. Числа: `PORT` задаёт хаб (`routing/lib/gemini-routes.js`, движок) и
`routing/transparent-proxy.js` (литерал шлюза), тот же 20178 продублирован в `config.json` как
умолчание. Запуск `node gemini/src/index.js` руками без `PORT` поднимет 8080 - это ожидаемо.

**Как с этим жить.** Обычно его поднимает хаб — вкладкой «Gemini» в дашборде `:8200`
(`routing/lib/gemini-routes.js` — пульт, `routing/vendor/gemini-tab.js` — лицо).
Руками — `START.bat` в этой папке, для отладки, когда надо видеть вывод.

## Что изменено против апстрима

Всё перечислено и здесь, и в поле `_vendor` в `package.json`.

**Выброшено:**
- `src/webui/**` и `public/**` — веб-морда форка (890 КБ). Её роль играет вкладка хаба;
  нужные ручки переехали в `src/account-api.js`.
- `src/cli/**` и `bin/**` — пульт теперь вкладка.
- `postcss`/`tailwind` и сборка CSS, `async-mutex` (мёртвая зависимость).

**Дописано:**
- `src/account-api.js` — ручки аккаунтов (`GET /api/accounts`, `toggle`, `DELETE`, `reload`),
  OAuth (`GET /api/auth/url`, `POST /api/auth/complete`), статус для жизненного цикла хаба
  (`/status`, `/__keepalive/api/status`).
- `POST /__drain` в `src/server.js` + `onDrain()` — мягкая остановка: хаб просит уйти,
  сервер дожидается конца текущего ответа и выходит (иначе Claude Code видит обрыв посреди
  сообщения).

**Правки в существующем коде (три, все помечены комментарием в месте правки):**
- `src/config.js` — каталог конфига перекрывается `ANTIGRAVITY_CONFIG_DIR`; хаб выставляет его
  на эту папку, чтобы пул аккаунтов лежал здесь, а не в `~/.config/antigravity-proxy`.
- `src/constants.js` — `ACCOUNT_CONFIG_PATH` и `USAGE_HISTORY_PATH` берутся из того же каталога.
- `src/index.js` — слушает `127.0.0.1` (у апстрима `0.0.0.0`).

**Оставлено намеренно, хотя план переноса это не трогал:** legacy-путь чтения сессии
установленного приложения Antigravity (`src/auth/database.js`, `token-extractor.js`,
`native-module-helper.js`). Он даёт вход без OAuth, если приложение залогинено, а нативный
`better-sqlite3` уже стоит в корне хаба — отдельно ставить и собирать нечего.

**Не тронуто вовсе:** `src/cloudcode/**`, `src/format/**`, `src/account-manager/**`,
`src/auth/oauth.js`. Это работа с подписями thinking и схемами Google — хрупкое место,
где ошибка выглядит не падением, а «модель тупит».

## Данные

- `accounts.json` — пул: `refreshToken` (единственный секрет), тир, квота по моделям.
  **В git не уходит** (`.gitignore`). Наружу из API не отдаётся.
- `config.json` — порт и TTL-ы.
- `usage-history.json`, `logs/` — расход и логи, пишутся сами.

## Обновление копии

Апстрим живёт на GitHub, автоматического обновления тут нет. Обновлять — только вручную и
осознанно: сверить `_vendor.upstreamVersion` с релизом, взять архив, наложить **поверх папки
`src/`**, и заново посмотреть три правки из списка выше (они переживут наложение только если
их перенести руками).
