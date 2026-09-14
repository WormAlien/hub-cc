# Карта поверхности клонирования — эталон `kktoken` (шлюз `kk`, порт 20161)

Аудит только на чтение. Вопрос: **полон ли список из 10 файлов в `tools/gateways.spec.json`** —
клонирование нового шлюза с эталона `kktoken` правит ~40 мест по всему репо, и забытый файл
даёт не ошибку, а тихую полуработу.

Маркеры поиска: `kktoken` · `kk` (short) · `KK` / `KK_` / `KKtoken` (UPPER) · `kktoken.cc` (хост) ·
`20161` (порт) · `🪙` (иконка) · `Sog2` (реф-код).

Исключено из области: `node_modules/`, `.git/`, `_sandbox/`, `_research/`, `logs/`, `manual_sessions/`.

Состояние на: 2026-09-13. Спека: 93 точки, 10 файлов в `files`.

---

## Файлы вне спеки — НАЙДЕНЫ

Все пути — от корня репо. «Обязателен ли» = попадёт ли шлюз в тихую полуработу, если файл
не поправить при клонировании `kktoken` → новый шлюз.

### Живой рантайм (`routing/`, `internal/`) — 11 файлов

| Файл | Что там | Обязателен ли |
|---|---|---|
| `routing/health-probe.js` | Строки 84, 107: `const PROBE_HOSTS = [... 'kktoken.cc']` и **реестр `GATEWAYS`** `kk: { tag:'kktoken', label:'KKtoken', host:'kktoken.cc', base:'https://kktoken.cc/v1', keyName:'kktoken', ignoresMaxTokens:true }`. Плюс спец-ветки `tag === 'kktoken'` (382, 384, 515, 702, 704) и предупреждение «игнорирует max_tokens» | **ДА.** Без записи проба здоровья не увидит шлюз молча: он просто не появится в списке |
| `routing/health-catalog.js` | Строки 105 (`kktoken: 'kktoken-modelmap.json'` — реестр тир-карт), 153 (`{ key:'kk', bk:'kktoken', label:'KKtoken', host:'kktoken.cc' }`), 200 (`kktoken.cc` в массиве хостов), 233 (кэш `kktoken: [...]`) | **ДА.** Каталог моделей вкладки «Модели» пуст без строки 105/153 |
| `routing/health-reliability.js` | Строка 75: `kktoken: Number(process.env.KK_KEEPALIVE_PORT \|\| 20161)` — **прямой хардкод порта шлюза** | **ДА.** Без строки у нового шлюза не считается надёжность пула |
| `routing/pool-watchdog.js` | Строки 73-74: `{ backend: 'kktoken', port: 20161 }` в списке опроса; строка 270-272 — комментарий-инвариант «сейчас семь» (счётчик!) | **ДА.** Вотчдог молча не следит за упавшим шлюзом |
| `routing/rescue.js` | Строка 253: `[20161, 'KKtoken keepalive', '/__keepalive/api/status']` — таблица аварийного подъёма | **ДА.** RESCUE не поднимет keepalive нового шлюза |
| `routing/finance-backfill.js` | Строка 26: `kktoken: 'kktoken-sessions.json'` — маппинг тег→файл пула для до-заливки финансов | **ДА (деньги).** История расходов шлюза не забэкфиллится |
| `routing/lib/github-session.js` | Строка 51: `{ tag: 'kk', dir: path.join(ROOT,'kktoken','profiles'), host: 'kktoken.cc' }` — **реестр хостов GitHub-заселения** | **ДА.** Без строки `hostToTag('новый-хост')` вернёт `null`, и заселение GitHub-сессий молча не сработает (комментарий этого и не скрывает) |
| `routing/lib/custom-ports.js` | Строка 30: `20161, 20162, 20163, 20164,  // kktoken, hcnsec, aipm, wisdomsatan` — список занятых портов | **ДА.** Порт нового шлюза не попадёт под защиту от коллизий |
| `routing/frontdoor-proxy.js` | Строка 201 — только комментарий-ссылка на замер 04.09 | Нет (документация) |
| `routing/health-agg.js` | Строка 301 — только комментарий | Нет (документация) |
| `internal/hub-balance.js` | **УЖЕ В СПЕКЕ** (3.8), строка 28: `{ id:'kk', file:'kktoken-sessions.json', name:'KKtoken' }` | в спеке |

Необязательные (только тексты, но полезны как образец): `routing/health-agg.js:301`,
`routing/frontdoor-proxy.js:201`.

### Оболочки и встроенные лаунчеры — 2 файла

| Файл | Что там | Обязателен ли |
|---|---|---|
| `routing/statusline-autoreger.sh` | **7 мест**: 264 (путь `kktoken-active-key.txt`), 293-294 (`localhost:20161`/`127.0.0.1:20161`), 317 (`kktoken.cc`), 349, 385 (маппинг префикса), 696-697 (gauge баланса из `routing/kktoken-sessions.json`), 945 (список провайдеров) | **ДА.** Статуслайн покажет «unknown» и нулевой баланс |
| `routing/keepalive-restart.ps1` | **УЖЕ В СПЕКЕ** (3.4). Строка 4 — шапка-список портов; 58-59 — блок `20161 = @{ UPSTREAM='https://kktoken.cc'; KEY_FILE=...; MODELMAP_FILE=... }` | в спеке (но см. замечание: 3.4 проверяет только форму ключа) |

### Документация и служебное

| Файл | Что там | Обязателен ли |
|---|---|---|
| `ARCHITECTURE.md` | Разделы `§ KKtoken (kk)`; упоминания в шапке-списке шлюзов | Нет (документация) — но чекер `check-kktoken.js` отсылает читателя именно туда |
| `.gitignore` | **УЖЕ В СПЕКЕ** (3.11). По `check-kktoken.js:410` обязаны быть 4 строки: `kktoken/profiles/`, `kktoken/sessions/`, `kktoken/gh-sessions/`, `routing/kktoken-sessions.json` — спека покрывает только последнюю | в спеке частично |

### `tools/` — чекеры и утилиты (НЕ в спеке)

| Файл | Что там | Обязателен ли |
|---|---|---|
| `tools/check-kktoken.js` | **Пошлюзовый регресс эталона.** 35 КБ, ~60 проверок. Именно он — источник истины о том, «что обязано быть»; спека писалась с него | Обязателен как **эталон для нового чекера**, не как правка |
| `tools/git-pull-safe.js` | Строка 48: `'routing/kktoken-modelmap.json'` в списке локально-ценных файлов, которые нельзя терять при `git pull` | **ДА.** Тир-карта нового шлюза будет затираться pull'ом |
| `tools/check-lk-lock.js` | Строка 73-74: цикл `[['ar','agentrouter'], ..., ['kk','kktoken']]` — проверка блокировки ЛК | Да, если шлюз с ЛК-входом |
| `tools/check-hub.js` | Строка 998: `const want = ['fin','league',...,'kktoken','aipm','hcnsec',...]` — эталонный `DEFAULT_TABS_VISIBLE` в проверке дашборда | **ДА.** Чекер дашборда начнёт ругаться (или наоборот — не заметит) |
| `tools/check-modelmap-merge.js` | Строка 165: список шлюзов `['agentrouter','gorouter','kktoken','aipm','hcnsec',...]` | Да |
| `tools/check-provider-sort.js` | Строки 114-116: `opts.kk` — эталон сортировки провайдеров | Да |
| `tools/check-ref-codes.js` | Строки 60, 76-82, 109: число живых провайдеров (**«восемь»** — счётчик!), `url('kktoken') === 'https://kktoken.cc/sign-up?aff=Sog2'`, дефолт `Sog2` | Да |
| `tools/check-journal-tail.js` | Строки 143, 147: `bk: 'kktoken'`, `p: 'kktoken', id: 'kk_1'` — фикстуры журнала | Нет (тестовый образец) |
| `tools/check-hold-window.js` | Строки 88, 319 — комментарии с живым случаем 03.09 | Нет (документация) |
| `tools/check-hcnsec.js` | Строки 6, 112, 215, 404: комментарии + `strayLit` regex `('go'\|'kk'\|...\|kk-[a-z]\|hc-[a-z])` — детектор чужих префиксов в блоке | Да, если делать чекер нового шлюза |
| `tools/check-league.js` | Строки 75, 188: `load('kktoken-sessions.json')` | Да |
| `tools/check-league-chat.js` | Строка 152: `loadFrom('kktoken-sessions.json')` | Да |
| `tools/check-league-hub-groups.js` | Строка 161: `loadFrom('kktoken-sessions.json')` | Да |
| `tools/check-league-receiver.js` | Строка 1343: `load('kktoken-sessions.json')` | Да |
| `tools/events.js` | Строки 11-12, 38: `20161` в примерах и подсказке CLI | Нет (пример в usage) |
| `tools/check-add-gateway.js` | Строки 18, 27: «эталон (kktoken) перестал давать 100%» — самопроверка инструмента | Нет (мета-инструмент) |
| `tools/add-gateway.js` | Строки 30, 32, 189: `check kktoken` / `plan kktoken` в usage; 189 — комментарий про формы порта | Нет (генератор, читает `gateways.config.json`) |

### Мёртвое / историческое

| Файл | Что там | Обязателен ли |
|---|---|---|
| `routing/transparent-proxy.bak-before-media-2026-09-10-06-22-50.js` | Полная допотопная копия бэкенда (~30 упоминаний `kktoken`). Не исполняется | **Нет.** Не править, но и не считать за «место» |
| `_sandbox/`, `_research/`, `.tmp-split/`, `.routes-audit/` | Черновики и отчёты аудита (`.routes-audit/handlers-a.md`, `save-functions.md`, `model-lists-a.md`) | Нет (артефакты) |


## Папка шлюза: состав

_(заполняется)_

## Маркеры для поиска нового шлюза

_(заполняется)_
