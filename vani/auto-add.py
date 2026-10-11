#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
vani/auto-add.py

Авторега Vani (vani.ai) без человека. Движок - Camoufox (Firefox без CDP): капчу
Cloudflare Turnstile на шаге входа берёт смена движка + клик по виджету.

🔴 Особенность vani: ВХОД БЕЗ ПАРОЛЯ. Адрес -> кнопка «Email me a sign-in link or code»
-> 6-значный код из письма -> сессия. Пароля нет, поэтому в пул пишется email + ключ.

Почта - emailnator.com, точечный адрес `.Gmail`. Доставка кода vani на такой адрес
доказана ручной записью 09.10. Код читаем ИЗ РАЗМЕТКИ ЯЩИКА (письмо кладёт код в тему),
а НЕ через ручку `/message-list` - она отдаёт 404 (замер 09.10).

Запуск:  python vani/auto-add.py <label> [--tier none|scraper|own]
Маркеры: VN_STAGE {json}, VN_AUTOADD_RESULT {json}.
Коды возврата: 1 не запустился, 2 форма/капча, 3 код не получен, 4 ключ не снят, 6 ящик не взят.
"""

import asyncio
import json
import os
import re
import sys
import time
import urllib.request

try:
    import requests  # быстрый CF-пре-чек через прокси (socks - через PySocks)
except Exception:
    requests = None
from datetime import datetime
from pathlib import Path

from camoufox import AsyncCamoufox

DIR = Path(__file__).resolve().parent
# od_common (odyssey) - прокси из ОБЩЕГО пула для автореги (acquire_proxy). Импорт после DIR:
# путь к odyssey/ известен только от расположения этого файла.
sys.path.insert(0, str(DIR.parent / "odyssey"))
import od_common as od  # noqa: E402
PROFILE_ROOT = DIR / "profiles"
SESSIONS_DIR = DIR / "sessions"

LOGIN_URL = "https://c.vani.ai/login"
KEYS_URL = "https://c.vani.ai/settings/developer"
MAIL_URL = "https://www.emailnator.com/"
DASH_ADD = "http://127.0.0.1:8200/__switch/api/vn/add"

KEY_RE = re.compile(r"\bvani_[A-Za-z0-9]{40,}\b")
CODE_RE = re.compile(r"\b(\d{6})\b")
CODE_HINT = re.compile(r"code|verification|verify|sign-?in|код", re.I)
STALE = re.compile(r"\d+\s*(hrs?|hours?|days?|d)\s*ago|yesterday", re.I)

argv = sys.argv[1:]
label = "autoreg"
tier = "scraper"
exclude = []
i = 0
while i < len(argv):
    a = argv[i]
    if a == "--tier" and i + 1 < len(argv):
        tier = argv[i + 1]; i += 1
    elif a.startswith("--tier="):
        tier = a.split("=", 1)[1]
    elif a == "--exclude" and i + 1 < len(argv):
        exclude = [x for x in argv[i + 1].split(",") if x]; i += 1
    elif a.startswith("--exclude="):
        exclude = [x for x in a.split("=", 1)[1].split(",") if x]
    elif not a.startswith("--"):
        label = a
    i += 1
label = re.sub(r"[^\w-]", "_", label) or "autoreg"
if tier not in ("none", "scraper", "own"):
    tier = "scraper"
# 🔴 Профиль - СВОЙ на каждый прогон (метка + время), а не один общий `autoreg_<label>`.
# Две причины, обе кусались 10.10:
#   1) куки каждого зарега в общем профиле ПЕРЕТИРАЮТСЯ следующим прогоном, а они должны жить;
#   2) Firefox копит в переиспользованном профиле след грязных завершений (`couldRestoreSession`,
#      `sessionstore-backups/recovery.jsonlz4`) и на старте предлагает Troubleshoot Mode -
#      а он выключает кастом и расширения, то есть весь анти-детект Camoufox, и Turnstile палит.
# Профиль НЕ удаляется: в конце успешного прогона он переименовывается в `acct_<id>` (см. finally),
# чтобы дашборд находил его детерминированно, без кнопки «🔗 Профили».
RUN_STAMP = datetime.now().strftime("%Y%m%d-%H%M%S")
PROFILE = PROFILE_ROOT / f"autoreg_{label}_{RUN_STAMP}"


def log(kind, msg):
    print(f"[{datetime.now():%H:%M:%S}] {kind:<9} {msg}", flush=True)


def flat(s, n):
    return re.sub(r"\s+", " ", str(s if s is not None else ""))[:n]


def stage(name, note=""):
    print(f"stage: {name}" + (f" | {note}" if note else ""), flush=True)
    print("VN_STAGE " + json.dumps({"stage": name, "note": note or None}, ensure_ascii=False), flush=True)


async def refeed_proxies(log):
    """Долив СВЕЖИХ прокси под c.vani.ai прямо перед прогоном (как odyssey `refill`).

    🔴 Публичные прокси живут минуты: работать по вчерашнему файлу пула нельзя - пул сядет
    на дохлых и откажет. `proxy-refeed.js` скрапит под хост, льёт свежие В НАЧАЛО файла
    (привязки не рвутся, хвост режется по cap) - и пул сразу отдаёт живого.
    """
    script = DIR.parent / "routing" / "lib" / "proxy-refeed.js"
    if not script.exists():
        log("ПРОКСИ", "proxy-refeed.js нет - долив пропущен")
        return
    log("ПРОКСИ", "доливаю свежие прокси (скрап под c.vani.ai)...")
    cmd = ["node", str(script), "--host", "c.vani.ai", "--path", "/api/announcements",
           "--want", "12", "--max-candidates", "4000"]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, cwd=str(DIR.parent),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env={**os.environ, "PROXY_POOL_SOURCE": "scraped", "PYTHONIOENCODING": "utf-8"})
        out, err = await asyncio.wait_for(proc.communicate(), timeout=600)
        for l in (out or b"").decode("utf-8", "replace").strip().splitlines()[-3:]:
            log("ПРОКСИ", f"  {flat(l, 120)}")
    except asyncio.TimeoutError:
        log("ПРОКСИ", "долив не уложился в 10 мин - иду с тем, что есть")
    except Exception as e:
        log("ПРОКСИ", f"долив сорвался: {flat(str(e), 100)}")


def preflight_cf(cfg, log):
    """БЫСТРЫЙ пре-чек: пройдёт ли Cloudflare на странице входа через этот прокси.

    🔴 Замер 10.10: часть прокси достаёт JSON-ручку `api/announcements`, но CF **челленджит
    HTML-страницу входа** - браузер на них висит минуту и падает «форма не найдена». Ждать
    по минуте на каждый прокси нельзя, поэтому проверяем ДО запуска браузера: обычный GET
    `/login` через прокси (10 с), ищем признак настоящей страницы и отсутствие челленджа.
    Не прошёл - сразу следующий (вернём False, обёртка исключит адрес).
    """
    if not cfg or requests is None:
        return True
    server = str(cfg.get("server") or "")
    if not server:
        return True
    url = server
    if cfg.get("username"):
        scheme, _, rest = server.partition("://")
        url = f"{scheme}://{cfg['username']}:{cfg.get('password', '')}@{rest}"
    try:
        r = requests.get("https://c.vani.ai/login", proxies={"http": url, "https": url},
                         timeout=10, headers={"User-Agent": "Mozilla/5.0", "Accept": "text/html"})
    except Exception as e:
        log("ПРЕ-ЧЕК", f"CF: прокси не ответил ({flat(str(e), 60)}) - беру следующий")
        return False
    body = (r.text or "")[:6000].lower()
    challenge = ("just a moment" in body) or ("attention required" in body) or ("cf-chl" in body) \
        or ("challenge-platform" in body) or ("enable javascript and cookies" in body)
    real = ("vani" in body)
    if r.status_code == 200 and real and not challenge:
        log("ПРЕ-ЧЕК", "✅ CF пройден на этом прокси")
        return True
    log("ПРЕ-ЧЕК", f"CF не пройден (HTTP {r.status_code}{' · челлендж' if challenge else ''}) - беру следующий")
    return False


def register_in_dashboard(l, email, key):
    body = json.dumps({"email": email, "api_key": key, "name": l}).encode("utf-8")
    try:
        req = urllib.request.Request(DASH_ADD, data=body, method="POST")
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=15) as r:
            ans = json.loads(r.read().decode("utf-8") or "{}")
        log("ДАШБОРД", f"аккаунт заведён в пул: {ans.get('id')}")
        return ans.get("id")
    except Exception as e:
        log("ДАШБОРД", f"в пул не завёл ({flat(str(e), 80)}) - ключ всё равно в маркере")
        return None


async def click_button(page, text):
    idx = await page.evaluate("""(t) => {
        const all = [...document.querySelectorAll('button')];
        return all.findIndex(x => (x.innerText || '').replace(/\\s+/g, ' ').trim() === t);
    }""", text)
    if idx < 0:
        return False
    try:
        await page.locator('button').nth(idx).click(timeout=8000)
        return True
    except Exception:
        return False


# ── emailnator: адрес точечный `.Gmail` ────────────────────────────────────────
CHIPS = ["Domain", "+Gmail", ".Gmail", "GoogleMail"]
WANT_CHIP = ".Gmail"


async def _chip_on(page, label_):
    """Включён ли чип: по цвету переключателя (синий = вкл), атрибут врёт."""
    return await page.evaluate("""(t) => {
        const b = [...document.querySelectorAll('button.mf-chip')]
            .find(x => (x.innerText || '').replace(/\\s+/g, ' ').trim() === t);
        if (!b) return null;
        const sw = b.querySelector('.mf-chip-switch');
        if (!sw) return null;
        const m = (getComputedStyle(sw).backgroundColor || '').match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
        if (!m) return false;
        const [r, g, bl] = [+m[1], +m[2], +m[3]];
        return bl > 150 && (bl - r) > 60;
    }""", label_)


async def _click_chip(page, label_):
    idx = await page.evaluate("""(t) => {
        const all = [...document.querySelectorAll('button.mf-chip')];
        return all.findIndex(x => (x.innerText || '').replace(/\\s+/g, ' ').trim() === t);
    }""", label_)
    if idx < 0:
        return
    try:
        await page.locator('button.mf-chip').nth(idx).click(timeout=4000)
        await asyncio.sleep(0.7)
    except Exception:
        pass


async def _select_dot_gmail(page):
    for c in CHIPS:
        cur = await _chip_on(page, c)
        if cur is None:
            continue
        if cur != (c == WANT_CHIP):
            await _click_chip(page, c)
    after = {c: await _chip_on(page, c) for c in CHIPS}
    log("ПОЧТА", "чипы: " + " ".join(f"{c}={'ВКЛ' if after[c] else 'выкл'}" for c in CHIPS))


async def _read_addr(page):
    try:
        loc = page.locator(".mf-address-row .mf-mono, .mf-panel-address, .mf-mono").first
        if await loc.count():
            m = re.search(r"[\w.+-]+@[\w.-]+", " ".join((await loc.inner_text()).split()))
            if m:
                return m.group(0)
    except Exception:
        pass
    try:
        return await page.evaluate("""() => {
            const h = decodeURIComponent(location.hash.replace('#',''));
            if (h.includes('@')) return h.trim();
            const m = (document.body.innerText||'').match(/[a-zA-Z0-9.+_%\\-]+@(?:gmail|googlemail)\\.com/);
            return m ? m[0] : '';
        }""")
    except Exception:
        return ""


def _is_dot_gmail(a):
    a = (a or "").strip()
    return bool(a) and "+" not in a and a.split("@")[-1].lower() in ("gmail.com", "googlemail.com")


async def get_mailbox(page):
    try:
        await page.goto(MAIL_URL, wait_until="domcontentloaded", timeout=60000)
    except Exception as e:
        log("ПОЧТА", f"emailnator не открылся: {flat(str(e), 80)}")
        return ""
    try:
        await page.click('button:has-text("Consent")', timeout=4000)
    except Exception:
        pass
    for _ in range(30):
        await asyncio.sleep(2)
        try:
            t = await page.title()
        except Exception:
            t = ""
        if "just a moment" not in (t or "").lower():
            break
    await asyncio.sleep(1.5)
    for attempt in range(1, 4):
        await _select_dot_gmail(page)
        if not await click_button(page, "Generate New"):
            await click_button(page, "Generate")
        await asyncio.sleep(4)
        addr = await _read_addr(page)
        log("ПОЧТА", f"попытка {attempt}: {addr or '(пусто)'}")
        if _is_dot_gmail(addr):
            if await click_button(page, "GO !") or await click_button(page, "GO"):
                await asyncio.sleep(4)
                addr = await _read_addr(page) or addr
            log("ПОЧТА", f"✅ gmail: {addr}")
            return addr.strip()
    log("ПОЧТА", "точечный gmail не получен")
    return ""


async def read_code(page, addr, timeout_s=220, poll_s=2):
    """Код из РАЗМЕТКИ ящика emailnator. Письмо vani кладёт код в ТЕМУ («NNNNNN is your
    Vani sign-in code»), поэтому список писем уже содержит код - открывать письмо не нужно.

    🪤 Ручка `/message-list` отдаёт 404 (замер 09.10) - читаем DOM, как emailnator.js.
    """
    log("ПОЧТА", f"слежу за {addr} ({timeout_s}s макс)")
    try:
        await page.goto(f"{MAIL_URL}inbox#{addr}", wait_until="domcontentloaded", timeout=30000)
    except Exception:
        pass
    await asyncio.sleep(3)
    deadline = asyncio.get_event_loop().time() + timeout_s
    last_n = -1
    last_refresh = 0.0
    seen = set()
    while asyncio.get_event_loop().time() < deadline:
        try:
            rows = await page.locator("a.mf-msg-link").all()
        except Exception:
            rows = []
        texts = []
        for row in rows[:10]:
            try:
                texts.append(" ".join((await row.inner_text()).split()))
            except Exception:
                pass
        if len(texts) != last_n:
            last_n = len(texts)
            log("ПОЧТА", f"писем в списке: {len(texts)}")
        for t in texts:
            if not t:
                continue
            if re.search(r"upgrade to unlock|locked sender|unleash the power|ai tools", t, re.I):
                continue
            if STALE.search(t):
                continue
            if t in seen:
                continue
            if CODE_HINT.search(t):
                m = CODE_RE.search(t)
                if m:
                    log("ПОЧТА", f"✅ код из темы: {m.group(1)}")
                    return m.group(1)
            seen.add(t)
        # 🪤 Список читаем ЧАСТО (каждые poll_s), а обновляем РЕДКО (раз в 15 с): кнопка
        # Reload на каждой итерации перезагружает страницу, и чтение тонет в перезагрузках -
        # снаружи это «рега очень медленная на шаге кода» (замер 10.10). Тот же приём, что
        # у odyssey (`fetch_22do_code`): читаем 2 с, «Refresh» - только если пусто дольше.
        now = time.monotonic()
        if now - last_refresh > 15:
            last_refresh = now
            clicked = False
            for sel in ("button:has-text('Reload')", "button:has-text('Refresh')", "button.mf-panel-btn"):
                try:
                    loc = page.locator(sel).first
                    if await loc.count():
                        await loc.click(timeout=4000)
                        clicked = True
                        break
                except Exception:
                    continue
            if not clicked:
                try:
                    await page.reload(wait_until="domcontentloaded", timeout=20000)
                except Exception:
                    pass
        await asyncio.sleep(poll_s)
    log("ПОЧТА", "код не появился")
    return ""


async def pass_turnstile(site_page, bound_s=40):
    """Жмёт Turnstile и ждёт токен (приём ourtoken): клик по элементу iframe + фолбэк в тело
    фрейма. Окно ДОЛЖНО быть впереди - в фоне Firefox троттлит вкладку."""
    try:
        await site_page.bring_to_front()
    except Exception:
        pass
    for _ in range(max(4, bound_s // 5)):
        try:
            await site_page.click(
                "iframe[src*='cloudflare'], iframe[src*='turnstile'], .cf-turnstile", timeout=3000)
        except Exception:
            for f in site_page.frames:
                if "challenges.cloudflare" in (f.url or ""):
                    try:
                        await f.click("body", position={"x": 30, "y": 30}, timeout=3000)
                    except Exception:
                        pass
                    break
        await asyncio.sleep(1.5)
        try:
            t = await site_page.eval_on_selector(
                'input[name="cf-turnstile-response"]', "el => el.value")
        except Exception:
            t = None
        if t and len(t) > 10:
            log("КАПЧА", f"✅ токен ({len(t)} симв.)")
            return True
    log("КАПЧА", "токен не получен - форму всё равно пробуем отправить")
    return False


async def main():
    PROFILE.mkdir(parents=True, exist_ok=True)
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    log("СТАРТ", f"Camoufox · профиль vani/profiles/{PROFILE.name} · ярус {tier}")

    # Прокси из ОБЩЕГО пула скраппера (как у odyssey, через od_common). Контракт пула:
    # `ok:false` - «НЕ ХОДИТЬ ВООБЩЕ»; молча уйти напрямую нельзя.
    proxy_cfg = None
    if tier != "none":
        # Сначала ДОЛИВ свежих (скрап + сразу в дело), потом берём из пула - как odyssey.
        await refeed_proxies(log)
        # 🔴 Таймаут обязателен: скрап-пул перебирает кандидатов и на почти-мёртвом пуле
        # (замер 10.10: все адреса для c.vani.ai мимо) не возвращает ответ минутами. Раньше
        # это вешало прогон наглухо. Не ответил - идём напрямую, но ГРОМКО.
        try:
            proxy_cfg = await asyncio.wait_for(
                od.acquire_proxy(tier, f"vani:autoreg:{label}", log,
                                 host="c.vani.ai", probe_path="/api/announcements",
                                 exclude=exclude),
                timeout=75)
        except asyncio.TimeoutError:
            log("ПРОКСИ", "⚠️ пул не ответил за 75 с (перебор мёртвых) - иду НАПРЯМУЮ")
            proxy_cfg = None
        except Exception as e:
            log("ПРОКСИ", f"⚠️ пул отказал: {flat(str(e), 120)} - иду НАПРЯМУЮ (домашний IP)")
            proxy_cfg = None
        # Быстрый CF-пре-чек ДО запуска браузера: не прошёл - сразу на следующий прокси
        # (вернём 7 с retryable, обёртка исключит адрес), чтобы не жечь минуту на форму.
        if proxy_cfg and not preflight_cf(proxy_cfg, log):
            print("VN_AUTOADD_RESULT " + json.dumps(
                {"ok": False, "error": "CF не пройден на прокси", "retryable": True,
                 "proxy": (od.LAST_PROXY or {}).get("label")}, ensure_ascii=False), flush=True)
            return 7

    captured = {"key": ""}
    rename_to = None   # куда переименовать профиль на выходе (`acct_<id>`), см. finally
    base = dict(
        headless=False, os="windows", window=(1500, 1000),
        persistent_context=True, user_data_dir=str(PROFILE),
        disable_coop=True, humanize=8.0, main_world_eval=True, i_know_what_im_doing=True,
        firefox_user_prefs={
            "widget.windows.window_occlusion_tracking.enabled": False,
            "dom.min_background_timeout_value": 4,
            "dom.timeout.enable_budget_timer_throttling": False,
            "media.suspend-bkgnd-video.enabled": False,
            "browser.tabs.unloadOnLowMemory": False,
        },
    )

    # 🔴 ПОЧТА - ВНЕ ПРОКСИ, РЕГИСТРАЦИЯ - ЧЕРЕЗ ПРОКСИ. Замер 10.10: прокси скраппера
    # достаёт c.vani.ai за 1.4 с, а emailnator через него - 200, но 25 с и тело рвётся;
    # 22.do и вовсе недоступен. Почтовый сервис ВНЕШНИЙ, панель тут ни при чём (канон
    # AIKeysAPI: «ящик создаётся раньше прокси»). Профили РАЗНЫЕ - Firefox не открывает
    # один user_data_dir дважды.
    reg_base = dict(base)
    if proxy_cfg:
        reg_base["proxy"] = proxy_cfg
        # geoip - extras-зависимость; без неё пояс/локаль останутся нашими при чужом IP,
        # а это ровно то расхождение, по которому Cloudflare отличает бота.
        try:
            import importlib.util
            if importlib.util.find_spec("geoip2"):
                reg_base["geoip"] = True
            else:
                log("ПРОКСИ", "geoip недоступен - иду без него")
        except Exception:
            pass
    reg_cm = AsyncCamoufox(**reg_base)
    try:
        ctx = await reg_cm.__aenter__()
    except Exception as e:
        print('VN_AUTOADD_RESULT {"ok":false,"error":"браузер регистрации не поднялся"}', flush=True)
        log("БРАУЗЕР", f"регистрация не поднялась: {flat(str(e), 400)}")
        return 1

    mail_cm = None
    if proxy_cfg:
        mail_base = dict(base)
        mail_base["user_data_dir"] = str(PROFILE) + "_mail"
        mail_cm = AsyncCamoufox(**mail_base)
        try:
            ctx_mail = await mail_cm.__aenter__()
        except Exception as e:
            print('VN_AUTOADD_RESULT {"ok":false,"error":"браузер почты не поднялся"}', flush=True)
            log("БРАУЗЕР", f"почта не поднялась: {flat(str(e), 100)}")
            try:
                await reg_cm.__aexit__(None, None, None)
            except Exception:
                pass
            return 1
    else:
        ctx_mail = ctx   # прокси нет - почта и панель в одной сессии

    try:
        def wire(c):
            def on_res(res):
                async def grab():
                    try:
                        u = res.url or ""
                        if "vani.ai" not in u:
                            return
                        full = await res.text()
                        if "/login" in u and res.request.method == "POST":
                            log("ОТВЕТ", f"{res.status} {flat(u, 44)} :: {flat(full, 150)}")
                        m = KEY_RE.search(full or "")
                        if m and captured["key"] != m.group(0):
                            captured["key"] = m.group(0)
                            log("КЛЮЧ", f"🔑 поймал в ответе {flat(u, 60)}")
                    except Exception:
                        pass
                asyncio.create_task(grab())
            c.on("response", on_res)
        wire(ctx)

        # 1. ящик - в ПОЧТОВОМ (непроксированном) контексте
        stage("mail", "ящик emailnator (.Gmail)")
        mail_page = ctx_mail.pages[0] if ctx_mail.pages else await ctx_mail.new_page()
        addr = await get_mailbox(mail_page)
        if not addr:
            print('VN_AUTOADD_RESULT {"ok":false,"error":"ящик не взят"}', flush=True)
            return 6
        # 2. форма - в РЕГИСТРАЦИОННОМ (проксированном) контексте
        site_page = await ctx.new_page()

        # 2. форма + капча
        stage("form", "c.vani.ai/login")
        try:
            await od.goto_retry(site_page, LOGIN_URL, log, tries=3, pause_s=4)
        except Exception as e:
            log("ФОРМА", f"страница входа не открылась: {flat(str(e), 90)}")
            print('VN_AUTOADD_RESULT {"ok":false,"error":"прокси сорвал переход"}', flush=True)
            return 2
        await site_page.wait_for_timeout(3000)
        try:
            # 🪤 Через скрап-прокси страница входа грузится дольше: сначала CF-челлендж, потом
            # Next.js. Замер 10.10 - на 30 с форма не успевала, прогон писал «форма не найдена».
            await site_page.wait_for_selector("input#email", timeout=60000)
            await site_page.fill("input#email", addr, timeout=15000)
        except Exception as e:
            log("ФОРМА", f"поле адреса не найдено: {flat(str(e), 70)}")
            print('VN_AUTOADD_RESULT {"ok":false,"error":"форма входа не найдена"}', flush=True)
            return 2
        asked = False
        for attempt in range(1, 5):
            if not await click_button(site_page, "Email me a sign-in link or code"):
                try:
                    await site_page.click("button[type='submit']", timeout=6000)
                except Exception:
                    pass
            stage("turnstile", f"капча, попытка {attempt}")
            await pass_turnstile(site_page, 30)
            if not await click_button(site_page, "Email me a sign-in link or code"):
                try:
                    await site_page.click("button[type='submit']", timeout=6000)
                except Exception:
                    pass
            await site_page.wait_for_timeout(4000)
            if await site_page.locator("input#email-code").count() > 0:
                log("ФОРМА", f"код запрошен (попытка {attempt})")
                asked = True
                break
            try:
                log("ФОРМА", f"состояние: {flat(await site_page.inner_text('body'), 140)}")
            except Exception:
                pass
            await site_page.wait_for_timeout(15000)
        if not asked:
            print('VN_AUTOADD_RESULT {"ok":false,"error":"код не запрошен: капча не пройдена"}', flush=True)
            return 2

        # 3. код
        stage("code", "ждём письмо с кодом")
        code = await read_code(mail_page, addr)
        if not code:
            print('VN_AUTOADD_RESULT {"ok":false,"error":"код не получен"}', flush=True)
            return 3

        # 4. ввод кода
        stage("verify", "вводим код")
        await site_page.bring_to_front()
        try:
            await site_page.wait_for_selector("input#email-code", timeout=30000)
            await site_page.fill("input#email-code", code, timeout=15000)
            await click_button(site_page, "Verify code and sign in")
        except Exception as e:
            log("ПРОВЕРКА", f"код не введён: {flat(str(e), 70)}")
            print('VN_AUTOADD_RESULT {"ok":false,"error":"не ввёл код"}', flush=True)
            return 2
        await site_page.wait_for_timeout(5000)

        # 5. ключ
        stage("key", "создаём ключ на platform.vani.ai")
        try:
            # 🪤 Прямой goto через прокси иногда рвётся `NS_BINDING_ABORTED` (навигацию
            # перебивает ещё неосевший редирект после ввода кода). Берём goto_retry od_common.
            await od.goto_retry(site_page, KEYS_URL, log, tries=4, pause_s=4)
            await site_page.wait_for_timeout(5000)
            try:
                await click_button(site_page, "Create key")
                await site_page.wait_for_timeout(1500)
                name_input = site_page.locator("input#key-name").first
                if await name_input.count():
                    await name_input.fill(label, timeout=8000)
                await site_page.locator("button:has-text('Create key')").last.click(timeout=10000)
            except Exception as e:
                log("КЛЮЧ", f"кнопки создания ключа: {flat(str(e), 70)}")
            for _ in range(20):
                if captured["key"]:
                    break
                await site_page.wait_for_timeout(1000)
        except Exception as e:
            log("КЛЮЧ", f"консоль не открылась: {flat(str(e), 80)}")
        key = captured["key"]
        if not key:
            print('VN_AUTOADD_RESULT {"ok":false,"error":"ключ не снят"}', flush=True)
            return 4

        # 6. пул
        acc_id = register_in_dashboard(label, addr, key)
        if acc_id:
            rename_to = f"acct_{acc_id}"
            try:
                cookies = await ctx.cookies()
                vc = [c for c in cookies if "vani.ai" in (c.get("domain") or "")]
                out = SESSIONS_DIR / f"acct_{acc_id}.json"
                out.write_text(json.dumps({"cookies": vc, "origins": []}, ensure_ascii=False, indent=1),
                               encoding="utf-8")
                log("СЕССИЯ", f"куки для 🌐: {out.name} ({len(vc)})")
            except Exception as e:
                log("СЕССИЯ", f"снимок не вышел: {flat(str(e), 70)}")

        stage("done", "готово")
        print("VN_AUTOADD_RESULT " + json.dumps(
            {"ok": True, "key": key, "email": addr, "label": label, "id": acc_id,
             "proxy": (od.LAST_PROXY or {}).get("label")},
            ensure_ascii=False), flush=True)
        return 0
    finally:
        for _cm in (reg_cm, mail_cm):
            if _cm is not None:
                try:
                    await _cm.__aexit__(None, None, None)
                except Exception:
                    pass
        # Браузер закрыт - профиль свободен. Отдаём его дашборду под именем `acct_<id>`,
        # чтобы баланс и «🌐 ЛК» находили живые куки зарега без ручного сопоставления.
        if rename_to:
            try:
                dest = PROFILE_ROOT / rename_to
                if not dest.exists():
                    PROFILE.rename(dest)
                    log("ПРОФИЛЬ", f"сохранён → vani/profiles/{rename_to}")
            except Exception as e:
                log("ПРОФИЛЬ", f"переименовать не вышло (куки всё равно в {PROFILE.name}): {flat(str(e), 70)}")


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        print('VN_AUTOADD_RESULT {"ok":false,"error":"прервано"}', flush=True)
        sys.exit(130)
