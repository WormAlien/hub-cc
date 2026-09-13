# 502 HPE_INVALID_CONTENT_LENGTH на `/model agentrouter/gpt-6-astra`

Сессия 2026-09-13, репо `C:\Users\WormAlien\Desktop\Autoreger_Clean`.
Файл пишется инкрементально: каждый факт — сразу на диск.

---

## Поправка к брифу №1: лог front-door ЕСТЬ

Бриф говорит «у front-door нет файла лога в `logs/`». Он есть, просто не в `logs/`:

```
routing/frontdoor-proxy.log   1 122 892 байт, mtime 2026-09-13 04:35 (живой)
```

В нём ровно **7** совпадений `HPE_`, все — `agentrouter`:

```
7039:[2026-09-12T09:42:36.168Z] POST /v1/messages agentrouter: HPE_INVALID_CONTENT_LENGTH
7057:[2026-09-12T09:45:14.570Z] POST /v1/messages agentrouter: HPE_INVALID_CONTENT_LENGTH
7370:[2026-09-12T16:55:43.319Z] POST /v1/messages?beta=true agentrouter: HPE_INVALID_CONTENT_LENGTH
7379:[2026-09-12T16:59:16.479Z] POST /v1/messages agentrouter: HPE_INVALID_CONTENT_LENGTH
7381:[2026-09-12T16:59:19.129Z] POST /v1/messages?beta=true agentrouter: HPE_INVALID_CONTENT_LENGTH
7400:[2026-09-12T17:40:10.775Z] POST /v1/messages?beta=true agentrouter: HPE_INVALID_CONTENT_LENGTH
7993:[2026-09-13T01:33:13.871Z] POST /v1/messages?beta=true agentrouter: HPE_INVALID_CONTENT_LENGTH
```

## Факт №1: каждому HPE непосредственно предшествует `gpt-6-astra`, и только он

Полный список: перед всеми 7 HPE стоит строка роутинга именно `gpt-6-astra`.

```
[2026-09-13T01:33:11.435Z] POST /v1/messages?beta=true ▸agentrouter (префикс модели): agentrouter/gpt-6-astra → gpt-6-astra → http://localhost:20133
[2026-09-13T01:33:13.871Z] POST /v1/messages?beta=true agentrouter: HPE_INVALID_CONTENT_LENGTH   ← +2.4 с
```

Через **тот же** код-путь (`routed` + локальный апстрим `:20133` + строка `:620`)
успешно ходят `deepseek-v4-flash` (928 запросов) и `opus-5`/`claude-opus-5` (1302).
Значит установка `content-length` на `:620` **одинакова для всех трёх** и сама по себе
объяснить избирательность не может — разница где-то по имени модели.

## Факт №2: `remapForRemote()` для agentrouter НЕ вызывается вовсе

`routing/frontdoor-proxy.js:652-658` — весь блок под `if (!state.local)`.
Апстрим agentrouter — `http://localhost:20133`, `local: true`. Значит:

- строка `:656` (`headers['content-length'] = …` после `remapForRemote`) на этом пути
  мертва;
- ветка `:658` (`else if (!mm && …/claude-/i…`) — тоже;
- ключ/`authorization` не подставляются (чистый релей, как и написано в контракте).

Гипотеза брифа про «двойную установку `:620` + `:656`» для **этого** бага не работает.
Но проверить её отдельно на удалённом шлюзе всё равно надо — там она может быть жива.

## Факт №3: HPE прилетает из обработчика ошибок ВОСХОДЯЩЕГО запроса

Строка лога собирается на `routing/frontdoor-proxy.js:730`:

```js
log(`${req.method} ${reqPath} ${state.backend}: ${e.code || e.message}${retried ? …}`);
```

Это `upReq.on('error')` (`:712`…`:731`). У Node-**клиента** `HPE_*` возникает при
разборе **ОТВЕТА**, а не запроса: свой собственный запрос клиент не парсит. Если бы
запрос был битым, парсер бы упал на приёмнике (`:20133`), тот ответил бы `400 Bad
Request` и порвал сокет — front-door увидел бы `400`/`ECONNRESET`, а не `HPE_*`.

Промежуточный вывод: **портит заголовок не front-door, а то, что отвечает
`:20133`** — либо keepalive сам, либо он релеит битые заголовки шлюза дальше.
Front-door при этом виноват в другом: он показывает владельцу 502 с текстом, который
уводит расследование в `content-length` **запроса**, хотя сломан `content-length`
**ответа**.

## Факт №4: КОРЕНЬ. Ломает `keepalive-proxy.js`, и он УЖЕ ПОЧИНЕН на диске

Цепочка (по логу `:20133`, `routing/keepalive-20133.log:19749-19754`):

```
[2026-09-13T01:33:11.436Z] >> POST /v1/messages?beta=true start
[2026-09-13T01:33:11.437Z] POST /v1/messages?beta=true gpt-6-astra via http://127.0.0.1:20132
[2026-09-13T01:33:11.437Z] POST /v1/messages?beta=true model-echo: gpt-6-astra → gpt-6-astra[1m] (окно клиента 1M)
[2026-09-13T01:33:13.870Z] POST /v1/messages?beta=true -> 200 2434ms          ← не-SSE!
```

и в тот же миг у front-door:

```
[2026-09-13T01:33:13.871Z] POST /v1/messages?beta=true agentrouter: HPE_INVALID_CONTENT_LENGTH   ← +1 мс
```

Разница между `gpt-6-astra` и работающими `deepseek-v4-flash`/`opus-5` — **не в
front-door**, а в том, куда keepalive уводит gpt-модели:

- `gpt-*` → конвертер Anthropic→OpenAI `http://127.0.0.1:20132`
  (`routing/keepalive-proxy.js:97,103`: `HAIKU_GPT_PROXY`), потому что у agentrouter
  gpt через `/v1/messages` сломан;
- конвертер отвечает **chunked** (`transfer-encoding: chunked`) — длину в момент
  заголовков он не знает;
- keepalive на не-SSE ветке буферизует тело целиком и, если MODEL_ECHO дописал
  `[1m]` к имени модели, **выставляет свой `content-length`**;
- в одном ответе оказываются `content-length` И `transfer-encoding: chunked` — по
  RFC 9112 §6.2 невалидная пара. Node-парсер у **клиента** (front-door) роняет её как
  `HPE_INVALID_CONTENT_LENGTH`.

`deepseek`/`opus` идут прямо на `agentrouter.org` (не через `:20132`) и SSE-веткой —
там длина не дописывается, пары не возникает.

### Правка уже в файле (сделана 12.09, не мной)

`routing/keepalive-proxy.js:1780-1785`:

```js
if (hdrs['content-length'] && (hdrs['transfer-encoding'] || hdrs['Transfer-Encoding'])) {
    hdrs = Object.assign({}, hdrs);
    delete hdrs['transfer-encoding'];
    delete hdrs['Transfer-Encoding'];
}
```

И сторож в selftest — `routing/keepalive-proxy.js:2882-2888`. Комментарий там описывает
ровно этот случай, включая дату «живой случай 12.09».

## Факт №5: почему владелец всё ещё видит 502 — процесс СТАРЫЙ

```
PID 23660  keepalive-proxy.js   старт 12.09.2026 19:53:09 MSK   ← слушает :20133
файл       keepalive-proxy.js   mtime 12.09.2026 20:38:31 MSK   ← правка на 45 мин ПОЗЖЕ
```

`netstat`: `127.0.0.1:20133 → PID 23660`, `127.0.0.1:20132 → PID 27260`,
`127.0.0.1:20100 → PID 13308` (front-door, старт 19:53:08), `:8200 → PID 35496`.

Node читает файл один раз при старте. Значит **в памяти `:20133` живёт код без
`delete hdrs['transfer-encoding']`** — правка на диске, но не в процессе. Последний HPE
в логе (13.09 01:33) — это старый процесс, а не незакрытый баг в коде.

Восстановить работу можно **только рестартом `:20133`**. Рестартовать нельзя мне
(живая сессия владельца) — оформлено задачей ниже.
