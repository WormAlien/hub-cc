"""smailpro/probe_sonjj.py - весь конвейер почты smailpro БЕЗ модалки и 2-го Turnstile.

Контракт вычитан из кода страницы (smailpro/recordings/sm-page.html):

  POST /app/inbox  [{address, timestamp, key}]        -> [{..., payload: JWT}]
  GET  api.sonjj.com/v1/temp_gmail/inbox?payload=...  -> список писем (есть mid)
  GET  api.sonjj.com/v1/temp_gmail/message?payload=...-> тело письма

Для Gmail - `temp_gmail`, для Outlook - `temp_outlook`, иначе `temp_email`.
Модалка в UI не нужна: она лишь дёргает те же ручки и падает на втором Turnstile.

Проба: создаёт ящик (страница делает это сама), берёт key/timestamp из
localStorage, гоняет цепочку и печатает что ответило. Если есть письма -
пытается достать тело и вытащить код ThreeRouter (6 символов A-Z0-9).

Запуск: python smailpro/probe_sonjj.py [секунды]
Выход: smailpro/recordings/probe-sonjj.json
"""
import asyncio, json, re, sys, time
from pathlib import Path

from camoufox import AsyncCamoufox

URL = "https://smailpro.com/temporary-email"
OUT = Path(__file__).parent / "recordings"
WAIT = int(sys.argv[1]) if len(sys.argv) > 1 else 90
PROFILE = OUT / "probe-sonjj-profile"
PROFILE.mkdir(parents=True, exist_ok=True)

MAILBOX_JS = """() => {
  const r = document.querySelector('input[name="limitEmail"]');
  const a = r ? String(r.value || '') : '';
  const t = document.body ? document.body.innerText : '';
  const lim = t.match(/Limit\\s*(\\d+)\\s*\\/\\s*(\\d+)/i);
  return { addr: /@(gmail|outlook|googlemail)\\.com$/i.test(a) ? a : null,
           limit: lim ? lim[0] : null, limitN: lim ? parseInt(lim[1],10) : 0 };
}"""

CHAIN_JS = """async (hintAddr) => {
  const out = { steps: [], lsKeys: [] };
  const j = async (r) => { const t = await r.text(); let p = null;
    try { p = JSON.parse(t); } catch (e) {}
    return { status: r.status, text: t.slice(0, 900), json: p }; };

  // 1. Ящики из localStorage: emailManager хранит {address, timestamp, key}
  let emails = [], fromKey = null;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    out.lsKeys.push(k);
    try {
      const v = JSON.parse(localStorage.getItem(k));
      const arr = Array.isArray(v) ? v : (v && (v.emails || v.items)) || null;
      if (Array.isArray(arr) && arr.length && arr[0] && arr[0].address && arr[0].key) {
        emails = arr; fromKey = k; break;
      }
    } catch (e) {}
  }
  out.emailsFrom = fromKey;
  out.emails = emails.map(e => ({ address: e.address, hasKey: !!e.key, ts: e.timestamp }));

  // 2. POST /app/inbox -> payload
  const body = emails.filter(e => e.key && e.address)
    .map(e => ({ address: e.address, timestamp: e.timestamp, key: e.key }));
  if (!body.length && hintAddr) out.note = 'нет ящиков с key в localStorage';
  let payload = null, addr = body[0] ? body[0].address : (hintAddr || null);
  if (body.length) {
    const r = await j(await fetch('/app/inbox', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
    out.steps.push({ step: 'app/inbox', status: r.status, text: r.text.slice(0, 300) });
    const arr = Array.isArray(r.json) ? r.json : [];
    const f = arr.find(x => x && x.address === addr) || arr[0];
    if (f) payload = f.payload || null;
  }
  out.payload = payload ? String(payload).slice(0, 24) + '…' : null;
  if (!payload) return out;

  // 3. Список писем с api.sonjj.com (БЕЗ captcha)
  const isG = /@(gmail|googlemail)\\.com$/i.test(addr || '');
  const isO = /@(outlook|hotmail|live)\\./i.test(addr || '');
  const kind = isG ? 'temp_gmail' : (isO ? 'temp_outlook' : 'temp_email');
  out.kind = kind;
  const base = 'https://api.sonjj.com/v1/' + kind;
  const inbox = await j(await fetch(base + '/inbox?payload=' + encodeURIComponent(payload)));
  out.steps.push({ step: 'sonjj/inbox', status: inbox.status, text: inbox.text.slice(0, 600) });
  out.inboxJson = inbox.json;

  // 4. Тело первого письма
  let msgs = [];
  if (Array.isArray(inbox.json)) msgs = inbox.json;
  else if (inbox.json && Array.isArray(inbox.json.data)) msgs = inbox.json.data;
  else if (inbox.json && Array.isArray(inbox.json.messages)) msgs = inbox.json.messages;
  out.msgCount = msgs.length;
  if (msgs.length) {
    const m = msgs[0];
    out.msgKeys = Object.keys(m || {});
    const mid = m.mid || m.id || m.message_id || null;
    out.mid = mid;
    if (mid) {
      const q = '?payload=' + encodeURIComponent(payload) + '&mid=' + encodeURIComponent(mid);
      const msg = await j(await fetch(base + '/message' + q));
      out.steps.push({ step: 'sonjj/message', status: msg.status, text: msg.text.slice(0, 900) });
      out.messageJson = msg.json;
      out.messageText = msg.text;
    }
  }
  return out;
}"""

STOP = {"PLEASE", "VERIFY", "EMAILS", "EMAIL", "SECURE", "THANKS", "NOTICE", "ACCESS",
        "WELCOME", "ACCOUNT", "ROUTER", "THREE", "GMAIL", "HTTPS", "SIGNIN", "LOGINS",
        "SHARED", "SUPPORT", "PRIVACY", "POLICY", "TERMS", "CODE", "OTP"}


def extract_code(text):
    s = str(text or "")
    for line in s.splitlines():
        m = re.match(r"^\s*([A-Z0-9]{6})\s*$", line.replace("\\n", "\n"))
        if m and m.group(1).upper() not in STOP:
            return m.group(1).upper()
    flat = re.sub(r"\s+", " ", s)
    near = re.search(r"(?:code|код|otp|pin)[^A-Za-z0-9]{0,20}([A-Z0-9]{6})(?![A-Za-z0-9])", flat, re.I)
    if near and near.group(1).upper() not in STOP:
        return near.group(1).upper()
    for m in re.finditer(r"(?<![A-Za-z0-9])([A-Z0-9]{6})(?![A-Za-z0-9])", flat):
        t = m.group(1).upper()
        if t not in STOP and re.search(r"\d", t):
            return t
    return None


def log(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)


async def main():
    log(f"probe sonjj, wait={WAIT}s")
    result = {}
    try:
        async with AsyncCamoufox(
            headless=False, os="windows", window=(1280, 800),
            persistent_context=True, user_data_dir=str(PROFILE),
            disable_coop=True, humanize=10.0,
            main_world_eval=True, i_know_what_im_doing=True,
        ) as ctx:
            page = ctx.pages[0] if ctx.pages else await ctx.new_page()
            await page.goto(URL, wait_until="domcontentloaded", timeout=60000)
            log("loaded, ждём ящик…")
            t0 = time.time()
            addr = None
            while time.time() - t0 < WAIT:
                try:
                    st = await page.evaluate(MAILBOX_JS)
                except Exception as e:
                    log(f"err {str(e)[:60]}")
                    break
                if st.get("limitN", 0) >= 1 and st.get("addr"):
                    addr = st["addr"]
                    log(f"✅ ящик {addr} ({st['limit']})")
                    break
                await asyncio.sleep(3)
            if not addr:
                log("❌ ящика нет")
                return
            result["mailbox"] = addr

            log("гоню цепочку: /app/inbox -> sonjj/inbox -> sonjj/message")
            res = await page.evaluate(CHAIN_JS, addr)
            result.update(res or {})
            for s in (res or {}).get("steps", []):
                log(f"  {s.get('step')}: {s.get('status')} {str(s.get('text'))[:200]}")
            log(f"  localStorage: {res.get('lsKeys')}")
            log(f"  emailsFrom={res.get('emailsFrom')} emails={res.get('emails')}")
            log(f"  payload={'есть' if res.get('payload') else 'НЕТ'} kind={res.get('kind')}")
            log(f"  писем: {res.get('msgCount')} mid={res.get('mid')} поля={res.get('msgKeys')}")
            if res.get("messageText"):
                code = extract_code(res["messageText"])
                result["code"] = code
                log(f"  🎯 КОД: {code}" if code else "  код не распознан")
    except Exception as e:
        result["error"] = str(e)[:300]
        log(f"FATAL: {result['error']}")

    (OUT / "probe-sonjj.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    log("dump -> probe-sonjj.json")


asyncio.run(main())
