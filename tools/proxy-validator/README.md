# Proxy Scraper & Checker

Сборщик и чекер бесплатных публичных прокси (HTTP / HTTPS / SOCKS4 / SOCKS5) на чистом Python 3 (только стандартная библиотека, без зависимостей).

Собирает прокси из ~109 источников (GitHub-списки + API агрегаторов), проверяет их на живость через сырые сокеты, отсеивает мёртвые, умеет валидировать под целевые домены и формат Dolphin Anty.

## Возможности

- Скрап с 100+ источников параллельно (потоки + кэш одинаковых URL)
- Авто-карантин: источники, которые не отвечают или дают < 2% живых, автоматически переносятся из `config/proxy_services.json` в `config/bad_service.json`
- Быстрая проверка через raw sockets: HTTP GET через прокси, SOCKS4/4a и SOCKS5 хендшейки вручную
- Глобальная дедупликация `ip:port` между источниками перед проверкой
- TCP-префильтр: быстрый connect-проб отсекает мёртвые адреса за ~3 сек до полного хендшейка
- Прогресс-бары, цветной вывод, корректная обработка Ctrl+C (найденное сохраняется)
- Атомарная запись результатов (`os.replace` + fsync)

## Быстрый старт

```bat
run_proxy.bat
```

или вручную:

```bat
.venv\Scripts\activate
python main.py
```

Требования: Python 3.10+ (проверено на 3.13). Внешних зависимостей нет.

## Режимы работы

Запуск без аргументов показывает интерактивное меню. Режим также задаётся флагом `--mode N`.

### 1. Скрап публичных прокси → `export/proxies.txt`

Параллельно тянет списки со всех активных источников и сразу проверяет живость. Результат — только рабочие прокси.

```bat
python main.py --mode 1 --protocol socks5 --check-workers 600 --max-per-source 3000
```

Основные параметры:

| Флаг | По умолчанию | Описание |
|---|---|---|
| `--services-file` | `config/proxy_services.json` | Список источников |
| `--protocol` | `all` | `http` / `https` / `socks4` / `socks5` |
| `--threads` | 220 | Потоки скрапа |
| `--timeout` | 6 | Таймаут загрузки источника, сек |
| `--max-per-source` | 0 (без лимита) | Ограничение прокси с одного источника |
| `--check-workers` | 600 | Параллельных проверок прокси |
| `--check-timeout` | 6 | Таймаут проверки прокси, сек |
| `--prefilter-timeout` | 3.0 | Таймаут TCP connect-проба перед полной проверкой (0 = выкл) |
| `--no-dedupe` | выкл | Не удалять дубли ip:port между источниками |
| `--check-limit` | 5000 | Размер пакета проверки на источник |
| `--runtime-source-min-valid-rate` | 0.02 | Источник переносится в bad_service.json, если alive < 2% после порога |
| `--out-file` | `export/proxies.txt` | Файл результата |

Выходные файлы:
- `export/proxies.txt` — живые прокси (`ip:port`, одна строка = один прокси)
- `export/proxy_sources.txt` — те же прокси, сгруппированные по источникам, с URL источника

### 2. Строгая проверка `export/proxies.txt` → `export/protocols/*.txt`

Повторная строгая валидация с сортировкой по протоколам: `http.txt`, `https.txt`, `socks4.txt`, `socks5.txt`.

```bat
python main.py --mode 2 --workers 220 --timeout 6
```

### 3. Проверка по целевым доменам → `export/domains/*.txt`

Прогоняет прокси из `export/protocols/*` через реальные сайты из `config/domain_targets.json` (mail.ru, steam, twitch, instagram и т.д.). Пишет файлы по каждому домену и `export/all_valid.txt` (прошли все включённые цели).

```bat
python main.py --mode 3 --workers 160 --timeout 8
```

Цели включаются/выключаются флагом `"enabled"` в `config/domain_targets.json`.

### 4. Dolphin-стиль проверка → `export/dolphin_proxy/*`

Проверка в формате, совместимом с импортом в Dolphin Anty (расширенный таймаут, ретраи).

```bat
python main.py --mode 4 --workers 80 --timeout 15 --retries 1
```

## Конфигурация

- **`config/proxy_services.json`** — активные источники. Формат записи:
  ```json
  {
    "name": "TheSpeedX SOCKS5",
    "url": "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt",
    "protocol": "SOCKS5",
    "parser": "regex",
    "enabled": true,
    "origin_repo": "https://github.com/TheSpeedX/PROXY-List"
  }
  ```
  `parser`: `regex` (парсит `ip:port` из любого текста/HTML) или `geonode` (JSON API geonode).
  Если файла нет — создаётся из дефолтов (`proxy_scraper/services.py`).
- **`config/bad_service.json`** — карантин: нерабочие/низкоурожайные источники с причиной и статистикой последнего прогона.
- **`config/domain_targets.json`** — целевые сайты для режима 3.

## Структура проекта

```
main.py                    # точка входа, выбор режима
proxy_scraper/
  scraper.py               # загрузка и парсинг источников (ProxyScraper)
  checker.py               # быстрая проверка прокси через raw sockets (ProxyChecker)
  strict_checker.py        # строгая проверка для режима 2
  domain_checker.py        # проверка по доменам (режим 3)
  dolphin_checker.py       # проверка формата Dolphin (режим 4)
  public_mode.py           # режим 1: скрап + проверка + авто-карантин источников
  valid_mode.py            # режим 2
  domain_mode.py           # режим 3
  dolphin_mode.py          # режим 4
  services.py              # дефолтный список источников, загрузка JSON
  proxy_io.py              # парсинг строк ip:port / user:pass@host:port
  models.py                # dataclass-модели
  console_ui.py            # цветной вывод и прогресс-бары
config/
  proxy_services.json      # источники
  bad_service.json         # карантин источников
  domain_targets.json      # целевые домены
export/
  proxies.txt              # результат режима 1
  protocols/               # результат режима 2
  domains/                 # результат режима 3
  dolphin_proxy/           # результат режима 4
```

## Замечания по скорости

- Узкое место — сетевые таймауты, а не CPU: потоки при I/O отпускают GIL, поэтому 600+ воркеров работают эффективно.
- Мега-источники (fyvri ~300K, rix4uni ~130K записей) сильно увеличивают объём скрапа. Для обычного прогона используйте `--max-per-source 2000..5000`.
- Windows: при большом количестве проверок полезно расширить диапазон эфемерных портов:
  ```bat
  netsh int ipv4 set dynamicport tcp start=1025 num=64510
  ```

## Дисклеймер

Проект для образовательных целей. Бесплатные публичные прокси небезопасны: не передавайте через них логины, пароли и платёжные данные.
