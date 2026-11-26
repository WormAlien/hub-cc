# Ферма UncensoredLabs

Скрипты кнопки «Авторега» на вкладке `uc` дашборда `:8200`.

Почта - SmailPro, отдельный Camoufox-процесс с JSON-lines stdin/stdout.
Текущий конвейер: форма signup -> ссылка подтверждения -> login -> API key
-> отдельная запись в банк и пул. Полный непрерывный сценарий и trial wallet
ещё требуют live-приёмки; один успешный mail-test не принимает ферму целиком.

## Что здесь лежит

| файл | зачем |
|---|---|
| `uc_farm_full.py` | конвейер: аккаунт → ключ → пул. Его спавнит кнопка |
| `uc_mail_smailpro.py` | отдельный почтовый процесс: open/adopt/inbox/msg/link/code |
| `uc_pool.py` | запись в `routing/uncensoredlabs-sessions.json` в форме `ucLoad()` |
| `requirements.txt` | зависимости venv |
| `socks-alive.example.txt` | формат списка прокси |
| `tests/test_uc_mail_smailpro.py` | offline regression tests почтового reader, без browser/signup |
| `uc_mail_rpc.py` | транспорт к процессу-ящику: reader-threads, монотонные таймауты, redaction |
| `tests/test_uc_mail_rpc.py` | реальные subprocess-тесты транспорта (23 шт) |
| `tests/test_uc_farm_mail.py` | интеграционные тесты фермы↔ящик (4 шт) |

🪤 Пути считаются **от файлов**, не хардкодом: скрипт лежит в
`<repo>/uncensoredlabs/farm/`, пул — в `<repo>/routing/`. Прежняя версия брала
всё из Windows-specific Hermes scratch (`%LOCALAPPDATA%\hermes\cache\scratch\…`),
и кнопка не работала на другой машине или при чистом клоне.

## Установка

Нужен venv **рядом с этим каталогом** — хаб ищет именно его.

```bash
cd uncensoredlabs/farm
python -m venv .venv                      # Python 3.11–3.12, на 3.14 не соберётся
.venv/Scripts/python -m pip install -r requirements.txt
.venv/Scripts/python -m camoufox fetch    # сам браузер Camoufox
```

Проверка, что хаб найдёт интерпретатор:

```bash
.venv/Scripts/python -c "from camoufox.sync_api import Camoufox; print('ok')"
```

## Переопределения (все необязательные)

| переменная | по умолчанию |
|---|---|
| `UC_FARM_DIR` | `<repo>/uncensoredlabs/farm` |
| `UC_FARM_PYTHON` | `<UC_FARM_DIR>/.venv/{Scripts,bin}/python[.exe]`, иначе `PYTHON` или `python` |
| `UL_POOL` | `<repo>/routing/uncensoredlabs-sessions.json` |
| `UL_BANK` | `<UC_FARM_DIR>/bank.jsonl` |

## Почему ключ обязан попасть в пул

`bank.jsonl` — наш журнал всех попыток, включая провалы без ключа. Дашборд
читает **другой** файл — `routing/uncensoredlabs-sessions.json`. Раньше ключ
уходил только в банк, поэтому кнопка создавала аккаунт и в UI не появлялось
ничего. `save_pool()` пишет вторым шагом: только записи с ключом, в форме
`ucLoad()`, без дублей по ключу.

## Границы

- Прокси скрапит сама кнопка перед запуском и кладёт в `socks-alive.txt`.
  Статичный список здесь — только фолбэк, прокси живут минуты.
- `status` в пуле ставится `unknown`, не `live`: подтверждает сам хаб через
  `ucProbe`. Ложный `live` у мёртвого ключа портит ротацию сильнее.
- Регистрация тратит реальные аккаунты площадки. Лимит на IP — 5/24ч, вендор
  его не снимает.

## Почтовая диагностика и проверки

`payload` нельзя хранить на весь прогон: SmailPro выдаёт новый по той же
тройке `{address,timestamp,key}` перед каждым inbox/message. Устаревший
payload в read-only A/B26.11 дал `NetworkError`, свежий - HTTP200.
HTTP403/503 - ошибка чтения, не успешный пустой inbox.

Ссылки читаются из HTML до удаления тегов, с декодированием entities и
проверкой hostname `uncensoredlabs.dev`. Письмо отмечается прочитанным
только после получения непустого body: transient error/пустое тело допускают
повтор. То же правило используется для `wait_code`.

Из корня farm: `.venv/Scripts/python.exe -m unittest discover -s tests -v`.
Тесты не создают аккаунтов, не скрапят прокси и не открывают браузер.

`smailpro_box.json` - один перезаписываемый snapshot, не история ящиков.
Перед adopt сравнивать `addr` с `triple.address` и адресом конкретной попытки.
Тройку, payload, коды, пароли и verification query не выводить в лог/вики.
`perIp=1` означает один аккаунт на каждый прокси; public `count` кнопки не
является общим лимитом попыток. Суточный egress budget не реализован.

## Транспорт ферма↔ящик

`uc_mail_rpc.py` держит reader-threads на stdout/stderr: non-JSON диагностика
редактируется и уходит в on_log (в ферме это `log("smailpro-mail:", ...)`),
stderr не копится в мёртвой трубе. `ask()` даёт один монотонный бюджет на
write+reply; таймаут/EOF/десинк ядовиты - после них нужен новый процесс.
`close()` сначала посылает quit, потом киляет ровно дерево PID (taskkill /T /F)
и reap-ит: прежний terminate() оставлял node/Camoufox-детей висеть.
