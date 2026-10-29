"""smailpro/probe_chain.py - ПОЛНАЯ цепочка почты: ящик -> payload -> письма -> код.

Все звенья теперь известны (замеры 28.10, не догадки):

  1. ящик создаётся сам на голой странице (26 с; probe_create.py)
  2. `{address, timestamp, key}` лежит в IndexedDB `EmailDatabase` -> стор `emails`
     (probe_store.py: `{"address","timestamp","expired_at","key"}`)
  3. POST /app/inbox `[{address,timestamp,key}]` -> `payload` (JWT)
     (тело поймано probe_requests.py, массив; ответ содержит `payload`)
  4. GET api.sonjj.com/v1/temp_gmail/inbox?payload=...   -> список писем
     GET api.sonjj.com/v1/temp_gmail/message?payload=... -> тело письма
     (карта URL вычитана из страницы: sm-page.html, `urls` в `inbox()`/`message()`)
  5. код ThreeRouter - 6 символов A-Z0-9

Turnstile нужен ТОЛЬКО на `/app/create` и `/app/message`; шаги 3-4 идут без него,
поэтому модалка с "Verification failed" больше не мешает.

Запуск: python smailpro/probe_chain.py [секунды]
Выход: smailpro/recordings/probe-chain.json
"""
import asyncio, json, re, sys, time
from pathlib import Path

from camoufox import AsyncCamoufox

URL = "https://smailpro.com/temporary-email"
OUT = Path(__file__).parent / "recordings"
WAIT = int(sys.argv[1]) if len(sys.argv) > 1 else 90
PROFILE = OUT / "probe-chain-profile"
PROFILE.mkdir(parents=True, exist_ok=True)

MAILBOX_JS = """() => {
  const r = document.querySelector('input[name="limitEmail"]');
  const a = r ? String(r.value || '') : '';
  const t = document.body ? document.body.innerText : '';
  const lim = t.match(/Limit\\s*(\\d+)\\s*\\/\\s*(\\d+)/i);
  return { addr: /@(gmail|outlook|googlemail)\\.com$/i.test(a) ? a : null,
           limit: lim ? lim[0] : null, limitN: lim ? parseInt(lim[1],10) : 0 };
}"""

CHAIN_JS = """async (addr) => {
  const out = { steps: [] };
  const j = async (r) => {
    const t = await r.text(); let p = null;
    try { p = JSON.parse(t); } catch (e) {}
    return { status: r.status, text: t.slice(0, 800), json: p };
  };

  // 2. {address, timestamp, key} из IndexedDB EmailDatabase/emails
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
  try { rows = await readEmails(); } catch (e) { out.errors = ['idb: ' + e]; }
  out.rows = rows.map(r => ({ address: r.address, ts: r.timestamp, hasKey: !!r.key }));
  const mine = rows.find(r => r.address === addr) || rows[0];
  if (!mine) { out.error = 'в IndexedDB нет ящиков'; return out; }

  // 3. payload
  const body = [{ address: mine.address, timestamp: mine.timestamp, key: mine.key }];
  const r1 = await j(await fetch('/app/inbox', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
  out.steps.push({ step: '/app/inbox', status: r1.status, text: r1.text.slice(0, 260) });
  let payload = null;
  const arr = Array.isArray(r1.json) ? r1.json : [];
  const f = arr.find(x => x && x.address === mine.address) || arr[0];
  if (f && f.payload) payload = f.payload;
  out.payload = payload ? String(payload).slice(0, 20) + '…' : null;
  if (!payload) return out;

  // 4. список + тело с api.sonjj.com (без captcha)
  const isG = /@(gmail|googlemail)\\.com$/i.test(mine.address);
  const isO = /@(outlook|hotmail|live)\\./i.test(mine.address);
  const kind = isG ? 'temp_gmail' : (isO ? 'temp_outlook' : 'temp_email');
  const base = 'https://api.sonjj.com/v1/' + kind + '/';
  out.base = base;

  const li = await j(await fetch(base + 'inbox?payload=' + encodeURIComponent(payload)));
  out.steps.push({ step: 'sonjj/inbox', status: li.status, text: li.text.slice(0, 500) });
  let msgs = [];
  if (Array.isArray(li.json)) msgs = li.json;
  else if (li.json && Array.isArray(li.json.data)) msgs = li.json.data;
  else if (li.json && Array.isArray(li.json.messages)) msgs = li.json.messages;
  out.msgCount = msgs.length;
  if (!msgs.length) return out;

  out.msgKeys = Object.keys(msgs[0] || {});
  const m = msgs[0];
  const mid = m.mid || m.id || m.message_id || null;
  out.mid = mid;
  if (!mid) return out;

  const rq = '?payload=' + encodeURIComponent(payload) + '&mid=' + encodeURIComponent(mid);
  const me = await j(await fetch(base + 'message' + rq));
  out.steps.push({ step: 'sonjj/message', status: me.status, text: me.text.slice(0, 900) });
  out.messageText = me.text;
  return out;
}"""

STOP = {"PLEASE", "VERIFY", "EMAILS", "EMAIL", "SECURE", "THANKS", "NOTICE", "ACCESS",
        "WELCOME", "ACCOUNT", "ROUTER", "THREE", "GMAIL", "HTTPS", "SIGNIN", "LOGINS",
        "SHARED", "SUPPORT", "PRIVACY", "POLICY", "TERMS", "CODE", "OTP"}


def extract_code(text):
    s = str(text or "")
    for line in s.splitlines():
        m = re.match(r"^\s*([A-Z0-9]{6})\s*$", line)
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
    log(f"probe chain, wait={WAIT}s")
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
                    log(f"✅ ящик {addr}")
                    break
                await asyncio.sleep(3)
            if not addr:
                log("❌ ящика нет")
                return
            result["mailbox"] = addr

            log("цепочка: IndexedDB -> /app/inbox -> sonjj/inbox -> sonjj/message")
            for attempt in (1, 2):
                res = await page.evaluate(CHAIN_JS, addr)
                result.update(res or {})
                for s in (res or {}).get("steps", []):
                    log(f"  {s.get('step')}: {s.get('status')} {str(s.get('text'))[:220]}")
                log(f"  строк в IndexedDB: {res.get('rows')}")
                log(f"  payload={'есть' if res.get('payload') else 'НЕТ'} base={res.get('base')}")
                log(f"  писем: {res.get('msgCount')} mid={res.get('mid')} поля={res.get('msgKeys')}")
                if res.get("messageText"):
                    code = extract_code(res["messageText"])
                    result["code"] = code
                    log(f"  🎯 КОД: {code}" if code else "  код не распознан")
                    break
                if attempt == 1:
                    log("  писем пока нет - жду 15 с и повторяю (нужно письмо от ThreeRouter)")
                    await asyncio.sleep(15)
    except Exception as e:
        result["error"] = str(e)[:300]
        log(f"FATAL: {result['error']}")

    (OUT / "probe-chain.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    log("dump -> probe-chain.json")


asyncio.run(main())
