# New API v0.11.5 — HTTP API (шлюз api.wisdomsatan.club)

> Разбор HTTP-API панели **New API v0.11.5** на живом шлюзе `https://api.wisdomsatan.club`.
> Цель: авторег (регистрация логин+пароль, без капчи, без подтверждения почты) + вкладка в дашборде.
> Дата разбора: 2026-09-10.
> **Инструмент:** голый `curl` на Windows зависает в петле TLS-ренеготиации (schannel). Все пробы — Python через OpenSSL, шаблон `python -X utf8 -c "..."`.
> **Ничего не регистрировалось и не менялось на сервере — только чтение и заведомо невалидные пробы.**

---

## 0. Идентификация панели (`GET /api/status`)

Публичный эндпоинт, без авторизации. Ключевые поля конфигурации шлюза:

| Поле | Значение | Значение для авторега |
|---|---|---|
| `version` | `v0.11.5` | версия панели |
| `_qn` | `new-api` | форк QuantumNous/new-api |
| `system_name` | `麻辣烫科技` | «Malatang Tech» |
| `email_verification` | `false` | **почту подтверждать НЕ надо** |
| `turnstile_check` | `false` | **капчи Turnstile НЕТ** |
| `checkin_enabled` | `true` | чек-ин включён |
| `setup` | `true` | панель настроена |
| `quota_per_unit` | `500000` | 500000 quota = 1 единица валюты |
| `quota_display_type` | `CNY` | квота отображается в юанях |
| `usd_exchange_rate` / `price` | `7.3` | курс |
| `custom_currency_symbol` | `¤` | символ валюты |
| `github_oauth` / `wechat_login` / `telegram_oauth` / `linuxdo_oauth` / `discord_oauth` / `oidc_enabled` | `false` | сторонних OAuth нет |
| `passkey_login` | `true` | passkey доступен (нам не нужен) |
| `self_use_mode_enabled` | `false` | не self-use режим |
| `demo_site_enabled` | `false` | |
| `server_address` | `https://api.hczhw.com` | основной адрес (наш — «大陆线路», зеркало) |

`api_info`: две линии — id=1 `https://api.hczhw.com` (默认线路/дефолт), id=2 `https://api.wisdomsatan.club` (大陆线路/материковая). Наш хост — зеркало.

Вывод: **регистрация логин+пароль без капчи и без подтверждения почты подтверждена конфигом** (`email_verification=false`, `turnstile_check=false`).

---
