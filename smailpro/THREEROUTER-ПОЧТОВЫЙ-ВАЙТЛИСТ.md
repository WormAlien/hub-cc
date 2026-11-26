# Вайтлист почтовых доменов ThreeRouter

Снято живьём 25.11.2026: `GET /api/v1/settings/public` →
`registration_email_suffix_whitelist` (**172 домена**), плюс
`registration_email_domain_quota_enabled = true`,
`registration_email_domain_quota_window = daily`.

Полный машиночитаемый список: `tr_whitelist.json` (scratch).

## Главное

- Регистрация принимает **только** эти 172 домена. `@gmail.com` в списке.
- 🔴 **Квота на домен — суточная.** Даже свободный адрес может упереться в лимит
  по домену, а не по IP: массовая рега на один домен сама себя ограничивает.
- `force_email_on_third_party_signup = false` — через OAuth (GitHub/Google)
  почта формально не требуется, но `email_verify_enabled = true` для обычной реги.

## Пригодные для автореги (47 из 172)

Публичный приём, есть API или алиасы:

| домен | чем удобен |
|---|---|
| `@gmail.com` | основной, но сейчас занятые адреса из пула smailpro |
| `@outlook.com`, `@hotmail.com`, `@live.com`, `@msn.com` | **+алиасы** (`user+1@outlook.com`) — один ящик, много адресов |
| `@icloud.com` | Hide My Email даёт генеративные адреса |
| `@yahoo.com`, `@ymail.com`, `@rocketmail.com` | Yahoo, есть disposable-алиасы |
| `@aol.com` | тот же движок, что Yahoo |
| `@protonmail.ch`, `@pm.me` | Proton + алиасы |
| `@zoho.com`, `@zohomail.com` | Zoho, бесплатный тариф с алиасами |
| `@gmx.com`, `@gmx.net`, `@web.de`, `@freenet.de`, `@gmx.de` | GMX-семейство, есть трэш-алиасы |
| `@mail.com` | десятки доменов-алиасов на одном аккаунте |
| `@tutanota.com`, `@tuta.io`, `@tuta.com` | Tuta |
| `@fastmail.com`, `@hey.com` | платные, но с генеративными алиасами |
| `@yandex.com`, `@ya.ru`, `@yandex.ru` | Яндекс |
| `@mail.ru`, `@inbox.ru`, `@list.ru`, `@bk.ru`, `@internet.ru`, `@rambler.ru` | Mail.ru группа |
| `@hushmail.com`, `@mailfence.com`, `@mailbox.org`, `@posteo.de`, `@posteo.net` | приватные, принимают |
| `@seznam.cz`, `@wp.pl`, `@o2.pl`, `@onet.pl`, `@interia.pl` | EU-провайдеры |
| `@naver.com`, `@daum.net`, `@ukr.net` | KR/UA |

## Остальные 125

Локальные ISP и национальные домены (`@orange.fr`, `@comcast.net`,
`@bigpond.com`, `@terra.com.br`, `@nifty.com`, …) — принимаются, но бесплатного
API для приёма писем у них нет, нужен реальный ящик.

Полный перечень — `tr_whitelist.json` или `GET /api/v1/settings/public`.
