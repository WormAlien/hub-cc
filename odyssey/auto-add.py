#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
odyssey/auto-add.py

Авторегистрация аккаунта Odyssey с ОДНИМ ручным шагом - кликом по капче.
Всё остальное делает скрипт: берёт прокси из общего пула, берёт gmail-ящик на 22.do,
заполняет форму Clerk, проходит ALTCHA, ждёт клик человека, добирает код из письма,
создаёт API-ключ и печатает машинный маркер результата.

🔴 Про капчу - замер 16.09 переписал первый вывод. У Clerk стоит Cloudflare Turnstile
(sitekey `0x4AAAAAAAWXJGBD7bONzLBd`), и он **не всегда требует человека**: требовательность
зависит от IP выхода. На одном тест-прокси (`.251.60`) регистрация уходила молча, за 9 секунд
после «Continue» - ни одного клика; на другом (`.150.84`) Clerk показал отдельный виджет
«Verify you are human», и его клик в Camoufox не проходил. Поэтому шаг с кликом оставлен как
АВАРИЙНЫЙ: скрипт ждёт до 10 минут, и если человек подойдёт и прожмёт - прогон продолжится;
на «хорошем» адресе этого не требуется вовсе.

Что делает скрипт сам: прокси из пула → gmail-ящик на 22.do → форма Clerk → ALTCHA
(proof-of-work, считается виджетом) → ожидание регистрации → код из письма → ключ.

Шаги печатаются строками `stage: <имя>` - их разбирает дашборд, чтобы показать прогресс
(так же устроены соседние автореги). Результат - маркером в одну строку:

    OD_AUTOADD_RESULT {"ok":true,"key":"sk-ody-...","email":"...","label":"..."}

Запуск:
  python odyssey/auto-add.py acct_1 [--tier own|scraper|none] [--proxy <строка прокси>]

`--proxy` закрепляет конкретный адрес (`http://user:pass@ip:port`) и пул не спрашивает -
это нужно, чтобы проверять зависимость от IP, а не верить в неё.

Коды возврата (их читает дашборд, см. `JW_AUTOADD_FAIL` у соседей):
  0 - аккаунт заведён, ключ снят
  2 - капча не была пройдена (регистрация так и не ушла)
  3 - код из письма не получен
  4 - аккаунт есть, но ключ снять не удалось
  5 - прокси не получен: пул отказал (напрямую не идём намеренно)
  6 - ящик на 22.do не взят (gmail не выпал или сайт изменился)
  7 - сеть уже получала подарочные $5: аккаунт вышел бы с нулевым балансом, не берём его
"""

import asyncio
import importlib.util
import json
import random
import re
import sys
import urllib.request
from datetime import datetime
from pathlib import Path

from camoufox import AsyncCamoufox

sys.path.insert(0, str(Path(__file__).resolve().parent))
# 🔴 Решатель Turnstile берём из `anymodel/lib/camoufox_anymodel.py`, а не пишем свой.
# Там он проверен живой регистрацией на площадке с той же капчей: ищет виджет по ТЕКСТУ
# («Verify you are human») и по классу `.cf-turnstile`, кликает настоящими событиями мыши
# по координатам и признаёт успех по токену в скрытом поле. Моя первая попытка искала
# `iframe[src*=challenges…]` и не находила ничего - отсюда «мышка не едет»: кликать было нечему.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "anymodel" / "lib"))
try:
    from camoufox_anymodel import solve_turnstile  # noqa: E402
except Exception as _e:   # noqa: BLE001
    solve_turnstile = None
    _SOLVER_ERR = str(_e)

from od_common import (  # noqa: E402
    API_KEYS_URL, CONSOLE_URL, DIR, LAST_PROXY, POOL_HOST, POOL_PREFLIGHT_PATH,
    BILLING_URL, SIGNUP_URL, acquire_fresh_proxy, acquire_proxy, click_button_by_text,
    fetch_22do_code, flat, goto_retry, open_log, pick_22do_gmail, short_url,
)

REC_DIR = DIR / "recordings"
# 🪤 Свои служебные файлы лежат В ПОДПАПКЕ `sessions/_meta/`. Рядом с боевыми
# сессиями им делать нечего: `odyssey/sessions/<label>.json` - это storageState
# для кнопки 🌐, и совпадение имени сломало бы вход в аккаунт (наш JSON прочитали
# бы как снимок сессии).
SESSION_DIR = DIR / "sessions" / "_meta"

# Сколько ждать, пока регистрация уйдёт сама. 🪤 По умолчанию коротко и это НЕ экономия
# на человеке: замер 16.09 показал, что на «строгом» адресе виджет Turnstile не нажимается
# НИ из кода, НИ рукой - ждать там нечего, надо менять адрес. На «хорошем» адресе
# регистрация уходит за 9 секунд. Окно можно поднять флагом `--captcha-wait`, если владелец
# хочет успеть подойти и нажать сам.
CAPTCHA_WAIT_S = 75
OTP_WAIT_S = 200
KEY_WAIT_S = 90
KEY_RE = re.compile(r"\bsk-(?:ody-)?[A-Za-z0-9_-]{24,}\b")


def gen_password():
    """Пароль не должен совпадать с адресом: Clerk отдаёт на это 422 (ловили 16.09)."""
    chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "Od" + "".join(random.choice(chars) for _ in range(12)) + "!7"


# Открытые окна, которые надо закрыть на любом выходе.
#
# 🔴 Зачем. Провальные прогоны выходили из `main` через `return`, не закрывая контекст
# Camoufox: окно оставалось жить, а запись HAR (она пишется при закрытии контекста) не
# появлялась вовсе - то есть у провала не оставалось ни разбора трафика, ни снимка. Разбор
# четырёх подряд неудач 16.09 пришлось вести по одним строчкам лога, где половина причин
# была записана неверно. Теперь выход один - через `close_open()`.
OPEN_CMS = []


async def close_open():
    """Закрывает все поднятые окна. Ошибка закрытия не должна подменять код возврата."""
    while OPEN_CMS:
        cm = OPEN_CMS.pop()
        try:
            await cm.__aexit__(None, None, None)
        except Exception:
            pass


async def dump_captcha_state(site, label, log):
    """Что было на странице в момент, когда регистрация не ушла.

    🔴 Замер 16.09 вечером: три провала подряд записаны одной строкой «капча не пройдена»,
    и по ней нельзя отличить строгий адрес от незагрузившейся страницы. Разбор постфактум
    невозможен, поэтому состояние снимаем в момент отказа: адрес страницы, фреймы Cloudflare
    с их размерами (виджет Turnstile - отдельный фрейм), наличие полей формы, текст формы.
    """
    try:
        log("РАЗБОР", f"страница: {short_url(site.url)}")
    except Exception:
        pass
    try:
        frames = []
        for f in site.frames:
            try:
                el = await f.frame_element()
                box = await site.evaluate(
                    "el => { const r = el.getBoundingClientRect(); return {w: Math.round(r.width), h: Math.round(r.height)}; }",
                    el)
            except Exception:
                box = {"w": -1, "h": -1}
            frames.append((f.url or "about:blank", box))
        log("РАЗБОР", f"фреймов на странице: {len(frames)}, из них решаемых: "
                      f"{sum(1 for u, _ in frames if 'challenge' in u or 'turnstile' in u)}")
        for u, b in frames:
            if "challenge" in u or "turnstile" in u or b["w"] > 40:
                log("РАЗБОР", f"   фрейм {b['w']}×{b['h']}: {short_url(u)[:90]}")
    except Exception as e:
        log("РАЗБОР", f"фреймы не перечислились: {flat(str(e), 70)}")
    for what, sel in (("поле адреса", "input#emailAddress-field"),
                      ("поле пароля", "input#password-field"),
                      ("кнопка Continue", "button.cl-formButtonPrimary"),
                      ("виджет ALTCHA", "input[id^='altcha-checkbox']")):
        try:
            n = await site.locator(sel).count()
            vis = 0
            for i in range(min(n, 3)):
                try:
                    if await site.locator(sel).nth(i).is_visible():
                        vis += 1
                except Exception:
                    pass
            log("РАЗБОР", f"   {what}: найдено {n}, видимых {vis}")
        except Exception:
            pass
    try:
        text = flat(await site.inner_text("body"), 300)
        log("РАЗБОР", f"текст страницы: {text}")
    except Exception:
        pass
    try:
        shot = REC_DIR / f"fail-{label}.png"
        await site.screenshot(path=str(shot), full_page=False)
        log("РАЗБОР", f"снимок: {shot.name}")
    except Exception:
        pass


def stage(name, note=""):
    """Этап прогона. Печатается ДВАЖДЫ, и это не дубль.

    Человекочитаемая строка `stage: …` идёт в лог и в панель прогона; машинный маркер
    `OD_STAGE {json}` читает дашборд, чтобы нарисовать шаг. Так же сделано у соседних
    авторег (`RM_STAGE` у rumeng), и причина ровно та, что записана у них: индикатор,
    привязанный к формулировке текста, однажды молча покажет не тот шаг.
    """
    print(f"stage: {name}" + (f" | {note}" if note else ""), flush=True)
    print("OD_STAGE " + json.dumps({"stage": name, "note": note or None}, ensure_ascii=False),
          flush=True)


async def register_in_dashboard(label, email, key, log, password=None):
    """Заводит аккаунт в пул дашборда ЕГО ЖЕ ручкой, а не своей записью в файл.

    🪤 Писать `routing/odyssey-sessions.json` из Python нельзя: дашборд делает это
    durable-записью (`durableWriteJson`) и держит в файле свои поля. Вторая реализация
    записи в тот же файл однажды разъедется с первой - в этом репозитории так уже было.
    Ручка `POST /__switch/api/od/add` принимает `{email, api_key, name, password}` и сама
    решает, считать ключ настоящим.

    Дашборд может быть не запущен: тогда это не ошибка прогона, а повод сказать об этом
    вслух - ключ всё равно уезжает маркером.

    Возвращает `id` аккаунта: по нему называется файл сессии для кнопки 🌐 (`acct_<id>`).
    """
    payload = {"email": email, "api_key": key, "name": label}
    if password:
        # Пароль в записи нужен человеку: зайти в кабинет руками и не гадать, что там было.
        payload["password"] = password
    body = json.dumps(payload).encode("utf-8")
    try:
        req = urllib.request.Request("http://127.0.0.1:8200/__switch/api/od/add",
                                     data=body, method="POST")
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=15) as r:
            ans = json.loads(r.read().decode("utf-8") or "{}")
        log("ДАШБОРД", f"аккаунт заведён в пул: {ans.get('id')}")
        return ans.get("id")
    except Exception as e:
        log("ДАШБОРД", f"в пул не завёл ({flat(str(e), 80)}) - ключ всё равно в маркере")
        return None


async def save_browser_session(ctx, site, account_id, log):
    """Складывает куки и localStorage аккаунта туда, откуда их берёт кнопка 🌐.

    🔴 Без этого аккаунт в пуле есть, а войти в него нельзя: `odyssey/open-session.js`
    открывает СВОЙ профиль (`acct_<id>`) и подкладывает в него снимок сессии из
    `odyssey/sessions/acct_<id>.json`. Регистрация же проходит в профиле Camoufox
    (Firefox), и оттуда куки никто не забирал - отсюда «ни баланс не почекать, ни зайти
    обратно» (владелец, 16.09).

    Формат - ровно `storage_state()` Playwright: `{cookies, origins}`. Он браузерно-
    нейтральный, поэтому Firefox-снимок открывается в Chromium-профиле дашборда.
    """
    if not account_id:
        log("СЕССИЯ", "id аккаунта неизвестен (дашборд не ответил) - снимок не сохранён")
        return False

    # 🔴 Снимаем НЕ сразу, а после перезагрузки кабинета. `__session` у Clerk живёт минуту,
    # и держит сессию кука `__refresh_v-…`, которую браузер получает при следующей загрузке
    # страницы. Снимок, взятый сразу после шага с ключом, приходил БЕЗ неё - и кабинет
    # отвечал 307 (замер 16.09: у снимка с refresh 200, без него 307 при одинаковых
    # остальных куках). Поэтому сначала заходим в кабинет и даём Clerk поставить refresh.
    try:
        await site.goto(CONSOLE_URL, wait_until="domcontentloaded", timeout=45000)
        await site.wait_for_timeout(6000)
    except Exception as e:
        log("СЕССИЯ", f"кабинет перед снимком не открылся ({flat(str(e).splitlines()[0], 60)}) - снимаю как есть")

    # 🪤 Одного захода мало. `__refresh_v-…` Clerk ставит не в тот же момент, что
    # `__session`, и снимок без неё выглядит целым, но кабинет его не принимает (307).
    # Поэтому снимаем с ПРОВЕРКОЙ: нет refresh - ждём и заходим ещё раз, до трёх попыток.
    state = None
    for snap in range(1, 4):
        try:
            state = await ctx.storage_state()
        except Exception as e:
            log("СЕССИЯ", f"снять куки не удалось: {flat(str(e), 80)}")
            return False
        names = [c.get("name", "") for c in (state.get("cookies") or [])]
        if any(n.startswith("__refresh") for n in names):
            break
        if snap < 3:
            log("СЕССИЯ", f"refresh-куки ещё нет (попытка {snap}) - захожу в кабинет снова")
            try:
                await site.goto(CONSOLE_URL, wait_until="domcontentloaded", timeout=45000)
            except Exception:
                try:
                    await site.reload(wait_until="domcontentloaded", timeout=45000)
                except Exception:
                    pass
            await site.wait_for_timeout(8000)

    cookies = [c for c in (state.get("cookies") or [])
               if "odysseyapi.tech" in (c.get("domain") or "")]
    origins = [o for o in (state.get("origins") or [])
               if "odysseyapi.tech" in (o.get("origin") or "")]
    out = DIR / "sessions" / f"acct_{account_id}.json"
    try:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps({"cookies": cookies, "origins": origins},
                                  ensure_ascii=False, indent=1), encoding="utf-8")
    except Exception as e:
        log("СЕССИЯ", f"записать снимок не вышло: {flat(str(e), 80)}")
        return False
    log("СЕССИЯ", f"✅ куки аккаунта сохранены для кнопки 🌐: {out.name} "
                  f"({len(cookies)} кук, {len(origins)} origin'ов)")
    return True



async def bind_account_proxy(account_id, log):
    """Связывает аккаунт с ТЕМ ЖЕ прокси, через который он зарегистрирован.

    🔴 Зачем. Ключ липкости у дашборда - сам `accountId` (`stickyKey` возвращает его), а
    авторега шла под ключом окна. Пока привязки разные, чек баланса идёт через ДРУГОЙ
    адрес, а `cf_clearance` Cloudflare привязан к IP: кабинет отвечает 307, и баланс не
    читается. Выравниваем сразу после регистрации, когда id уже известен.
    """
    label = LAST_PROXY.get("label")
    if not account_id or not label:
        log("ПРОКСИ", "привязку аккаунта пропускаю: нет id аккаунта или метки прокси")
        return False
    cmd = ["node", str(DIR.parent / "routing" / "lib" / "proxy-for.js"),
           "--bind-key", account_id, "--bind-label", label]
    proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE,
                                                stderr=asyncio.subprocess.PIPE)
    raw, _ = await proc.communicate()
    text = (raw or b"").decode("utf-8", "replace").strip()
    line = [l for l in text.splitlines() if l.strip().startswith("{")]
    if not line:
        log("ПРОКСИ", f"привязку выровнять не вышло (код {proc.returncode})")
        return False
    ans = json.loads(line[-1])
    if ans.get("bound"):
        log("ПРОКСИ", f"аккаунт привязан к своему прокси: {ans.get('proxy')}")
        return True
    log("ПРОКСИ", f"привязка не удалась: {ans.get('error')}")
    return False



async def mark_network_used(log):
    """Записывает сеть (ASN) прокси в список траченных: `odyssey/networks-used.json`.

    🔴 Зачем. Подарок $5 даётся «one account per network» - дословно из кабинета. Значит
    сеть, с которой аккаунт уже заводили, для подарка мертва, и следующий прогон обязан
    взять ДРУГУЮ. Без учёта пул снова выдаст тот же адрес (или соседний из того же ASN -
    наши тест-прокси 154.221.x и 154.219.x оказались одной сетью AS202656), и подарок
    потеряется молча: аккаунт будет, а $5 на нём - нет.
    """
    label = LAST_PROXY.get("label")
    if not label:
        return
    m = re.search(r"//([^:/]+)", label)
    if not m:
        return
    ip = m.group(1)
    try:
        req = urllib.request.Request(f"http://ip-api.com/json/{ip}?fields=as,isp,country")
        with urllib.request.urlopen(req, timeout=10) as r:
            info = json.loads(r.read().decode("utf-8") or "{}")
    except Exception as e:
        log("СЕТЬ", f"ASN не спросился ({flat(str(e), 60)}) - в траченные не записал")
        return
    asn = str(info.get("as") or "").strip()
    if not asn:
        log("СЕТЬ", "ASN пустой - в траченные не записал")
        return
    out = DIR / "networks-used.json"
    try:
        doc = json.loads(out.read_text(encoding="utf-8"))
        if not isinstance(doc, dict):
            doc = {}
    except Exception:
        doc = {}
    doc.setdefault(asn, f"{label} ({datetime.now():%Y-%m-%d %H:%M})")
    try:
        out.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
        log("СЕТЬ", f"{asn} записана в траченные (всего {len(doc)})")
    except Exception as e:
        log("СЕТЬ", f"записать список сетей не вышло: {flat(str(e), 60)}")



async def check_gift(site, log):
    """Читает, начислен ли подарочный $5.

    🔴 Это и есть приёмка (владелец 16.09: «аккаунт с нулевым балансом не создаём, там сразу
    видно»). Кабинет говорит прямым текстом: либо `Credit balance $5.00`, либо «Your $5
    signup credit wasn't added. Another account on the same network has already received it».
    Возврат: True - подарок есть, False - его нет (сеть уже отработана), None - не разобрал.
    """
    try:
        await goto_retry(site, BILLING_URL, log)
        await site.wait_for_timeout(4000)
        text = await site.inner_text("body")
    except Exception as e:
        log("ПОДАРОК", f"кабинет не прочитался: {flat(str(e).splitlines()[0], 70)}")
        return None
    low = (text or "").lower()
    if "wasn't added" in low or "was not added" in low or "already received" in low:
        log("ПОДАРОК", "❌ $5 не начислены: эта сеть уже получала подарок")
        return False
    m = re.search(r"credit balance[^$]{0,40}\$([0-9]+(?:\.[0-9]+)?)", low)
    if m:
        got = float(m.group(1))
        log("ПОДАРОК", f"{'✅' if got > 0 else '❌'} credit balance: ${got:.2f}")
        return got > 0
    log("ПОДАРОК", "цифру баланса не нашёл - считаю неизвестным")
    return None


async def take_key(site, label, seen, log, need_console=True):
    """Открывает кабинет, создаёт ключ и ждёт, пока он приедет в ответе.

    Вынесено отдельной функцией, потому что зовут её ДВА пути: обычный прогон и режим
    `--key-only` (аккаунт создан, ключ не снят - тот самый случай, когда прогон упал на
    переходе к странице ключей и повторять всю регистрацию незачем).
    """
    if need_console and not await goto_retry(site, CONSOLE_URL, log):
        log("КЛЮЧ", "кабинет не открылся - похоже, сессия в профиле не жива")
        return None
    await site.wait_for_timeout(3000)

    if not await goto_retry(site, API_KEYS_URL, log):
        log("КЛЮЧ", "страница ключей не открылась")
        return None
    await site.wait_for_timeout(4000)

    for what, note in (("Create API key", "открыл окно создания ключа"),
                       (None, "название ключа"),
                       ("Create key", "создаю ключ")):
        try:
            if what is None:
                await site.fill("input#key-name", label, timeout=20000)
            else:
                # По тексту, а не `:has-text(...)`: этот селектор не CSS, и JS-путь
                # (нужный при медленном `humanize`) на нём терял кнопку.
                ok, how = await click_button_by_text(site, what, log)
                if not ok:
                    raise RuntimeError(how)
            log("КЛЮЧ", note)
            await site.wait_for_timeout(2500)
        except Exception as e:
            log("КЛЮЧ", f"«{note}» не вышло: {flat(str(e).splitlines()[0], 70)}")

    deadline = asyncio.get_event_loop().time() + KEY_WAIT_S
    while asyncio.get_event_loop().time() < deadline and not seen["key"]:
        await asyncio.sleep(2)
    return seen["key"]


async def main():
    argv = sys.argv[1:]
    positional = [a for a in argv if not a.startswith("--")]
    label = re.sub(r"[^\w-]", "_", positional[0]) if positional else f"acct_{int(datetime.now().timestamp())}"

    tier = "own"
    pin = None
    exclude = []
    for i, a in enumerate(argv):
        if a.startswith("--tier"):
            tier = (a.split("=", 1)[1] if "=" in a
                    else (argv[i + 1] if i + 1 < len(argv) else "own")).lower()
        elif a.startswith("--captcha-wait"):
            try:
                CAPTCHA_WAIT_S = max(15, int(a.split("=", 1)[1] if "=" in a else argv[i + 1]))
            except Exception:
                pass
        elif a.startswith("--exclude"):
            exclude = (a.split("=", 1)[1] if "=" in a
                       else (argv[i + 1] if i + 1 < len(argv) else "")).split(",")
            exclude = [x.strip() for x in exclude if x.strip()]
        elif a.startswith("--proxy"):
            pin = a.split("=", 1)[1] if "=" in a else (argv[i + 1] if i + 1 < len(argv) else None)
    if tier not in ("own", "scraper", "none"):
        tier = "own"

    REC_DIR.mkdir(parents=True, exist_ok=True)
    SESSION_DIR.mkdir(parents=True, exist_ok=True)
    profile = DIR / "profiles" / label
    log_path = REC_DIR / f"autoadd-{label}-{datetime.now():%Y-%m-%dT%H-%M-%S}.log"
    log = open_log(log_path)

    # 🔴 stderr тоже в лог. Иначе диагностика решателя Turnstile (он пишет свои строки в
    # stderr) теряется: дашборд держит только последние 100 строк прогона, и на трёх неудачных
    # попытках подряд её вытесняет - причину отказа разобрать нечем (замер 16.09 вечером).
    try:
        errlog = open(str(log_path).replace(".log", ".err.log"), "a", encoding="utf-8")
        sys.stderr = errlog
    except Exception:
        pass

    log("СТАРТ", f"профиль {label} · ярус {tier}")
    state = {"label": label, "tier": tier, "started": datetime.now().isoformat(timespec="seconds")}
    password = gen_password()
    state["password"] = password

    # ── 1. прокси ────────────────────────────────────────────────────────────
    stage("proxy")
    try:
        if pin:
            proxy_cfg = await acquire_proxy(tier, f"odyssey:profile:{label}", log,
                                            POOL_HOST, POOL_PREFLIGHT_PATH, pin=pin)
        else:
            # Свежая сеть: на траченной сеть подарок не дадут, и аккаунт выйдет с нулём.
            proxy_cfg = await acquire_fresh_proxy(tier, f"odyssey:profile:{label}", log,
                                                  POOL_HOST, POOL_PREFLIGHT_PATH,
                                                  tried=exclude)
    except Exception as e:
        log("ПРОКСИ", f"❌ {e}")
        print("OD_AUTOADD_RESULT " + json.dumps(
            {"ok": False, "error": flat(e, 120), "retryable": True, "label": label},
            ensure_ascii=False), flush=True)
        return 5

    # ── 2. окно ──────────────────────────────────────────────────────────────
    base = dict(
        headless=False,
        os="windows",
        window=(1500, 1000),
        persistent_context=True,
        user_data_dir=str(profile),
        disable_coop=True,
        humanize=True,   # как в проверенных скриптах; 10.0 водил мышь ползком
        main_world_eval=True,
        i_know_what_im_doing=True,
    )
    if proxy_cfg:
        base["proxy"] = proxy_cfg
        if importlib.util.find_spec("geoip2") is not None:
            base["geoip"] = True
        else:
            log("ВНИМАНИЕ", "geoip недоступен (нет extra) - пояс и локаль останутся локальными")

    # HAR - единственная страховка разбора, если что-то пойдёт не так; падение на нём
    # не должно стоить прогона, поэтому вторая попытка без него.
    ctx = None
    for note, extra in (("с HAR", dict(record_har_path=str(REC_DIR / f"autoadd-{label}.har"),
                                       record_har_content="embed")), ("без HAR", {})):
        try:
            cm = AsyncCamoufox(**base, **extra)
            ctx = await cm.__aenter__()
            log("БРАУЗЕР", f"Camoufox поднят ({note})")
            break
        except Exception as e:
            log("ВНИМАНИЕ", f"запуск «{note}» сорвался: {flat(str(e).splitlines()[0], 90)}")
    if ctx is None:
        print('OD_AUTOADD_RESULT {"ok":false,"error":"браузер не поднялся"}', flush=True)
        return 5
    OPEN_CMS.append(cm)

    # Ответы площадки слушаем, а не угадываем: по ним видно и отправку регистрации, и ключ.
    seen = {"signup_sent": False, "signup_ok": False, "complete": False, "key": None}

    async def on_response(res):
        try:
            url = res.url
            if "/v1/client/sign_ups" in url and res.request.method == "POST":
                body = await res.text()
                if "/attempt_verification" in url:
                    if '"status":"complete"' in body:
                        seen["complete"] = True
                        log("РЕГИСТРАЦИЯ", "✅ статус complete")
                elif "/prepare_verification" in url:
                    log("РЕГИСТРАЦИЯ", "код запрошен у Clerk")
                else:
                    seen["signup_sent"] = True
                    if res.status == 200:
                        seen["signup_ok"] = True
                        log("РЕГИСТРАЦИЯ", "✅ регистрация принята (sua…)")
                    else:
                        log("РЕГИСТРАЦИЯ", f"⚠️ {res.status}: {flat(body, 160)}")
            if "/api-keys" in url and res.status == 200:
                full = await res.text()
                m = KEY_RE.search(full)
                if m:
                    seen["key"] = m.group(0)
                    log("КЛЮЧ", f"🔑 пойман: {m.group(0)}")
        except Exception as e:
            log("ВНИМАНИЕ", f"разбор ответа: {flat(str(e), 80)}")

    ctx.on("response", lambda res: asyncio.create_task(on_response(res)))

    site = ctx.pages[0] if ctx.pages else await ctx.new_page()

    # ── режим «только ключ» ──────────────────────────────────────────────────
    # Нужен для восстановления: прогон мог завести аккаунт и упасть на последнем шаге
    # (так вышло 16.09 - `NS_BINDING_ABORTED` на переходе к ключам). Сессия живёт в
    # профиле, поэтому повторять регистрацию не только незачем - новый адрес создал бы
    # ВТОРОЙ аккаунт вместо починки первого.
    if "--key-only" in argv:
        stage("key-only")
        log("РЕЖИМ", "только ключ: аккаунт уже создан, сессия - в профиле")
        try:
            prev = json.loads((SESSION_DIR / f"{label}.json").read_text(encoding="utf-8"))
            state["email"] = prev.get("email", "")
            state["password"] = prev.get("password", password)
        except Exception:
            log("РЕЖИМ", "файла сессии нет - адрес и пароль неизвестны, ключ всё равно сниму")
        key = await take_key(site, label, seen, log)
        state["key"] = key
        state["finished"] = datetime.now().isoformat(timespec="seconds")
        (SESSION_DIR / f"{label}.json").write_text(
            json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
        if key:
            log("ИТОГ", f"✅ ключ для {label} снят повторным заходом")
            acc_id = await register_in_dashboard(label, state.get("email", ""), key, log,
                                                 password=state.get("password"))
            await save_browser_session(ctx, site, acc_id, log)
            print("OD_AUTOADD_RESULT " + json.dumps(
                {"ok": True, "key": key, "email": state.get("email", ""),
                 "label": label, "tier": tier, "keyOnly": True}, ensure_ascii=False), flush=True)
            await close_open()
            return 0
        log("ИТОГ", "ключ повторным заходом тоже не снят")
        print(json.dumps({"ok": False, "error": "ключ не снят", "label": label},
                         ensure_ascii=False), flush=True)
        await close_open()
        return 4

    # ── 3. ящик на 22.do ─────────────────────────────────────────────────────
    stage("mail")
    mail_cm, mail_ctx, mail = None, None, None
    if "--mail-via-proxy" in argv:
        # Старое поведение - ящик в том же окне и через тот же прокси. Оставлено
        # переключателем, а не удалено: если однажды понадобится ящик "из той же сети",
        # это уже проверенный путь.
        mail = site
        log("ПОЧТА", "ящик беру в общем окне, через прокси (--mail-via-proxy)")
    else:
        # 🔴 Ящик берём ОТДЕЛЬНЫМ окном и БЕЗ прокси. Замер 16.09 15:45: адрес AS198068
        # открывал площадку за 2 с, а 22.do через него не открылся вовсе
        # (`NS_ERROR_CONNECTION_REFUSED`) - прогон умер на шаге почты с кодом 6, хотя с
        # регистрацией всё было в порядке. Почтовому сервису безразлично, с какого IP создан
        # ящик: адрес всё равно gmail, а правила Odyssey к 22.do не относятся. Зато
        # надёжность шага почты перестаёт зависеть от выбранного адреса регистрации, и целый
        # класс провалов исчезает. Проверено живьём: напрямую gmail выпадает (10-е нажатие).
        try:
            mail_cm = AsyncCamoufox(headless=True, os="windows", humanize=True,
                                    persistent_context=True,
                                    user_data_dir=str(DIR / "profiles" / "_mail"),
                                    main_world_eval=True, i_know_what_im_doing=True)
            mail_ctx = await mail_cm.__aenter__()
            OPEN_CMS.append(mail_cm)
            mail = mail_ctx.pages[0] if mail_ctx.pages else await mail_ctx.new_page()
            log("ПОЧТА", "ящик беру отдельным окном, напрямую (без прокси)")
        except Exception as e:
            log("ПОЧТА", f"окно почты не поднялось ({flat(str(e).splitlines()[0], 70)}) - беру в общем окне")
            mail = site
    email = await pick_22do_gmail(mail, log, allow_plus=("--allow-plus" in argv))
    if not email:
        # Ящик не взялся - и это тоже повод сменить адрес: 22.do отказывает по сети/сессии,
        # а не «навсегда» (замер 16.09: на одном прокси перебор адресов упёрся в отказ
        # соединения, на другом всё прошло с первой попытки).
        print("OD_AUTOADD_RESULT " + json.dumps(
            {"ok": False, "error": "ящик на 22.do не взят", "retryable": True,
             "proxy": LAST_PROXY.get("label"), "label": label}, ensure_ascii=False), flush=True)
        await close_open()
        return 6
    state["email"] = email

    # ── 4. форма Clerk + ALTCHA ──────────────────────────────────────────────
    stage("form")
    # 🪤 Две разные беды выглядят одинаково («регистрация не ушла»), а лечатся по-разному:
    # страница могла не открыться вовсе (адрес не годится) или открыться без формы (не
    # прошла ALTCHA). Поэтому держим оба признака и говорим в маркере тот, что случился.
    page_ok, form_ready = False, False
    try:
        await site.goto(SIGNUP_URL, wait_until="domcontentloaded", timeout=60000)
        page_ok = True
        await site.wait_for_timeout(5000)
    except Exception as e:
        log("ВНИМАНИЕ", f"страница регистрации не открылась: {flat(str(e).splitlines()[0], 90)}")

    # ALTCHA - proof-of-work: жмём галочку, дальше виджет считает сам, без человека.
    try:
        box = site.locator('input[id^="altcha-checkbox"]').first
        if await box.count():
            await site.evaluate("""() => {
                const el = document.querySelector('input[id^="altcha-checkbox"]');
                if (el) el.click();
            }""")
            log("ALTCHA", "галочку нажал, виджет считает proof-of-work")
    except Exception as e:
        log("ALTCHA", f"не нажалась: {flat(str(e), 80)}")

    # Поля Clerk появляются ПОСЛЕ ALTCHA - ждём их, а не спим фиксированно.
    try:
        await site.wait_for_selector("input#emailAddress-field", timeout=90000)
        form_ready = True
    except Exception:
        log("ФОРМА", "поле адреса не появилось - возможно, ALTCHA не прошла")
    try:
        await site.fill("input#emailAddress-field", email, timeout=20000)
        await site.fill("input#password-field", password, timeout=20000)
        log("ФОРМА", f"адрес и пароль вписаны ({email})")
    except Exception as e:
        log("ФОРМА", f"не удалось вписать: {flat(str(e).splitlines()[0], 90)}")

    # ── 5. клик человека по капче ────────────────────────────────────────────
    stage("captcha_wait", "нужен клик по Turnstile")
    try:
        btn = site.locator("button.cl-formButtonPrimary").first
        if await btn.count():
            await site.evaluate("""() => {
                const b = document.querySelector('button.cl-formButtonPrimary');
                if (b) b.click();
            }""")
            log("ФОРМА", "«Continue» нажал")
    except Exception as e:
        log("ФОРМА", f"«Continue» не нажался: {flat(str(e), 80)}")

    print("", flush=True)
    if form_ready:
        print("=" * 62, flush=True)
        print("  🖐  НУЖЕН ОДИН КЛИК: пройди капчу Cloudflare в открытом окне.", flush=True)
        print(f"  Адрес: {email}   пароль: {password}", flush=True)
        print("  Дальше всё сделаю сам: код из письма, ключ, маркер результата.", flush=True)
        print("=" * 62, flush=True)
    else:
        print(f"  окно открыто на {short_url(site.url)}: формы нет, жду до {CAPTCHA_WAIT_S} с", flush=True)
    print("", flush=True)
    try:
        await site.bring_to_front()
    except Exception:
        pass

    deadline = asyncio.get_event_loop().time() + CAPTCHA_WAIT_S
    ticks = 0
    while asyncio.get_event_loop().time() < deadline and not seen["signup_ok"]:
        await asyncio.sleep(2)
        ticks += 1
        # 🔴 Клик по капче из кода ОТМЕНЁН, и это замер, а не лень: владелец 16.09 нажал
        # виджет рукой - регистрация пошла; тот же виджет под виртуальной мышью Playwright
        # («оранжевый кружок») не срабатывает вовсе. Turnstile отличает машинный клик.
        # Поэтому: один раз говорим человеку, что нужно, и ждём. Кто хочет без человека -
        # тот берёт адрес, где капча проходит молча (у обёртки это ротация прокси).
        # Первые круги пробуем решить капчу проверенным решателем (он же нужен для случая,
        # когда Camoufox не решил её сам по отпечатку). Дальше - ждём человека: у нас бывает
        # и «строгий» адрес, где виджет жмёт только рука.
        # Две попытки, а не одна: виджет появляется через несколько секунд после «Continue»,
        # и первый заход может застать страницу ещё без него (замер 16.09).
        if ticks in (1, 6) and solve_turnstile:
            try:
                tok = await solve_turnstile(site, timeout=30)
                if tok:
                    log("КАПЧА", f"Turnstile решён решателем (токен {len(tok)} симв)")
                else:
                    log("КАПЧА", "решатель токена не добыл - если видишь «Verify you are human», нажми в окне")
            except Exception as e:
                log("КАПЧА", f"решатель упал: {flat(str(e).splitlines()[0], 70)}")
        elif ticks == 1:
            log("КАПЧА", f"решатель недоступен ({globals().get('_SOLVER_ERR', '?')}) - капчу жми в окне")
    if not seen["signup_ok"]:
        # 🔴 Причину называем ТУ, что случилась. До этого все три разные беды записывались
        # одной фразой «капча не пройдена», и разбор четырёх подряд провалов 16.09 упирался
        # в неё как в стену: два адреса вообще не открыли страницу, два не открыли ящик -
        # но в маркерах стояла капча.
        if not page_ok:
            why = "адрес не открыл страницу регистрации"
        elif not form_ready:
            why = "форма регистрации не появилась (ALTCHA не прошла)"
        else:
            why = "капча Turnstile потребовала человека"
        log("КАПЧА", f"регистрация не ушла за {CAPTCHA_WAIT_S} с - {why}")
        await dump_captcha_state(site, label, log)
        state["error"] = why
        (SESSION_DIR / f"{label}.json").write_text(
            json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
        print("OD_AUTOADD_RESULT " + json.dumps(
            {"ok": False, "error": why, "retryable": True,
             "proxy": LAST_PROXY.get("label"), "label": label}, ensure_ascii=False), flush=True)
        await close_open()
        return 2

    # ── 6. код из письма ─────────────────────────────────────────────────────
    stage("otp")
    # 🔴 Ящик и поле кода ищем ПАРАЛЛЕЛЬНО, а не по очереди. Замер 16.09 (владелец: «опять
    # ты долго ждал письмо, 23 секунды, когда оно уже лежало»): письмо приходит раньше, чем
    # на странице появляется поле для кода, а прежний порядок сначала ждал поле (до 60 с) и
    # только потом шёл в ящик - и всё это время готовое письмо лежало непрочитанным.
    code_task = asyncio.create_task(fetch_22do_code(mail, log, timeout_s=OTP_WAIT_S))
    try:
        await site.wait_for_selector("div.cl-otpCodeField input, input[name='otp-code']", timeout=30000)
    except Exception:
        log("КОД", "поле кода не появилось - код всё равно ищу в ящике")
    code = await code_task
    if not code:
        print('OD_AUTOADD_RESULT {"ok":false,"error":"код из письма не получен"}', flush=True)
        await close_open()
        return 3

    # 🔴 Ввод кода делаем ЖИВУЧИМ, и это не перестраховка: прогон 16.09 повесил код в поле,
    # `complete` не пришёл, и весь аккаунт пропал (на странице ключей не оказалось кнопки,
    # потому что сессия не подтверждена). Поэтому: набор → Enter → ждём подтверждение, и
    # если его нет, берём СВЕЖИЙ код из ящика и пробуем ещё раз (первый мог протухнуть,
    # пока шёл разбор).
    for otp_round in (1, 2):
        typed = False
        try:
            # 🪤 Клик мышью по полю упирался в таймаут: `humanize=10.0` водит мышь медленно,
            # а поле узкое и перекрыто соседними разрядами. Фокус ставим из JS, цифры
            # набираем клавиатурой - React-поле принимает именно ввод, а не присваивание.
            focused = await site.evaluate("""() => {
                const el = document.querySelector('div.cl-otpCodeField input, input[name="otp-code"]');
                if (!el) return false;
                el.focus();
                return true;
            }""")
            if not focused:
                raise RuntimeError("поле кода не найдено")
            await site.keyboard.type(code, delay=170)
            await site.keyboard.press("Enter")
            typed = True
            log("КОД", f"вписал {code} и нажал Enter (круг {otp_round})")
        except Exception as e:
            log("КОД", f"не удалось вписать код: {flat(str(e).splitlines()[0], 90)}")

        if typed:
            deadline = asyncio.get_event_loop().time() + 45
            while asyncio.get_event_loop().time() < deadline and not seen["complete"]:
                await asyncio.sleep(2)
        if seen["complete"]:
            break
        if otp_round == 1:
            log("КОД", "подтверждения нет - беру свежий код из ящика")
            fresh = await fetch_22do_code(mail, log, timeout_s=90)
            if not fresh or fresh == code:
                break
            code = fresh

    log("РЕГИСТРАЦИЯ", "статус complete" if seen["complete"] else "complete не увидел, иду за ключом")
    state["complete"] = bool(seen["complete"])

    # Приёмка: без подарочных $5 аккаунт бесполезен - не заводим его в пул.
    gift = await check_gift(site, log)
    state["gift"] = gift
    if gift is False:
        await mark_network_used(log)      # сеть отработана - больше её не берём
        print("OD_AUTOADD_RESULT " + json.dumps(
            {"ok": False, "error": "сеть уже получала подарок: аккаунт с нулевым балансом не берём",
             "retryable": True, "proxy": LAST_PROXY.get("label"), "label": label},
            ensure_ascii=False), flush=True)
        await close_open()
        return 7

    # ── 7. ключ ──────────────────────────────────────────────────────────────
    deadline = asyncio.get_event_loop().time() + 30
    while asyncio.get_event_loop().time() < deadline and not seen["complete"]:
        await asyncio.sleep(2)

    stage("key")
    key = await take_key(site, label, seen, log, need_console=bool(seen["complete"]))

    state["key"] = key
    state["finished"] = datetime.now().isoformat(timespec="seconds")
    (SESSION_DIR / f"{label}.json").write_text(
        json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")

    if not seen["key"]:
        log("ИТОГ", "аккаунт заведён, но ключ не пойман")
        print(json.dumps({"ok": False, "error": "ключ не снят", "email": email,
                          "label": label}, ensure_ascii=False), flush=True)
        await close_open()
        return 4

    stage("done")
    account_id = await register_in_dashboard(label, email, seen["key"], log, password=password)
    await bind_account_proxy(account_id, log)
    await mark_network_used(log)
    # Снимок сессии - ПОСЛЕ заведения в пул: имя файла зависит от id аккаунта.
    await save_browser_session(ctx, site, account_id, log)
    marker = json.dumps({"ok": True, "key": seen["key"], "email": email,
                         "label": label, "tier": tier,
                         "proxy": LAST_PROXY.get("label")}, ensure_ascii=False)
    log("ИТОГ", f"✅ аккаунт {label}: ключ снят, адрес {email}")
    print(f"OD_AUTOADD_RESULT {marker}", flush=True)

    # Окно оставляем открытым ненадолго: закрытие сразу после успеха мешало бы разбору,
    # если что-то пошло не так уже после создания ключа. Закрываем ОБА окна (почта тоже):
    # незакрытое окно Camoufox остаётся жить после прогона и ест память.
    await asyncio.sleep(5)
    await close_open()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        sys.exit(130)
