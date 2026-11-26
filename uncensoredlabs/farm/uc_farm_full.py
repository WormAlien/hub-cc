#!/usr/bin/env python3
"""uc_farm_full.py — полный конвейер uncensoredlabs: signup → login → key → verify-email → claim.

Каждый аккаунт выходит С БАЛАНСОМ $0.10 (100 000 000 nano). Почта — mail.tm (домены ротируются,
429 обрабатывается паузой). Прокси — SOCKS5, по одному аккаунту на egress за прогон (лимит 5/IP/24ч).

Usage:
    PYEXE -u uc_farm_full.py --per-ip 2 --proxies socks-alive.txt
    UL_BANK=... UL_POOL=... переопределяют выходы.
"""
import argparse
import json
import os
import queue
import re
import sys
import threading
import time
import random
import string
import urllib.request
import urllib.error

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
from camoufox.sync_api import Camoufox

SITE = "https://uncensoredlabs.dev"
SITEKEY = "0x4AAAAAAFvIxFn7-3_j5sez"
# Движок — только Camoufox (см. farm_one). Путь к Chrome убран намеренно:
# Chromium на этом челлендже бесполезен по построению (виджет 0x0 без iframe),
# а оставленная строка рано или поздно снова запустила бы его.
HERE = os.path.dirname(os.path.abspath(__file__))
BANK = os.environ.get("UL_BANK", os.path.join(HERE, "bank.jsonl"))
# 🪤 Пул хаба — ВТОРОЙ выход, отдельный от bank.jsonl. Хаб читает
# routing/uncensoredlabs-sessions.json, а не наш банк: без этой записи кнопка
# «авторега» на вкладке создавала аккаунт и ключ, но в дашборде не появлялось
# НИЧЕГО (проверка 25.11: poolReady держался на 5 старых аккаунтах).
# UL_POOL раньше был упомянут только в docstring, в коде его не было.
# Путь считается ОТ ФАЙЛА: скрипт лежит в <repo>/uncensoredlabs/farm/, пул —
# в <repo>/routing/. Так работает и из репозитория, и из scratch-копии.
POOL = os.environ.get(
    "UL_POOL",
    os.path.abspath(os.path.join(HERE, "..", "..", "routing",
                                 "uncensoredlabs-sessions.json")))
POOL = os.path.abspath(POOL)
PROF = os.path.join(HERE, "prof_full")

MAILTM_DOMAINS = None  # кеш доменов


def log(*a):
    s = " ".join(str(x) for x in a)
    print(s, flush=True)


# ── почта: smailpro (настоящий @gmail.com) ──────────────────────────────
# 🪤 mail.tm НЕ годится для trial: его домены (euploading.com) не входят в
# список поддерживаемых провайдеров, и POST /api/account/trial/verify-email
# отвечает 400 «Use an email from a supported provider (Gmail, Outlook,
# Proton, Yandex, Tuta)». smailpro выдаёт реальный @gmail.com — и кредит
# $0.10 проходит (замер 25.11, полный цикл через smailpro).
#
# Ящик живёт в ОТДЕЛЬНОМ ПРОЦЕССЕ: два sync-браузера Camoufox в одном
# Python-процессе невозможны (Playwright Sync API падает на втором
# `with Camoufox` — «inside the asyncio loop»). Общение — JSON-строками.
import subprocess as _sp

from uc_mail_rpc import MailProcessClient


def make_mailbox(proxy=None):
    """Поднять процесс-ящик smailpro и создать @gmail.com.

    Возвращает {addr, kind, triple, proc, pw} или None.
    """
    import sys as _sys
    if HERE not in _sys.path:
        _sys.path.insert(0, HERE)
    script = os.path.join(HERE, "uc_mail_smailpro.py")
    if not os.path.exists(script):
        log("smailpro-скрипт не найден:", script)
        return None
    cmd = [_sys.executable, "-u", script, "--serve", proxy or "-"]
    proc = _sp.Popen(cmd, stdin=_sp.PIPE, stdout=_sp.PIPE, stderr=_sp.PIPE,
                     text=True, encoding="utf-8", bufsize=1, cwd=HERE)

    def _mail_log(line):
        log("smailpro-mail:", line)

    # 🪤 Прямой stdout.readline() обходит таймауты и отбрасывает non-JSON
    # диагностику, а stderr копился в мёртвой трубе. MailProcessClient держит
    # reader-threads с монотонным бюджетом: прогон 26.11 потерял письмо с
    # темой 'Verify your email address' (виден на скрине владельца), потому
    # что diagnostic lines просто съедались, а реальная причина осталась
    # невидимой.
    client = MailProcessClient(proc, on_log=_mail_log)
    mb = {"proc": proc, "client": client,
          "pw": "Ul" + "".join(random.choices(string.ascii_letters + string.digits, k=10))}
    try:
        hello = client.read_response(240)
        if not hello.get("ready"):
            raise RuntimeError("mailbox server not ready: %s" % hello.get("error", ""))
        r = client.ask({"cmd": "open"}, timeout=300)
    except Exception as e:
        log("smailpro: ящик не создан:", str(e)[:100])
        try:
            client.close(timeout=2)
        except Exception:
            pass
        return None
    if not r.get("ok"):
        log("smailpro: ящик не создан:", str(r.get("error"))[:100])
        try:
            client.close(timeout=2)
        except Exception:
            pass
        return None
    addr = r.get("addr")
    log("mailbox:", addr)
    mb.update(addr=addr, kind=r.get("kind"), triple=r.get("triple"))
    return mb


def _mail_ask(mb, **req):
    """Команда процессу-ящику. Возвращает JSON или {} при ошибке.

    `timeout` в req остаётся клиентской опцией: MailProcessClient не вставляет
    его в JSON и не даёт висящему readline() обойти дедлайн.
    """
    client = mb.get("client")
    if client is None:
        return {"ok": False, "error": "почтовый клиент не поднят"}
    timeout = req.pop("timeout", 300)
    try:
        return client.ask(req, timeout=timeout)
    except Exception as e:
        return {"ok": False, "error": str(e)[:120]}


def save(rec):
    with open(BANK, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def save_pool(rec):
    """Записать аккаунт в пул хаба — иначе ключ не попадёт в ротацию.

    Отдельно от save(): bank.jsonl — наш журнал всех попыток (включая провалы
    без ключа), а пул принимает ТОЛЬКО записи с ключом, в форме ucLoad().
    Ошибку пула не глотаем молча: без пула аккаунт бесполезен для хаба, и
    владелец должен видеть это в логе прогона, а не искать ключ в файле.
    """
    key = (rec.get("secret") or "").strip()
    if not key:
        return 0
    try:
        if HERE not in sys.path:
            sys.path.insert(0, HERE)
        import uc_pool
        email = rec.get("email") or rec.get("acc") or ""
        record = uc_pool.make_record(email, key, None,
                                     acc_id=rec.get("acc"),
                                     note="farm" if not rec.get("claimed") else None)
        n = uc_pool.pool_append(record, pool=POOL)
        log(rec.get("idx", "?"), "pool:", "добавлен" if n else "уже был")
        return n
    except Exception as e:
        log(rec.get("idx", "?"), "pool FAILED:", str(e)[:120])
        return -1




def read_verify_link(m, deadline_s=240):
    """Ссылка подтверждения из письма smailpro.

    Чтение перекладывается на процесс-ящик: письмо приходит на api.sonjj.com
    по payload, а fetch обязан уходить со страницы smailpro (origin + куки).

    🪤 Прогон 26.11: письмо ВИДИМО в ящике (скриншот владельца), но ферма
    сказала «verify письма нет». Без лога ответа процесса причина была
    невидима — процесс мог умереть, оттаймаутить или отдать пустой inbox.
    Теперьdiag-лог всегда.
    """
    if m.get("proc") and m["proc"].poll() is not None:
        log("verify DIAG: почтовый процесс УЖЕ МЁРТВ (rc=%s)" % m["proc"].returncode)
    r = _mail_ask(m, cmd="link", deadline=deadline_s, timeout=deadline_s + 60)
    log("verify DIAG: link-ответ ok=%s err=%s link=%s" % (
        r.get("ok"), str(r.get("error"))[:80], bool(r.get("link"))))
    if not r.get("ok"):
        # вторая попытка: процесс мог моргнуть
        r2 = _mail_ask(m, cmd="link", deadline=60, timeout=120)
        log("verify DIAG: повтор ok=%s link=%s" % (r2.get("ok"), bool(r2.get("link"))))
        if r2.get("link"):
            return r2["link"]
    return r.get("link") or ""


def _mail_stop(mb):
    """Погасить процесс-ящик через MailProcessClient: quit → taskkill /T → reap.

    🪤 Прежний proc.stdin.write + terminate() гасил только launcher: на Windows
    Popen фермы разворачивается в launcher + python + node + Camoufox, и дети
    оставались висеть. close() киляет ровно дерево PID владельца и reap-ит.
    """
    client = mb.get("client")
    if client is None:
        return
    try:
        client.close(timeout=2)
    except Exception:
        pass


# ── playwright ─────────────────────────────────────────────────────────
def _cf_frame_geo(pg):
    """Геометрия чекбокса Turnstile из самого CF-кадра → (x, y, w, h) или None.

    🪤 Виджет живёт в iframe `challenges.cloudflare.com`, и в главном документе
    его НЕ видно: замер 25.11 на uncensoredlabs дал `slot: null, hostLen: 0,
    iframes: 0` во всех снимках состояния при видимом чекбоксе. Прежний код
    искал `.challenge-slot`, получал None и бил по координатам разметки —
    (332,336) вместо настоящих (214,336), то есть на 118 px мимо.

    Честный источник — `frame_element().bounding_box()`: виджет 300x65,
    квадрат-чекбокс ~30 px от левого края, по центру виджета.
    """
    for f in pg.frames:
        if "challenges.cloudflare" not in (f.url or ""):
            continue
        try:
            bb = f.frame_element().bounding_box()
        except Exception:
            continue
        if not bb or bb.get("width", 0) < 20 or bb.get("height", 0) < 10:
            continue
        return (bb["x"] + 30.0, bb["y"] + bb["height"] / 2.0,
                bb["width"], bb["height"])
    return None


def _cf_slot(pg):
    """Слот Turnstile из DOM → (x, y, w, h) или None."""
    try:
        return pg.evaluate("""() => { const s = document.querySelector('.challenge-slot');
            if (!s) return null; const r = s.getBoundingClientRect();
            return [r.left, r.top, r.width, r.height]; }""")
    except Exception:
        return None


def _cf_clearance(ctx):
    try:
        return any(c.get("name") == "cf_clearance" for c in ctx.cookies())
    except Exception:
        return False


_TOK_JS = "()=>{try{return (window.turnstile&&window.turnstile.getResponse&&window.turnstile.getResponse())||''}catch(e){return ''}}"


def wait_tok(pg, tag="", quiet=40):
    """Дождаться токена Turnstile, при необходимости пройдя проверку Cloudflare.

    Канон вики (odyssey + Одноразовые почты § SmailPro) и замер 25.11:
      1) сначала короткая молчаливая пауза: годный адрес иногда проходит сам, а
         инструментация на старте ломает invisible-Turnstile;
      2) дальше клик по ЧЕКБОКСУ ИЗ CF-КАДРА (см. _cf_frame_geo). Прежняя версия
         брала `.challenge-slot`, а его на этой странице нет — клик уходил мимо
         и всё сводилось к слепому ожиданию;
      3) успех — форма регистрации ИЛИ токен; судить только по токену нельзя,
         он часто остаётся пустым при пройденной проверке.

    Возвращает токен, "FORM_OPEN" или "".
    """
    def tok_of():
        try:
            return pg.evaluate(_TOK_JS) or ""
        except Exception:
            return ""

    def has_form():
        try:
            return bool(pg.evaluate(
                "() => Boolean(document.querySelector('input[type=email],input[name=email]'))"))
        except Exception:
            return False

    # Короткая пауза: если адрес годный, проверка проходит сама.
    time.sleep(min(quiet, 4))
    t = tok_of()
    if t:
        return t
    if has_form():
        return "FORM_OPEN"

    ctx = pg.context
    clicked = 0
    deadline = time.time() + max(quiet, 45)
    while time.time() < deadline:
        geo = _cf_frame_geo(pg)
        if geo:
            cx, cy = geo[0], geo[1]
            try:
                # Человекоподобный подвод: телепорт курсора Turnstile ловит.
                pg.mouse.move(cx - 220, cy - 120, steps=15)
                time.sleep(0.3)
                pg.mouse.move(cx, cy, steps=22)
                time.sleep(0.45)
                pg.mouse.click(cx, cy)
                clicked += 1
                log(tag, f"cf: клик #{clicked} ({cx:.0f},{cy:.0f})")
            except Exception as e:
                log(tag, "cf: клик не удался:", str(e)[:60])
        # Опрос частый: проверка проходит за 1-2с после клика, ждать 10с впустую
        # незачем. Это assess-поллинг getResponse, а не перерисовка страницы.
        for _ in range(12):
            time.sleep(0.5)
            t = tok_of()
            if t:
                log(tag, f"cf: токен получен (после {clicked} клик(ов))")
                return t
            if has_form():
                log(tag, f"cf: форма открыта (после {clicked} клик(ов))")
                return "FORM_OPEN"
        if _cf_clearance(ctx) and not geo:
            # Кука уже есть, кадра больше нет — проверка пройдена, но форма ещё
            # не отрисовалась. Даём странице доехать, не кликая повторно.
            for _ in range(20):
                time.sleep(0.5)
                if has_form():
                    return "FORM_OPEN"
                t = tok_of()
                if t:
                    return t
    log(tag, f"cf: не прошло за отведённое время ({clicked} клик(ов))")
    return ""



def _cap_signup(resp, events, bodies):
    """Перехват ответов signup/login для честного признака успеха.

    Судить об успехе регистрации можно только по ответу СЕРВЕРА на
    POST /api/auth/sign-up/email — `input[name=cf-turnstile-response]`
    остаётся пустым даже при пройденной капче (канон вики).

    🪤 `resp.text()` в Camoufox часто падает (Cross-origin/внутренняя ошибка),
    и тело молча терялось — статус при этом есть в `resp.status`. Поэтому
    тело пишем best-effort: статус надёжен всегда, текст — если отдался.
    """
    try:
        u = resp.url or ""
        if ("api/auth/sign-up/email" in u or "api/auth/sign-in/email" in u
                or "api/auth/verify-email" in u):
            ev = {"u": u, "s": resp.status, "t": ""}
            try:
                ev["t"] = (resp.text() or "")[:300]
            except Exception:
                pass
            events.append(ev)
            # ключ — короткий хвост URL, чтобы login/signup не перетирали друг друга
            key = u.split("?")[0].split("/api/")[1] if "/api/" in u else u
            bodies[key] = str(resp.status) + " " + ev["t"]
    except Exception:
        pass


def farm_one(p, idx, proxy, mailbox):
    """Возвращает rec или None. Один аккаунт полный цикл.

    🪤 Движок — ТОЛЬКО Camoufox. Chromium/Chrome на этом челлендже бесполезен по
    построению: виджет Turnstile рендерится пустой заглушкой 0x0 без iframe и без
    shadow (замер 25.11: hostLen 0, iframes 0), и в консоли CSP режет inline-скрипт.
    Параметры — из рабочего рецепта smailpro: disable_coop снимает кросс-оригин
    изоляцию (без неё клик по кадру не доезжает), main_world_eval нужен для evaluate
    в мир страницы, humanize — человекоподобный ввод.
    """
    prof = os.path.join(PROF, f"f{idx}_{int(time.time())}")
    tag = f"[{idx}]"
    # 🪤 geoip требует extra `camoufox[geoip]` (maxminddb). Без него Camoufox
    # падает на КАЖДОМ аккаунте: «Please install the geoip extra to use this
    # feature». Аккаунт не создаётся вовсе, а выглядит это как отказ площадки.
    # Проверяем наличие и откатываемся на geoip=False — без геолокации ферма
    # работает, с падающим импортом не работает никогда.
    _geoip = True
    try:
        from camoufox.geolocation import geoip_allowed
        geoip_allowed()
    except Exception as e:
        log(tag, "geoip выключен:", str(e)[:90])
        _geoip = False
    kw = dict(headless=False, humanize=10.0, os="windows", geoip=_geoip,
              persistent_context=True, user_data_dir=prof,
              disable_coop=True, main_world_eval=True, i_know_what_im_doing=True,
              window=(1280, 900))
    if proxy:
        kw["proxy"] = {"server": proxy}
    fox = Camoufox(**kw)
    # 🪤 InvalidIP («Failed to get IP address» от ipecho.net) вылетает ИЗ
    # __enter__, когда прокси умер между проверкой и запуском. Раньше это
    # роняло попытку целиком снаружи try — теперь ловим и откатываемся на
    # geoip=False: без геолокации аккаунт создаётся, без браузера — нет.
    try:
        ctx = fox.__enter__()
    except Exception as e:
        if "IP address" not in str(e) or not _geoip:
            raise
        log(tag, "geoip: прокси не отдал IP — повтор без геолокации:", str(e)[:90])
        kw["geoip"] = False
        fox = Camoufox(**kw)
        ctx = fox.__enter__()
    rec = None
    try:
        pg = ctx.pages[0] if ctx.pages else ctx.new_page()
        pg.set_default_timeout(25000)
        # signup
        try:
            pg.goto(SITE + "/signup", wait_until="commit", timeout=45000)
        except Exception as e:
            log(tag, "goto retry:", str(e)[:60])
            try:
                pg.goto(SITE + "/signup", wait_until="commit", timeout=45000)
            except Exception:
                log(tag, "FAIL goto"); save({"idx": idx, "acc": "", "secret": "", "proxy": proxy,
                                             "email": mailbox["addr"], "stage": "goto_fail",
                                             "ts": time.strftime("%Y-%m-%dT%H:%M:%S")}); return None
        time.sleep(2)
        tok = wait_tok(pg, tag=tag, quiet=45)
        if tok == "FORM_OPEN":
            # Cloudflare пропущен (interstitial), но на САМОЙ ФОРМЕ свой второй
            # Turnstile. Прежний код ждал токен 40с — снаружи это выглядело как
            # «вторая проверка не нажимается».
            #
            # 🪤 И главная ловушка: `input[name=cf-turnstile-response]` остаётся
            # ПУСТЫМ даже при пройденной проверке (живой прогон 25.11: зелёная
            # галочка на форме, токен 0). Судить по токену нельзя — иначе код
            # объявляет «форма без токена» уже после того, как CF принял.
            # Честный признак успеха — ответ сервера на POST /sign-up/access-key:
            # если он 200 и вернул key, проверка пройдена, чем бы ни выглядел input.
            log(tag, "форма открыта")
            for att in range(1, 4):
                geo = _cf_frame_geo(pg)
                if not geo:
                    log(tag, f"форма: CF-кадра нет (попытка {att}) — проверка уже пройдена")
                    break
                cx, cy = geo[0], geo[1]
                try:
                    pg.mouse.move(cx - 220, cy - 120, steps=15)
                    time.sleep(0.3)
                    pg.mouse.move(cx, cy, steps=22)
                    time.sleep(0.45)
                    pg.mouse.click(cx, cy)
                    log(tag, f"форма: клик #{att} ({cx:.0f},{cy:.0f})")
                except Exception as e:
                    log(tag, "форма: клик не удался:", str(e)[:60])
                time.sleep(3)
                tok = pg.evaluate(_TOK_JS) or ""
                if tok:
                    log(tag, "форма: токен появился")
                    break
                # Кадр исчез — виджет отработал, даже если токен не выставился.
                if not _cf_frame_geo(pg):
                    log(tag, "форма: кадр исчез после клика — считаю проверку пройденной")
                    break
            if not tok:
                log(tag, "форма: токена нет, но пробую POST — признак успеха даст сервер")
        elif not tok:
            log(tag, "no signup token"); save({"idx": idx, "acc": "", "secret": "", "proxy": proxy,
                                               "email": mailbox["addr"], "stage": "no_signup_token",
                                               "ts": time.strftime("%Y-%m-%dT%H:%M:%S")}); return None
        # ── signup: РАБОЧИЙ ПУТЬ через штатную форму (как в full_flow.py) ──
        # 🪤 Прежний путь — голый `fetch /api/auth/sign-up/access-key` с
        # ручным `X-Turnstile-Token` — не работает: токен из
        # `window.turnstile.getResponse()` не доезжает (остаётся пустым даже
        # при видимо пройденной капче), сервер отвечает 403 captcha_required
        # на КАЖДОЙ попытке (живой прогон 26.11: 6 из 11). Рабочий путь,
        # подтверждённый 25.11 (signup 200 → verify → вход → ключ → $0.10):
        # заполнить email/password, прожать CF-виджет на форме, нажать
        # ШТАТНУЮ кнопку — сайт сам шлёт POST /api/auth/sign-up/email.
        events = []
        bodies = {}
        pg.on("response", lambda r: _cap_signup(r, events, bodies))

        # 1. ждём готовности полей (на медленном прокси форма рисуется позже,
        #    чем input'ы готовы: fill тихо падал, и форма оставалась пустой)
        ready_fields = False
        for _ in range(20):
            try:
                ready_fields = bool(pg.evaluate(
                    "() => !!(document.querySelector('input[type=email],input[name=email]')"
                    " && document.querySelector('input[type=password]'))"))
            except Exception:
                ready_fields = False
            if ready_fields:
                break
            time.sleep(1.5)
        if not ready_fields:
            log(tag, "форма не отрисовалась (нет полей)")
            save({"idx": idx, "acc": "", "secret": "", "proxy": proxy,
                  "email": mailbox["addr"], "stage": "no_fields",
                  "ts": time.strftime("%Y-%m-%dT%H:%M:%S")})
            return None

        # 2. заполняем email/password и сверяем фактическое содержимое
        pw = "Ul" + str(idx) + "!x" + "".join(random.choices(string.ascii_letters, k=4))
        try:
            eb = pg.locator("input[type=email],input[name=email]").first
            eb.click()
            eb.fill(mailbox["addr"])
            time.sleep(0.5)
            pb = pg.locator("input[type=password]").first
            pb.click()
            pb.fill(pw)
        except Exception as e:
            log(tag, "fill FAIL:", str(e)[:80])
        vals = pg.evaluate(
            "() => ({e: (document.querySelector('input[type=email],input[name=email]')||{}).value"
            " ? document.querySelector('input[type=email],input[name=email]').value.length : -1,"
            " p: (document.querySelector('input[type=password]')||{value:''}).value.length})")
        log(tag, "поля:", vals)
        if not (vals and vals.get("e") and vals.get("p")):
            log(tag, "поля ПУСТЫЕ")
            save({"idx": idx, "acc": "", "secret": "", "proxy": proxy,
                  "email": mailbox["addr"], "stage": "empty_fields",
                  "ts": time.strftime("%Y-%m-%dT%H:%M:%S")})
            return None

        # 3. чекбокс согласия (без него кнопка серая)
        try:
            cb = pg.locator("input[type=checkbox]").first
            if cb.count() and not cb.is_checked():
                cb.check(force=True)
        except Exception:
            pass

        # 4. виджет на форме: прокрутить и прожать до исчезновения кадра
        for att in range(1, 6):
            geo = _cf_frame_geo(pg)
            if not geo:
                break
            cx, cy = geo[0], geo[1]
            try:
                pg.mouse.move(cx - 220, cy - 120, steps=15)
                time.sleep(0.3)
                pg.mouse.move(cx, cy, steps=22)
                time.sleep(0.45)
                pg.mouse.click(cx, cy)
                log(tag, f"форма: клик #{att} ({cx:.0f},{cy:.0f})")
            except Exception:
                pass
            time.sleep(4)
            if not _cf_frame_geo(pg):
                break

        # 5. ШТАТНАЯ кнопка: жмём до трёх раз, ждём POST sign-up/email в сети
        r = ""
        for attempt in range(1, 4):
            for sel in ("button:has-text('Create account')", "form button[type=submit]",
                        "button[type=submit]"):
                try:
                    btn = pg.locator(sel).first
                    if btn.count():
                        btn.click(timeout=8000)
                        break
                except Exception:
                    continue
            for _ in range(12):
                time.sleep(2)
                if any("sign-up/email" in e["u"] for e in events):
                    break
            if any("sign-up/email" in e["u"] for e in events):
                log(tag, "регистрация отправлена (попытка %d)" % attempt)
                time.sleep(4)
                r = bodies.get("/api/auth/sign-up/email", "")
                break
            # не ушло — могли не прожать виджет, пробуем ещё
            if _cf_frame_geo(pg):
                geo = _cf_frame_geo(pg)
                try:
                    pg.mouse.click(geo[0], geo[1])
                except Exception:
                    pass
                time.sleep(4)

        if not r:
            # статус надёжнее тела: в Camoufox resp.text() часто падает,
            # и тела нет — но код ответа есть в events
            su = [e for e in events if "sign-up/email" in e["u"]]
            if su:
                r = str(su[-1].get("s")) + " " + str(su[-1].get("t", ""))[:200]
            else:
                r = bodies.get("auth/sign-up/email", "")
        log(tag, "signup:", str(r)[:120])
        if "200" not in str(r):
            stage = "captcha_required" if "captcha_required" in str(r) else "signup_fail"
            save({"idx": idx, "acc": "", "secret": "", "proxy": proxy,
                  "email": mailbox["addr"], "stage": stage,
                  "err": str(r)[:120], "ts": time.strftime("%Y-%m-%dT%H:%M:%S")})
            return None

        # verify-email: подтверждение почты ПО ССЫЛКЕ из письма.
        # 🪤 Кредит $0.10 начисляется сам при подтверждении почты — но без
        # перехода по ссылке emailVerified остаётся false, и trial/verify-email
        # потом возвращает 409/400. Рабочий путь (full_flow 25.11): письмо
        # «Verify your email address» → переход по ссылке В ТОМ ЖЕ контексте.
        link = read_verify_link(mailbox, deadline_s=180)
        if link:
            log(tag, "verify link:", link[:80])
            try:
                pg.goto(link, wait_until="commit", timeout=45000)
                time.sleep(5)
                # CF-заставка на странице верификации: пробить циклом
                for att in range(1, 7):
                    try:
                        body = str(pg.evaluate(
                            "() => (document.body?document.body.innerText:'').slice(0,300)"))
                    except Exception:
                        body = ""
                    low = body.lower()
                    if body and not ("security verification" in low
                                     or "just a moment" in low):
                        log(tag, "verify: контент появился (CF попыток: %d)" % (att - 1))
                        break
                    geo = _cf_frame_geo(pg)
                    if geo:
                        try:
                            pg.mouse.move(geo[0] - 220, geo[1] - 120, steps=15)
                            time.sleep(0.3)
                            pg.mouse.move(geo[0], geo[1], steps=22)
                            time.sleep(0.45)
                            pg.mouse.click(geo[0], geo[1])
                        except Exception:
                            pass
                    time.sleep(3)
            except Exception as e:
                log(tag, "goto verify:", str(e)[:70])
        else:
            log(tag, "verify письма нет — кредит не начислился")

        
# login: РАБОЧИЙ ПУТЬ — email+пароль через штатную кнопку.
        # 🪤 Сессия email-регистрации не даёт: после verify сайт ведёт на
        # /login («Welcome back»). Прежний `sign-in/access-key` требовал
        # Turnstile-токен, которого нет — тот же 403, что и на signup.
        acc = mailbox["addr"]  # для email-аккаунтов входной идентификатор
        pg.goto(SITE + "/login", wait_until="commit", timeout=45000)
        time.sleep(2)
        login_events = []
        login_bodies = {}
        pg.on("response", lambda r: _cap_signup(r, login_events, login_bodies))
        ready = False
        for att in range(1, 10):
            try:
                ready = bool(pg.evaluate(
                    "() => Boolean(document.querySelector('input[type=email],input[name=email]'))"))
            except Exception:
                ready = False
            if ready:
                break
            geo = _cf_frame_geo(pg)
            if geo:
                try:
                    pg.mouse.move(geo[0] - 220, geo[1] - 120, steps=15)
                    time.sleep(0.3)
                    pg.mouse.move(geo[0], geo[1], steps=22)
                    time.sleep(0.45)
                    pg.mouse.click(geo[0], geo[1])
                except Exception:
                    pass
            time.sleep(3)
        if not ready:
            log(tag, "форма входа не открылась")
            save({"idx": idx, "acc": acc, "secret": "", "proxy": proxy,
                  "email": mailbox["addr"], "stage": "no_login_form",
                  "ts": time.strftime("%Y-%m-%dT%H:%M:%S")})
            return None
        try:
            eb = pg.locator("input[type=email],input[name=email]").first
            eb.click()
            eb.fill(mailbox["addr"])
            time.sleep(0.5)
            pb = pg.locator("input[type=password]").first
            pb.click()
            pb.fill(pw)
        except Exception as e:
            log(tag, "fill login FAIL:", str(e)[:80])
        # виджет на форме входа
        for att in range(1, 5):
            geo = _cf_frame_geo(pg)
            if not geo:
                break
            try:
                pg.mouse.move(geo[0] - 220, geo[1] - 120, steps=15)
                time.sleep(0.3)
                pg.mouse.move(geo[0], geo[1], steps=22)
                time.sleep(0.45)
                pg.mouse.click(geo[0], geo[1])
            except Exception:
                pass
            time.sleep(5)
        for sel in ("button:has-text('Sign in')", "button:has-text('Log in')",
                    "form button[type=submit]", "button[type=submit]"):
            try:
                btn = pg.locator(sel).first
                if btn.count():
                    btn.click(timeout=8000)
                    log(tag, "нажата:", sel[:40])
                    break
            except Exception:
                continue
        time.sleep(8)
        r = next((v for k, v in login_bodies.items() if "sign-in" in k), "")
        me = pg.evaluate(
            "async()=>{const r=await fetch('/api/account/me',{credentials:'include'});"
            "return r.status+' '+(await r.text()).slice(0,300);}")
        log(tag, "сессия:", str(me)[:90])
        if '"user"' not in str(me):
            save({"idx": idx, "acc": acc, "secret": "", "proxy": proxy,
                  "email": mailbox["addr"], "stage": "login_fail",
                  "err": str(me)[:100], "ts": time.strftime("%Y-%m-%dT%H:%M:%S")})
            return None

        # key
        pg.goto(SITE + "/dashboard/keys", wait_until="commit", timeout=45000)
        time.sleep(9)
        secret = ""
        for attempt in range(3):
            me = pg.evaluate("async()=>{const r=await fetch('/api/account/me',{credentials:'include'});return r.status+' '+(await r.text());}")
            mu = re.search(r'"id"\s*:\s*"([0-9a-f-]{36})"', me)
            uid = mu.group(1) if mu else ""
            ci = pg.evaluate("()=>{try{return JSON.parse(localStorage.getItem('ul:security-browser')||'null')?.id||''}catch(e){return ''}}")
            k = pg.evaluate("""async (h) => {
                const r = await fetch('/api/account/keys', {method:'POST', credentials:'include',
                    headers:{'Content-Type':'application/json','X-Account-ID':h.uid,'X-Client-Instance':h.ci},
                    body: JSON.stringify({name:'k'+Date.now()})});
                return r.status + ' ' + (await r.text()).slice(0,400); }""", {"uid": uid, "ci": ci})
            if k.startswith("201"):
                try: secret = json.loads(k.split(" ", 1)[1]).get("secret", "")
                except Exception: pass
                break
            log(tag, "key attempt:", k[:100])
            if "account_changed" in k:
                pg.evaluate("()=>location.reload()")
                time.sleep(9)
            else:
                time.sleep(3)
        if not secret:
            log(tag, "NO KEY"); save({"idx": idx, "acc": acc, "secret": "", "proxy": proxy, "stage": "no_key"}); return None
        log(tag, "KEY ok", secret[:14] + "...")

        # verify-email + claim (сессия уже загружена на /dashboard/keys — годится)
        ve = pg.evaluate("""async (h) => {
            const r = await fetch('/api/account/trial/verify-email', {method:'POST', credentials:'include',
                headers:{'Content-Type':'application/json','X-Account-ID':h.uid,'X-Client-Instance':h.ci},
                body: JSON.stringify({email: h.em})});
            return r.status + ' ' + (await r.text()).slice(0,150); }""", {"uid": uid, "ci": ci, "em": mailbox["addr"]})
        log(tag, "verify-email:", ve[:100])
        claimed = False
        if ve.startswith("200"):
            # trial-токен читаем из письма smailpro (cmd=code), не из mail.tm
            cr = _mail_ask(mailbox, cmd="code", deadline=180, timeout=240)
            ctok = cr.get("code") or ""
            log(tag, "claim token:", bool(ctok))
            if ctok:
                c = pg.evaluate("""async (h) => {
                    const r = await fetch('/api/account/trial/claim', {method:'POST', credentials:'include',
                        headers:{'Content-Type':'application/json','X-Account-ID':h.uid,'X-Client-Instance':h.ci},
                        body: JSON.stringify({token: h.tok})});
                    return r.status + ' ' + (await r.text()).slice(0,150); }""", {"uid": uid, "ci": ci, "tok": ctok})
                log(tag, "claim:", c[:100])
                claimed = c.startswith("200")

        rec = {"idx": idx, "acc": acc, "secret": secret, "email": mailbox["addr"],
               "claimed": claimed, "proxy": proxy.split("@")[-1],
               "ts": time.strftime("%Y-%m-%dT%H:%M:%S")}
        save(rec)
        # В пул хаба пишем ДО лога DONE: аккаунт уже рабочий (ключ есть), и
        # ротация должна видеть его, даже если claim не удался.
        save_pool(rec)
        log(tag, "DONE claimed:", claimed)
        return rec
    except Exception as e:
        log(tag, "ERR", str(e)[:140])
        try:
            save({"idx": idx, "acc": locals().get("acc", ""), "secret": locals().get("secret", ""),
                  "proxy": proxy, "stage": "exc", "err": str(e)[:120]})
        except Exception:
            pass
        return None
    finally:
        # Закрываем именно fox, а не ctx: Camoufox держит внутри playwright-цикл,
        # и простой ctx.close() оставлял висящую задачу («Task was destroyed but it
        # is pending», TargetClosedError после прогона).
        try: fox.__exit__(None, None, None)
        except Exception: pass
        # ящик smailpro живёт своим процессом — гасим, иначе остаётся висеть
        try: _mail_stop(mailbox)
        except Exception: pass


def scrape_proxies(want=12, timeout=600):
    """Скрапим СВЕЖИЕ прокси нашим же скрапером хаба перед каждой волной.

    Почему каждый раз: бесплатные SOCKS5 дохнут за часы, а не дни — замер 24.11
    показал 8 мёртвых из 16 в списке суточной давности. Список «socks-alive.txt»
    живёт как вход, а не как истина: истина — то, что отдал скрапер сейчас.

    Возвращает список строк socks5://host:port или [] при неудаче.
    """
    import subprocess
    # 🪤 Путь к скраперу считается ОТ ФАЙЛА, как и путь пула: <repo>/tools/
    # proxy-validator. Хардкод C:/Users/... не работал на другой машине, а
    # теперь ещё и маскировался — скрипт молча уходил на старый список.
    validator = os.path.abspath(os.path.join(HERE, "..", "..", "tools", "proxy-validator"))
    out = os.path.join(HERE, "socks-fresh.txt")
    log(f"скрап свежих прокси (want={want})…")
    log(f"скрапер: {validator}")
    try:
        r = subprocess.run(
            [sys.executable, "-m", "proxy_scraper.find_for_host",
             "--host", "uncensoredlabs.dev", "--path", "/v1/models",
             "--want", str(want), "--json", "--out", out],
            cwd=validator, capture_output=True, text=True, timeout=timeout,
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        )
    except Exception as e:
        log("скрап упал:", str(e)[:120])
        return []
    if r.returncode != 0:
        log("скрап rc:", r.returncode, (r.stderr or "")[-160:])
        return []
    try:
        fresh = [x.strip() for x in open(out, encoding="utf-8") if x.strip()]
    except Exception:
        fresh = []
    log(f"скрап дал {len(fresh)} прокси")
    return fresh


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-ip", type=int, default=2, help="аккаунтов на прокси за прогон")
    ap.add_argument("--proxies", default=os.path.join(HERE, "socks-alive.txt"))
    ap.add_argument("--rounds", type=int, default=1, help="сколько прогонов по списку прокси")
    ap.add_argument("--want", type=int, default=12, help="сколько свежих прокси скрапить на волну")
    ap.add_argument("--parallel", type=int, default=1,
                    help="сколько аккаунтов гонять ОДНОВРЕМЕННО (каждому свой прокси)")
    ap.add_argument("--no-scrape", action="store_true",
                    help="не скрапить, взять готовый --proxies (отладка)")
    args = ap.parse_args()
    parallel = max(1, min(8, args.parallel))

    proxies = []
    if not args.no_scrape:
        proxies = scrape_proxies(want=max(args.want, parallel))
    if not proxies:
        proxies = [x.strip() for x in open(args.proxies, encoding="utf-8") if x.strip()]
        log(f"свежих нет — беру готовый список: {len(proxies)}")
    if not proxies:
        log("нет живых прокси"); return 2
    log(f"пул: {len(proxies)} прокси × {args.per_ip} акк × {args.rounds} раунд(ов) · параллельно {parallel}")

    # ── очередь задач: (proxy, idx) — прокси раздаётся по одному за раз ─────
    # 🪤 Лимит 5/IP/24ч: параллельные воркеры должны брать РАЗНЫЕ прокси, поэтому
    # очередь одну и ту же прокси не отдаёт, пока предыдущий воркер её не вернёт.
    # per_ip>1 не совмещается с параллелью (все n одного прокси идут подряд в
    # одном воркере — очередь и так это обеспечит).
    task_q = queue.Queue()
    done_q = queue.Queue()
    idx_base = int(time.time()) % 100000
    total_tasks = 0
    for rnd in range(args.rounds):
        for px in proxies:
            for n in range(args.per_ip):
                total_tasks += 1
                task_q.put((px, idx_base + total_tasks, rnd))

    made = claimed = 0
    counter_lock = threading.Lock()

    def worker():
        nonlocal made, claimed
        while True:
            try:
                px, idx, rnd = task_q.get_nowait()
            except queue.Empty:
                return
            mb = None
            try:
                mb = make_mailbox(None)
                if not mb:
                    log(f"[{idx}] mailbox FAIL — пропуск")
                    continue
                log(f"[{idx}] mailbox:", mb["addr"], f"(раунд {rnd+1})")
                rec = farm_one(None, idx, px, mb)
                if rec:
                    with counter_lock:
                        made += 1
                        if rec.get("claimed"): claimed += 1
                else:
                    log(f"[{idx}] попытка без результата")
            except Exception as e:
                log(f"[{idx}] farm ERR", str(e)[:120])
            finally:
                if mb:
                    _mail_stop(mb)
                done_q.put(idx)

    # 🪤 ThreadPoolExecutor вместо ручных Thread: исключение воркера не убивает
    # пул, а join прост. Каждый аккаунт поднимает СВОЙ Camoufox (farm_one), окно
    # своё — окно владельца не трогается.
    from concurrent.futures import ThreadPoolExecutor
    n_workers = min(parallel, total_tasks)
    log(f"воркеров: {n_workers}, задач: {total_tasks}")
    with ThreadPoolExecutor(max_workers=n_workers) as pool:
        for _ in range(n_workers):
            pool.submit(worker)
        # ждём: done_q наполняется по одному на завершённую задачу
        for _ in range(total_tasks):
            done_q.get()

    log(f"ИТОГО: {made} аккаунтов, {claimed} с $0.10, банк: {BANK}")
    return 0 if made else 1


if __name__ == "__main__":
    sys.exit(main())
