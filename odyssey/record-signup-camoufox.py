#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
odyssey/record-signup-camoufox.py

Окно с ЗАПИСЬЮ ручной регистрации на odysseyapi.tech. Движок - Camoufox
(Firefox с вырезанными следами автоматизации), путь проекта: тот же, которым
ходит freemodel/lib/camoufox_emailnator.py.

🔴 Почему не Chrome. Прогоны 16.09 показали: у площадки ДВА барьера, и второй -
Cloudflare Turnstile самого Clerk (sitekey 0x4AAAAAAAWXJGBD7bONzLBd). Он отбил
и комплектный Chromium Playwright, и настоящий Google Chrome, причём у живого
человека: галочка краснела, `POST /v1/client/sign_ups` так и не уходил. Дело не в
сборке браузера - браузером управляли снаружи по CDP, а включённый домен Runtime
Turnstile видит. Firefox-путь Camoufox идёт не через CDP вовсе.

🪤 Отсюда же главное отличие этой записи от хромовой: НИКАКИХ `expose_binding` и
никаких свойств на `window`. Действия складываются в буфер в изолированном мире
(страница его не видит), Python вычерпывает буфер опросом, а вторым каналом идёт
зеркало в `console.debug` - на случай, если init-скрипт и evaluate окажутся в
разных мирах. Дубли снимаются по паре (мир, номер).

Первый барьер, ALTCHA, записан целиком и человека не требует:
  GET  /api/auth/altcha/challenge  → PBKDF2/SHA-256, cost 5000
  POST /api/auth/altcha/verify     → 200 {"nonce": "..."}

Запуск:
  python odyssey/record-signup-camoufox.py [label]

Итог (odyssey/recordings/):
  signup-cf-<ts>.log       читаемый лог действий
  signup-cf-<ts>.jsonl     машинный лог: действия + запросы + ответы
  signup-cf-<ts>.har       полный трафик (если движок дал)
  signup-cf-<ts>-route.md  сводный маршрут, собирается при закрытии окна
"""

import asyncio
import importlib.util
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from urllib.parse import unquote_plus

from camoufox import AsyncCamoufox
from playwright.async_api import Error as PWError

DIR = Path(__file__).resolve().parent
REC_DIR = DIR / "recordings"
VIDEO_DIR = REC_DIR / "video"
STATE_FILE = DIR / ".signup-state.json"

SIGNUP_URL = "https://odysseyapi.tech/sign-up"
MAIL_URL = "https://www.emailnator.com/"
# 🔴 Emailnator тут бесполезен, и это замер, а не догадка: 16.09 Clerk ответил
# `200` и на `sign_ups`, и на `prepare_verification` со `strategy=email_code`, то
# есть код он отправил - а до Gmail-алиаса Emailnator письмо так и не дошло. У
# знакомого владельца та же картина, и вышло у него через 22.do. Поэтому ящик
# выбирается флагом: `--mail 22do` (или свой URL), по умолчанию прежний.
MAIL_SOURCES = {
    "emailnator": "https://www.emailnator.com/",
    "22do": "https://22.do/",
}
# challenges.cloudflare.com в списке намеренно: по нему видно, выдал Turnstile
# токен или пересоздал челлендж. Без этого барьер выглядит как клик в пустоту.
WATCH = ("odysseyapi.tech", "clerk.odysseyapi.tech", "challenges.cloudflare.com")
ADDRESS_SEL = ".mf-address-row .mf-mono, .mf-panel-address, .mf-mono"

raw_argv = sys.argv[1:]
positional = []
mail_arg = "emailnator"
i = 0
while i < len(raw_argv):
    a = raw_argv[i]
    if a.startswith("--mail"):
        # 🪤 Значение флага нельзя просто отфильтровать по «--»: `--mail 22do` отдаёт
        # `22do` отдельным словом, и без этого разбора оно уехало бы в label профиля.
        if "=" in a:
            mail_arg = a.split("=", 1)[1]
        elif i + 1 < len(raw_argv):
            mail_arg = raw_argv[i + 1]
            i += 1
    elif not a.startswith("--"):
        positional.append(a)
    i += 1

label = re.sub(r"[^\w-]", "_", positional[0]) if positional else "signup-camoufox"
PROFILE = DIR / "profiles" / label

MAIL_MODE = mail_arg if mail_arg in MAIL_SOURCES else ("custom" if "://" in mail_arg else "emailnator")
MAIL_OPEN = MAIL_SOURCES.get(mail_arg, mail_arg if "://" in mail_arg else MAIL_SOURCES["emailnator"])

# --tier <scraper|own|none>: чей прокси берём под прогон. Решение владельца 16.09 -
# «должен быть выбор, сначала тестим скрапер», поэтому ярус именно ручка, а не догадка.
# 🪤 Прокси решает, пройдёт ли Turnstile: публичные адреса скрапера часто уже в чёрных
# списках Cloudflare, и капча с них может перестать проходить даже руками. Ради этого
# замера ручка и нужна - в логе видно, какой ярус был под прогоном.
TIER = "none"
for i, a in enumerate(raw_argv):
    if a.startswith("--tier"):
        TIER = (a.split("=", 1)[1] if "=" in a else (raw_argv[i + 1] if i + 1 < len(raw_argv) else "none")).lower()
if TIER not in ("scraper", "own", "none"):
    TIER = "none"
POOL_HOST = "odysseyapi.tech"
# Зонд пула: у Next.js нет `/api/status` из соглашения New API, зато ALTCHA-челлендж
# отдаёт 200 JSON без авторизации (замер 16.09).
POOL_PREFLIGHT_PATH = "/api/auth/altcha/challenge"

stamp = datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
LOG_PATH = REC_DIR / f"signup-cf-{stamp}.log"
JSONL_PATH = REC_DIR / f"signup-cf-{stamp}.jsonl"
HAR_PATH = REC_DIR / f"signup-cf-{stamp}.har"
ROUTE_PATH = REC_DIR / f"signup-cf-{stamp}-route.md"

for d in (REC_DIR, VIDEO_DIR, PROFILE):
    d.mkdir(parents=True, exist_ok=True)

# 🔴 Пишем на диск КАЖДУЮ строку сразу: сессия агента уже умирала посреди прогона,
# и единственным носителем записи остаётся файл.
log_fh = LOG_PATH.open("a", encoding="utf-8")
jsonl_fh = JSONL_PATH.open("a", encoding="utf-8")

route = []
phase = {"v": "setup"}   # setup - жму я, user - жмёт владелец
# Адрес, выбранный ИМЕННО этим прогоном. Показывать в шапке `state['email']` нельзя:
# в стейте лежит прошлый ящик, и в прогоне, где автоматика не сработала, человек
# прочитал бы старый адрес как готовый (ровно это и случилось 16.09).
picked = {"email": ""}
seen_ids = set()


def LOG(kind, msg):
    line = f"[{datetime.now():%H:%M:%S}] {str(kind):<9} {msg}"
    print(line, flush=True)
    log_fh.write(line + "\n")
    log_fh.flush()


def REC(obj):
    obj = {"t": datetime.now().isoformat(timespec="seconds"), "phase": phase["v"], **obj}
    jsonl_fh.write(json.dumps(obj, ensure_ascii=False) + "\n")
    jsonl_fh.flush()


def load_state():
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_state(st):
    STATE_FILE.write_text(json.dumps(st, ensure_ascii=False, indent=1), encoding="utf-8")


def short(url):
    m = re.match(r"https?://([^/]+)(/[^\s]*)?", url or "")
    return (m.group(1) + (m.group(2) or "")) if m else (url or "")


def ours(url):
    return any(h in (url or "") for h in WATCH)


# Схлопывание пробелов вынесено в функцию не для красоты: `re.sub(r"\s+", ...)`
# внутри f-строки - это обратный слеш в выражении, а он там запрещён до Python 3.12.
def flat(s, n):
    return re.sub(r"\s+", " ", str(s if s is not None else ""))[:n]


# ── слой 1: запись действий, без единого следа на window страницы ──────────────
INIT_SCRIPT = r"""
(() => {
  const g = globalThis;
  if (!g.__odrecWid) g.__odrecWid = Math.random().toString(36).slice(2, 8);
  if (!g.__odrecBuf) g.__odrecBuf = [];
  if (!g.__odrecN) g.__odrecN = 0;

  const txt = (el) => ((el.innerText || el.value || el.placeholder ||
      (el.getAttribute && el.getAttribute('aria-label')) || '') + '')
    .replace(/\s+/g, ' ').trim().slice(0, 48);
  const masked = (el) => {
    const t = (el.type || '').toLowerCase();
    const n = ((el.name || '') + ' ' + (el.id || '')).toLowerCase();
    return t === 'password' || /pass|pwd|secret/.test(n);
  };
  const desc = (el) => {
    if (!el || !el.tagName) return '?';
    const cls = (typeof el.className === 'string' && el.className.trim())
      ? '.' + el.className.trim().split(/\s+/)[0] : '';
    return '<' + el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + cls + '> «' + txt(el) + '»';
  };
  const sel = (el) => {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 5) {
      let p = cur.tagName.toLowerCase();
      const tid = cur.getAttribute && (cur.getAttribute('data-testid') || cur.getAttribute('data-test-id'));
      if (cur.id) { parts.unshift(p + '#' + cur.id); break; }
      if (tid) { parts.unshift(p + '[data-testid="' + tid + '"]'); break; }
      const nm = cur.getAttribute && cur.getAttribute('name');
      if (nm) p += '[name="' + nm + '"]';
      else {
        const cls = (typeof cur.className === 'string' && cur.className.trim())
          ? '.' + cur.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
        p += cls;
        const par = cur.parentElement;
        if (par) {
          const same = Array.from(par.children).filter(c => c.tagName === cur.tagName);
          if (same.length > 1) p += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
        }
      }
      parts.unshift(p);
      cur = cur.parentElement || (cur.getRootNode() && cur.getRootNode().host) || null;
    }
    return parts.join(' > ');
  };
  // Настоящая цель клика - самый глубокий узел пути: у ALTCHA галочка лежит
  // в shadow DOM, и `event.target` отдал бы только хост-элемент.
  const deepest = (ev) => {
    const p = (ev.composedPath && ev.composedPath()) || [];
    const d = p.find(n => n && n.nodeType === 1);
    return { deep: d || ev.target, host: ev.target };
  };
  const send = (p) => {
    p.wid = g.__odrecWid;
    p.n = ++g.__odrecN;
    p.href = location.href;
    g.__odrecBuf.push(p);
    if (g.__odrecBuf.length > 400) g.__odrecBuf.shift();
    try { console.debug('__odrec ' + JSON.stringify(p)); } catch (e) {}
  };

  document.addEventListener('click', (ev) => {
    const { deep, host } = deepest(ev);
    send({ act: 'КЛИК', sel: sel(deep), el: desc(deep), shadow: deep !== host ? desc(host) : null });
  }, { capture: true, passive: true });

  // Ввод пишем по паузе, иначе лог утонет в посимвольных строках.
  const timers = new WeakMap();
  document.addEventListener('input', (ev) => {
    const el = deepest(ev).deep;
    clearTimeout(timers.get(el));
    timers.set(el, setTimeout(() => {
      const v = el.value == null ? '' : String(el.value);
      send({ act: 'ВВОД', sel: sel(el), el: desc(el),
             value: masked(el) ? '«скрыто, ' + v.length + '»' : v.slice(0, 120) });
    }, 600));
  }, { capture: true, passive: true });

  document.addEventListener('change', (ev) => {
    const el = deepest(ev).deep;
    const tag = (el.tagName || '').toLowerCase();
    if (tag !== 'select' && el.type !== 'checkbox' && el.type !== 'radio') return;
    send({ act: 'ВЫБОР', sel: sel(el), el: desc(el),
           value: (el.type === 'checkbox' || el.type === 'radio') ? String(el.checked) : String(el.value) });
  }, { capture: true, passive: true });

  document.addEventListener('submit', (ev) => {
    send({ act: 'SUBMIT', sel: sel(ev.target), el: desc(ev.target) });
  }, { capture: true, passive: true });

  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== 'Escape') return;
    const el = deepest(ev).deep;
    send({ act: 'КЛАВИША', sel: sel(el), el: desc(el), value: ev.key });
  }, { capture: true, passive: true });
})();
"""

DRAIN_JS = "() => { const b = globalThis.__odrecBuf || []; globalThis.__odrecBuf = []; return b; }"

BRIDGE = DIR.parent / "routing" / "lib" / "proxy-for.js"

# ── 22.do: адрес берём сами ───────────────────────────────────────────────────
#
# 🔴 Разведка 16.09 (`_research/probe-22do-selectors.py`) показала устройство сайта:
# кнопка «Random» (`button#mail-random`) крутит **ДОМЕН**, а не локальную часть.
# Набор доменов: `youxiang.dev`, `colabeta.com`, `colaname.com`, `linshiyou.com`,
# `tnbeta.com`, `usdtbeta.com`, `fft.edu.do`, `hotmail.com`, `outlook.com` и - главное -
# **`gmail.com` и `googlemail.com`**, которые выпадают примерно раз в три нажатия
# (замер: 5 попаданий на 20 нажатий). В выпадающем списке (Choices.js) gmail НЕТ,
# он приходит только через «Random» - поэтому выбрать его прямо нельзя, только крутить.
#
# 🎯 Почему именно gmail и без плюса: у Clerk `block_email_subaddresses: true` и
# `block_disposable_email_domains: true`, то есть плюс-алиас и любой одноразовый домен
# он отвергнет. Форма с точками проходит (проверено живой регистрацией).
# 🪤 Потолок нажатий пришлось поднять: в разведке gmail выпадал раз в три-четыре нажатия,
# а на живом прогоне 16.09 - только на 32-м. Сорок попыток тут впритык, и однажды упрутся
# в потолок при живом сервисе. Восемьдесят - это ~2 минуты, дешевле, чем упасть в ручной режим.
RANDOM_MAX_TRIES = 80
DOMAIN_RE = re.compile(r"@([A-Za-z0-9.-]+\.[A-Za-z]{2,})")


async def robust_click(page, selector, what, timeout=9000, prefer_js=False):
    """Клик, который не сдаётся на первом отказе.

    🪤 Тот же клик проходил в headless-разведке и упал в окне записи: у кнопки на 22.do
    может быть перекрытие (баннер, рекламный iframe) или она ещё не встала на место.
    Playwright в таком случае честно ждёт «actionability» и падает таймаутом, хотя
    кнопка есть. Поэтому три попытки по возрастанию грубости, и в логе видно, какая
    сработала - иначе следующий разбор начнётся с нуля.

    🔴 `prefer_js` - для СВОЕЙ автоматики (ящик на 22.do). С включённым `humanize=10.0`
    Camoufox ведёт мышь нарочно медленно, и один клик по «Random» занимал **30 секунд**
    (замер 16.09: шесть нажатий = три минуты). Клик из JS мгновенный: там, где
    человеческое движение мыши ничего не даёт (это наш собственный шаг, а не проход
    антибота), ждать его бессмысленно.
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
            last = str(e).splitlines()[0][:70]
    return False, f"все три способа не прошли (последняя ошибка: {last})"


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
    """Адрес ящика: сначала по известным селекторам, потом по хешу URL (`#/<адрес>`)."""
    for sel in ("#copyEmail", ".mf-panel-address", ".mf-address-row .mf-mono"):
        try:
            loc = page.locator(sel).first
            if await loc.count():
                t = " ".join((await loc.inner_text()).split())
                if "@" in t and "+" not in t.split("@")[0]:
                    return t
        except Exception:
            pass
    if "@" in page.url:
        candidate = page.url.split("#")[-1].strip("/ ")
        candidate = candidate.replace("inbox/", "").strip("/ ")
        if "@" in candidate and "+" not in candidate.split("@")[0]:
            return candidate
    return ""


async def prepare_22do_mailbox(page, state):
    """Крутит «Random» до домена gmail.com, жмёт «Open» и возвращает адрес ящика.

    Крутит ИМЕННО скрипт, а не человек: ручное «жми, пока не выпадет» - это ровно та
    работа, которую машина делает лучше (владелец 16.09: «а ты не научился оттуда
    брать gmail?»).
    """
    try:
        await page.goto(MAIL_OPEN, wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(4000)
    except Exception as e:
        LOG("ПОЧТА", f"22.do не открылся: {str(e).splitlines()[0][:80]}")
        return ""

    btn = page.locator("button#mail-random").first
    if not await btn.count():
        LOG("ПОЧТА", "🪤 кнопки «Random» нет - сайт изменился, адрес берёшь руками")
        return ""

    seen = []
    for i in range(1, RANDOM_MAX_TRIES + 1):
        dom = await read_22do_domain(page)
        seen.append(dom)
        if dom == "gmail.com":
            LOG("ПОЧТА", f"gmail.com выпал на {i}-м нажатии «Random»")
            break
        # 🪤 Запас времени здесь больше обычного: в окне записи включён `humanize=10.0`,
        # и Camoufox нарочно ведёт мышь медленно и с дрожью. В headless-разведке тот же
        # клик прошёл при humanize=2.0, а в окне упал таймаутом на 8 секундах - то есть
        # виноват был не селектор, а время. Поэтому здесь ещё и `prefer_js`: ждать
        # человеческое движение мыши на своём шаге незачем.
        ok, how = await robust_click(page, "button#mail-random", "Random",
                                     timeout=25000, prefer_js=True)
        if not ok:
            LOG("ПОЧТА", f"«Random» не нажался: {how}")
            return ""
        await page.wait_for_timeout(900)
    else:
        # Честный отказ вместо тихого перехода на чужой домен: регистрация с
        # одноразового домена всё равно упрётся в Clerk.
        LOG("ПОЧТА", f"❌ gmail.com не выпал за {RANDOM_MAX_TRIES} нажатий "
                     f"(видели: {', '.join(sorted(set(seen))[:8])}) - возьми адрес руками")
        return ""

    ok, how = await robust_click(page, "button#into-mailbox", "Open", timeout=30000, prefer_js=True)
    if not ok:
        LOG("ПОЧТА", f"«Open» не нажался: {how}")
        return ""
    await page.wait_for_timeout(6000)

    addr = await read_22do_address(page)
    if addr:
        state["email"] = addr
        state["created"] = datetime.now().isoformat(timespec="seconds")
        save_state(state)
        LOG("ПОЧТА", f"✅ адрес готов: {addr}")
    else:
        LOG("ПОЧТА", "ящик открылся, но адрес не прочитался - посмотри во вкладке")
    return addr


def emit_action(p):
    key = f"{p.get('wid')}:{p.get('n')}"
    if key in seen_ids:
        return
    seen_ids.add(key)
    tail = f'  <- "{p["value"]}"' if p.get("value") is not None else ""
    shadow = f'  (в тени {p["shadow"]})' if p.get("shadow") else ""
    LOG(p.get("act", "?"), f'{p.get("sel")}  -> {p.get("el")}{shadow}{tail}')
    REC({"kind": "action", **p})
    if phase["v"] == "user":
        route.append({"k": "act", **p})


async def acquire_proxy():
    """Прокси из ОБЩЕГО пула через мост на Node. Своей копии правил пула тут нет.

    Ключ привязки - профиль, а не адрес почты: на момент запуска окна адреса ещё нет,
    его владелец выберет на 22.do. Один профиль = один аккаунт, поэтому липкость честная.
    """
    if TIER == "none":
        LOG("ПРОКСИ", "ярус none - прогон идёт напрямую, с домашнего адреса")
        return None

    key = f"odyssey:profile:{label}"
    cmd = ["node", str(BRIDGE), "--key", key, "--host", POOL_HOST,
           "--path", POOL_PREFLIGHT_PATH, "--tier", TIER]
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    raw, err = await proc.communicate()
    text = (raw or b"").decode("utf-8", "replace").strip()
    line = [l for l in text.splitlines() if l.strip().startswith("{")]
    if not line:
        LOG("ПРОКСИ", f"мост пула не ответил JSON (код {proc.returncode}): "
                      f"{(text or (err or b'').decode('utf-8', 'replace'))[:160]}")
        raise SystemExit("прокси не получен, а ярус запрошен - прогон отменён")
    ans = json.loads(line[-1])
    REC({"kind": "proxy", "tier": TIER, "answer": ans})

    # 🔴 Контракт пула: `ok:false` значит «НЕ ходить вообще». Молча уйти напрямую - это
    # ровно тот тихий провал, из-за которого автореги когда-то регистрировались с
    # домашнего IP, и никто об этом не знал.
    if not ans.get("ok"):
        LOG("ПРОКСИ", f"❌ {ans.get('error')}")
        raise SystemExit("пул отказал в прокси - прогон отменён")
    if ans.get("direct"):
        LOG("ПРОКСИ", f"⚠️ пул отправил напрямую: {ans.get('reason')}")
        return None
    LOG("ПРОКСИ", f"{ans.get('label')} · ярус {ans.get('tier')} · привязка {ans.get('how')}")
    return ans.get("browser")


async def main():
    state = load_state()
    if not state.get("password"):
        state["password"] = "Od" + datetime.now().strftime("%H%M%S") + "aX!7"
        save_state(state)

    LOG("СТАРТ", f"Camoufox · профиль odyssey/profiles/{label} · ярус {TIER} · запись {LOG_PATH.name}")

    proxy_cfg = await acquire_proxy()

    base = dict(
        headless=False,
        os="windows",
        window=(1500, 1000),
        persistent_context=True,
        user_data_dir=str(PROFILE),
        disable_coop=True,
        humanize=10.0,          # относится только к движениям, которые делает скрипт
        main_world_eval=True,
        i_know_what_im_doing=True,
    )
    # 🪤 Первый прогон 16.09 умер ровно на открытии второй вкладки: Camoufox поднялся
    # с HAR и видео, ящик открылся - и браузер закрылся сам (TargetClosedError). Гадать,
    # какой слой записи его валит, смысла нет: перебираем слои по одному сверху вниз, и
    # то, на чём окно выживет, само и назовёт виновника в логе.
    attempts = [
        ("с HAR и видео", dict(record_har_path=str(HAR_PATH), record_har_content="embed",
                               record_video_dir=str(VIDEO_DIR))),
        ("только с HAR", dict(record_har_path=str(HAR_PATH), record_har_content="embed")),
        ("без HAR и видео", {}),
    ]

    # Прокси и geoip идут в КАЖДУЮ попытку. `geoip=True` заставляет Camoufox подогнать
    # часовой пояс, локаль и координаты под IP выхода: с прокси это не украшение -
    # расхождение «китайский IP, московский часовой пояс» само по себе повод для капчи.
    #
    # 🪤 Но geoip - это extras-зависимость (`camoufox[geoip]`), и если её нет, каждая
    # попытка с ним падает сообщением «install the geoip extra». Проверяем ДО запуска,
    # иначе три из шести попыток уходят в мусор, а в логе трижды пишется одна и та же
    # причина (ровно это и случилось 16.09).
    if proxy_cfg:
        base["proxy"] = proxy_cfg
        if importlib.util.find_spec("geoip2") is None:
            LOG("ВНИМАНИЕ", "geoip недоступен (нет extra `camoufox[geoip]`) - иду без него: "
                            "часовой пояс и локаль останутся локальными при чужом IP")
        else:
            attempts = ([(f"{n} + geoip", dict(o, geoip=True)) for n, o in attempts]
                        + [(n, o) for n, o in attempts])

    closed = asyncio.Event()

    def wire(ctx):
        ctx.on("close", lambda *_: closed.set())

        # ── слой 2: HTTP-контракт ────────────────────────────────────────────
        def on_request(req):
            if not ours(req.url) or req.resource_type in ("image", "font", "stylesheet"):
                return
            body = (req.post_data or "")[:4000] or None
            REC({"kind": "request", "method": req.method, "url": short(req.url), "body": body})
            # Адрес, которым владелец реально регистрируется, узнаём из тела запроса,
            # а не из вкладки почты: так он попадает в стейт при любом источнике ящика.
            if body and "/sign_ups" in req.url and "email_address=" in body:
                got = re.search(r"email_address=([^&]+)", body)
                if got:
                    addr = unquote_plus(got.group(1))
                    if addr and state.get("email") != addr:
                        state["email"] = addr
                        save_state(state)
                        LOG("ПОЧТА", f"адрес регистрации: {addr} (записал в стейт)")
            if req.method != "GET" or "/v1/" in req.url or "/api/" in req.url:
                extra_txt = f"  body: {flat(body, 200)}" if body else ""
                LOG("ЗАПРОС", f"{req.method} {short(req.url)}{extra_txt}")
                route.append({"k": "req", "method": req.method, "url": short(req.url), "body": body})

        async def on_response(res):
            try:
                if not ours(res.url) or res.request.resource_type in ("image", "font", "stylesheet"):
                    return
                try:
                    full = await res.text()
                except Exception:
                    full = "<не прочитано>"
                body = full[:6000]
                REC({"kind": "response", "status": res.status, "url": short(res.url), "body": body})
                if res.request.method != "GET" or "/v1/" in res.url or "/api/" in res.url:
                    LOG("ОТВЕТ", f"{res.status} {short(res.url)} :: {flat(body, 200)}")
                    route.append({"k": "res", "status": res.status, "url": short(res.url), "body": body[:600]})
                # 🪤 Ключ ищем в ПОЛНОМ теле, а не в обрезанном: 16.09 он приехал ответом
                # Server Action `POST /api-keys` - RSC-поток, где ключ лежит далеко за
                # шестью тысячами символов. Из-за обрезки первый живой ключ поймать не вышло.
                # 🪤 Границы слова и длина не для красоты: со `sk-[A-Za-z0-9_-]{16,}` в
                # «ключ» попал CSS-класс `sk-image-linear-pos` из разметки страницы.
                # Настоящий ключ Odyssey - `sk-ody-…` длиной больше сорока символов.
                key = re.search(r"\bsk-(?:ody-)?[A-Za-z0-9_-]{24,}\b", full or "")
                if key and state.get("api_key") != key.group(0):
                    state["api_key"] = key.group(0)
                    save_state(state)
                    LOG("КЛЮЧ", f"🔑 поймал в ответе {short(res.url)}: {key.group(0)}")
            except Exception as e:
                REC({"kind": "error", "where": "on_response", "msg": str(e)[:200]})

        ctx.on("request", on_request)
        ctx.on("response", lambda res: asyncio.create_task(on_response(res)))

        def attach(page):
            # Второй канал действий: зеркало в console.debug. Нужен потому, что
            # init-скрипт и evaluate могут оказаться в разных мирах - тогда буфер
            # вычерпать не выйдет, а консоль дойдёт.
            def on_console(msg):
                t = msg.text or ""
                if not t.startswith("__odrec "):
                    return
                try:
                    emit_action(json.loads(t[8:]))
                except Exception:
                    pass

            page.on("console", on_console)

            def on_nav(frame):
                if frame != page.main_frame:
                    return
                LOG("ПЕРЕХОД", short(frame.url))
                REC({"kind": "nav", "url": frame.url})
                if phase["v"] == "user":
                    route.append({"k": "nav", "url": short(frame.url)})

            page.on("framenavigated", on_nav)

        for p in ctx.pages:
            attach(p)
        ctx.on("page", lambda p: (LOG("ВКЛАДКА", f"новая: {short(p.url)}"), attach(p)))

    async def open_tabs(ctx):
        # 🪤 Вторую вкладку создаём ДО всякой навигации. Так падение (если оно от
        # самой вкладки) приходит на чистом окне, а не после четырёх секунд загрузки
        # ящика - и в логе однозначно видно, что убило.
        site = await ctx.new_page()
        mail = ctx.pages[0]

        email = state.get("email")
        if MAIL_MODE == "emailnator" and email:
            LOG("НАСТРОЙКА", f"открываю прежний ящик {email} (жму я, это ещё не запись твоих действий)")
            await mail.goto(f"{MAIL_SOURCES['emailnator']}inbox#{email}", wait_until="domcontentloaded", timeout=60000)
            await mail.wait_for_timeout(4000)
            shown = ""
            try:
                loc = mail.locator(ADDRESS_SEL).first
                if await loc.count():
                    shown = (await loc.inner_text()).strip()
            except Exception:
                pass
            if shown.lower() == str(email).lower():
                LOG("ПОЧТА", f"ящик наш: {shown}")
                picked["email"] = shown
            else:
                LOG("ПОЧТА", f"на странице «{shown or 'адрес не прочитался'}», а нужен {email} - "
                              "нажми GO ! или сгенерируй новый (чипы: включён только .Gmail)")
        elif MAIL_MODE == "22do":
            # 22.do: адрес выбираем сами (Random до gmail.com + Open), человеку остаётся
            # только регистрация. Если не вышло - функция скажет об этом громко, и адрес
            # можно взять во вкладке руками.
            addr = await prepare_22do_mailbox(mail, state)
            picked["email"] = addr
            if not addr:
                LOG("ПОЧТА", f"вкладка почты: {MAIL_OPEN} - возьми адрес там")
        else:
            # Свой URL: никакой автоматики, адрес берёт владелец. Скрипт всё равно узнает
            # его сам - из тела `POST /v1/client/sign_ups`.
            await mail.goto(MAIL_OPEN, wait_until="domcontentloaded", timeout=60000)
            LOG("ПОЧТА", f"вкладка почты: {MAIL_OPEN} ({MAIL_MODE}) - адрес возьми там")

        try:
            await site.goto(SIGNUP_URL, wait_until="domcontentloaded", timeout=60000)
        except Exception as e:
            LOG("ВНИМАНИЕ", f"страница регистрации не открылась: {str(e)[:90]}")
        await site.bring_to_front()

    cm = None
    ctx = None
    for note, extra in attempts:
        try:
            cm = AsyncCamoufox(**base, **extra)
            ctx = await cm.__aenter__()
            await ctx.add_init_script(INIT_SCRIPT)
            wire(ctx)
            await open_tabs(ctx)
            LOG("БРАУЗЕР", f"Camoufox поднят и обе вкладки живы ({note})")
            break
        except Exception as e:
            # Ловим широко намеренно: отказать может и Playwright (TargetClosedError), и
            # сама сборка Camoufox (нет базы geoip, не принят ключ). Разбирать эти случаи
            # по типам смысла нет - у всех один и тот же выход: следующая попытка. Причина
            # печатается, поэтому диагностика не теряется.
            LOG("ВНИМАНИЕ", f"попытка «{note}» сорвалась: {str(e).splitlines()[0][:110]}")
            closed.clear()          # крах контекста уже зажёг событие - гасим перед новой попыткой
            if cm is not None:
                try:
                    await cm.__aexit__(None, None, None)
                except Exception:
                    pass
            cm = None
            ctx = None
    if ctx is None:
        raise SystemExit("Camoufox не выжил ни с одним набором ключей записи")

    phase["v"] = "user"
    print("")
    print("=" * 60)
    print("  ЗАПИСЬ ИДЁТ (Camoufox). Дальше всё в логе - твои действия.")
    print("=" * 60)
    print(f"  вкладка 1: {MAIL_OPEN} ({MAIL_MODE})")
    if picked["email"]:
        # Адрес печатаем отдельной строкой и крупно: его надо вписать в форму, а вкладку
        # с ящиком человек открывать не обязан.
        print(f"  📬 АДРЕС: {picked['email']}")
    else:
        print("  📬 АДРЕС: не выбран этим прогоном - возьми во вкладке 1")
    print("  вкладка 2: odysseyapi.tech/sign-up")
    print(f"  ярус прокси: {TIER}" + (f" · {proxy_cfg.get('server')}" if proxy_cfg else " · напрямую"))
    print(f"  пароль наготове: {state.get('password')}")
    print("")
    print("  🎯 Адрес нужен @gmail.com БЕЗ плюса: у Clerk block_email_subaddresses,")
    print("     плюс-алиас он отвергнет. На 22.do жми «Random» до попадания.")
    print("  🪤 Пароль НЕ должен совпадать с адресом - Clerk отдаёт на это 422.")
    print("  ALTCHA и Turnstile проходи как получится - я пишу и успех, и отказ.")
    print("  Адрес почты я уже выбрал - вписывай его в форму.")
    print("  ЗАКОНЧИЛ - просто закрой окно браузера, я соберу сводку.")
    print("=" * 60)
    print("", flush=True)

    # ── вычерпывание буфера действий ─────────────────────────────────────────
    async def drain_loop():
        while not closed.is_set():
            for p in list(ctx.pages):
                try:
                    items = await p.evaluate(DRAIN_JS)
                except Exception:
                    continue
                for it in items or []:
                    emit_action(it)
            await asyncio.sleep(0.7)

    drain = asyncio.create_task(drain_loop())
    await closed.wait()
    drain.cancel()

    # ── сводка маршрута ──────────────────────────────────────────────────────
    md = [
        "# Odyssey - записанный ручной маршрут регистрации (Camoufox)",
        "",
        f"- Записано: {datetime.now():%Y-%m-%d %H:%M} (MSK)",
        f"- Профиль: `odyssey/profiles/{label}/`",
        f"- Почта: `{state.get('email') or '(готовил руками)'}`",
        f"- Ключ: {'`' + state['api_key'] + '`' if state.get('api_key') else 'не поймал в трафике'}",
        f"- Логи: `{LOG_PATH.name}`, `{JSONL_PATH.name}`",
        "",
        "## Маршрут по шагам",
        "",
    ]
    for r in route:
        if r["k"] == "nav":
            md.append(f"- 🧭 переход -> `{r['url']}`")
        elif r["k"] == "act":
            val = f' <- "{r["value"]}"' if r.get("value") is not None else ""
            md.append(f"- 👉 {r['act']} `{r['sel']}` -> {r['el']}{val}")
        elif r["k"] == "req":
            b = f" body: `{flat(r['body'], 300)}`" if r.get("body") else ""
            md.append(f"  - → `{r['method']} {r['url']}`{b}")
        elif r["k"] == "res":
            md.append(f"  - ← `{r['status']}` `{r['url']}` :: {flat(r['body'], 300)}")
    ROUTE_PATH.write_text("\n".join(md) + "\n", encoding="utf-8")

    await cm.__aexit__(None, None, None)
    log_fh.close()
    jsonl_fh.close()
    print("")
    print("=" * 60)
    print(f"  Запись закрыта. Шагов в маршруте: {len(route)}")
    print(f"  лог:     {LOG_PATH}")
    print(f"  маршрут: {ROUTE_PATH}")
    if state.get("api_key"):
        print(f"  ключ:    {state['api_key']}")
    print("=" * 60, flush=True)


if __name__ == "__main__":
    asyncio.run(main())
