# getunikey / 11 — open-session.js: создание шлюза

Репозиторий: `C:\Users\WormAlien\Desktop\Autoreger_Clean` (живой).
Задача: создать `getunikey/open-session.js` и `getunikey/share-session.js` копированием
с эталона `kktoken`, вырезав GitHub-машинерию (у площадки нет GitHub-входа).

## Лог хода

- [x] Прочитаны ориентиры: `kktoken/open-session.js` 441 строка, `kktoken/share-session.js`
      86 строк, `hcnsec/open-session.js` 541 строка (образец вырезанного GitHub),
      `hcnsec/share-session.js` 90 строк. `kktoken/gh-sessions` существует — НЕ переносим.
- [x] Живой замер `/api/status` (2026-09-15) подтвердил вводные: `github_oauth=false`,
      `github_client_id=""`, `google_oauth=true` (client_id заполнен), `oidc_enabled=false`,
      `linuxdo_oauth=false`, `telegram_oauth=false`, `wechat_login=false`,
      `password_login_enabled=true`, `register_enabled=true`, `password_register_enabled=true`,
      `email_verification=true`, `turnstile_check=true` (hcaptcha=false),
      `system_name="UNIKEY"`, `server_address="https://www.getunikey.ai"`, version `dd3277f`.
      `GET https://www.getunikey.ai/wallet` → 200 (роут кошелька верный).
- [x] `routing/lib/ref-codes.js` уже знает `getunikey` (host `www.getunikey.ai`,
      path `/sign-up?aff=`, label `UniKey`), дефолт `6ssC` в `ref-codes.default.json`.
      Проверено резолвом: `url('getunikey')` → `https://www.getunikey.ai/sign-up?aff=6ssC`.
- [x] Создан `getunikey/open-session.js` (база — ЭТАЛОН, вырез GitHub, добавлен `preflight()`).
- [x] Создан `getunikey/share-session.js` (база — эталонный, снят как есть).
- [x] Созданы пустые `getunikey/sessions/` и `getunikey/profiles/` (git их не хранит,
      как у соседей — `.gitkeep` ни у кого нет).

## Что вырезано из open-session.js и почему

| Вырезано | Почему |
|---|---|
| `require('../routing/lib/gh-live-capture.js')` + все `ghCapture.holdOpen(context)` | Снимать GitHub-куки негде: входа через GitHub у площадки нет. Заменено локальным `holdOpen()` (4 строки), как у HCNsec. |
| `poolFile: routing/kktoken-sessions.json` | Часть gh-live-capture. |
| `seededGithub` и ветка «заселен готовый GitHub» | Заселять нечего. `seed:'github'` в снимке теперь распознаётся и ИГНОРИРУЕТСЯ (`ghSeedOnly`) — иначе файл приняли бы за готовый аккаунт друга и увели на кошелёк несуществующего аккаунта. |
| `SITE_ERRORS`: `git_token`, `state`, `user_info` | Все три про обмен GitHub-кода («failed to fetch git token», «State parameter is empty or mismatched», «failed to get user information»). Без GitHub-входа совпасть не могут никогда. Осталась одна запись — `no_register`. |
| `OAUTH_CALLBACK_RE` + `settleAfterLogin()` | Чисто GitHub-ветка («с колбэка уходим на кошелёк, reload = второй расход одноразового code»). Взамен после успешного входа — `reportRender(page)`, как у HCNsec. |
| Ветки `/github\.com/i` в `openRegisterViaRef` и в `main()` | Переписаны на `EXTERNAL_LOGIN_RE` (`accounts.google.com`): у площадки внешний вход ЕСТЬ, но это Google OAuth. Грабля та же — второй `goto` рвёт OAuth-state. |
| Папка `gh-sessions/` | Не переносится вовсе. |
| Автореги (⚡), спавны, роуты | Решение владельца: у getunikey их НЕ будет. `turnstile_check=true` — капчу проходит человек. |

## Что осталось живым

Живых вызовов GitHub нет ни одного. `grep -i github` даёт 20 строк, все — комментарии
(объяснение вырезки, как у HCNsec) плюс два `console.log` про игнорируемый `seed:'github'`
и одно сравнение `ss.seed === 'github'` — это разбор значения поля в файле снимка, не
обращение к GitHub. `ghSeedOnly` — имя переменной, тоже как у HCNsec.

## Верификация (точные выводы команд)

```
node --check getunikey/open-session.js   → OK
node --check getunikey/share-session.js  → OK
grep -n "kk\|KK\|kktoken\|20161\|Sog2" getunikey/open-session.js getunikey/share-session.js
                                         → пусто (exit 1)
git status --porcelain --untracked-files=all -- getunikey
                                         → ?? getunikey/open-session.js
                                           ?? getunikey/share-session.js
CRLF: 0 байт \r, файлы кончаются \n (оба)
```

🪤 Первый прогон residue-грепа НЕ был пустым: три строки комментариев называли эталон
по имени (`у kktoken`, `GoRouter/KKtoken/HCNsec`). Переписаны на «у ЭТАЛОНА» — проверка
из задания требует пустоты буквально, а не «кроме комментариев».

## Что осталось за кадром (не делал — не входило в задачу)

- Реестры (`BACKENDS`, `SHAPES` — уже есть, `CC_MODEL_PREFIX`, `GH_POOL_*`,
  `NEWAPI_PROFILE_DIRS`, роуты, дашборд) правит `tools/add-gateway.js`, отдельная сессия.
- `prefillLogin()` (подстановка email/пароля из `HN_LK_*`) из HCNsec НЕ переносил:
  в списке обязательного его не было, а env-переменные дашборд для getunikey пока не
  выставляет — вышел бы молчаливый no-op.
- Вторая вкладка с почтой (`openMailTab`) — тоже нет по той же причине.

