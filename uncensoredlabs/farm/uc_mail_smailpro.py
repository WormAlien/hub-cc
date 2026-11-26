"""Ящик smailpro с РЕАЛЬНЫМ @gmail.com — для автореги UncensoredLabs.

Зачем: UC не даёт trial $0.10 на произвольный домен. `POST
/api/account/trial/verify-email` отвечает 400 «Use an email from a supported
provider, such as Gmail, Outlook, Proton Mail, Yandex, or Tuta». Наши ящики на
`euploading.com` (mail.tm) в этот список не входят, поэтому claim не проходил.

smailpro выдаёт настоящие `@gmail.com` (замер 28.10: ящик за ~26 с). В
`THREEROUTER-ПОЧТОВЫЙ-ВАЙТЛИСТ.md` gmail стоит основным доменом панели.

Цепочка взята из `smailpro/auto-add.py` (1395 строк) и урезана до почты:
  1. голая страница smailpro.com/temporary-email
  2. Turnstile-чекбокс прожать мышью по координатам CF-кадра
  3. SPA сама дёргает `/app/create` и подставляет адрес в `input[name=limitEmail]`
  4. {address,timestamp,key} из IndexedDB `EmailDatabase` -> POST /app/inbox -> payload
  5. GET api.sonjj.com/v1/<kind>/inbox?payload=...            -> список писем
     GET api.sonjj.com/v1/<kind>/message?payload=...&mid=...  -> тело письма

🪤 Ловушки, каждая стоила времени в auto-add.py:
  • судить по `input[name=cf-turnstile-response]` нельзя — он пуст и при
    пройденной проверке; правду говорит только `input[name=limitEmail].value`;
  • координаты чекбокса брать у кадра (`frame_element().bounding_box()`), а не
    в главном документе: `document.querySelectorAll('iframe')` его не видит;
  • кадр в `page.frames` появляется РАНЬШЕ готовности — ранний клик по пустому
    прямоугольнику Turnstile проглатывает молча;
  • страница должна загружаться ГОЛОЙ: посторонние обработчики до загрузки
    ломают Turnstile и ящик не создаётся вовсе;
  • `post_data`, а не `postdata` — во всех листенерах.
"""
import html
import json
import os
import re
import time
from typing import Any
from urllib.parse import urlsplit

from camoufox.sync_api import Camoufox

SMAILPRO = "https://smailpro.com/temporary-email"

MAILBOX_JS = """() => {
  const r = document.querySelector('input[name="limitEmail"]');
  const a = r ? String(r.value || '') : '';
  const t = document.body ? document.body.innerText : '';
  const lim = t.match(/Limit\\s*(\\d+)\\s*\\/\\s*(\\d+)/i);
  return { addr: /@(gmail|outlook|googlemail)\\.com$/i.test(a) ? a : null,
           raw: a,
           limit: lim ? lim[0] : null, limitN: lim ? parseInt(lim[1], 10) : 0 };
}"""

GET_PAYLOAD_JS = """async (arg) => {
  let mine = null;
  if (arg && typeof arg === 'object' && arg.address) {
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

  const r = await fetch('https://smailpro.com/app/inbox', {
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


def mail_kind(addr):
    a = (addr or "").lower()
    if a.endswith("@gmail.com") or a.endswith("@googlemail.com"):
        return "temp_gmail"
    if re.search(r"@(outlook|hotmail|live)\.", a):
        return "temp_outlook"
    return "temp_email"


def log(*a):
    print(f"[{time.strftime('%H:%M:%S')}]", *a, flush=True)


def frame_geo(pg, min_w=60, min_h=20):
    """Готовый к клику CF-кадр. Ждём не «кадр в списке», а видимый прямоугольник
    нужного размера: уменьшенный кадр — ещё не готов и глотает клик молча."""
    for f in pg.frames:
        if "challenges.cloudflare" not in (f.url or ""):
            continue
        try:
            el = f.frame_element()
            bb = el.bounding_box()
        except Exception:
            continue
        if not bb or bb.get("width", 0) < min_w or bb.get("height", 0) < min_h:
            continue
        return bb
    return None


def click_turnstile(pg, bb):
    """Прожать чекбокс настоящей мышью. Оранжевый квадрат ~30 px от края кадра."""
    try:
        x = bb["x"] + 30
        y = bb["y"] + bb["height"] / 2
        # Короткий подвод: с `humanize=10` каждый шаг mouse.move начисляет
        # задержку, и подвод в 37 шагов стоил ~7 с (живой замер 25.11).
        pg.mouse.move(x - 140, y - 70, steps=2)
        time.sleep(0.1)
        pg.mouse.move(x, y, steps=3)
        time.sleep(0.12)
        pg.mouse.click(x, y)
        return True
    except Exception as e:
        log("чекбокс CF:", str(e)[:70])
        return False


class SmailproBox:
    """Ящик smailpro. Держит страницу, payload и тройку для повторных запросов."""

    def __init__(self, proxy=None, profile=None, wait_s=180, headless=False):
        kw: dict = dict(headless=headless, humanize=10.0, os="windows",
                        geoip=bool(proxy), locale="en-US", disable_coop=True,
                        main_world_eval=True, i_know_what_im_doing=True,
                        window=(1280, 1000))
        if profile:
            kw.update(persistent_context=True, user_data_dir=profile)
        if proxy:
            kw["proxy"] = {"server": proxy}
        self._kw = kw
        self.wait_s = wait_s
        self.cam: Any = None
        self.pg: Any = None
        self.addr = None
        self.payload = None
        self.triple = None
        self.kind = None
        self.clicks = 0

    def __enter__(self):
        self.cam = Camoufox(**self._kw)
        try:
            b = self.cam.__enter__()
        except Exception as e:
            # 🪤 `geoip=True` тянет публичный IP через прокси (ipecho.net) и
            # валится с InvalidIP, если тот не отвечает: «Failed to get IP
            # address». Геолокация тут не нужна — без неё страница открывается,
            # а с ней падает весь ящик. Откатываемся и пробуем снова.
            msg = str(e)
            try:
                self.cam.__exit__(None, None, None)
            except Exception:
                pass
            if "geoip" not in self._kw or "IP address" not in msg:
                raise
            log("smailpro: geoip не поднялся, повтор без него:", msg[:80])
            self._kw["geoip"] = False
            self.cam = Camoufox(**self._kw)
            b = self.cam.__enter__()
        pages = getattr(b, "pages", None)
        self.pg = pages[0] if pages else b.new_page()
        self.pg.set_default_timeout(30000)
        return self

    def __exit__(self, *a):
        try:
            self.cam.__exit__(*a)
        except Exception:
            pass
        return False

    # ── создать ящик ────────────────────────────────────────────────────
    def open(self):
        log("smailpro: открываю голую страницу…")
        self.pg.goto(SMAILPRO, wait_until="domcontentloaded", timeout=60000)
        t0 = time.time()
        pending_at = None
        st = {}
        while time.time() - t0 < self.wait_s:
            try:
                st = self.pg.evaluate(MAILBOX_JS)
            except Exception as e:
                log("smailpro: страница", str(e)[:60])
                time.sleep(1.5)
                continue
            # Адрес есть — ящик создан. Кнопку «Create» жать НЕ нужно.
            if st.get("addr"):
                self.addr = st["addr"]
                break
            # Виджет отрисован и готов: ждём подтверждения на втором опросе
            # (~0.4 с), иначе ранний клик проглатывается.
            bb = frame_geo(self.pg)
            if bb is not None:
                if pending_at is None:
                    pending_at = time.time()
                elif time.time() - pending_at >= 0.4 and self.clicks < 6:
                    if click_turnstile(self.pg, bb):
                        self.clicks += 1
                        log(f"smailpro: чекбокс CF прожат (попытка {self.clicks}, "
                            f"{bb['width']:.0f}x{bb['height']:.0f}, {time.time()-t0:.1f} с)")
                        pending_at = None
                        time.sleep(2.5)
                        continue
            time.sleep(0.4)

        if not self.addr:
            raise RuntimeError(f"smailpro не выдал ящик за {self.wait_s} с "
                               f"(кликов CF: {self.clicks}); "
                               f"поле = {st.get('raw')!r}")
        self.kind = mail_kind(self.addr)
        log(f"smailpro: ящик {self.addr} ({st.get('limit')}) · "
            f"{time.time()-t0:.0f} с · кликов CF: {self.clicks}")

        got = self.pg.evaluate(GET_PAYLOAD_JS, self.addr)
        if not got or got.get("error"):
            raise RuntimeError(f"payload не получен: {(got or {}).get('error')} "
                               f"{(got or {}).get('body', '')}")
        self.payload = got["payload"]
        self.triple = {"address": got["address"], "timestamp": got["timestamp"],
                       "key": got["key"]}
        log(f"smailpro: payload получен, тип {self.kind}")
        return self.addr

    # ── переполучить payload (страницу могли закрыть) ───────────────────
    def refresh_payload(self):
        self.payload = None
        if not self.triple:
            raise RuntimeError("нет тройки {address,timestamp,key}")
        # 🪤 fetch к /app/inbox должен уходить С страницы smailpro: после
        # создания ящика SPA уводит документ на /app/..., и оттуда запрос
        # получает чужой origin. Замер 25.11: в отдельной пробе чтение
        # работало только после явного возврата на /temporary-email.
        try:
            if "smailpro.com/temporary-email" not in (self.pg.url or ""):
                self.pg.goto(SMAILPRO, wait_until="domcontentloaded", timeout=60000)
                time.sleep(2)
        except Exception as e:
            log("smailpro: возврат на страницу для чтения:", str(e)[:60])
        got = self.pg.evaluate(GET_PAYLOAD_JS, self.triple)
        if not got or got.get("error") or not got.get("payload"):
            raise RuntimeError("smailpro payload refresh failed (status=%s)" %
                               (got or {}).get("status"))
        self.payload = got["payload"]
        return self.payload

    # ── письма ──────────────────────────────────────────────────────────
    def inbox(self):
        # Payloads expire while UC is still loading/signup is in progress.
        # Renew from the saved mailbox triple, as smailpro/auto-add.py does.
        self.refresh_payload()
        result = self.pg.evaluate(FETCH_INBOX_JS,
                                  {"payload": self.payload, "kind": self.kind})
        status = (result or {}).get("status")
        if not isinstance(status, int) or not 200 <= status < 300:
            raise RuntimeError("smailpro inbox HTTP %s" % status)
        return result

    def message(self, mid):
        self.refresh_payload()
        result = self.pg.evaluate(FETCH_MESSAGE_JS,
                                  {"payload": self.payload, "kind": self.kind, "mid": mid})
        status = (result or {}).get("status")
        if not isinstance(status, int) or not 200 <= status < 300:
            raise RuntimeError("smailpro message HTTP %s" % status)
        return result

    def wait_link(self, deadline=240, want_host="uncensoredlabs",
                  want=("verify", "confirm", "uncensored", "trial")):
        """Ссылка из письма. Возвращает URL или ''."""
        expected_host = "uncensoredlabs.dev" if want_host == "uncensoredlabs" else want_host
        t0 = time.time()
        seen = set()
        while time.time() - t0 < deadline:
            time.sleep(6)
            try:
                box = self.inbox()
            except Exception as e:
                log("  wait_link: inbox EXC:", str(e)[:80])
                continue
            if not (box.get("msgs") or []):
                log("  wait_link: inbox пуст (t+%dс)" % int(time.time() - t0))
            for m in box.get("msgs") or []:
                mid = m.get("mid")
                if not mid or mid in seen:
                    continue
                subj = (m.get("subject") or "")[:60]
                try:
                    body = (self.message(mid) or {}).get("body") or ""
                except Exception as e:
                    # 🪤 Прогон 26.11 01:30: письмо с темой 'Verify your email
                    # address' лежало (скриншот владельца), но wait_link молча
                    # вернул пусто. Причина была невидима: message() падал и
                    # письмо пропускалось через continue. Логируем ЖЁСТКО —
                    # это не «нет письма», это «не смогли прочитать письмо».
                    log("  wait_link: message EXC " + subj[:40] + ": " + str(e)[:90])
                    continue
                if not body:
                    continue
                seen.add(mid)
                # Read URLs before removing markup: verification buttons keep
                # their destination in href, not necessarily in visible text.
                flat = html.unescape(body)
                links = re.findall(r"https?://[^\s\"'<>)\]]+", flat)
                for l in links:
                    try:
                        hostname = urlsplit(l).hostname
                    except ValueError:
                        continue
                    if hostname == expected_host:
                        log(f"  письмо: {subj}")
                        return l.rstrip(".,;")
                if any(w in subj.lower() for w in want):
                    log("  письмо без UC-ссылки: " + subj +
                        " (len=" + str(len(body)) + ", links=" + str(len(links)) + ")")
        return ""

    def wait_code(self, deadline=240, length=6):
        """Код подтверждения из письма. Возвращает строку или ''."""
        t0 = time.time()
        seen = set()
        while time.time() - t0 < deadline:
            time.sleep(6)
            try:
                box = self.inbox()
            except Exception:
                continue
            for m in box.get("msgs") or []:
                mid = m.get("mid")
                if not mid or mid in seen:
                    continue
                try:
                    body = (self.message(mid) or {}).get("body") or ""
                except Exception:
                    continue
                if not body:
                    continue
                seen.add(mid)
                code = extract_code(body, length)
                if code:
                    log("  код из письма получен")
                    return code
        return ""


def extract_code(text, length=6):
    """Код из письма: `length` символов A-Z0-9, мимо слов-стопперов."""
    s = str(text or "")
    plain = re.sub(r"<[^>]+>", " ", s)
    for line in plain.splitlines():
        m = re.match(r"^\s*([A-Z0-9]{%d})\s*$" % length, line.strip())
        if m and m.group(1).upper() not in STOP:
            return m.group(1).upper()
    flat = re.sub(r"\s+", " ", plain)
    near = re.search(r"(?:verification\s*code|verify\s*code|\bcode\b|код|otp|pin)"
                     r"[^A-Za-z0-9]{0,24}([A-Z0-9]{%d})(?![A-Za-z0-9])" % length, flat, re.I)
    if near and near.group(1).upper() not in STOP:
        return near.group(1).upper()
    for m in re.finditer(r"(?<![A-Za-z0-9])([A-Z0-9]{%d})(?![A-Za-z0-9])" % length, flat):
        t = m.group(1).upper()
        if t not in STOP and re.search(r"\d", t):
            return t
    return None


STOP = {"PLEASE", "VERIFY", "EMAILS", "EMAIL", "SECURE", "THANKS", "NOTICE", "ACCESS",
        "WELCOME", "ACCOUNT", "ROUTER", "THREE", "GMAIL", "HTTPS", "SIGNIN", "LOGINS",
        "SHARED", "SUPPORT", "PRIVACY", "POLICY", "TERMS", "CODE", "OTP",
        "UNCENSORED", "LABS", "TRIAL"}


if __name__ == "__main__":
    import sys

    # ── режим сервера: ящик в СВОЁМ процессе ────────────────────────────
    # 🪤 Два sync-браузера Camoufox в одном процессе невозможны: Playwright
    # Sync API падает с «It looks like you are using Playwright Sync API inside
    # the asyncio loop» на втором `with Camoufox(...)`. Ящик и UC-страница
    # должны жить вместе, поэтому ящик вынесен в отдельный процесс, а
    # вызывающий говорит с ним построчно: JSON в stdin -> JSON в stdout.
    #
    # Команды:
    #   {"cmd":"open"}                     -> {"ok":true,"addr":...,"kind":...,"triple":...}
    #   {"cmd":"link","deadline":240}      -> {"ok":true,"link":"https://..."}
    #   {"cmd":"code","deadline":240}      -> {"ok":true,"code":"ABC123"}
    #   {"cmd":"inbox"}                    -> {"ok":true,"count":N,...}
    #   {"cmd":"quit"}                     -> выход
    if len(sys.argv) > 1 and sys.argv[1] == "--serve":
        import sys as _s

        proxy = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] != "-" else None
        HERE = os.path.dirname(os.path.abspath(__file__))
        box = SmailproBox(proxy=proxy,
                          profile=os.path.join(HERE, "prof_mail_srv_" + str(int(time.time()))[-6:]),
                          wait_s=180)
        try:
            box.__enter__()
            print(json.dumps({"ok": True, "ready": True}), flush=True)
            for line in _s.stdin:
                line = line.strip()
                if not line:
                    continue
                try:
                    req = json.loads(line)
                except Exception:
                    print(json.dumps({"ok": False, "error": "bad json"}), flush=True)
                    continue
                cmd = req.get("cmd")
                if cmd == "quit":
                    print(json.dumps({"ok": True, "bye": True}), flush=True)
                    break
                try:
                    if cmd == "open":
                        addr = box.open()
                        # 🪤 Сохраняем тройку на диск: если прогон фермы упадёт
                        # позже, ящик останется читаемым для добивания вручную
                        # (adopt по тройке не требует живого процесса).
                        try:
                            json.dump({"addr": addr, "kind": box.kind,
                                       "triple": box.triple},
                                      open(os.path.join(HERE, "smailpro_box.json"),
                                           "w", encoding="utf-8"),
                                      ensure_ascii=False, indent=1)
                        except Exception:
                            pass
                        out = {"ok": True, "addr": addr, "kind": box.kind,
                               "triple": box.triple}
                    elif cmd == "adopt":
                        # Готовая тройка: ящик уже создан, повторно не создаём.
                        # Нужно для добивания прогона, когда письмо пришло
                        # позже, чем закончилось ожидание.
                        box.triple = req.get("triple") or {}
                        box.kind = req.get("kind") or "temp_gmail"
                        box.addr = box.triple.get("address")
                        box.payload = None
                        box.refresh_payload()
                        out = {"ok": bool(box.payload), "addr": box.addr}
                    elif cmd == "link":
                        link = box.wait_link(deadline=int(req.get("deadline", 240)))
                        out = {"ok": bool(link), "link": link}
                    elif cmd == "code":
                        code = box.wait_code(deadline=int(req.get("deadline", 240)))
                        out = {"ok": bool(code), "code": code}
                    elif cmd == "msg":
                        # тело одного письма: нужно для диагностики формата
                        # ссылок активации (замер 26.11: 'Account activation',
                        # и wait_link не находил в нём ссылку на UC)
                        b = box.message(req.get("mid")) if hasattr(box, "message") else {}
                        out = {"ok": True, "body": (b or {}).get("body", "")}
                    elif cmd == "inbox":
                        got = box.inbox()
                        out = {"ok": True, "count": got.get("count"),
                               "msgs": got.get("msgs")}
                    else:
                        out = {"ok": False, "error": "unknown cmd " + str(cmd)}
                except Exception as e:
                    out = {"ok": False, "error": str(e)[:200]}
                print(json.dumps(out, ensure_ascii=False), flush=True)
        finally:
            try:
                box.__exit__(None, None, None)
            except Exception:
                pass
        raise SystemExit(0)

    proxy = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] != "-" else None
    HERE = os.path.dirname(os.path.abspath(__file__))
    prof = os.path.join(HERE, "prof_mail_" + str(int(time.time()))[-6:])
    t0 = time.time()
    with SmailproBox(proxy=proxy, profile=prof) as box:
        addr = box.open()
        print(f"\nЯЩИК: {addr}")
        print(f"тип:  {box.kind}")
        print(f"время: {time.time()-t0:.0f} с")
        json.dump({"addr": addr, "kind": box.kind, "triple": box.triple,
                   "payload": box.payload},
                  open(os.path.join(HERE, "smailpro_box.json"), "w", encoding="utf-8"),
                  ensure_ascii=False, indent=1)
        print("сохранено: smailpro_box.json")
