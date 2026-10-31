"""smailpro/probe_body.py - читается ли ТЕЛО письма из страницы (свежий payload).

Зачем отдельная проба: `probe_chain.py` дошёл до `sonjj/inbox` = 200 `{"messages":[]}`
- цепочка жива, но письма не было, поэтому ВЕТКА ТЕЛА не проверена ни разу.

Есть сохранённые `{address, timestamp, key}` от ящика, куда ThreeRouter письмо
РЕАЛЬНО прислал (smailpro/recordings/old-payload.json,
`lanhrietghoongkuy.e.n78.8.7@gmail.com`, письмо `[ThreeRouter] Email verification code`).

🔴 Первый заход этой пробы падал с `NetworkError`: брал СОХРАНЁННЫЙ payload, а он
протух - api.sonjj.com отвечает 403 без CORS-заголовков, и Firefox показывает это
как сетевую ошибку. Поэтому теперь: сначала `POST /app/inbox` по key/timestamp
(он выдаёт СВЕЖИЙ payload), потом уже inbox/message. Тот же порядок в auto-add.py.

Снаружи api.sonjj.com отвечает 403 (фильтр по origin), из страницы smailpro - 200.

Проверяем ровно три вещи:
  1. приходят ли письма (и сколько);
  2. какие поля у письма;
  3. отдаёт ли `message?mid=` тело и есть ли в нём код 6 символов A-Z0-9.

Запуск: python smailpro/probe_body.py
Выход: smailpro/recordings/probe-body.json
"""
import asyncio, json, re, time
from pathlib import Path

from camoufox import AsyncCamoufox

OUT = Path(__file__).parent / "recordings"
PROFILE = OUT / "probe-body-profile"
PAYLOAD_FILE = OUT / "old-payload.json"

STOP = {"PLEASE", "VERIFY", "EMAILS", "EMAIL", "SECURE", "THANKS", "NOTICE", "ACCESS",
        "WELCOME", "ACCOUNT", "ROUTER", "THREE", "GMAIL", "HTTPS", "SIGNIN", "LOGINS",
        "SHARED", "SUPPORT", "PRIVACY", "POLICY", "TERMS", "CODE", "OTP"}

FETCH_JS = """async (args) => {
  const base = 'https://api.sonjj.com/v1/' + args.kind + '/';
  const get = async (u) => {
    try {
      const r = await fetch(u);
      const t = await r.text();
      let j = null;
      try { j = JSON.parse(t); } catch (e) {}
      return { status: r.status, text: t.slice(0, 1500), json: j };
    } catch (e) { return { error: String(e) }; }
  };
  const out = {};

  // 🔴 СНАЧАЛА свежий payload: сохранённый протухает и даёт 403 без CORS
  // (Firefox показывает это как NetworkError). /app/inbox выдаёт новый по key.
  const r = await fetch('/app/inbox', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([{ address: args.address, timestamp: args.timestamp, key: args.key }]),
  });
  const rtxt = await r.text();
  let rarr = null;
  try { rarr = JSON.parse(rtxt); } catch (e) {}
  out.refresh = { status: r.status, body: rtxt.slice(0, 300) };
  const f = Array.isArray(rarr) ? rarr[0] : null;
  if (f && f.payload) args.payload = f.payload;
  out.usedPayload = args.payload ? String(args.payload).slice(0, 20) + '…' : null;
  if (!args.payload) { out.error = 'payload не получен'; return out; }

  out.inbox = await get(base + 'inbox?payload=' + encodeURIComponent(args.payload));
  let msgs = [];
  const j = out.inbox.json;
  if (Array.isArray(j)) msgs = j;
  else if (j && Array.isArray(j.messages)) msgs = j.messages;
  else if (j && Array.isArray(j.data)) msgs = j.data;
  out.count = msgs.length;
  out.keys = msgs[0] ? Object.keys(msgs[0]) : [];
  out.first = msgs[0] ? JSON.stringify(msgs[0]).slice(0, 600) : null;
  if (msgs.length) {
    const m = msgs[0];
    const mid = m.mid || m.id || m.message_id || null;
    out.mid = mid;
    if (mid) {
      out.message = await get(base + 'message?payload=' + encodeURIComponent(args.payload) +
                              '&mid=' + encodeURIComponent(mid));
    }
  }
  return out;
}"""


def extract_code(text):
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


def log(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)


async def main():
    old = json.loads(PAYLOAD_FILE.read_text(encoding="utf-8"))
    payload = old["payload"]
    log(f"старый ящик: {old['address']} · payload {len(payload)} симв.")

    try:
        async with AsyncCamoufox(
            headless=False, os="windows", window=(1280, 800),
            persistent_context=True, user_data_dir=str(PROFILE),
            disable_coop=True, humanize=8.0,
            main_world_eval=True, i_know_what_im_doing=True,
        ) as ctx:
            page = ctx.pages[0] if ctx.pages else await ctx.new_page()
            log("открываю smailpro (нужен его origin для api.sonjj.com)…")
            await page.goto("https://smailpro.com/temporary-email",
                            wait_until="domcontentloaded", timeout=60000)
            await asyncio.sleep(3)

            log("обновляю payload и дёргаю sonjj inbox/message…")
            res = await page.evaluate(FETCH_JS, {
                "payload": payload, "kind": "temp_gmail",
                "address": old["address"], "timestamp": old["timestamp"], "key": old["key"],
            })
            rf = res.get("refresh") or {}
            log(f"  refresh /app/inbox: {rf.get('status')} {str(rf.get('body'))[:160]}")
            log(f"  payload: {res.get('usedPayload')}")
            ib = res.get("inbox") or {}
            log(f"  inbox: {ib.get('status')} {str(ib.get('text'))[:200]}")
            log(f"  писем: {res.get('count')} · поля: {res.get('keys')}")
            if res.get("first"):
                log(f"  первое: {res['first'][:300]}")
            msg = res.get("message") or {}
            if msg:
                log(f"  message: {msg.get('status')} {str(msg.get('text'))[:300]}")
                body = msg.get("text") or ""
                code = extract_code(body)
                log(f"  🎯 КОД: {code}" if code else "  код не распознан")

            (OUT / "probe-body.json").write_text(
                json.dumps(res, ensure_ascii=False, indent=2), encoding="utf-8")
            log("dump -> probe-body.json")
    except Exception as e:
        log(f"FATAL: {str(e)[:250]}")


asyncio.run(main())
