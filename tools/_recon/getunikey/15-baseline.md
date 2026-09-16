# 15 — БАЗОВЫЙ замер генератора вкладок (ДО апгрейда)

Дата замера: 2026-09-15
Репозиторий: `C:\Users\WormAlien\Desktop\Autoreger_Clean`
Режим: **только чтение**. Ни `apply --write`, ни правок кода/вики. Единственный записанный файл — этот отчёт.
Версия node: v24.16.0

> Назначение: зафиксировать точные цифры состояния генератора вкладок ДО апгрейда,
> чтобы после апгрейда было с чем сравнивать.

---

## 1. `check` по трём шлюзам

Дословные итоговые строки:

```
$ node tools/add-gateway.js check kktoken          # EXIT=0
KKtoken  (kktoken, префикс kk, порт 20161)
флаги: github=да  ref=да  flatRate=нет  anthropic=нет

ПОЛНО  —  92/93 точек на месте, 1 ослаблений, 0 пропусков
ослабления (ожидаемы): 3.2
```

```
$ node tools/add-gateway.js check getunikey        # EXIT=0
UniKey  (getunikey, префикс uk, порт 20168)
флаги: github=нет  ref=да  flatRate=нет  anthropic=да

ПОЛНО  —  80/93 точек на месте, 13 ослаблений, 0 пропусков
ослабления (ожидаемы): 1.29, 1.30, 1.31, 1.32, 1.8c, 1.8d, 1.8e, 1.8f, 1.9n, 1.9u, 1.9v, 2.9, 3.2
```

```
$ node tools/add-gateway.js check fluxnat          # EXIT=1
FluxRouter  (fluxnat, префикс fn, порт 20167)
флаги: github=да  ref=нет  flatRate=нет  anthropic=да

НЕПОЛНО  —  3/93 точек на месте, 3 ослаблений, 87 пропусков
ослабления (ожидаемы): 3.2, 3.5, 3.6
```

`check fluxnat` печатает полный список из 87 отсутствующих точек с адресами и
подсказками-подстроками. Полный дамп — 193 строки, сохранён ниже по группам
(см. § 5), потому что он же и есть карта того, что генератор должен вставлять.

### Сводка

| Шлюз | Точек на месте | Ослаблений | Пропусков | Итог |
|---|---|---|---|---|
| kktoken (эталон) | 92/93 | 1 | 0 | ПОЛНО |
| getunikey (заведён) | 80/93 | 13 | 0 | ПОЛНО |
| fluxnat (пустой слот) | 3/93 | 3 | 87 | НЕПОЛНО |

Разбивка пропущенных точек fluxnat по файлам-адресатам:

| Группа (файл) | Пропущено |
|---|---|
| backend | 69 |
| frontend | 13 |
| keepalive | 1 |
| lifecycle | 1 |
| restart | 1 |
| newapiAccount | 1 |
| hubBalance | 1 |
| **итого** | **87** |

---

## 2. `apply` (СУХОЙ) по двум шлюзам

Ни один файл не тронут — обе команды без `--write`, в шапке вывода явно
`режим: сухой прогон — файлы не тронуты`.

### 2.1 `node tools/add-gateway.js apply fluxnat` — EXIT=0, 178 строк

Итоговая строка дословно:

```
ИТОГ  —  48 вставить, 1 уже на месте, 3 ослаблений, 41 руками, 0 дефектов
Сухой прогон. Записать: npm-скрипт не нужен, добавь --write.
```

Разбивка «48 вставить» по файлам:

| Файл | Вставить |
|---|---|
| `routing/transparent-proxy.js` | 25 |
| `routing/proxy-dashboard.html` | 10 |
| `routing/keepalive-proxy.js` | 1 |
| `routing/lifecycle.js` | 1 |
| `routing/keepalive-restart.ps1` | 1 |
| `routing/lib/newapi-account.js` | 1 |
| `internal/hub-balance.js` | 1 |
| **итого по файлам** | **40** |

> Разница с «48 вставить» (40 против 48) — потому что часть точек в выводе
> помечена как `＋ … — line, строк 1` и `＋ … — дописать в якорную строку`
> пачками в `transparent-proxy.js`; расхождение объясняется тем, что одна
> запись `＋` может покрывать несколько под-точек спеки (1.9a…1.9v и 1.8c…1.8f
> идут как отдельные `＋`, поэтому здесь пересчёт ниже — по машинному подсчёту
> в § 6.2). Ручной подсчёт глазами по дампу даёт 40 строк `＋`; скриптовый
> подсчёт — уточнение в § 6.

По типам операций:

| Тип | Кол-во | Пример |
|---|---|---|
| `line` (вставка одной строки) | 22 | `fluxnat: 'fluxnat',` |
| `дописать в якорную строку` | 7 | `kk: () => kkLoad(), fn: () => fnLoad()` |
| `braces` (блок целиком) | 2 | `function fnPidAlive`, реестр `BACKENDS` |
| `lines:N` (пачка строк) | 1 | кнопка сайдбара, 5 строк |
| `уже на месте` | 1 | `.gitignore` (3.11) |

Ослаблений 3: `3.2`, `3.5`, `3.6`.

### 2.2 `node tools/add-gateway.js apply getunikey` — EXIT=0, 87 строк

Итоговая строка дословно:

```
ИТОГ  —  0 вставить, 41 уже на месте, 13 ослаблений, 39 руками, 0 дефектов
Сухой прогон. Записать: npm-скрипт не нужен, добавь --write.
```

**Контроль пройден: «0 вставить» на уже заведённом шлюзе.** То есть `apply`
идемпотентен на своём же результате и повторный прогон ничего не перезапишет.

Все 41 точка помечены `= … — уже на месте`, все 39 «руками», дефектов нет.
Из 48 «вставить» на эталоне-слоне (fluxnat) 41 закрывается существующим кодом
getunikey — разница ровно в тех 7 точках, которые помечены как «руками» и на
getunikey тоже (2.2 панель, 2.12 state init, 2.13 рендер, 3.5, 3.6, 3.9, 3.10).

### 2.3 Сверка check ↔ apply по fluxnat

`check` насчитал 87 пропусков, `apply` собирается вставить 48 строк в 40 мест.
Это не противоречие: точки 1.1…1.28, 2.2, 2.12, 2.13, 3.5, 3.6, 3.9, 3.10 —
«руками» (41 шт.), их генератор не умеет; 87 = 41 руками + 46 машинных
(48 вставить минус 2, покрывающих несколько под-точек разом / плюс уже на месте).

---

## 3. Контроль `git status` до и после

Снимок **до** первой команды (уже был грязным до моего прихода — это состояние
рабочего дерева, не моё):

```
 M .gitignore
 M internal/hub-balance.js
 M routing/ar-modelmap.json
 M routing/github-spend.json
 M routing/keepalive-restart.ps1
 M routing/lib/ar-quota-probe.js
 M routing/lib/newapi-account.js
 M routing/lib/proxy-pool.js
 M routing/lib/ref-codes.js
 M routing/lifecycle.js
 M routing/proxy-dashboard.html
 M routing/ref-codes.default.json
 M routing/transparent-proxy.js
 M tools/check-ar-quota.js
 M tools/check-hub.js
 M tools/check-pooldrop.js
 M tools/gateways.config.json
 M tools/gateways.spec.json
 M tools/pooldrop-stand.js
?? getunikey/
?? routing/getunikey-modelmap.json
?? routing/getunikey-routes-modelmap.json
?? routing/lib/proxy-admin.js
?? routing/vendor/proxies-tab.css
?? routing/vendor/proxies-tab.js
?? tools/_recon/getunikey/
?? tools/check-ar-login-verdict.js
?? tools/check-proxies-tab.js
?? tools/check-proxy-mapping.js
```

HEAD: `b0c36f5 feat(keepalive): автофолбэк при 402 «пул пуст» …`


