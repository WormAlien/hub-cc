"""smailpro/auto-add.py - авторега ThreeRouter с почтой на smailpro через Camoufox.

ЗАМЕНА emailnator. Причина: свободные адреса на emailnator кончились, а smailpro
выдаёт РЕАЛЬНЫЕ @gmail.com, которые проходят вайтлист панели.

Почему Camoufox, а не Chromium: smailpro.com закрыт Cloudflare Turnstile, обычный
Chromium отдаёт "Verification failed" (живой скрин владельца 28.10). Camoufox
проходит челлендж сам - ящик создаётся за ~26 с без единого клика.

Почему не через API smailpro напрямую: `POST /app/create` и `GET /app/message`
требуют заголовок `x-captcha` с Turnstile-токеном. Но список и тело письма лежат
на `api.sonjj.com` и берутся по `payload`-токену БЕЗ капчи - поэтому письмо
читается HTTP-запросом из самой smailpro-страницы, минуя модалку со вторым Turnstile.

ЦЕПОЧКА (все звенья замерены 28.10, подробности у sleep/probe_*.py):
  1. голая страница smailpro -> ящик создаётся сам (~26 с)
  2. {address, timestamp, key} - IndexedDB `EmailDatabase` -> стор `emails`
  3. POST /app/inbox [{address,timestamp,key}] -> payload (JWT)
  4. GET api.sonjj.com/v1/temp_gmail/inbox?payload=... -> письма (mid)
     GET api.sonjj.com/v1/temp_gmail/message?payload=...&mid=... -> тело
  5. ThreeRouter: клик-капча РУКАМИ -> /auth/register -> группа -> ключ

🪤 Страница smailpro должна загружаться ГОЛОЙ: если к моменту загрузки на ней
уже висят посторонние обработчики, Turnstile не докручивается и ящик не
создаётся вовсе (замер: 133 с, `Limit 0/5`). Поэтому таб ThreeRouter
открывается ТОЛЬКО после того, как адрес появился.

Запуск:
  python smailpro/auto-add.py [количество] [--no-proxy] [--proxy=<label>]

Результат: запись в routing/threerouter-sessions.json (+ снимок сессии).
"""
import asyncio, json, os, random, re, string, sys, time, traceback
from contextlib import asynccontextmanager
from pathlib import Path

from camoufox import AsyncCamoufox

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(__file__).resolve().parent / "recordings"
OUT.mkdir(parents=True, exist_ok=True)
PROFILE = OUT / "autoadd-profile"

ORIGIN = "https://www.threerouter.com"
API = ORIGIN + "/api/v1"
GATEWAY = "https://api.threerouter.com"
REF = "VWCYM3TATVDX"
REGISTER_URL = f"{ORIGIN}/register?aff={REF}"
POOL_FILE = ROOT / "routing" / "threerouter-sessions.json"
# Снимок сессии должен лежать там, где его ищет кнопка 🌐 дашборда: open-session.js
# читает threerouter/sessions/acct_<id>.json. smailpro/sessions - мёртвый путь (29.10).
SESS_DIR = Path(__file__).resolve().parent.parent / "threerouter" / "sessions"
# PID-файл: кнопка «Стоп» на вкладке tr читает ИМЕННО этот путь
# (`TR_AUTOREG_PID` в routing/transparent-proxy.js). Без него прогон, запущенный
# из терминала, кнопкой не остановить - и наоборот.
PID_FILE = ROOT / "routing" / "threerouter-autoreg.pid"


def pid_write():
    try:
        PID_FILE.write_text(str(os.getpid()), encoding="utf-8")
    except Exception:
        pass


def pid_clear():
    try:
        if PID_FILE.read_text(encoding="utf-8").strip() == str(os.getpid()):
            PID_FILE.unlink()
    except Exception:
        pass

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36")

MAILBOX_WAIT_S = 180
OTP_WAIT_S = 300
CAPTCHA_WAIT_S = 600

STOP = {"PLEASE", "VERIFY", "EMAILS", "EMAIL", "SECURE", "THANKS", "NOTICE", "ACCESS",
        "WELCOME", "ACCOUNT", "ROUTER", "THREE", "GMAIL", "HTTPS", "SIGNIN", "LOGINS",
        "SHARED", "SUPPORT", "PRIVACY", "POLICY", "TERMS", "CODE", "OTP"}


def log(tag, msg):
    print(f"[{time.strftime('%H:%M:%S')}] [{tag}] {msg}", flush=True)


def stage(name, **extra):
    print("SP_STAGE " + json.dumps({"stage": name, **extra}, ensure_ascii=False), flush=True)


# ───────────────────────────── JS: состояние ящика ─────────────────────────────

MAILBOX_JS = """() => {
  const r = document.querySelector('input[name="limitEmail"]');
  const a = r ? String(r.value || '') : '';
  const t = document.body ? document.body.innerText : '';
  const lim = t.match(/Limit\\s*(\\d+)\\s*\\/\\s*(\\d+)/i);
  return { addr: /@(gmail|outlook|googlemail)\\.com$/i.test(a) ? a : null,
           limit: lim ? lim[0] : null, limitN: lim ? parseInt(lim[1], 10) : 0 };
}"""

# Забирает {address,timestamp,key} из IndexedDB и обменивает на payload.
# Всё - в одной evaluate: запросы уходят с origin smailpro.com и его куками.
GET_PAYLOAD_JS = """async (arg) => {
  let mine = null;
  if (arg && typeof arg === 'object') {
    // Тройка {address,timestamp,key}, спасённая в Python: /app/inbox принимает её
    // напрямую, IndexedDB не нужен - работает даже после перезапуска браузера.
    mine = arg;
  } else {
    const readEmails = async () => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('EmailDatabase');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      const rows = await new Promise((res, rej) => {
        const tx = db.transaction('emails', 'readonly');
        const q = tx.objectStore('emails').getAll();
        q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
      });
      db.close();
      return rows || [];
    };
    let rows = [];
    try { rows = await readEmails(); } catch (e) { return { error: 'idb: ' + e }; }
    mine = rows.find(r => r.address === arg) || rows[0];
    if (!mine) return { error: 'в IndexedDB нет ящиков', rows: rows.length };
  }

  const r = await fetch('/app/inbox', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([{ address: mine.address, timestamp: mine.timestamp, key: mine.key }]),
  });
  const txt = await r.text();
  let arr = null;
  try { arr = JSON.parse(txt); } catch (e) {}
  const f = (Array.isArray(arr) ? arr.find(x => x && x.address === mine.address) : null)
         || (Array.isArray(arr) ? arr[0] : null);
  if (!f || !f.payload) return { error: 'нет payload', status: r.status, body: txt.slice(0, 200) };
  return { address: mine.address, timestamp: mine.timestamp, payload: f.payload, key: mine.key };
}"""

# Список писем: api.sonjj.com, без captcha.
FETCH_INBOX_JS = """async (args) => {
  const base = 'https://api.sonjj.com/v1/' + args.kind + '/inbox?payload=' +
               encodeURIComponent(args.payload);
  const r = await fetch(base);
  const txt = await r.text();
  let j = null;
  try { j = JSON.parse(txt); } catch (e) {}
  let msgs = [];
  if (Array.isArray(j)) msgs = j;
  else if (j && Array.isArray(j.messages)) msgs = j.messages;
  else if (j && Array.isArray(j.data)) msgs = j.data;
  return { status: r.status, count: msgs.length,
           msgs: msgs.map(m => ({
             mid: m.mid || m.id || m.message_id || null,
             from: m.from || m.sender || m.textFrom || '',
             subject: m.subject || m.textSubject || '',
           })), raw: txt.slice(0, 300) };
}"""

# Тело письма по mid.
FETCH_MESSAGE_JS = """async (args) => {
  const base = 'https://api.sonjj.com/v1/' + args.kind + '/message?payload=' +
               encodeURIComponent(args.payload) + '&mid=' + encodeURIComponent(args.mid);
  const r = await fetch(base);
  const txt = await r.text();
  let j = null;
  try { j = JSON.parse(txt); } catch (e) {}
  let body = '';
  if (j) {
    if (typeof j === 'string') body = j;
    else body = j.body || j.html || j.text || j.content ||
                (j.data && (j.data.body || j.data.html || j.data.text)) || '';
  }
  return { status: r.status, body: String(body).slice(0, 20000), raw: txt.slice(0, 500) };
}"""

# Заполнение формы. Клики НЕ здесь - см. click_exact_button().
FILL_FORM_JS = """(args) => {
  const setVal = (sel, val) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  return {
    okEmail: setVal('#email, input[type="email"]', args.email),
    okPass: setVal('#password, input[type="password"]', args.password),
  };
}"""

# Текст кнопок для поиска по нормализованному innerText (замер 28.10: все реально есть).
AGREE_TEXTS = ["Accept and continue", "同意并继续", "Accept", "同意"]
START_TEXTS = ["Click to start verification", "Start verification",
               "点击开始验证", "开始验证"]

CONSENT_KEY = "sub2api_login_agreement_consent"


async def fetch_agreement_revision(page):
    """Живая ревизия соглашения из /api/v1/settings/public.

    🪤 Ревизию берём с сервера, а не из константы: сменится - старое согласие
    перестанет совпадать, и модалка вылезет снова. Тот же расчёт, что в бандле
    SPA и в рабочем threerouter/open-session.js (иначе ключ не совпадёт).
    """
    st, data = await tr_api(page, "/settings/public")
    if st != 200 or not isinstance(data, dict):
        return None
    docs = data.get("login_agreement_documents")
    docs = docs if isinstance(docs, list) else []
    rev = data.get("login_agreement_revision") or (
        f"{data.get('login_agreement_updated_at') or ''}:" +
        "|".join(f"{d.get('id')}:{d.get('title')}" for d in docs)
        if docs else ""
    )
    return rev or None


async def click_exact_button(page, texts):
    """Клик по кнопке с точным ВИДИМЫМ текстом - настоящим кликом Playwright.

    🔴 JS-`.click()` не доходит до Alpine-обработчиков: живой прогон 07:46 дал
    `{'agreed': False, 'started': False}` при том, что обе кнопки на странице
    есть (список кнопок из записи). Приём взят из рабочего
    `threerouter/open-session.js`: ищем индекс перебором по нормализованному
    innerText в самой странице, кликаем `page.locator('button').nth(idx)`.
    Локаторы с якорями `/^ТЕКСТ$/` не годятся - внутри кнопок иконки, и
    textContent содержит разметку, а innerText уже нормализован.
    """
    for t in texts:
        idx = await page.evaluate("""(want) => {
            const all = [...document.querySelectorAll('button')];
            return all.findIndex(x => (x.innerText || '').replace(/\\s+/g, ' ').trim() === want);
        }""", t)
        if idx is not None and idx >= 0:
            try:
                await page.locator("button").nth(idx).click(timeout=8000)
                return t
            except Exception:
                continue
    return None


def extract_code(text):
    """Код ThreeRouter: 6 символов A-Z0-9. Живой пример AXMFJK."""
    s = str(text or "")
    plain = re.sub(r"<[^>]+>", " ", s)
    for line in plain.splitlines():
        m = re.match(r"^\s*([A-Z0-9]{6})\s*$", line.strip())
        if m and m.group(1).upper() not in STOP:
            return m.group(1).upper()
    flat = re.sub(r"\s+", " ", plain)
    near = re.search(r"(?:verification\s*code|verify\s*code|\bcode\b|код|otp|pin)"
                     r"[^A-Za-z0-9]{0,24}([A-Z0-9]{6})(?![A-Za-z0-9])", flat, re.I)
    if near and near.group(1).upper() not in STOP:
        return near.group(1).upper()
    for m in re.finditer(r"(?<![A-Za-z0-9])([A-Z0-9]{6})(?![A-Za-z0-9])", flat):
        t = m.group(1).upper()
        if t not in STOP and re.search(r"\d", t):
            return t
    return None


def rand_password():
    body = "".join(random.choice(string.ascii_letters + string.digits) for _ in range(12))
    return f"Tr{body}7q"


def key_name():
    return "cc_" + "".join(random.choice("0123456789abcdef") for _ in range(8))


def unwrap(j):
    if isinstance(j, dict) and isinstance(j.get("code"), int) and "data" in j:
        return j["data"]
    return j


def pool_append(rec):
    rows = []
    try:
        raw = POOL_FILE.read_text(encoding="utf-8")
        if raw.startswith("﻿"):
            raw = raw[1:]
        rows = json.loads(raw)
        if not isinstance(rows, list):
            rows = []
    except Exception:
        rows = []
    have = {r.get("api_key") for r in rows if isinstance(r, dict)}
    if rec.get("api_key") in have:
        return 0
    rows.insert(0, rec)
    POOL_FILE.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    return 1


# Вызов API ThreeRouter ИЗ САМОЙ СТРАНИЦЫ.
#
# 🔴 Капча-токен привязан к ОТПЕЧАТКУ КЛИЕНТА, а не только к IP. Живой прогон
# 08:19: токен поймали в 08:19:24, отправили в 08:19:25 - одна секунда, истёк
# он быть не мог, - а панель ответила `400 registration click captcha token
# invalid or expired`. Причина: запрос уходил через `urllib` из Python, у него
# свой TLS-отпечаток и UA, а капчу решал Firefox. Панель видит «токен от одного
# клиента пришёл от другого».
# Поэтому ВСЕ вызовы API идут fetch'ем из страницы: тот же origin, куки, IP и
# отпечаток, что и у решённой капчи.
PAGE_API_JS = """async (a) => {
  const headers = { 'Accept': 'application/json' };
  if (a.token) headers['Authorization'] = 'Bearer ' + a.token;
  const opts = { method: a.method, headers, credentials: 'include' };
  if (a.body !== null && a.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(a.body);
  }
  try {
    const r = await fetch('/api/v1' + a.path, opts);
    const t = await r.text();
    let j = null;
    try { j = JSON.parse(t); } catch (e) {}
    return { status: r.status, json: j, text: t.slice(0, 600) };
  } catch (e) {
    return { status: 0, error: String(e).slice(0, 200) };
  }
}"""


async def tr_api(page, path, method="GET", body=None, token=None):
    """API ThreeRouter через fetch из страницы (отпечаток тот же, что у капчи)."""
    raw = await page.evaluate(PAGE_API_JS, {
        "path": path, "method": method, "body": body, "token": token,
    })
    if raw.get("error"):
        return 0, {"message": raw["error"]}
    data = raw.get("json")
    if data is None:
        data = {"message": (raw.get("text") or "")[:200]}
    return raw.get("status", 0), unwrap(data)


def mail_kind(addr):
    a = (addr or "").lower()
    if a.endswith("@gmail.com") or a.endswith("@googlemail.com"):
        return "temp_gmail"
    if re.search(r"@(outlook|hotmail|live)\.", a):
        return "temp_outlook"
    return "temp_email"


# ───────────────────────────── прокси из общего пула ─────────────────────────────
#
# Своей копии правил пула тут НЕТ: пул живёт в Node (`routing/lib/proxy-pool.js`),
# а Python зовёт мост `routing/lib/proxy-for.js` - тот же, что у автореги odyssey.
# Вторая реализация правил распределения уже приводила к тому, что правка в одном
# месте не касалась другого, а снаружи это выглядело как необъяснимый провал.
#
# 🪤 Источник пула глобальный и по умолчанию `own` (настройка дашборда). Для
# threerouter нужен СКРАПЕРНЫЙ ярус, поэтому мосту ставим
# `PROXY_POOL_SOURCE=scraped` в окружение: env сильнее файла конфига, настройку
# владельца это не трогает.
PROXY_LEDGER = ROOT / "routing" / "threerouter-proxy-ledger.json"
# Скраперный список со вкладки: его пишет кнопка «Найти прокси»
# (`python -m proxy_scraper.find_for_host --host www.threerouter.com`).
SCRAPER_FILE = ROOT / "tools" / "proxy-validator" / "export" / "live-for-host.txt"
OWN_FILE = ROOT / "routing" / "own-proxies.txt"
BRIDGE = ROOT / "routing" / "lib" / "proxy-for.js"
PROBE_URL = "https://www.threerouter.com/api/v1/settings/public"
# 🔴 Рега идёт ЧЕРЕЗ СКРАПЕРНЫЙ ЯРУС - так устроена вкладка: прокси-скрапер в неё
# встроен, кнопка «Найти прокси» наполняет `live-for-host.txt`. «Свои»
# (`routing/own-proxies.txt`) остаются опцией `TR_PROXY_ORDER=scraper,own`.
PROXY_ORDER = [t.strip().lower() for t in
               os.environ.get("TR_PROXY_ORDER", "scraper").split(",") if t.strip()]

BASE_LAUNCH = dict(
    headless=False, os="windows", window=(1400, 900),
    persistent_context=False,
    humanize=8.0, main_world_eval=True, i_know_what_im_doing=True,
    firefox_user_prefs={
        "widget.windows.window_occlusion_tracking.enabled": False,
        "dom.min_background_timeout_value": 4,
        "dom.timeout.enable_budget_timer_throttling": False,
        "media.suspend-bkgnd-video.enabled": False,
        "browser.tabs.unloadOnLowMemory": False,
    },
)


def provider_date():
    """Дата площадки: лимит «1 регистрация на IP в сутки» живёт по UTC+8."""
    return time.strftime("%Y-%m-%d", time.gmtime(time.time() + 8 * 3600))


def redact(label):
    """Метка прокси без кредов: `scheme://user:pass@host:port` → `scheme://host:port`.

    🔴 В `own-proxies.txt` логин и пароль стоят прямо в строке, и первая версия
    писала такой label в лог и в журнал как есть (живой прогон 22:50 - пароль
    уехал в stdout). Пул в Node держит креды ОТДЕЛЬНО от label именно поэтому.
    В журнал и логи кладём только адрес: по нему и различаем «этот адрес уже
    регистрировал сегодня».
    """
    return re.sub(r"(//)[^@/]+@", r"\1", str(label or ""))


def ledger_used():
    try:
        doc = json.loads(PROXY_LEDGER.read_text(encoding="utf-8"))
    except Exception:
        return set()
    if not isinstance(doc, dict) or doc.get("date") != provider_date():
        return set()
    return set(str(x) for x in (doc.get("used") or []))


def ledger_mark(label):
    if not label:
        return
    used = ledger_used()
    used.add(str(label))
    try:
        PROXY_LEDGER.write_text(
            json.dumps({"date": provider_date(), "used": sorted(used)},
                       ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8")
    except Exception as e:
        log("proxy", f"журнал не записался: {str(e)[:60]}")


async def bridge_call(args, timeout_s=600):
    """Мост пула (Node) - оставлен для будущих сценариев; в автореге не используется.

    Скраперный ярус проверяем curl'ом сами (см. probe_label): мост браковал живые
    адреса на TLS-туннеле, и рега через него не поднималась.
    """
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    proc = await asyncio.create_subprocess_exec(
        "node", str(BRIDGE), *args,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=env)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
    except asyncio.TimeoutError:
        proc.kill()
        raise RuntimeError(f"мост пула не ответил за {timeout_s} с")
    text = (out or b"").decode("utf-8", "replace")
    for line in reversed(text.splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except Exception:
                continue
    tail = (err or b"").decode("utf-8", "replace").strip().splitlines()[-2:]
    raise RuntimeError("мост пула вернул не JSON: " + " | ".join(tail)[:200])


def parse_proxy_line(line):
    m = re.match(r"^(?P<scheme>\w+)://(?:(?P<user>[^:@/]+):(?P<pass>[^@/]*)@)?"
                 r"(?P<host>[^:/]+):(?P<port>\d+)/?$", line)
    if not m:
        return None
    cfg = {"server": f"{m.group('scheme')}://{m.group('host')}:{m.group('port')}"}
    if m.group("user"):
        cfg["username"] = m.group("user")
        cfg["password"] = m.group("pass") or ""
    return cfg


def read_list(file):
    out = []
    try:
        raw = file.read_text(encoding="utf-8")
    except Exception:
        return out
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        cfg = parse_proxy_line(line)
        if cfg:
            out.append((line, cfg))
    return out


async def probe_label(label, url, timeout=12):
    """Жив ли адрес для панели - curl'ом.

    🔴 Проверяем ИМЕННО curl'ом, а не мостом пула. Замер 28.10: Node-туннель
    браковал живые адреса («Client network socket disconnected before secure TLS
    connection was established»), а curl через те же адреса отвечал 200. Firefox
    ходит через прокси той же природы, что curl, - проверка обязана совпадать
    с ходом браузера, иначе мы отбрасываем рабочее и берём мёртвое.
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            "curl", "-s", "-o", os.devnull, "-w", "%{http_code}",
            "--max-time", str(timeout), "--proxy", label, url,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout + 5)
        return (out or b"").decode().strip() == "200"
    except Exception:
        return False


async def probe_alive(cands, url, batch=6):
    """Живые адреса в порядке списка (свежие впереди), пачками по `batch`."""
    for i in range(0, len(cands), batch):
        chunk = cands[i:i + batch]
        res = await asyncio.gather(*(probe_label(lbl, url) for lbl, _ in chunk))
        alive = [c for c, ok in zip(chunk, res) if ok]
        if alive:
            return alive
    return []


async def acquire_proxy(tried=(), pin=None):
    """Прокси для панели. Возвращает (cfg, label).

    Ярус - `TR_PROXY_ORDER`, по умолчанию **только `scraper`**: на вкладке `tr`
    прокси-скрапер встроен (кнопка «Найти прокси» пишет
    `tools/proxy-validator/export/live-for-host.txt`), и рега идёт через него.
    Молча уйти напрямую нельзя: лимит площадки «1 регистрация на IP в сутки».
    """
    if pin:
        cfg = parse_proxy_line(pin)
        if not cfg:
            raise RuntimeError(f"прокси «{pin}» не разобран")
        return cfg, redact(pin)

    skip = ledger_used() | {redact(x) for x in tried}
    errors = []
    for tier in PROXY_ORDER:
        src = SCRAPER_FILE if tier == "scraper" else OWN_FILE
        cands = [(lbl, cfg) for lbl, cfg in read_list(src) if redact(lbl) not in skip]
        if not cands:
            errors.append(f"{tier}: список пуст или все адреса уже отработали сегодня")
            continue
        log("proxy", f"проверяю {tier}-список: {len(cands)} кандидатов (curl, пачками)")
        alive = await probe_alive(cands, PROBE_URL)
        if not alive:
            errors.append(f"{tier}: ни один адрес не ответил 200 на {PROBE_URL}")
            continue
        label, cfg = alive[0]
        ledger_mark(redact(label))
        log("proxy", f"✅ {redact(label)} · ярус {tier} · живых в пачке: {len(alive)}")
        return cfg, redact(label)

    raise RuntimeError("прокси нет: " + "; ".join(errors or ["пусто"]))


def page_of(browser):
    """Первая страница Camoufox. С `persistent_context=False` это Browser (нет `.pages`)."""
    if hasattr(browser, "pages"):
        pages = browser.pages or []
        return (pages[0] if pages else None), browser
    ctx = browser.contexts[0] if getattr(browser, "contexts", None) else None
    if ctx is None:
        return None, browser
    pages = ctx.pages or []
    return (pages[0] if pages else None), ctx


@asynccontextmanager
async def tr_browser_ctx(use_proxy, tried, pin=None):
    """Окно панели через прокси, с повтором на другом адресе.

    🔴 Прокси у Camoufox задаётся на ВЕСЬ браузер, поэтому почта и панель живут в
    разных окнах: smailpro за Cloudflare и чужие выходы там только хуже, а панели
    нужен отдельный IP - у неё лимит «1 регистрация на адрес в сутки».

    Повтор нужен потому, что preflight пула проверяет ОДИН лёгкий запрос, а полная
    SPA тянет десятки ресурсов и слабый адрес умирает на них (живой случай 25.10 в
    JS-автореге: `page.goto: Timeout 30000ms` на прокси, который preflight прошёл).
    """
    cm = None
    try:
        for attempt in range(1, 4):
            cfg, label = (None, "напрямую")
            if use_proxy:
                cfg, label = await acquire_proxy(tried, pin)
            launch = dict(BASE_LAUNCH)
            if cfg:
                launch["proxy"] = cfg
                # 🪤 Без geoip Camoufox предупреждает (LeakWarning), что пояс и локаль
                # останутся нашими при чужом IP, - а это ровно то расхождение, по
                # которому Cloudflare отличает бота. geoip - extras-зависимость,
                # поэтому включаем только если она стоит.
                try:
                    import importlib.util
                    if importlib.util.find_spec("geoip2"):
                        launch["geoip"] = True
                except Exception:
                    pass
            cm = AsyncCamoufox(**launch)
            try:
                browser = await cm.__aenter__()
            except Exception as e:
                # 🔴 geoip спрашивает публичный IP ЧЕРЕЗ ПРОКСИ (ipecho.net, таймаут 5 с)
                # и на медленном socks4 падает с InvalidIP - живой прогон 23:02.
                # Откатываемся на запуск без geoip: предупреждение о поясе лучше,
                # чем несостоявшийся прогон.
                if launch.pop("geoip", None):
                    log("proxy", f"geoip не поднялся ({str(e)[:70]}) - запускаю без него")
                    cm = AsyncCamoufox(**launch)
                    browser = await cm.__aenter__()
                else:
                    raise
            page, ctx = page_of(browser)
            if page is None:
                page = await ctx.new_page()
            try:
                await page.goto(REGISTER_URL, wait_until="domcontentloaded", timeout=45000)
            except Exception as e:
                net = re.search(r"Timeout|ERR_|net::|ECONN|socket|proxy", str(e), re.I)
                try:
                    await cm.__aexit__(None, None, None)
                except Exception:
                    pass
                cm = None
                if not (net and use_proxy and attempt < 3):
                    raise
                tried.append(label)
                log("proxy", f"страница не открылась через {label} - беру другой прокси")
                continue
            log("tr", f"панель открыта через {label}")
            yield page
            break
    finally:
        if cm is not None:
            try:
                await cm.__aexit__(None, None, None)
            except Exception:
                pass


async def run_account(n, use_proxy=True, proxy_pin=None):
    log("main", f"--- аккаунт {n} ---")
    password = rand_password()
    mail = None
    tried = []

    # Почта - СВОИМ окном и НАПРЯМУЮ: smailpro за Cloudflare, скраперный выход там
    # только ухудшает прохождение Turnstile. Панель поднимется отдельным окном ниже.
    async with AsyncCamoufox(**BASE_LAUNCH) as mail_browser:
        # ── 1. ГОЛАЯ страница smailpro: ящик создаётся сам ──
        stage("mail")
        # 🪤 С `persistent_context=False` Camoufox отдаёт Browser (нет `.pages`),
        # с `True` - BrowserContext. Разбор в page_of(): ошибка живого прогона 07:43
        # "'Browser' object has no attribute 'pages'" падала сразу после старта.
        mail, mail_ctx = page_of(mail_browser)
        if mail is None:
            mail = await mail_ctx.new_page()
        log("mail", "открываю smailpro (страница должна быть голой)…")
        await mail.goto("https://smailpro.com/temporary-email",
                        wait_until="domcontentloaded", timeout=60000)

        addr = None
        t0 = time.time()
        while time.time() - t0 < MAILBOX_WAIT_S:
            try:
                st = await mail.evaluate(MAILBOX_JS)
            except Exception as e:
                log("mail", f"страница: {str(e)[:70]}")
                await asyncio.sleep(3)
                continue
            if st.get("limitN", 0) >= 1 and st.get("addr"):
                addr = st["addr"]
                break
            await asyncio.sleep(3)
        if not addr:
            raise RuntimeError(f"smailpro не выдал ящик за {MAILBOX_WAIT_S} с")
        log("mail", f"✅ ящик: {addr} ({st.get('limit')})")

        # ── 2. payload для чтения писем ──
        got = await mail.evaluate(GET_PAYLOAD_JS, addr)
        if not got or got.get("error"):
            raise RuntimeError(f"payload не получен: {(got or {}).get('error')} {(got or {}).get('body', '')}")
        payload = got["payload"]
        # Тройку СПАСАЕМ в Python: она сама достаточна для /app/inbox (запросу нужен
        # только {address,timestamp,key}, страница не нужна). Если окно Camoufox
        # закрыли посреди прогона (владелец 30.10 02:57), mail_page() поднимет новое
        # и опрос почты продолжится по спасённой тройке - ящик пересоздавать не надо.
        saved_triple = {"address": got["address"], "timestamp": got["timestamp"], "key": got["key"]}
        kind = mail_kind(addr)
        log("mail", f"payload получен, тип ящика {kind}")

        # ── 3. панель: ОТДЕЛЬНОЕ окно ЧЕРЕЗ ПРОКСИ ──
        # Прокси у Camoufox на весь браузер, поэтому почта и панель - разные окна.
        # Адрес берём из общего пула через мост proxy-for.js (см. acquire_proxy).
        stage("register-form")
        async with tr_browser_ctx(use_proxy, tried, proxy_pin) as tr:
            await asyncio.sleep(1.5)

            # 🔴 СОГЛАСИЕ ПОДСЕВАЕМ, А НЕ ПРОКЛИКИВАЕМ. Текст страницы (замер 07:54):
            #   «Accept the latest terms before continuing. Account/password login and
            #    quick sign-in stay disabled until you accept.»
            # Пока согласие не дано, кнопка `Click to start verification` ОТКЛЮЧЕНА и
            # клик по ней ничего не делает - живой прогон дал `started: НЕТ`, модалка
            # при этом даже не показывалась (`agreed: не появилась`), потому что её
            # нет при живом заголовке Accept иначе, чем через localStorage-ключ.
            # Приём из рабочего threerouter/open-session.js: ключ согласия с ЖИВОЙ
            # ревизией + перезагрузка (без reload localStorage-запись SPA не подхватит).
            rev = await fetch_agreement_revision(tr)
            if rev:
                await tr.evaluate("""(a) => {
                    try {
                        localStorage.setItem(a.key, JSON.stringify({
                            revision: a.rev, accepted_at: new Date().toISOString(),
                        }));
                    } catch (e) {}
                }""", {"key": CONSENT_KEY, "rev": rev})
                log("tr", f"согласие подсеяно (ревизия {rev[:16]}…), перезагружаю")
                await tr.reload(wait_until="domcontentloaded")
                # Через прокси reload иногда приезжает не на ту страницу (обрыв,
                # редирект): тогда один повторный заход по прямому адресу.
                if "/register" not in (tr.url or ""):
                    log("tr", f"после reload мы на {tr.url!r} - открываю форму заново")
                    await tr.goto(REGISTER_URL, wait_until="domcontentloaded", timeout=45000)
                await asyncio.sleep(2.0)
            else:
                log("tr", "⚠️ ревизия соглашения не получена - жму кнопку вручную")

            # Клики - настоящими кликами Playwright, а не JS-.click(): см. click_exact_button().
            agreed = await click_exact_button(tr, AGREE_TEXTS)
            if agreed:
                log("tr", f"модалка условий была на экране - нажал «{agreed}»")

            # 🪤 Через медленный прокси SPA после reload отрисовывается дольше двух
            # секунд: живой прогон 23:01 получил `{'okEmail': False, 'okPass': False}`
            # на живом окне. Ждём появление полей и заполняем с повторами, а не
            # один раз «на глазок».
            filled = {}
            for attempt in range(1, 6):
                try:
                    await tr.wait_for_selector("#email, input[type='email']", timeout=20000)
                except Exception:
                    pass
                filled = await tr.evaluate(FILL_FORM_JS, {"email": addr, "password": password})
                if filled.get("okEmail") and filled.get("okPass"):
                    break
                log("tr", f"поля ещё не готовы (попытка {attempt}): {filled}")
                await asyncio.sleep(2.5)
            log("tr", f"форма: {filled}")
            if not filled.get("okEmail") or not filled.get("okPass"):
                raise RuntimeError("поля формы не заполнились")

            started = await click_exact_button(tr, START_TEXTS)
            log("tr", f"капча стартовала: {started or 'НЕТ - открой кнопкой сам'}")

            # ── 4. капча руками ──
            stage("captcha-manual")
            print("\n" + "=" * 70, flush=True)
            print("  ✋ РЕШИ КАПЧУ В ОКНЕ Camoufox (4 зелёных круга / ползунок).", flush=True)
            print(f"     email: {addr}", flush=True)
            print(f"  Пароль: {password}", flush=True)
            print("  Дальше скрипт продолжит сам.", flush=True)
            print("=" * 70 + "\n", flush=True)

            captcha_token = [None]

            def on_resp(res):
                u = res.url
                if "/auth/captcha/verify" not in u or captcha_token[0]:
                    return

                async def grab():
                    try:
                        data = unwrap(await res.json())
                        tok = (data or {}).get("captcha_token")
                        if tok:
                            captcha_token[0] = tok
                            log("captcha", f"токен получен: {tok[:10]}…")
                    except Exception:
                        pass
                asyncio.create_task(grab())

            tr.on("response", on_resp)

            t0 = time.time()
            while not captcha_token[0] and time.time() - t0 < CAPTCHA_WAIT_S:
                await asyncio.sleep(2)
            if not captcha_token[0]:
                raise RuntimeError("капча не решена за 10 минут")
            ctok = captcha_token[0]

            # ── 5. код на почту ──
            stage("send-code")
            st_code, resp = await tr_api(tr, "/auth/send-verify-code", "POST",
                                        {"email": addr, "click_captcha_token": ctok})
            log("tr", f"send-verify-code: {st_code} {str(resp)[:120]}")
            if st_code >= 400:
                raise RuntimeError(f"код не отправлен: {str(resp)[:160]}")

            stage("wait-mail")
            log("mail", f"жду письмо ThreeRouter на {addr} (до {OTP_WAIT_S} с)…")
            code = None
            seen = set()
            t0 = time.time()
            while time.time() - t0 < OTP_WAIT_S:
                # 🔴 payload ОБНОВЛЯЕМ перед каждым опросом.
                # Замер 28.10: свежий payload от api.sonjj.com отвечает 200, а
                # протухший - 403 БЕЗ CORS-заголовков, и Firefox показывает это как
                # `NetworkError when attempting to fetch resource` (живой прогон
                # 08:28:34 - три опроса подряд упали так). /app/inbox выдаёт новый
                # payload по тому же {address,timestamp,key} - берём его каждый раз.
                try:
                    fresh = await mail.evaluate(GET_PAYLOAD_JS, saved_triple)
                    if fresh and not fresh.get("error") and fresh.get("payload"):
                        payload = fresh["payload"]
                    box = await mail.evaluate(FETCH_INBOX_JS, {"payload": payload, "kind": kind})
                except Exception as e:
                    err = str(e)
                    log("mail", f"опрос: {err[:70]}")
                    # 🪤 Страница почты умерла НАВСЕГДА (владелец закрыл окно Camoufox
                    # посреди прогона 30.10: «Target page, context or browser has been
                    # closed») - sleep+continue здесь просто выжгут таймаут. Поднимаем
                    # новую страницу и продолжаем опрос по спасённой тройке: ящику
                    # перерождение не нужно, тройка уже у нас.
                    if re.search(r"closed|destroyed|Target page|Target closed", err, re.I):
                        try:
                            mail = await mail_ctx.new_page()
                            await mail.goto("https://smailpro.com/temporary-email",
                                            wait_until="domcontentloaded", timeout=60000)
                            log("mail", "страница почты пересоздана - продолжаю опрос")
                        except Exception as e2:
                            log("mail", f"пересоздание не удалось: {str(e2)[:70]}")
                    await asyncio.sleep(5)
                    continue
                for m in (box.get("msgs") or []):
                    mid = m.get("mid")
                    if not mid or mid in seen:
                        continue
                    seen.add(mid)
                    log("mail", f"письмо: from={m.get('from')!r} subj={m.get('subject')!r}")
                    # payload к этому моменту свежий: обновлён в начале итерации.
                    # Проверено живьём 28.10 (probe_body.py): inbox -> 200 с полями
                    # mid/textFrom/textSubject, message?mid= -> 200 с телом HTML,
                    # код из него извлекается (UAD9FE).
                    body = await mail.evaluate(FETCH_MESSAGE_JS,
                                               {"payload": payload, "kind": kind, "mid": mid})
                    c = extract_code(body.get("body") or body.get("raw") or "")
                    if c:
                        code = c
                        break
                if code:
                    break
                await asyncio.sleep(5)
            if not code:
                raise RuntimeError(f"код не пришёл за {OTP_WAIT_S} с (писем: {len(seen)})")
            log("mail", f"🎯 код: {code}")

            # ── 6. регистрация ──
            stage("register")
            st_reg, auth = await tr_api(tr, "/auth/register", "POST", {
                "email": addr, "password": password, "verify_code": code,
                "click_captcha_token": ctok, "aff_code": REF,
            })
            if st_reg >= 400 or not (auth or {}).get("access_token"):
                raise RuntimeError(f"регистрация: {st_reg} {str(auth)[:200]}")
            token = auth["access_token"]
            log("tr", f"аккаунт создан, userId={(auth.get('user') or {}).get('id')}")

            # ── 7. группа + ключ ──
            stage("key")
            st_g, groups = await tr_api(tr, "/groups/available", token=token)
            lst = groups if isinstance(groups, list) else []
            grp = (next((g for g in lst if re.search("default", g.get("name", ""), re.I)), None)
                   or next((g for g in lst if re.search("claude|anthropic", g.get("name", ""), re.I)), None)
                   or next((g for g in lst if g.get("status") == "active"), None)
                   or (lst[0] if lst else None))
            if not grp:
                raise RuntimeError("нет доступных групп")
            kn = key_name()
            st_k, key_rec = await tr_api(tr, "/keys", "POST", {"name": kn, "group_id": grp["id"]}, token=token)
            if st_k >= 400 or not (key_rec or {}).get("key"):
                raise RuntimeError(f"ключ: {st_k} {str(key_rec)[:160]}")
            if key_rec.get("group_id") is None:
                raise RuntimeError("ключ создан без group_id - он мёртв")
            log("tr", f"ключ {key_rec['key'][:6]}…{key_rec['key'][-4:]} (группа {grp['name']})")

            # ── 8. снимок сессии для кнопки 🌐 ──
            #
            # 🔴 Снимок ОБЯЗАН дойти до диска: кнопка 🌐 на вкладке ищет файл
            # `threerouter/sessions/acct_<id>.json` (`handleTrSessionOpen` →
            # `open-session.js`), и без него вход восстанавливается по пустому
            # профилю - владелец видел форму входа при живом аккаунте.
            # Имена ключей localStorage - как у SPA: `auth_token`, не `access_token`
            # (замер 23.10 в open-session.js), снимок с `access_token` открывает форму.
            stage("snapshot")
            rec_id = f"tr_sp_{int(time.time() * 1000)}_{n}"
            try:
                SESS_DIR.mkdir(parents=True, exist_ok=True)
                await tr.goto(ORIGIN + "/dashboard", wait_until="domcontentloaded")
            except Exception:
                pass
            try:
                await tr.evaluate("""(a) => {
                    try {
                        localStorage.setItem('auth_token', a.tok);
                        if (a.ref) localStorage.setItem('refresh_token', a.ref);
                        localStorage.setItem('token_expires_at', String(a.exp));
                        localStorage.setItem('auth_user', JSON.stringify(a.user || {}));
                    } catch (e) {}
                }""", {
                    "tok": token,
                    "ref": auth.get("refresh_token") or "",
                    "exp": int(time.time() * 1000) + int(auth.get("expires_in") or 86400) * 1000,
                    "user": auth.get("user") or {},
                })
            except Exception as e:
                log("tr", f"снимок localStorage: {str(e)[:80]}")
            snap_file = SESS_DIR / f"acct_{rec_id}.json"
            try:
                state = await tr.context.storage_state()
                snap_file.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
                log("tr", f"снимок сессии: {snap_file.name}")
            except Exception as e:
                log("tr", f"⚠️ снимок не записан: {str(e)[:90]} - вход будет по email+паролю")

            user = auth.get("user") or {}
            rec = {
                "id": rec_id,   # тот же id, что в имени снимка: 🌐 ищет файл по нему
                "email": addr,
                "name": addr.split("@")[0],
                "password": password,
                "api_key": key_rec["key"],
                "active": False,
                "status": "live",
                "created": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "userId": user.get("id"),
                "keyId": key_rec.get("id"),
                "keyName": kn,
                "groupId": grp["id"],
                "groupName": grp["name"],
                "autoAdded": True,
                "balance": user.get("balance"),
                "balanceSource": "key",
                "userAgent": UA,
                "mailProvider": addr.split("@")[-1],
                "mailService": "smailpro",
                "refCode": REF,
            }
            pool_append(rec)
            print("SP_AUTOADD_RESULT " + json.dumps(
                {"ok": True, "id": rec["id"], "email": addr, "group": grp["name"],
                 "key": key_rec["key"][:6] + "…"}, ensure_ascii=False), flush=True)
            return rec


async def main():
    args = sys.argv[1:]
    count = 1
    use_proxy = True
    proxy_pin = None
    for a in args:
        if a == "--no-proxy":
            use_proxy = False
        elif a.startswith("--proxy="):
            proxy_pin = a.split("=", 1)[1]
        elif a.isdigit():
            count = int(a)

    pid_write()
    log("main", f"аккаунтов: {count} · реф {REF} · почта smailpro ·"
                f" прокси {proxy_pin or ('скрапер: '+','.join(PROXY_ORDER) if use_proxy else 'напрямую')}")

    ok = 0
    try:
        for i in range(count):
            try:
                await run_account(i + 1, use_proxy, proxy_pin)
                ok += 1
            except Exception as e:
                log("main", f"❌ аккаунт {i + 1}: {e}")
                print("SP_AUTOADD_RESULT " + json.dumps(
                    {"ok": False, "n": i + 1, "error": str(e)[:200]}, ensure_ascii=False), flush=True)
                traceback.print_exc()
    finally:
        # PID снимаем всегда: и по нормальному выходу, и по Ctrl+C, и по «Стоп» с вкладки.
        pid_clear()
    log("main", f"готово: {ok}/{count}")
    return 0 if ok == count else 2


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
