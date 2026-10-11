#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
vani/record-signup-camoufox.py

Окно с ЗАПИСЬЮ ручной регистрации на vani.ai. Движок - Camoufox (Firefox с
вырезанными следами автоматизации), тот же путь проекта, которым ходит
freemodel/lib/camoufox_emailnator.py и odyssey/record-signup-camoufox.py.

🔴 Почему Camoufox, а не Chrome. У площадки своя панель на Next.js, и вход/регистрация
сидят за Cloudflare Turnstile (на `c.vani.ai/login` в разметке есть `turnstile`).
Хромом управляют снаружи по CDP, а включённый Runtime-домен Turnstile это видит -
ровно как на odyssey 16.09. Firefox-путь Camoufox идёт не через CDP вовсе.

Домен API != домен регистрации (типовая грабля канона):
  регистрация/вход : c.vani.ai/login      (SPA, signup - переключатель на той же странице)
  консоль ключей   : platform.vani.ai
  API              : api.vani.ai           (/v1/chat/completions и /v1/messages живые)
  статус           : status.vani.ai

Ключ формата `vani_<64 hex>` (замер 09.10).

Запуск:
  python vani/record-signup-camoufox.py [label] [--mail emailnator|22do|<url>] [--tier none|scraper|own]

Итог (vani/recordings/):
  signup-cf-<ts>.log       читаемый лог действий
  signup-cf-<ts>.jsonl     машинный лог: действия + запросы + ответы
  signup-cf-<ts>.har       полный трафик (если движок дал)
  signup-cf-<ts>-route.md  сводный маршрут, собирается при закрытии окна
"""

import asyncio
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from urllib.parse import unquote_plus

from camoufox import AsyncCamoufox

DIR = Path(__file__).resolve().parent
REC_DIR = DIR / "recordings"
VIDEO_DIR = REC_DIR / "video"
STATE_FILE = DIR / ".signup-state.json"

SIGNUP_URL = "https://c.vani.ai/login"
MAIL_URL = "https://www.emailnator.com/"
MAIL_SOURCES = {
    "emailnator": "https://www.emailnator.com/",
    "22do": "https://22.do/",
}
# challenges.cloudflare.com намеренно в списке: по нему видно, выдал Turnstile токен
# или пересоздал челлендж. Без этого барьер выглядит как клик в пустоту.
WATCH = ("vani.ai", "c.vani.ai", "platform.vani.ai", "challenges.cloudflare.com")
ADDRESS_SEL = ".mf-address-row .mf-mono, .mf-panel-address, .mf-mono"

raw_argv = sys.argv[1:]
positional = []
mail_arg = "emailnator"
i = 0
while i < len(raw_argv):
    a = raw_argv[i]
    if a.startswith("--mail"):
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

# --tier <scraper|own|none>: чей прокси берём под прогон. 🪤 Прокси решает, пройдёт ли
# Turnstile: публичные адреса скрапера часто уже в чёрных списках Cloudflare. Для этого
# шлюза со своим доменом панели лучший проход - домашний адрес, поэтому ярус по умолчанию none.
TIER = "none"
for i, a in enumerate(raw_argv):
    if a.startswith("--tier"):
        TIER = (a.split("=", 1)[1] if "=" in a else (raw_argv[i + 1] if i + 1 < len(raw_argv) else "none")).lower()
if TIER not in ("scraper", "own", "none"):
    TIER = "none"
POOL_HOST = "vani.ai"
# Зонд пула: у панели свой статус-HTTP (не соглашение New API), он отдаёт 200 JSON
# без авторизации (замер 09.10: {"checked_at":...,"components":[...]}).
POOL_PREFLIGHT_PATH = "/api/status"

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


def flat(s, n):
    return re.sub(r"\s+", " ", str(s if s is not None else ""))[:n]


# ── слой 1: запись действий, без единого следа на window страницы ──────────────
INIT_SCRIPT = r"""
(() => {
  const g = globalThis;
  if (!g.__vrecWid) g.__vrecWid = Math.random().toString(36).slice(2, 8);
  if (!g.__vrecBuf) g.__vrecBuf = [];
  if (!g.__vrecN) g.__vrecN = 0;

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
  const deepest = (ev) => {
    const p = (ev.composedPath && ev.composedPath()) || [];
    const d = p.find(n => n && n.nodeType === 1);
    return { deep: d || ev.target, host: ev.target };
  };
  const send = (p) => {
    p.wid = g.__vrecWid;
    p.n = ++g.__vrecN;
    p.href = location.href;
    g.__vrecBuf.push(p);
    if (g.__vrecBuf.length > 400) g.__vrecBuf.shift();
    try { console.debug('__vrec ' + JSON.stringify(p)); } catch (e) {}
  };

  document.addEventListener('click', (ev) => {
    const { deep, host } = deepest(ev);
    send({ act: 'КЛИК', sel: sel(deep), el: desc(deep), shadow: deep !== host ? desc(host) : null });
  }, { capture: true, passive: true });

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

DRAIN_JS = "() => { const b = globalThis.__vrecBuf || []; globalThis.__vrecBuf = []; return b; }"

BRIDGE = DIR.parent / "routing" / "lib" / "proxy-for.js"

EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")


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
    """Прокси из ОБЩЕГО пула через мост на Node. Своей копии правил пула тут нет."""
    if TIER == "none":
        LOG("ПРОКСИ", "ярус none - прогон идёт напрямую, с домашнего адреса")
        return None

    key = f"vani:profile:{label}"
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
        state["password"] = "Vn" + datetime.now().strftime("%H%M%S") + "aX!7"
        save_state(state)

    LOG("СТАРТ", f"Camoufox · профиль vani/profiles/{label} · ярус {TIER} · запись {LOG_PATH.name}")

    proxy_cfg = await acquire_proxy()

    base = dict(
        headless=False,
        os="windows",
        window=(1500, 1000),
        persistent_context=True,
        user_data_dir=str(PROFILE),
        disable_coop=True,
        humanize=10.0,
        main_world_eval=True,
        i_know_what_im_doing=True,
    )
    # Перебираем слои записи сверху вниз: то, на чём окно выживет, само назовёт виновника.
    attempts = [
        ("с HAR и видео", dict(record_har_path=str(HAR_PATH), record_har_content="embed",
                               record_video_dir=str(VIDEO_DIR))),
        ("только с HAR", dict(record_har_path=str(HAR_PATH), record_har_content="embed")),
        ("без HAR и видео", {}),
    ]

    if proxy_cfg:
        base["proxy"] = proxy_cfg
        try:
            import importlib.util
            if importlib.util.find_spec("geoip2") is None:
                LOG("ВНИМАНИЕ", "geoip недоступен - иду без него")
            else:
                attempts = ([(f"{n} + geoip", dict(o, geoip=True)) for n, o in attempts]
                            + [(n, o) for n, o in attempts])
        except Exception:
            pass

    closed = asyncio.Event()

    def wire(ctx):
        ctx.on("close", lambda *_: closed.set())

        def on_request(req):
            if not ours(req.url) or req.resource_type in ("image", "font", "stylesheet"):
                return
            body = (req.post_data or "")[:4000] or None
            REC({"kind": "request", "method": req.method, "url": short(req.url), "body": body})
            # Адрес, которым владелец реально регистрируется, узнаём из тела запроса.
            if body:
                em = EMAIL_RE.search(body)
                if em and state.get("email") != em.group(0):
                    state["email"] = em.group(0)
                    save_state(state)
                    LOG("ПОЧТА", f"адрес регистрации: {em.group(0)} (записал в стейт)")
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
                # Ключ 및 в ПОЛНОМ теле, не в обрезанном: он может приехать ответом
                # Server Action далеко за шестью тысячами символов.
                key = re.search(r"\bvani_[A-Za-z0-9]{40,}\b", full or "")
                if key and state.get("api_key") != key.group(0):
                    state["api_key"] = key.group(0)
                    save_state(state)
                    LOG("КЛЮЧ", f"🔑 поймал в ответе {short(res.url)}: {key.group(0)}")
            except Exception as e:
                REC({"kind": "error", "where": "on_response", "msg": str(e)[:200]})

        ctx.on("request", on_request)
        ctx.on("response", lambda res: asyncio.create_task(on_response(res)))

        def attach(page):
            def on_console(msg):
                t = msg.text or ""
                if not t.startswith("__vrec "):
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
        site = await ctx.new_page()
        mail = ctx.pages[0]

        email = state.get("email")
        if MAIL_MODE == "emailnator" and email:
            LOG("НАСТРОЙКА", f"открываю прежний ящик {email}")
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
                              "нажми GO ! или сгенерируй новый")
        else:
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
            LOG("ВНИМАНИЕ", f"попытка «{note}» сорвалась: {str(e).splitlines()[0][:110]}")
            closed.clear()
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
        print(f"  📬 АДРЕС: {picked['email']}")
    else:
        print("  📬 АДРЕС: не выбран этим прогоном - возьми во вкладке 1")
    print(f"  вкладка 2: {SIGNUP_URL}")
    print(f"  ярус прокси: {TIER}" + (f" · {proxy_cfg.get('server')}" if proxy_cfg else " · напрямую"))
    print(f"  пароль наготове: {state.get('password')}")
    print("")
    print("  🎯 Регистрация - переключатель Sign up на странице входа c.vani.ai/login.")
    print("  🪤 Turnstile проходи как получится - я пишу и успех, и отказ.")
    print("  🔑 Ключ ищи на platform.vani.ai - я ловлю его сам из трафика.")
    print("  ЗАКОНЧИЛ - просто закрой окно браузера, я соберу сводку.")
    print("=" * 60)
    print("", flush=True)

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

    md = [
        "# vani.ai - записанный ручной маршрут регистрации (Camoufox)",
        "",
        f"- Записано: {datetime.now():%Y-%m-%d %H:%M} (MSK)",
        f"- Профиль: `vani/profiles/{label}/`",
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
