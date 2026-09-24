#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
odyssey/od_common.py

Шаги, общие для всех окон Odyssey: прокси из общего пула, ящик на 22.do, клики,
чтение адреса. Берут отсюда и записыватель (`record-signup-camoufox.py`), и драйвер
автореги (`auto-add.py`).

Зачем отдельный модуль. Ящик на 22.do и получение прокси - не «две похожие строчки», а
два неочевидных шага с граблями, каждая из которых стоила прогона: «Random» крутит ДОМЕН,
а не локальную часть; gmail приходит только через Random и выпадает не с первого раза; у
`fetchVia` тело читается методом, а не свойством. Две копии этого разъедутся за неделю -
ровно то, что уже случилось в этом репозитории с ожиданием кода почты, где правка в либе
не касалась дубля в чужом скрипте.
"""

import asyncio
import json
import os
import re
import shutil
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

# 🔴 Вывод в UTF-8 принудительно. В консоли Windows кодировка cp866, и ЛЮБАЯ строка с
# эмодзи роняла прогон целиком: замер 16.09 - проба ящика умерла на `log("ПОЧТА", f"✅ адрес
# готов: …")` с `UnicodeEncodeError: 'charmap' codec can't encode character '✅'`.
# Дашборд ставит PYTHONIOENCODING сам, а ручной запуск из терминала - нет, поэтому
# кодировку задаём здесь, а не надеемся на окружение.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

DIR = Path(__file__).resolve().parent
# Метка последнего выданного прокси. Нужна драйверу: после регистрации он привязывает
# аккаунт к ТОМУ ЖЕ адресу (`--bind-key <id> --bind-label <метка>`), иначе чек баланса
# пойдёт через другой IP, а `cf_clearance` привязан к нему - кабинет ответит 307.
LAST_PROXY = {"label": None}
BRIDGE = DIR.parent / "routing" / "lib" / "proxy-for.js"

SIGNUP_URL = "https://odysseyapi.tech/sign-up"
CONSOLE_URL = "https://odysseyapi.tech/dashboard"
API_KEYS_URL = "https://odysseyapi.tech/api-keys"
BILLING_URL = "https://odysseyapi.tech/billing"
MAIL_22DO_URL = "https://22.do/"

POOL_HOST = "odysseyapi.tech"
# 🔴 Зонд пула - САМА СТРАНИЦА регистрации, а не ручка ALTCHA. Ручка отвечала 200 у адресов,
# через которые браузер не мог открыть страницу вовсе: замер 17.09 - четыре попытки подряд
# умерли на «форма не появилась», и каждая стоила двух минут. Пул теперь бракует такого
# кандидата сразу, а не отдаёт его в прогон.
POOL_PREFLIGHT_PATH = "/sign-up"

# 🪤 Потолок нажатий с запасом: в разведке gmail выпадал раз в три-четыре нажатия, а на
# живом прогоне - только на 32-м.
RANDOM_MAX_TRIES = 80

DOMAIN_RE = re.compile(r"@([A-Za-z0-9.-]+\.[A-Za-z]{2,})")
CODE_RE = re.compile(r"\b(\d{6})\b")


def short_url(url):
    m = re.match(r"https?://([^/]+)(/[^\s]*)?", url or "")
    return (m.group(1) + (m.group(2) or "")) if m else (url or "")


# Схлопывание пробелов вынесено в функцию не для красоты: `re.sub(r"\s+", ...)` внутри
# f-строки - это обратный слеш в выражении, а он там запрещён до Python 3.12.
def flat(s, n):
    return re.sub(r"\s+", " ", str(s if s is not None else ""))[:n]


def open_log(path, echo=True):
    """Лог в файл и на экран. Строки пишутся сразу: сессия агента уже умирала посреди
    прогона, и единственным носителем записи оставался диск."""
    fh = open(path, "a", encoding="utf-8")

    def log(kind, msg):
        line = f"[{__import__('datetime').datetime.now():%H:%M:%S}] {str(kind):<9} {msg}"
        if echo:
            print(line, flush=True)
        fh.write(line + "\n")
        fh.flush()

    log.file = fh
    return log



# ── сети: подарок $5 даётся один раз на сеть ──────────────────────────────────

def load_used_networks():
    """Сети, с которых аккаунт уже заводили. Пишет их авторега после регистрации."""
    try:
        d = json.loads((DIR / "networks-used.json").read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def asn_for_ip(ip, timeout=10):
    """ASN провайдера по адресу. Для площадки «сеть» - это провайдер, а не подсеть:
    три прокси одного хоста (`154.221.x`, `154.219.x`) оказались ОДНОЙ сетью AS202656."""
    try:
        req = urllib.request.Request(f"http://ip-api.com/json/{ip}?fields=as,isp,country")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return str((json.loads(r.read().decode("utf-8") or "{}").get("as")) or "").strip()
    except Exception:
        return ""


def ip_of_label(label):
    m = re.search(r"//(?:[^@/]*@)?([^:/]+)", str(label or ""))
    return m.group(1) if m else ""


def own_ip(timeout=10):
    """Свой внешний адрес машины. Нужен прогонам без прокси (ярус none): сеть, с которой
    идёт такой прогон, тоже надо учитывать в списке траченных, иначе следующий заход снова
    создаст аккаунт без подарка."""
    for url, field in (("http://ip-api.com/json/?fields=query", "query"),
                       ("https://api.ipify.org/?format=json", "ip")):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "curl/8"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                doc = json.loads(r.read().decode("utf-8") or "{}")
            ip = str(doc.get(field) or "").strip()
            if ip:
                return ip
        except Exception:
            continue
    return ""


# ── журнал плохих адресов ─────────────────────────────────────────────────────
#
# 🔴 Зачем отдельно от сетей. Леджер сетей отвечает на вопрос «дадут ли подарок», а этот
# журнал - «работает ли адрес вообще». Замер 18.09: два класса отказов повторяются на одних
# и тех же адресах, и каждый стоит полной попытки (две минуты):
#   · «форма регистрации не появилась» - приложение не собралось;
#   · «the captcha failed to load» - форму собрал, а виджет Turnstile не приехал (Clerk
#     говорит это сам).
# Один раз выяснив, что адрес такой, второй раз его пробовать незачем.

BAD_ADDRESSES_FILE = DIR / "addresses-bad.json"


def load_bad_addresses():
    try:
        d = json.loads(BAD_ADDRESSES_FILE.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def mark_bad_address(label, why):
    """Запоминает адрес, на котором попытка провалилась по причине, не зависящей от нас."""
    if not label:
        return
    doc = load_bad_addresses()
    doc.setdefault(label, {"why": flat(why, 120), "at": datetime.now().strftime("%Y-%m-%d %H:%M")})
    try:
        BAD_ADDRESSES_FILE.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    except Exception:
        pass


# ── прокси из общего пула ─────────────────────────────────────────────────────

async def _bridge_json(args):
    """Один вызов моста пула, разобранный до словаря.

    Общий и для выдачи прокси по ярусу, и для закреплённого адреса: две копии этого разбора
    разъехались бы ровно так же, как разъезжались прочие дубли в этом репозитории.
    """
    proc = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    raw, err = await proc.communicate()
    text = (raw or b"").decode("utf-8", "replace").strip()
    lines = [l for l in text.splitlines() if l.strip().startswith("{")]
    if not lines:
        detail = flat((text or (err or b"").decode("utf-8", "replace")), 200)
        raise RuntimeError(f"мост пула не ответил JSON (код {proc.returncode}): {detail}")
    return json.loads(lines[-1])


async def acquire_proxy(tier, key, log, host=POOL_HOST, probe_path=POOL_PREFLIGHT_PATH, pin=None,
                        exclude=None):
    """Прокси из ОБЩЕГО пула через мост на Node. Своей копии правил пула тут нет.

    `pin` - конкретная строка прокси (`http://user:pass@ip:port` или голый
    `http://ip:port`). Нужна не для красоты: требовательность Turnstile зависит от IP выхода
    (замер 16.09 - один тест-прокси проходит молча, другой требует интерактивного клика), и
    чтобы проверить это утверждение, а не поверить в него, нужен способ закрепить адрес.
    При `pin` пул не ВЫБИРАЕТ прокси и привязок не трогает.

    🪤 Но при голом `label` пул всё-таки спрашивается - за кредами. Сам `label` их не
    содержит, и браузер, собранный из одной строки, шёл на адрес анонимно (407 на CONNECT,
    разбор - ниже в ветке `pin`).

    Контракт пула соблюдаем буквально: `ok:false` - «НЕ ХОДИТЬ ВООБЩЕ». Молча уйти
    напрямую - это ровно тот тихий провал, из-за которого автореги когда-то
    регистрировались с домашнего IP и никто об этом не знал.
    """
    if pin:
        m = re.match(r"^(?P<scheme>\w+)://(?:(?P<user>[^:@/]+):(?P<pass>[^@/]*)@)?(?P<host>[^:/]+):(?P<port>\d+)$", pin)
        if not m:
            raise RuntimeError(f"--proxy не разобран: {pin}")
        # Креды прямо в строке - это ручной заход (`--proxy socks5://user:pass@ip:port`);
        # пул такого адреса может и не знать, поэтому разбираем локально, как было.
        if m.group("user"):
            cfg = {"server": f"{m.group('scheme')}://{m.group('host')}:{m.group('port')}"}
            cfg["username"] = m.group("user")
            cfg["password"] = m.group("pass") or ""
            LAST_PROXY["label"] = cfg["server"]
            log("ПРОКСИ", f"{cfg['server']} · закреплён вручную (--proxy), пул не спрашивал")
            return cfg

        # 🔴 Голый `scheme://host:port` - это форма `label`, и кредов в ней НЕТ намеренно
        # (`proxy-pool.js` держит их вне label, потому что label уходит в UI и логи). Значит
        # логин с паролем знает только пул - и спрашиваем его МЫ, а не браузер.
        #
        # Замер 22.09: проба кладёт в `candidates.json` один label, драйвер собирал из него
        # прокси браузера, и все три кандидата отвечали `407 Proxy Authentication Required`
        # на CONNECT. Firefox показывал это как `NS_ERROR_PROXY_CONNECTION_REFUSED`, а до
        # площадки не доходил ни один пакет - при том, что проба те же адреса проходила: она
        # ходит через объект пула, где креды есть.
        ans = await _bridge_json(["node", str(BRIDGE), "--pin", pin])
        if not ans.get("ok"):
            raise RuntimeError(flat(ans.get("error"), 140))
        cfg = ans.get("browser") or {}
        if not cfg.get("username"):
            # Адрес пул знает, а кредов у него нет - идём анонимно. Это законно (публичный
            # адрес скрапера), но именно так выглядит и наш нодовый инбаунд без пароля,
            # поэтому говорим вслух, а не молчим.
            log("ПРОКСИ", f"⚠️ у {ans.get('label')} кредов в пуле нет - иду анонимно")
        LAST_PROXY["label"] = ans.get("label") or pin
        log("ПРОКСИ", f"{ans.get('label')} · закреплён (--proxy) · ярус {ans.get('tier')} · "
                      f"креды из пула")
        return cfg

    if tier == "none":
        log("ПРОКСИ", "ярус none - идём напрямую")
        return None

    cmd = ["node", str(BRIDGE), "--key", key, "--host", host,
           "--path", probe_path, "--tier", tier, "--force"]
    # 🔴 Отдаём пулу список ТРАЧЕННЫХ сетей, чтобы он не предлагал их вовсе. Замер 17.09:
    # без этого пул выдавал адреса из сетей, где подарок уже получен (Contabo, Тубанет), драйвер
    # каждый отвергал, и на каждую пустую попытку уходил полный preflight - 2.5 минуты.
    spent = list(load_used_networks().keys())
    if spent:
        cmd += ["--skip-asn", ",".join(spent)]
    # Уже пробованные адреса: капча Turnstile на части IP не поддаётся вообще, и
    # единственный выход - следующий прокси из того же яруса.
    if exclude:
        cmd += ["--exclude", ",".join(exclude)]
    ans = await _bridge_json(cmd)
    if not ans.get("ok"):
        raise RuntimeError(f"пул отказал в прокси: {ans.get('error')}")
    if ans.get("direct"):
        log("ПРОКСИ", f"⚠️ пул отправил напрямую: {ans.get('reason')}")
        return None
    LAST_PROXY["label"] = ans.get("label")
    log("ПРОКСИ", f"{ans.get('label')} · ярус {ans.get('tier')} · привязка {ans.get('how')}")
    return ans.get("browser")


async def acquire_fresh_proxy(tier, key, log, host=POOL_HOST, probe_path=POOL_PREFLIGHT_PATH,
                              attempts=6, tried=None):
    """Прокси из СВЕЖЕЙ сети: с которой подарок $5 ещё не брали.

    🔴 Зачем отдельная функция, а не проверка после регистрации. Подарок даётся один раз на
    сеть, и аккаунт на уже отработанной сети получается сразу с нулевым балансом - владелец
    16.09: «аккаунт с нулевым балансом не создаём, там сразу видно». Значит сеть надо
    выбирать ДО регистрации: берём адрес у пула, спрашиваем его ASN и, если сеть уже в
    списке траченных, просим следующий (`--exclude`). Аккаунт на мёртвой сети просто не
    появится - вместо того чтобы появиться и оказаться бесполезным.
    """
    tried = list(tried or [])
    used = load_used_networks()
    for i in range(1, attempts + 1):
        browser = await acquire_proxy(tier, key, log, host, probe_path, exclude=tried)
        label = LAST_PROXY.get("label") or ""
        ip = ip_of_label(label)
        if not ip:
            return browser
        asn = asn_for_ip(ip)
        if not asn:
            log("СЕТЬ", f"ASN адреса {ip} не спросился - беру его как есть")
            return browser
        if asn not in used:
            log("СЕТЬ", f"{asn} - сеть свежая, подарок должен быть (попытка {i})")
            return browser
        log("СЕТЬ", f"{asn} уже трачен ({used[asn][:40]}…) - беру следующий адрес")
        tried.append(label)
    log("СЕТЬ", f"свежих сетей не нашлось за {attempts} попыток - иду с последним адресом")
    return browser


# ── 22.do: адрес на gmail ─────────────────────────────────────────────────────

async def robust_click(page, selector, log, what="", timeout=9000, prefer_js=False):
    """Клик, который не сдаётся на первом отказе.

    🪤 Тот же клик проходил в headless-разведке и падал в окне записи: у кнопки может быть
    перекрытие (баннер, рекламный iframe), а с `humanize=10.0` Camoufox ещё и ведёт мышь
    нарочно медленно - один клик занимал **30 секунд**. Поэтому три попытки по возрастанию
    грубости, а `prefer_js` для СВОЕЙ автоматики: там, где человеческое движение мыши
    ничего не даёт, ждать его бессмысленно.
    """
    loc = page.locator(selector).first
    try:
        await loc.wait_for(state="visible", timeout=timeout)
    except Exception:
        return False, "не появилась на странице"

    js_click = ("клик из JS", lambda: page.evaluate(
        "sel => { const e = document.querySelector(sel); if (e) e.click(); }", selector))
    mouse_click = ("обычный клик", lambda: loc.click(timeout=timeout))
    force_click = ("force-клик", lambda: loc.click(timeout=timeout, force=True))
    plan = [js_click, mouse_click, force_click] if prefer_js else [mouse_click, force_click, js_click]

    last = ""
    for how, action in plan:
        try:
            await action()
            return True, how
        except Exception as e:
            last = flat(str(e).splitlines()[0], 70)
    return False, f"все три способа не прошли (последняя ошибка: {last})"





async def goto_retry(page, url, log, tries=4, pause_s=3):
    """Переход с повтором.

    🪤 `Page.goto: NS_BINDING_ABORTED` - не «сайт недоступен», а «навигацию отменили»:
    приложение в этот же момент уходило на свою страницу (сразу после `complete` Clerk
    уводит с `/sign-up`), и наш переход столкнулся с его переходом. Лечится не ожиданием
    «подольше», а повтором: второй заход обычно уже никому не мешает.
    """
    last = ""
    for i in range(1, tries + 1):
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=45000)
            return True
        except Exception as e:
            last = flat(str(e).splitlines()[0], 80)
            if log:
                log("ПЕРЕХОД", f"попытка {i} на {short_url(url)} сорвалась: {last}")
            await page.wait_for_timeout(pause_s * 1000)
    # Последняя проверка: возможно, приложение само привело нас куда надо.
    if url.split("//")[-1].split("/")[0] in (page.url or ""):
        return True
    if log:
        log("ПЕРЕХОД", f"❌ {short_url(url)} не открылся ({last})")
    return False


async def click_button_by_text(page, text, log=None, timeout=20000):
    """Нажимает видимую кнопку по её тексту. Без CSS-селекторов вообще.

    🔴 Зачем так. Селекторы вида `button:has-text("…")` - это синтаксис Playwright, а не
    CSS: `document.querySelector` на них падает, и JS-запасной путь (нужный при медленном
    `humanize`) теряет кнопку. Именно на этом встал прогон 16.09: «Create API key» не
    находился ни мышью (таймаут), ни из JS (там синтаксическая ошибка), хотя кнопка на
    странице была. Поиск по тексту одинаково понимают оба пути, поэтому он и выбран.
    """
    js = """(want) => {
        const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
        const nodes = [...document.querySelectorAll('button, a, [role="button"], input[type="submit"]')];
        const hit = nodes.find(e => vis(e) && norm(e.innerText || e.value).includes(want));
        if (!hit) return false;
        hit.click();
        return true;
    }"""
    try:
        done = await page.evaluate(js, text.lower())
    except Exception as e:
        if log:
            log("КЛИК", f"поиск кнопки «{text}» сорвался: {flat(str(e).splitlines()[0], 70)}")
        done = False
    if done:
        return True, "клик из JS по тексту"

    # Запасной путь: обычный клик - если кнопка есть, но JS-путь её не увидел (например,
    # текст лежит во вложенном узле с другим регистром).
    try:
        await page.locator(f"button:has-text('{text}')").first.click(timeout=timeout)
        return True, "клик мышью"
    except Exception as e:
        return False, f"кнопка «{text}» не найдена ({flat(str(e).splitlines()[0], 60)})"


async def read_22do_domain(page):
    """Домен, который сейчас выбран на главной 22.do."""
    for sel in ("div.choices__item", ".mail-con-input", ".choices__inner"):
        try:
            loc = page.locator(sel).first
            if await loc.count():
                t = (await loc.inner_text()).strip()
                m = DOMAIN_RE.search(t)
                if m:
                    return m.group(1).lower()
                if t.startswith("@"):
                    return t[1:].strip().lower()
        except Exception:
            pass
    return ""


async def read_22do_address(page):
    """Адрес ящика: по селекторам, затем по хешу URL, затем по тексту страницы.

    🔴 Первый прогон драйвера (16.09) упал именно здесь: селекторы не совпали, и функция
    вернула пусто - хотя адрес на странице был. «Не прочитался» и «адрес не выдан» снаружи
    неотличимы, а стоят по-разному, поэтому проб три, и последняя - по регулярке в тексте.
    """
    for sel in ("#copyEmail", ".mf-panel-address", ".mf-address-row .mf-mono"):
        try:
            loc = page.locator(sel).first
            if await loc.count():
                t = flat(await loc.inner_text(), 80)
                if "@" in t:
                    return t
        except Exception:
            pass

    if "@" in (page.url or ""):
        candidate = page.url.split("#")[-1].strip("/ ")
        candidate = candidate.replace("inbox/", "").strip("/ ")
        if "@" in candidate and " " not in candidate:
            return candidate

    try:
        body = await page.inner_text("body")
    except Exception:
        return ""
    for m in re.finditer(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", body or ""):
        cand = m.group(0).strip(".")
        # Служебные адреса сайта адресом ящика не являются - иначе в «адрес» попадёт
        # `abuse@22.do` из подвала (на этих граблях уже стояли 16.09).
        if cand.lower().startswith(("abuse@", "support@", "info@")):
            continue
        return cand
    return ""


# Живые клиенты почты: закрываются на выходе драйвера, иначе процесс с браузером остаётся
# висеть после провального прогона. Список модульный, потому что заводит клиента драйвер,
# а закрывает общий `close_open()` в нём же.
OPEN_MAILERS = []


class MailClient:
    """Почта на emailnator.com: отдельный процесс со своим окном, общение JSON-строками.

    🔴 Почему не свой код в драйвере. У emailnator свой UI с тумблерами и своя ручка списка
    писем (`POST /message-list` с XSRF-кукой), и клиент для него УЖЕ есть -
    `freemodel/lib/camoufox_emailnator.py`, им пользуются соседние шлюзы. Вторая реализация
    тех же шагов разъехалась бы с первой (в этом репозитории так уже было с ожиданием кода
    почты, где правка в либе не касалась чужого дубля). Здесь только обвязка: запустить
    процесс и говорить с ним строками JSON.

    🔴 Зачем вообще вторая почта. Замер 16.09: у 22.do кончаются свободные gmail-адреса -
    сервис крутит по одному набору локальных частей, и прогоны подряд получают уже занятые
    ящики (занятых адресов стало 26). Плюс ящик на 22.do приходится `Random`-ить по 10-30
    нажатий. emailnator выдаёт адрес сразу, но у него своя беда - он отдаёт либо свои
    одноразовые домены (их Clerk отвергает: `block_disposable_email_domains`), либо
    gmail-алиас, который у Odyssey раньше писем не получал. Поэтому выбор провайдера должен
    быть ручкой, а не заменой: какой сработает - тот и берём.
    """

    # Два сервиса, один протокол (JSON-строки): `emailnator` - мост к проверенной либе
    # руменга, `boomlify` - свой мост к их «Gmail Temp Mail». Питоновский
    # `camoufox_emailnator.py` не берём: он ходит по старым селекторам и отдаёт
    # `googlemail.com` (замер 17.09).
    # Имя → (скрипт, чем запускать). `tmailor` - питоновский клиент, на нём крутится авторега
    # freemodel и письма доходят; он у нас третий вариант, потому что у Clerk домены
    # одноразовых сервисов обычно в блоклисте, и это надо проверить замером, а не верить.
    SCRIPTS = {
        "emailnator": (DIR / "mail-emailnator.js", "node"),
        "boomlify": (DIR / "mail-boomlify.js", "node"),
        "tmailor": (DIR.parent / "freemodel" / "lib" / "camoufox_tmailor.py", "python"),
    }

    def __init__(self, log, headless=True, kind="emailnator"):
        self.log = log
        self.headless = headless
        self.kind = kind
        pair = self.SCRIPTS.get(kind) or self.SCRIPTS["emailnator"]
        self.SCRIPT, self.runner = pair
        self.proc = None
        self.email = ""
        self._buf = b""

    async def start(self):
        if not self.SCRIPT.exists():
            raise RuntimeError(f"клиента emailnator нет: {self.SCRIPT}")
        exe = (shutil.which("node") or "node") if self.runner == "node" else sys.executable
        args = [exe, str(self.SCRIPT)] if self.runner == "node" else [exe, "-u", str(self.SCRIPT)]
        self.proc = await asyncio.create_subprocess_exec(
            *args, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, cwd=str(self.SCRIPT.parent),
            env={**os.environ, "PYTHONIOENCODING": "utf-8"})
        asyncio.create_task(self._pump_stderr())
        OPEN_MAILERS.append(self)
        self.log("ПОЧТА", f"{self.kind}: клиент запущен отдельным процессом")
        return True

    async def _pump_stderr(self):
        """Строки клиента - в наш лог: без них провал почты нечем разбирать."""
        try:
            while True:
                line = await self.proc.stderr.readline()
                if not line:
                    break
                text = line.decode("utf-8", "replace").rstrip()
                if text:
                    self.log(self.kind, flat(text, 160))
        except Exception:
            pass

    async def _cmd(self, obj, timeout=240):
        if not self.proc:
            raise RuntimeError("клиент emailnator не запущен")
        self.proc.stdin.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
        await self.proc.stdin.drain()
        deadline = asyncio.get_event_loop().time() + timeout
        while asyncio.get_event_loop().time() < deadline:
            line = await asyncio.wait_for(self.proc.stdout.readline(), timeout=timeout)
            if not line:
                raise RuntimeError("клиент emailnator закрылся")
            text = line.decode("utf-8", "replace").strip()
            # 🪤 Ищем `{` в строке, а не требуем её с него: чужой вывод (точки прогресса
            # библиотеки) может приклеиться к ответу спереди - строку из-за этого терять нельзя.
            brace = text.find("{")
            if brace < 0:
                continue
            try:
                return json.loads(text[brace:])
            except Exception:
                continue
        raise RuntimeError("клиент emailnator не ответил")

    async def create(self):
        ans = await self._cmd({"cmd": "create"}, timeout=180)
        if not ans.get("ok"):
            raise RuntimeError(f"адрес не выдан: {ans.get('error')}")
        self.email = str(ans.get("email") or "")
        if not self.email:
            raise RuntimeError(f"{self.kind} вернул пустой адрес")
        self.log("ПОЧТА", f"✅ адрес {self.kind} готов: {self.email}")
        return self.email

    async def wait_otp(self, timeout=180, from_hint=""):
        # 🪤 У клиентов РАЗНЫЕ единицы срока: JS-мосты (emailnator, boomlify) считают минуты,
        # питоновский tmailor - секунды, как и драйвер. Перевод - на этой границе, чтобы
        # наружу (в драйвер) всегда были секунды.
        if self.runner == "node":
            minutes = max(1, round(timeout / 60))
            ans = await self._cmd({"cmd": "code", "timeout_min": minutes,
                                   "from_hint": from_hint}, timeout=minutes * 60 + 90)
        else:
            ans = await self._cmd({"cmd": "wait_otp", "timeout": int(timeout), "poll": 4,
                                   "from_hint": from_hint}, timeout=timeout + 90)
        if ans.get("ok") and ans.get("code"):
            self.log("ПОЧТА", f"код из письма ({self.kind}): {ans['code']}")
            return str(ans["code"])
        self.log("ПОЧТА", f"код на {self.kind} не пришёл ({ans.get('error') or 'пусто'})")
        return ""

    async def stop(self):
        try:
            if self.proc and self.proc.returncode is None:
                self.proc.stdin.write(b'{"cmd":"stop"}\n')
                await self.proc.stdin.drain()
                await asyncio.wait_for(self.proc.wait(), timeout=20)
        except Exception:
            pass
        try:
            if self.proc and self.proc.returncode is None:
                self.proc.kill()
        except Exception:
            pass


# Домены, которые 22.do выдаёт и которые площадка ПРИНИМАЕТ. Это реальные ящики (Gmail,
# Hotmail, Outlook), а не одноразовые домены: Clerk отвергает последние прямым текстом
# («Temporary email services are not supported» - замер 17.09 на `taxibmt.net` от tmailor).
# 🔴 Hotmail и Outlook добавлены 17.09 со слов знакомого владельца, который так и
# регистрировал: до этого `clean_22do_address` пропускал ТОЛЬКО gmail.com и молча выбрасывал
# годные адреса - отсюда и «у 22.do кончаются почты».
MAIL_DOMAINS = ("gmail.com", "hotmail.com", "outlook.com")


def _key(addr, raw=False):
    """Ключ для сверки занятости: с `raw` берём адрес как есть (плюс-алиасы раздельны)."""
    a = str(addr or "").strip().lower()
    return a if raw else mail_key(a)


def mail_key(addr):
    """Ключ сравнения адресов для проверки «этот ящик уже занят».

    🔴 Точки не значат ничего ТОЛЬКО у Gmail: у Hotmail и Outlook `a.b@` и `ab@` - разные
    ящики, и склеивать их нельзя. Плюс-часть отбрасываем у всех: Clerk её запрещает
    (`block_email_subaddresses`), а для сравнения она всё равно не отдельный адрес.
    """
    if not addr or "@" not in addr:
        return ""
    local, _, domain = addr.strip().lower().rpartition("@")
    local = local.split("+")[0]
    if domain == "gmail.com":
        local = local.replace(".", "")
    return f"{local}@{domain}"


def gmail_key(addr):
    """Прежнее имя `mail_key` - оставлено, потому что им пользуются прогоны и пробы."""
    return mail_key(addr)


def _gmail_key_old(addr):
    """Ключ сравнения gmail-адресов: у Gmail точки в локальной части не значат НИЧЕГО,
    а `+что-угодно` - тот же ящик.

    🔴 Замер 16.09 16:20, и это стоило четырёх прогонов подряд. Форма поднялась, ALTCHA
    прошла («Check passed»), а Clerk ответил «This email address is already in use»: 22.do
    выдал `a.ntonelittl.erz.br37@gmail.com`, тогда как в пуле уже лежал аккаунт
    `od_1789553434481_6` с адресом `a.n.tonelitt.l.erzbr37@gmail.com`. По буквам это разные
    строки, для Gmail - ОДИН И ТОТ ЖЕ ящик. Снаружи это выглядело как «адрес не пропускает
    регистрацию», то есть списывалось на капчу и на прокси, хотя дело было в адресе.
    """
    if not addr or "@" not in addr:
        return ""
    local, _, domain = addr.strip().lower().rpartition("@")
    return f"{local.split('+')[0].replace('.', '')}@{domain}"


def used_addresses(raw=False):
    """Адреса, на которые аккаунты уже заведены: пул дашборда плюс мета-файлы прогонов.

    Читаем оба источника, потому что прогон мог создать аккаунт и упасть до записи в пул
    (тогда адрес остался только в `sessions/_meta/<метка>.json`) - а повторная регистрация
    на него всё равно упрётся в «already in use».
    """
    keys = set()
    try:
        doc = json.loads((DIR.parent / "routing" / "odyssey-sessions.json").read_text(encoding="utf-8"))
        accounts = doc if isinstance(doc, list) else (doc.get("accounts") or doc.get("items") or [])
        for a in accounts:
            k = _key(str(a.get("email") or ""), raw)
            if k:
                keys.add(k)
    except Exception:
        pass
    for meta in (DIR / "sessions" / "_meta").glob("*.json"):
        try:
            doc = json.loads(meta.read_text(encoding="utf-8"))
            k = _key(str(doc.get("email") or ""), raw)
            if k:
                keys.add(k)
        except Exception:
            continue
    return keys


def clean_22do_address(addr, allow_plus=False):
    """Годится ли адрес: ТОЛЬКО `gmail.com` (и по умолчанию без плюса).

    🔴 `googlemail.com` здесь запрещён намеренно, и это не придирка: у 22.do «Change»
    выдаёт его наравне с gmail, а я в первой версии проверки принимал оба домена - и
    прогон 16.09 ушёл регистрироваться на `…@googlemail.com`. Владелец это остановил.
    Нужен ровно `gmail.com`; домены самого 22.do Clerk отвергнет: у него включены
    `block_email_subaddresses` и `block_disposable_email_domains` (проверено живьём
    по `/v1/environment`).

    🪤 `allow_plus` - для ОПЫТА, а не для боя. Замер 16.09: 22.do выдаёт gmail только с
    плюсом (25 «Change» подряд - ни одного чистого), и надо проверить ФАКТОМ, отвергает
    ли такой адрес Clerk, а не верить в это по названию настройки. Флаг ставит
    вызывающий, и в постоянном режиме он выключен.
    """
    if not addr or "@" not in addr:
        return False
    local, _, domain = addr.rpartition("@")
    if domain.lower() not in MAIL_DOMAINS:
        return False
    return allow_plus or "+" not in local



async def reset_22do_session(page, log):
    """Сбрасывает сессию 22.do, чтобы следующий раунд дал НОВЫЙ адрес.

    🔴 Без этого раунды бессмысленны, и это замер 16.09: сервис помнит выданный адрес в
    своей сессии и возвращает ТОТ ЖЕ плюс-алиас в каждом круге - шесть раундов подряд
    приносили один и тот же `jokarkasm.4.5+qhy6y@gmail.com`. Новый адрес выдаётся только
    новой сессии, поэтому чистим куки и хранилище страницы.

    🪤 Куки чистим ВСЕ, а не только домена 22.do (в Python-API Playwright фильтра нет), и
    это безопасно именно тут: шаг ящика идёт ДО первой навигации на odysseyapi.tech, то
    есть сессии площадки в этот момент ещё не существует.
    """
    try:
        await page.evaluate("() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} }")
    except Exception:
        pass
    try:
        await page.context.clear_cookies()
        log("ПОЧТА", "сессию 22.do сбросил - адрес будет новый")
        return True
    except Exception as e:
        log("ПОЧТА", f"сбросить куки не вышло: {flat(str(e), 60)}")
        return False


async def pick_22do_gmail(page, log, tries=RANDOM_MAX_TRIES, rounds=10, allow_plus=False):
    """Крутит «Random» до ПЕРВОГО домена из допущенных, жмёт «Open» и отдаёт годный адрес.

    🔴 Берём первый же годный, а не «продолжаем до gmail»: допущены gmail, hotmail и outlook
    (замер 17.09 - знакомый владельца регистрировал на hotmail и outlook, оба проходят), и
    крутить дальше значило бы выбрасывать рабочие адреса ради красоты домена.

    🔴 Разведка 16.09: кнопка «Random» (`button#mail-random`) крутит **ДОМЕН**, а не
    локальную часть. В выпадающем списке (Choices.js) gmail НЕТ - он приходит только
    через «Random», поэтому выбрать его прямо нельзя, только крутить.

    🪤 Домен `gmail.com` сам по себе ещё не гарантия: 22.do умеет выдать и плюс-алиас
    (`…+0pmg2u4bh@gmail.com`). Такой адрес Clerk отвергнет, поэтому адрес проверяется
    (`clean_22do_address`), и если не подошёл - раунд повторяется с чистого листа: сайт
    генерирует и локальную часть, и домен заново.
    """
    # Занятые ящики считаем ОДИН раз до перебора: это чтение двух файлов, а не запрос в сеть.
    # 🪤 С `allow_plus` сравниваем ПОЛНЫЙ адрес: плюс-алиас - это отдельный ящик для площадки
    # (владелец 17.09: «с плюсами почту хавает»), и склеивать его с базовым именем нельзя,
    # иначе второй плюс-алиас того же ящика будет считаться занятым.
    used = used_addresses(raw=allow_plus)
    if used:
        log("ПОЧТА", f"занятых адресов в пуле и мета-файлах: {len(used)} - выданный сверяю с ними")
    for rnd in range(1, rounds + 1):
        # 🔴 Сброс сессии ПЕРЕД КАЖДЫМ раундом, включая первый, и это не симметрия ради
        # красоты. Окно почты живёт в постоянном профиле (`profiles/_mail`) и переживает
        # прогон: с сохранённой сессией 22.do выдаёт ТОТ ЖЕ ящик. Замер 16.09 - три прогона
        # подряд получили `a.ntonelittl.erz.br37@gmail.com`, который уже был занят, и
        # регистрация упиралась в «This email address is already in use». Кнопка «Random»
        # тут ни при чём: домен был gmail, а вот локальная часть приезжала из сессии.
        await reset_22do_session(page, log)
        try:
            await page.goto(MAIL_22DO_URL, wait_until="domcontentloaded", timeout=60000)
            await page.wait_for_timeout(4000)
        except Exception as e:
            log("ПОЧТА", f"22.do не открылся: {flat(str(e).splitlines()[0], 80)}")
            return ""

        seen = []
        for i in range(1, tries + 1):
            dom = await read_22do_domain(page)
            seen.append(dom)
            if dom in MAIL_DOMAINS:
                log("ПОЧТА", f"{dom} выпал на {i}-м нажатии «Random» (раунд {rnd})")
                break
            ok, how = await robust_click(page, "button#mail-random", log, "Random",
                                         timeout=25000, prefer_js=True)
            if not ok:
                log("ПОЧТА", f"«Random» не нажался: {how}")
                return ""
            await page.wait_for_timeout(900)
        else:
            log("ПОЧТА", f"❌ ни одного из допущенных доменов за {tries} нажатий "
                         f"(видели: {', '.join(sorted(set(seen))[:8])})")
            return ""

        ok, how = await robust_click(page, "button#into-mailbox", log, "Open",
                                     timeout=30000, prefer_js=True)
        if not ok:
            log("ПОЧТА", f"«Open» не нажался: {how}")
            return ""
        await page.wait_for_timeout(6000)

        addr = await read_22do_address(page)
        busy = gmail_key(addr) in used
        if clean_22do_address(addr, allow_plus) and not busy:
            log("ПОЧТА", f"✅ адрес готов: {addr}")
            return addr
        if busy:
            # 🔴 Тот же ящик, другая расстановка точек. Clerk на такой адрес отвечает
            # «This email address is already in use», и снаружи это читается как отказ
            # регистрации, а не как «ящик выдан повторно». Замер 16.09: четыре прогона
            # подряд ушли в разбор капчи и прокси, а дело было в адресе.
            log("ПОЧТА", f"адрес «{addr}» — тот же ящик, что уже занят (точки в gmail не "
                         f"значат ничего) — раунд {rnd} из {rounds} заново")
            continue

        # 🔴 Кнопку «Change» в ящике я пробовал и ОТКАЗАЛСЯ от неё. Она меняет ДОМЕН
        # вместе с адресом: после удачного gmail первый же «Change» уводил на `outlook.com`,
        # второй - на `fft.edu.do`, и адреса там приходили с плюсом. Вернуть домен на gmail
        # из ящика нельзя - кнопка «Random» живёт на ГЛАВНОЙ, и попытка нажать её из ящика
        # падала («не появилась на странице»). Владелец это видел и справедливо сказал:
        # «опять такая почта».
        #
        # Правильный путь - тот, которым он добывал gmail руками: начать ЗАНОВО с главной
        # страницы. Локальная часть генерируется при «Open», поэтому новый раунд даёт новый
        # адрес. Дороже по времени, зато перебор идёт ТОЛЬКО внутри gmail.
        log("ПОЧТА", f"адрес «{addr or 'не прочитался'}» не беру (нужен gmail без плюса) - "
                     f"раунд {rnd} из {rounds} заново")
    return ""
    return ""


async def reload_22do_inbox(page, log):
    """Обновить список писем. Кнопка есть не всегда - молчание тут нормально."""
    for sel in ("button.mf-panel-btn", "button:has-text('Reload')"):
        try:
            loc = page.locator(sel).first
            if await loc.count():
                await loc.click(timeout=8000)
                await page.wait_for_timeout(2500)
                return True
        except Exception:
            continue
    for attempt in (1, 2):
        try:
            await page.reload(wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_timeout(3000)
            return True
        except Exception as e:
            # 🪤 `NS_BINDING_ABORTED` - не «сайт лёг», а «навигацию отменили»: страница в
            # этот момент сама куда-то уходила. Второй заход обычно проходит.
            if attempt == 2:
                log("ПОЧТА", f"обновить ящик не вышло: {flat(str(e).splitlines()[0], 60)}")
    return False



# Ручка ящика 22.do: отдаёт письма JSON-ом. Замер 16.09 - тело запроса
# {"email":"<адрес>","lastime":<unixtime>}, ответ {"status":true,"data":…}.
MAILBOX_API_JS = """async (arg) => {
    const r = await fetch('/action/mailbox/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: arg.email, lastime: arg.lastime }),
    });
    const text = await r.text();
    return text.slice(0, 20000);
}"""



# Ручка ящика: {"email":…,"lastime":…}. Замер 16.09 - отвечает `{"status":false,
# "msg":"Authentication required"}`, если уходит без авторизации сеанса, поэтому
# основной путь НЕ она, а список писем на странице (см. ниже).
MAILBOX_API_JS = """async (arg) => {
    const r = await fetch('/action/mailbox/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: arg.email, lastime: arg.lastime }),
    });
    return (await r.text()).slice(0, 20000);
}"""

# Код виден в ТЕМЕ письма: «035789 is your verification code» (скриншот владельца 16.09).
# Поэтому ищем шесть цифр рядом со словами про код, а не тащим текст всего письма.
SUBJECT_CODE_RE = re.compile(r"(?:^|\D)(\d{6})(?:\D|$)")


async def fetch_22do_code(page, log, timeout_s=120, poll_s=2, email=None):
    """Ждёт письмо и берёт код из ТЕМЫ - частым чтением, без перезагрузок.

    🔴 Замер 16.09 вечером (владелец: «письмо приходит, ты ещё 4 раза страницу обновляешь»):
    письмо от Odyssey приходит за ~15 с, а прежний цикл замечал его через 30+ с, потому что
    каждые 12 секунд жал «Refresh» и читал страницу раз в 4 секунды. Ни то, ни другое не
    нужно: список писем обновляется сам, а чтение текста страницы стоит доли секунды.
    Поэтому: читаем каждые 2 секунды, «Refresh» - только если письма нет дольше 20 секунд.

    Код стоит в теме («035789 is your verification code»), поэтому берём шесть цифр из строки,
    где есть слово про код. Чужие письма в ящике (например «PwC account activation») при этом
    не подсунут свои цифры.
    """
    addr = email or await read_22do_address(page)
    deadline = asyncio.get_event_loop().time() + timeout_s
    started = asyncio.get_event_loop().time()
    lap = 0
    refreshed = False
    while asyncio.get_event_loop().time() < deadline:
        lap += 1
        try:
            text = await page.inner_text("body")
        except Exception:
            text = ""

        for line in (text or "").splitlines():
            low = line.lower()
            if ("code" in low or "verification" in low or "verify" in low) and "@" not in line:
                m = SUBJECT_CODE_RE.search(line)
                if m:
                    log("ПОЧТА", f"код из темы письма ({lap}-е чтение): {m.group(1)}")
                    return m.group(1)

        # 🔴 Обновлять список НАДО, и это поправка владельца: «без перезагрузки письмо не
        # увидишь». Список сам не обновляется - новое письмо появляется только после
        # «Refresh». Но и частить незачем: кнопка нажимается раз в 4 секунды (каждая пара
        # кругов), а читаем текст каждые 2 секунды - так письмо ловится через 2-4 секунды
        # после того, как сайт его отдал, вместо прежних 12-30.
        if lap % 2 == 0:
            await reload_22do_inbox(page, log)
        await page.wait_for_timeout(poll_s * 1000)
    log("ПОЧТА", f"код не появился за {timeout_s} с (адрес {addr or '?'})")
    return ""
