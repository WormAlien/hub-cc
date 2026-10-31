"""smailpro/probe_code.py - достать код письма ЧЕРЕЗ HTTP, без модалки и второго Turnstile.

Собрано замерами 28.10:
  - `POST /app/inbox` принимает МАССИВ: `[{"address","timestamp","key"}]`
    (тело страницы, поймано probe_requests.py; эти вызовы проходят 200).
  - `POST /app/message` -> 405 "Supported methods: GET, HEAD".
  - `GET /app/message` без `mid` -> 401 "The mid field is required".
  - модалка письма в UI триггерит ВТОРОЙ Turnstile -> "Verification failed"
    (скрин владельца), поэтому UI не годится.

План пробы:
  1. ждём автосоздания ящика (голая страница, как в probe_create);
  2. POST /app/inbox канонным телом -> получаем key/payload;
  3. перебираем GET/POST /app/history с этим телом -> ищем список писем и `mid`;
  4. GET /app/message?mid=... -> тело письма;
  5. извлекаем код ThreeRouter (6 символов A-Z0-9).

Запуск: python smailpro/probe_code.py [секунды]
Выход: smailpro/recordings/probe-code.json
"""
import asyncio, json, re, sys, time
from pathlib import Path

from camoufox import AsyncCamoufox

URL = "https://smailpro.com/temporary-email"
OUT = Path(__file__).parent / "recordings"
WAIT = int(sys.argv[1]) if len(sys.argv) > 1 else 120
PROFILE = OUT / "probe-code-profile"
PROFILE.mkdir(parents=True, exist_ok=True)

MAILBOX_JS = """() => {
  const r = document.querySelector('input[name="limitEmail"]');
  const a = r ? String(r.value || '') : '';
  const t = document.body ? document.body.innerText : '';
  const lim = t.match(/Limit\\s*(\\d+)\\s*\\/\\s*(\\d+)/i);
  return { addr: /@(gmail|outlook|googlemail)\\.com$/i.test(a) ? a : null,
           limit: lim ? lim[0] : null, limitN: lim ? parseInt(lim[1],10) : 0 };
}"""

# Тело канонного вызова. `key`/`timestamp` страница берёт из своего состояния;
# нам достаточно любого непустого ключа - сервер сам вернёт сессию по address.
INBOX_JS = """async (addr) => {
  const post = async (path, body) => {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.text()).slice(0, 1500) };
  };
  const get = async (path) => {
    const r = await fetch(path, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    return { status: r.status, body: (await r.text()).slice(0, 1500) };
  };
  const out = { steps: [], addr };

  // 1. Инбокс канонным МАССИВОМ. key - JWT адреса; если своего нет, сервер
  //    обычно возвращает сессию по одному address.
  const ts = Math.floor(Date.now() / 1000);
  const r1 = await post('/app/inbox', [{ address: addr, timestamp: ts, key: '' }]);
  out.steps.push({ step: 'inbox[array]', status: r1.status, body: r1.body });
  let key = null, payload = null;
  try {
    const arr = JSON.parse(r1.body);
    const f = Array.isArray(arr) ? arr[0] : arr;
    if (f && typeof f === 'object') { key = f.key || null; payload = f.payload || null; }
  } catch (e) {}
  out.hasKey = !!key;

  // 2. Список писем: пробуем все известные ручки
  const listTries = [
    ['history POST array', () => post('/app/history', [{ address: addr, timestamp: ts, key }])],
    ['history GET', () => get('/app/history?address=' + encodeURIComponent(addr))],
    ['inbox POST array+key', () => post('/app/inbox', [{ address: addr, timestamp: ts, key, payload }])],
  ];
  let listRaw = null;
  for (const [name, fn] of listTries) {
    try {
      const r = await fn();
      out.steps.push({ step: name, status: r.status, body: r.body.slice(0, 600) });
      if (r.status === 200 && r.body.length > 4) listRaw = r.body;
    } catch (e) {
      out.steps.push({ step: name, error: String(e) });
    }
  }
  out.listRaw = listRaw ? listRaw.slice(0, 1200) : null;

  // 3. mid из списка (перебор имён полей)
  let mid = null;
  if (listRaw) {
    try {
      const p = JSON.parse(listRaw);
      const arr = Array.isArray(p) ? p : (p.items || p.data || p.messages || []);
      const f = arr[0] || {};
      out.firstKeys = Object.keys(f);
      mid = f.mid || f.id || f.messageID || f.message_id || null;
    } catch (e) { out.parseError = String(e); }
  }
  out.mid = mid;

  // 4. Тело письма - GET (POST даёт 405)
  if (mid) {
    for (const [name, q] of [
      ['mid', '?mid=' + encodeURIComponent(mid)],
      ['mid+addr', '?mid=' + encodeURIComponent(mid) + '&address=' + encodeURIComponent(addr)],
    ]) {
      try {
        const r = await get('/app/message' + q);
        out.steps.push({ step: 'message:' + name, status: r.status, body: r.body.slice(0, 900) });
        if (r.status === 200) { out.messageBody = r.body; break; }
      } catch (e) {
        out.steps.push({ step: 'message:' + name, error: String(e) });
      }
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
        m = re.match(r"^\s*([A-Z0-9]{6})\s*$", line)
        if m and m.group(1) not in STOP:
            return m.group(1)
    flat = re.sub(r"\s+", " ", s)
    near = re.search(r"(?:code|код|otp|pin)[^A-Za-z0-9]{0,20}([A-Z0-9]{6})(?![A-Za-z0-9])", flat, re.I)
    if near and near.group(1).upper() not in STOP:
        return near.group(1).upper()
    return None


def log(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)


async def main():
    log(f"probe code, wait={WAIT}s")
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
            log("дёргаю /app/inbox, /app/history, /app/message…")
            res = await page.evaluate(INBOX_JS, addr)
            result.update(res)
            for s in res.get("steps", []):
                log(f"  {s.get('step')}: {s.get('status')} {str(s.get('body') or s.get('error'))[:180]}")
            if res.get("firstKeys"):
                log(f"  поля письма: {res['firstKeys']}")
            if res.get("messageBody"):
                code = extract_code(res["messageBody"])
                result["code"] = code
                log(f"  🎯 КОД: {code}" if code else "  код не распознан")
    except Exception as e:
        result["error"] = str(e)[:300]
        log(f"FATAL: {result['error']}")

    (OUT / "probe-code.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    log("dump -> probe-code.json")


asyncio.run(main())
