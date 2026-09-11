# wisdomsatan: конвертер или Anthropic-путь — решение

> Шлюз `api.wisdomsatan.club` (New API v0.11.5, форк QuantumNous/new-api). 22 модели:
> GPT-5.x, Gemini-3.x, DeepSeek-v4, картиночные. **Ни одной claude-модели.**
> Все 22 объявляют `supported_endpoint_types: ["openai"]`. Панель в `/api/pricing`
> при этом объявляет, что умеет `anthropic: POST /v1/messages`.
>
> Вопрос: имеет ли смысл клонировать KKtoken (эталон на Anthropic-пути через SSE
> keepalive), если у шлюза нет ни одной claude-модели, а keepalive гонит запрос в
> `/v1/messages`?
>
> Дата разбора: 2026-09-10. Замер живым ключом делает владелец (у агента ключа нет).

---

## TL;DR

1. **Клон KKtoken НЕ бессмысленен без claude-моделей.** Клон переписывает тир
   (opus/sonnet/haiku) в целевую модель шлюза через `PREFIX-modelmap.json` и релеит её на
   `/v1/messages`. Отсутствие claude-моделей неважно — маппим тиры на gpt/gemini/deepseek.
   Единственное, что решает, — **принимает ли `/v1/messages` шлюза его же openai-модель.**

2. **Замер должен идти РЕАЛЬНОЙ моделью шлюза (gpt-5.x/gemini/deepseek), а НЕ
   `claude-opus-5`.** `claude-opus-5` на `/v1/messages` вернёт model_not_found просто
   потому, что claude-моделей нет, — и это ложно укажет «Anthropic-путь сломан».

3. **Прецедент JustWoker (канон §6) — довод ЗА сценарий A, а не против.** Там
   `/v1/messages` с `gpt-5.6-sol` отдал **200**, сломан был `/v1/chat/completions`
   (Cloudflare 403), и конвертер оказался лишним. New API обычно обслуживает
   openai-модели через `/v1/messages` внутренней конверсией — значит у wisdomsatan
   сценарий A скорее всего сработает.

4. **Писать новый конвертер НЕ надо.** `custom-openai-proxy.js` уже generic (порт/URL/
   ключ/маппинг из конфига) и умеет reasoning DeepSeek — он новее и лучше эталона §6
   (`agentrouter-proxy.js`).

5. **Быстрый путь моделей за ноль кода — вкладка Custom** (шлюз добавляется как
   провайдер, конвертер поднимается сам). Цена — теряешь пул-авторотацию, баланс,
   чек-ин, авторег и keepalive-выживание.

**Рекомендация: сначала замер `/v1/messages` реальной моделью. 200 → сценарий A (полный
клон KKtoken, маппинг тиров на gpt, без конвертера). Не 200, а 200 только на
`/v1/chat/completions` → сценарий C (Custom-провайдер) как немедленное решение; сценарий B
только если баланс/чек-ин/авторег реально нужны и не жаль потерять keepalive.**

---

## 1. `routing/keepalive-proxy.js` — что дёргает и что будет на 404/400

### Что это

SSE keepalive-прокси между Claude Code и **Anthropic-совместимым** шлюзом. Один скрипт,
шесть живых экземпляров (по порту): :20133 agentrouter, :20155 tabi, :20156 gorouter,
:20157 xpeach, :20158 justwoker, :20159 seekai. KKtoken поднимает свой на :20161.

### Какой путь апстрима дёргает

**Транспарентный релей: путь берётся из запроса клиента, не хардкодится.** Claude Code
шлёт `POST /v1/messages`, `POST /v1/messages/count_tokens`, `GET /v1/models` — прокси
пересылает их на `${UPSTREAM}${reqPath}`, где `UPSTREAM` = корень хоста без `/v1`
(например `https://kktoken.cc`). То есть основной боевой путь — **`/v1/messages`
(Anthropic-формат)**. Тело запроса релеится как есть (с ремапом модели, см. ниже);
формат Anthropic внутрь, формат Anthropic наружу. **Конвертации OpenAI здесь нет
вообще.**

Единственное место, где прокси сам формирует запрос, — фоновый рефреш каталога:
`GET ${upBase}/v1/models` (строка ~858), чтобы проверять карту тиров против реального
ассортимента шлюза.

### Что делает с моделью (ремап)

`remapHaiku()` (строки ~1175–1268) переписывает поле `model` в теле:
- `claude-opus/sonnet/haiku` с замапленным тиром в `PREFIX-modelmap.json` → целевая
  модель шлюза (claude-цель уходит в тот же шлюз pass-through);
- **`gpt-*` / не-claude → уводятся на ОТДЕЛЬНЫЙ конвертер** (`HAIKU_GPT_PROXY`,
  по умолчанию `:20132` = agentrouter-proxy).

🔴 **Ключевое ограничение для wisdomsatan.** Увод gpt на конвертер включается флагом
`GPT_PROXY_ENABLED`, а он `true` **только если `UPSTREAM=agentrouter.org`** (или явный
`GPT_PROXY_FORCE=1`):

```js
let GPT_PROXY_ENABLED = !!HAIKU_GPT_PROXY
  && (process.env.GPT_PROXY_FORCE === '1' || /(^|\.)agentrouter\.org$/i.test(upstream.hostname));
```

Значит для чужого шлюза (`api.wisdomsatan.club`) при `GPT_PROXY_ENABLED=false`
gpt-модель в `remapHaiku` **возвращает `null` → passthrough как есть в `/v1/messages`**.
То есть голый keepalive отправит `{"model":"gpt-5.x", ...}` в Anthropic-эндпоинт
`/v1/messages` шлюза. Сработает это или нет — зависит ровно от того, умеет ли
`/v1/messages` шлюза принять OpenAI-модель (это и есть замер владельца).

### Что будет, если апстрим ответит 404/400 на `/v1/messages`

- `shouldRetryStatus()` (строка ~905): ретраятся 400/401/403/429/5xx. **404 НЕ
  ретраится** — уходит клиенту как есть.
- Для 400 включается `isTransientBody()`: словарь `RETRY_NO` содержит `bad request` и
  `not supported` → 400 «модель не поддерживается на этом пути» будет классифицирован
  как **постоянная ошибка**, ретрая не будет, ошибка уйдёт в Claude Code.
- `ROUTE_MISS_RE` (`model_not_found|no available channel|无可用渠道`) → тоже постоянная,
  отдаётся сразу (до пре-коммита, обычным HTTP-кодом, который CC умеет показать).

Вывод: **keepalive не «чинит» отсутствие Anthropic-пути.** Он либо прозрачно
доставит рабочий ответ (если `/v1/messages` шлюза принимает gpt-модель), либо прозрачно
доставит ошибку 404/400/model_not_found. Своей конвертации у него нет.

### Есть ли у него режим OpenAI-пути

Нет. Единственный «OpenAI-режим» — делегирование gpt-запросов ВНЕШНЕМУ конвертеру
(:20132), и то под флагом только для agentrouter. Сам keepalive в `/v1/chat/completions`
не ходит и Anthropic↔OpenAI не преобразует.

### Что нужно от wisdomsatan в shared-файлах keepalive

Канон §3.1: в `keepalive-proxy.js` для нового шлюза дописывают `FLAT_RATE_HOSTS`
(если тариф плоский) и `GW_BY_HOST` (`'api.wisdomsatan.club': 'ws'`) для авторотации
аккаунтов. Это не про конвертацию, а про биллинг и ротацию пула.

---

## 2. `routing/agentrouter-proxy.js` — конвертер-эталон

### Что на входе / выходе

- **Вход:** Anthropic-формат от Claude Code, `POST /v1/messages` (+ `count_tokens`,
  `GET /v1/models`). Слушает `:20132`, `127.0.0.1`.
- **Выход:** для gpt/не-claude — OpenAI-формат на `/v1/chat/completions` апстрима;
  claude-модели идут pass-through в `/v1/messages` (агентроутер их умеет).
- Ответ апстрима (OpenAI) конвертируется обратно в Anthropic перед отдачей клиенту.

### Как транслируется

**System-промпт** (`systemToText`): Anthropic `system` (строка ИЛИ массив блоков) →
плоский текст → первое OpenAI-сообщение `role: system`.

**Сообщения** (`convertClaudeToOpenAI`):
- user со строковым content → как есть;
- `tool_result` → отдельное сообщение `role: tool` c `tool_call_id: tr.tool_use_id`;
- text/image → `role: user` (мультимодально `image` → `image_url` data-URL);
- assistant: text-блоки склеиваются в `content`, `tool_use` → `tool_calls[]`
  (`function.name` + `arguments: JSON.stringify(input)`).

**Tools:** `tools[].input_schema` → `function.parameters`; `tool_choice` auto/any/tool →
auto/required/{function}.

**Стрим** (`handleStreaming`): читает OpenAI SSE построчно, эмитит правильную
Anthropic-последовательность: `message_start` → `ping` → `content_block_start/delta/stop`
(text и tool_use раздельно, tool-аргументы как `input_json_delta`) → `message_delta`
(со `stop_reason` из `finish_reason`) → `message_stop`. То есть чинит ровно то, из-за
чего у agentrouter gpt-стрим на `/v1/messages` был сломан.

**count_tokens:** локальная оценка ~4 симв/токен (шлюз этот путь 404-ит).

### Объём и привязка к AgentRouter

Файл ~1023 строки. Из них:
- **Чистая конвертация (переиспользуемое ядро):** `systemToText`,
  `contentPartsFromClaude`, `toolResultToText`, `convertClaudeToOpenAI`,
  `convertOpenAIToClaude`, `mapStopReason`, `handleStreaming`, `sseWrite` — **~250
  строк, к AgentRouter НЕ привязаны.**
- **Привязка к AgentRouter (замена/выкидывание при клонировании):**
  - `UPSTREAM_BASE = 'https://agentrouter.org'`, `ACTIVE_KEY_FILE = ar-active-key.txt`,
    `MODELMAP_FILE = ar-modelmap.json`, `LISTEN_PORT = 20132`, `createLogger('ar')`;
  - `CC_HEADERS` — WAF агентроутера ждёт заголовки Claude Code;
  - **весь WAF-слой (~200+ строк):** `WAF_PHRASES`, `wafSanitize`, base64-стриппинг
    `IMAGE_B64_RE`, cyrillic-байпас (сейчас выключен), `dumpBlocked`, `wafbisect` CLI,
    `CONTENT_FILTER_RE`. Это лечение конкретного Cloudflare/WAF агентроутера —
    другому шлюзу нужно проверять живым запросом (канон §6.7 грабля 3).
  - `applyModelMap` / тир-маппинг — специфика того, что у agentrouter есть claude-цели.

Итого: **ядро конвертации переносимо, обвязка (WAF + ключи + порт) специфична.**
Канон §6.2 так и предписывает: скопировать `agentrouter-proxy.js`, заменить ключ/URL/
порт/префикс, а WAF-обвязку «проверить живым запросом».

---

## 3. Все конвертеры в репо — сравнение

В репо **четыре** Anthropic→OpenAI конвертера. Все построены на одном ядре
(`convertClaudeToOpenAI` / `convertOpenAIToClaude` / `handleStreaming` — байт-в-байт
похожи), различаются обвязкой:

| Файл | Порт | Апстрим | Конфиг | reasoning (thinking) | WAF | Claude passthrough |
|---|---|---|---|---|---|---|
| `agentrouter-proxy.js` | 20132 (хардкод) | agentrouter.org (хардкод) | ar-modelmap.json | нет | **да, тяжёлый** | да (claude-цели) |
| `freemodel-openai-proxy.js` | 20130 (хардкод) | freemodel.dev (хардкод/env) | fm-openai-config.json (BIG/MIDDLE/SMALL) | нет | нет | нет |
| `vyceai-openai-proxy.js` | 20131 (хардкод) | vyceai.com (хардкод) | vyceai/config.js | нет | нет | нет |
| **`custom-openai-proxy.js`** | **из конфига** | **из конфига** | **JSON argv[2]** | **да** | нет | нет |

### Какой брать за образец

🎯 **`custom-openai-proxy.js` — самый свежий и самый универсальный, и он уже generic.**
Три причины, каждая важна для wisdomsatan:

1. **Полностью параметризован конфиг-файлом.** `port`, `upstream`, `keyFile`,
   `modelMap`, `providerName` — всё приходит из JSON (`argv[2]`), который пишет
   `transparent-proxy.js`. Ничего не хардкодит. Три остальных конвертера прибиты к
   своему хосту гвоздями (порт и URL в константах).

2. **Умеет `reasoning_content` → `thinking`-блок.** DeepSeek и прочие reasoner'ы шлют
   мысли отдельным полем; старые конвертеры (agentrouter/freemodel/vyce) его молча
   выбрасывали, и у reasoner'а, потратившего весь бюджет на размышления, ответ
   приходил **пустым**. `custom-openai-proxy.js` это чинит (ветки `delta.reasoning_content`,
   `ensureThinkBlock`, `REASONING_AS`). **wisdomsatan держит DeepSeek-v4 — это ровно тот
   случай.**

3. **Без WAF-обвязки.** У agentrouter ~200+ строк специфичного лечения Cloudflare
   (cyrillic-байпас, `WAF_PHRASES`, base64-стриппинг, `wafbisect`). Для нового шлюза это
   мёртвый балласт, который к тому же лечит НЕ его WAF. custom берёт чистое ядро.

**Итог:** новый конвертер под wisdomsatan писать НЕ нужно (в отличие от того, что
предполагает канон §6.2 «скопировать agentrouter-proxy.js»). `custom-openai-proxy.js`
уже делает ровно это — конвертирует Anthropic↔OpenAI для произвольного OpenAI-хоста,
заданного конфигом. Вопрос лишь в том, как его запитать под wisdomsatan (см. §4).

🪤 **Оговорка про WAF.** Канон §6.7 грабля 3: некоторые New API-шлюзы режут CC-специфику
(`x-anthropic-billing-header:`, фразу `you are a helpful assistant.`) и отвечают
`500 sensitive words detected`. custom-конвертер этой защиты НЕ несёт. Если замер
владельца на OpenAI-пути wisdomsatan даст такие 500 — придётся либо портировать
`wafSanitize()` из agentrouter в custom, либо (если WAF молчит) ничего не делать.
Проверяется тем же живым ключом.



## 4. Вкладка «Custom» — можно ли просто завести шлюз туда

### Как устроена

Хранилище — `routing/custom-providers.json` (массив `providers[]`: `id`, `name`,
`baseUrl`, `keys[]` с флагом `active`, `modelMap`, `protocol`, `mode`, `proxyPort`,
`proxyPid`). Кеш каталогов — `routing/custom-models-cache.json` (baseUrl → список
моделей, TTL 5 мин свежий / 24 ч stale, переживает рестарт). Бэкенд —
`handleCustom*` в `transparent-proxy.js` (~3693–4774), роуты `/__switch/api/custom/*`.

**Тип провайдера определяется сканом** (`customDetectProtocol`, ~3938): дёргает
`GET {baseUrl}/models` и пробит `POST /messages` + `/v1/messages` стандартной моделью
`claude-opus-5[1m]`:

| protocol | что значит | как подключается |
|---|---|---|
| `anthropic` | роут `/v1/messages` есть и стандартную claude-модель принимает | **direct** — CC ходит прямо на `baseUrl`, конвертер не нужен |
| `mapped` | роут `/v1/messages` есть, но claude-модель отклоняет | маппинг тиров + конвертер |
| `openai` | роута `/messages` нет (404/405) | **только конвертер** |

`customNeedProxy`: `mode` (ручной тумблер) > `protocol` (скан) > эвристика по modelMap.
Для `openai`/`mapped` → нужен конвертер.

**Активация** (`handleCustomActivate`, ~4459): пишет ключ в
`~/.claude/custom-active-key.txt`, и если нужен конвертер — `customSpawnProxy` поднимает
**`custom-openai-proxy.js`** на свободном порту 20150–20250, пишет ему конфиг-файл
(`~/.claude/custom-{id}-proxy.json`: port/upstream/keyFile/modelMap/providerName) и
направляет CC через `ANTHROPIC_BASE_URL=http://localhost:{port}`. То есть **это ровно тот
самый generic-конвертер из §3, только запускаемый и параметризуемый автоматически.**

### Можно ли просто завести wisdomsatan как custom-провайдера — ДА

Прецедент прямо в конфиге: как custom-провайдеры **уже** заведены другие New API-форки
с OpenAI-only каталогом — `api.hcnsec.cn`, `emtf.aipm9527.xyz`, `newapi.makelove.cloud`
(последний **прямо сейчас живёт** конвертером на `proxyPort: 20156`, `proxyPid: 34940`).
Каталог `hcnsec.cn` в кеше — DeepSeek-V4-Flash/Pro, glm, kimi (`owned_by: openai`) —
**та же форма, что у wisdomsatan.**

Практически: на вкладке Custom «добавить провайдера» → `name`, `baseUrl`
`https://api.wisdomsatan.club/v1`, вставить ключ → скан определит `openai` → активация
поднимет `custom-openai-proxy.js` → GPT/Gemini/DeepSeek-модели заработают в Claude Code.
**Ноль строк кода.** DeepSeek-v4 отдаёт reasoning отдельным полем — конвертер это умеет
(§3), мысли не потеряются.

🪤 Оговорки к чистому Custom-пути:
- Диапазон портов конвертеров (20150–20250) **пересекается** с keepalive-портами флота
  (20155–20162). `customFindFreePort` берёт свободный сокет, но занятость определяется в
  момент спавна — если keepalive шлюза в этот момент лежал, конвертер займёт его порт.
- Если OpenAI-путь wisdomsatan прикрыт WAF (500 sensitive words) — custom-конвертер это
  НЕ лечит (нет `wafSanitize`). Замер владельца покажет.

### Что теряется при чистом Custom (против клона KKtoken)

| Возможность | KKtoken-клон | Custom-провайдер |
|---|---|---|
| Пул аккаунтов | да (`keys[]` + автозаведение) | да (`keys[]`), но список руками |
| **Авторотация** ключа на 402/403 | да (`askRotate`/`GW_BY_HOST`) | **нет** — ключ переключаешь кликом |
| **Баланс** (чек, шкала-gauge, деньги) | да (`xxBalance`/MONEY_GW) | **нет** |
| **Чек-ин** (ежедневный) | да | **нет** |
| **keepalive-выживание** (пинги в паузах, пре-коммит, hold, retry, count_tokens, подмена мёртвой модели) | да (весь `keepalive-proxy.js`) | **нет** — голый конвертер |
| GitHub-пул / share-import профилей / авторег | да (GH_POOL_*) | **нет** |
| Реф-коды | да | нет |

🔴 **Главная потеря — keepalive-выживание.** Custom-конвертер (`custom-openai-proxy.js`)
шлёт `message_start`+`ping` один раз и дальше молчит до первого байта апстрима. Если
DeepSeek-v4 «думает» дольше ~20с до первого reasoning-токена, Claude Code словит
`Stream idle timeout`. KKtoken-клон этого не допускает (пинги каждые IDLE_MS). Для
reasoner-моделей это реальный риск, зависящий от того, как быстро шлюз отдаёт первый
reasoning-чанк.



## 5. Итоговая рекомендация по трём сценариям

### Замер-развилка (делает владелец, до всего)

Взять активный ключ и модель, которая у шлюза ЕСТЬ (по каталогу — `gpt-5.x`,
`gemini-3.x` или `deepseek-v4-*`; **не** `claude-opus-5`):

```bash
KEY=...            # активный ключ wisdomsatan
MODEL=gpt-5.x      # РЕАЛЬНАЯ модель из каталога, не claude-*

# Anthropic-путь (транспорт KKtoken-клона)
curl -sS -X POST https://api.wisdomsatan.club/v1/messages \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":20,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"

# OpenAI-путь (транспорт конвертера / Custom)
curl -sS -X POST https://api.wisdomsatan.club/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":20,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
```

> ⚠️ Инструмент: по research-файлу 12 голый `curl` на Windows виснет в петле TLS
> (schannel) на этом хосте — гонять пробу Python-ом через OpenSSL, как в `_probe.py`.

### (A) Прямой клон KKtoken на Anthropic-пути — если `/v1/messages` дал 200

**Условие:** замер `/v1/messages` реальной моделью → 200.

**Что делать:** канон §0–§5 целиком (copy-paste KK-блока, замены `kk→ws`/`KK→WS`/
`kktoken→wisdomsatan`/host/порт/цвет/иконка/реф, 9 реестров backend + 14 точек frontend +
7 shared-файлов). `PREFIX-modelmap.json` (§3.9): `opus`/`sonnet`/`haiku` → три модели
шлюза (например opus→лучшая gpt, sonnet→средняя, haiku→быстрая gemini/deepseek).
Конвертер НЕ нужен (§6 пропускаем).

**Цена:** велика по числу точек, но механическая — ошибок мало, если брать эталон
дословно (грабли §5 канона). Порт keepalive следующий свободный — **20163** (проверить
`grep -n 'port: 201' routing/lifecycle.js`).

**Что получаем:** всё — пул + автозаведение, авторотация, баланс+шкала, чек-ин,
GitHub-пул, реф-коды, и главное **keepalive-выживание** (пинги в паузах DeepSeek,
пре-коммит, hold, подмена мёртвой модели, count_tokens).

**Что теряем:** ничего относительно других шлюзов флота.

### (B) Клон KKtoken + конвертер `ws_gpt` по §6 — если работает ТОЛЬКО OpenAI-путь

**Условие:** `/v1/messages` реальной моделью → 404/400/model_not_found, а
`/v1/chat/completions` → 200.

**Что делать:** клон вкладки как в (A) для UI/пула/баланса/авторега/чек-ина, ПЛЮС
конвертер по §6. **Но эталон брать не `agentrouter-proxy.js` (как пишет §6.2), а
`custom-openai-proxy.js`** — он новее, generic и умеет reasoning. Активация шлюза должна
направлять CC на порт конвертера, а не на keepalive.

🔴 **Скрытая цена B: keepalive-выживание всё равно теряется.** Транспорт моделей —
конвертер (Anthropic→OpenAI), а весь `keepalive-proxy.js` (пинги/пре-коммит/hold) живёт
только на Anthropic→Anthropic пути, которого здесь нет. То есть B даёт
пул/баланс/чек-ин/авторег, но по надёжности потока = сценарий C. Это самый большой объём
работы за неполный результат.

**Вывод по B:** оправдан, только если баланс/чек-ин/авторег критичны, а модели через
конвертер терпимы. Иначе — либо A (если замер позволит), либо C.

### (C) Вкладка-клон для пула/баланса — модели через существующий Custom-провайдер

**Условие:** нужен быстрый рабочий доступ к моделям; либо `/v1/messages` не отдаёт модели.

**Что делать (немедленно, ноль кода):** вкладка Custom → добавить провайдера,
`baseUrl = https://api.wisdomsatan.club/v1`, вставить ключ. Скан → `openai` → активация
сама поднимет `custom-openai-proxy.js`. GPT/Gemini/DeepSeek работают в Claude Code.

**Цена:** ноль строк. Один клик «добавить» + вставить ключ.

**Что теряем:** авторотацию ключей на 402/403, баланс и шкалу, чек-ин, GitHub-пул и
интеграцию авторега, keepalive-выживание (риск `Stream idle timeout` на медленном
reasoner'е). Пул ключей есть, но список ведётся руками, без автозаведения.

🪤 Формулировка задачи «(C) вкладка-клон ДЛЯ пула + модели через custom» —
внутренне противоречива: если модели уже идут через Custom-конвертер, второй клон-вкладки
KKtoken для того же шлюза только дублирует UI и путается под ногами (у KK-клона транспорт
— keepalive, а не конвертер). Либо чистый Custom (это и есть быстрый C), либо полноценный
B. «Половинки» нет.

### Сводка

| | A (клон, Anthropic) | B (клон + конвертер) | C (Custom) |
|---|---|---|---|
| Условие | `/v1/messages`+модель = 200 | только `/v1/chat/completions` = 200 | всегда |
| Код | полный клон §0–5 | полный клон + §6 (взять `custom-openai-proxy`) | **ноль** |
| Пул/автозаведение | да | да | ключи руками |
| Баланс/шкала/чек-ин | да | да | нет |
| keepalive-выживание | **да** | нет (транспорт = конвертер) | нет |
| Модели GPT/Gemini/DeepSeek | да | да | да |
| Трудозатраты | высокие | **высшие** | минимальные |

**Порядок действий:** (1) владелец гоняет два curl'а реальной моделью; (2) 200 на
Anthropic → **A**; (3) 200 только на OpenAI → сначала **C** как рабочее решение сегодня,
**B** позже и только под нужду в балансе/авторег/чек-ине.

