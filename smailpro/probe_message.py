"""smailpro/probe_message.py - можно ли взять тело письма БЕЗ модалки и второго Turnstile.

Симптом 28.10 (скрин владельца): письмо ThreeRouter в списке видно, но клик по нему
открывает модалку со вторым Turnstile -> "Verification failed". Тело письма через UI
недоступно.

Гипотеза: эндпоинты `app/inbox` и `app/message` отдают данные по HTTP из самой
страницы (same-origin, с куками сессии), без виджета. Проверяем:

  POST /app/inbox   -> [{address, timestamp, key, payload}]   (уже видно в записи)
  POST /app/message -> тело письма ?                          (это и проверяем)

Токены `key`/`payload` из ответа inbox - JWT; пробуем их в разных формах тела,
потому что точную форму запроса фронтенд не показывает (запись ловит только ответы).

Запуск: python smailpro/probe_message.py [секунды]
"""
import asyncio, json, re, sys, time
from pathlib import Path

from camoufox import AsyncCamoufox

URL = "https://smailpro.com/temporary-email"
OUT = Path(__file__).parent / "recordings"
WAIT = int(sys.argv[1]) if len(sys.argv) > 1 else 150
PROFILE = OUT / "probe-message-profile"
PROFILE.mkdir(parents=True, exist_ok=True)

MAILBOX_JS = """() => {
  const r = document.querySelector('input[name="limitEmail"]');
  const a = r ? String(r.value || '') : '';
  const t = document.body ? document.body.innerText : '';
  const lim = t.match(/Limit\\s*(\\d+)\\s*\\/\\s*(\\d+)/i);
  return { addr: /@(gmail|outlook|googlemail)\\.com$/i.test(a) ? a : null,
           limit: lim ? lim[0] : null, limitN: lim ? parseInt(lim[1],10) : 0 };
}"""

# Всё - из page.evaluate: запрос уходит с origin smailpro.com и его куками.
# 🔴 Замер 28.10: `/app/message` отвечает на POST `405 ... Supported methods: GET, HEAD`
# - тело письма берётся GET-ом. `/app/inbox` на пустое тело отвечает
# `401 {"msg":"Data is empty"}` - ему нужно поле (email или токен), а не `{}`.
PROBE_JS = """async () => {
  const out = { steps: [] };
  const req = async (path, opts) => {
    const r = await fetch(path, opts);
    const txt = await r.text();
    return { status: r.status, body: txt.slice(0, 1200) };
  };
  const post = (path, body) => req(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: JSON.stringify(body === undefined ? {} : body),
  });
  const get = (path) => req(path, { method: 'GET', headers: { 'X-Requested-With': 'XMLHttpRequest' } });

  const email = (document.querySelector('input[name="limitEmail"]') || {}).value || null;
  out.email = email;

  // 🔴 API ведёт по шагам (замеры 07:12-07:15):
  //   {}                        -> "Data is empty"
  //   {email}                   -> "The email.address field is required"
  //   {email:{address}}         -> "The email.timestamp field is required"
  // Значит тело - ЦЕЛИКОМ объект ящика: address + timestamp. Timestamp ищем в
  // состоянии страницы (localStorage/sessionStorage/JS-переменные), а не выдумываем.
  const lsKeys = {}, ssKeys = {};
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); lsKeys[k] = String(localStorage.getItem(k) || '').slice(0, 300); } } catch (e) {}
  try { for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); ssKeys[k] = String(sessionStorage.getItem(k) || '').slice(0, 300); } } catch (e) {}
  out.lsKeys = lsKeys; out.ssKeys = ssKeys;

  // timestamp: ищем число рядом с адресом в любом хранилище
  const findTs = (v) => {
    if (!v) return null;
    const esc = email ? email.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&') : null;
    if (esc) {
      const m = new RegExp(esc + '[^}]{0,120}?(?:timestamp|ts)["\\\\s:]+(\\\\d{9,13})', 'i').exec(v)
             || new RegExp('(?:timestamp|ts)["\\\\s:]+(\\\\d{9,13})[^}]{0,120}?' + esc, 'i').exec(v);
      if (m) return Number(m[1]);
    }
    const any = /(?:timestamp|created_at|ts)["\\s:]+(\\d{10})/i.exec(v);
    return any ? Number(any[1]) : null;
  };
  let ts = null, tsSrc = null;
  for (const [src, store] of [['localStorage', lsKeys], ['sessionStorage', ssKeys]]) {
    for (const [k, v] of Object.entries(store)) {
      const t = findTs(v);
      if (t) { ts = t; tsSrc = src + ':' + k; break; }
    }
    if (ts) break;
  }
  out.timestamp = ts; out.timestampSource = tsSrc;

  const inboxBodies = [];
  if (ts) inboxBodies.push(['email{address,timestamp}', { email: { address: email, timestamp: ts } }]);
  if (ts) inboxBodies.push(['email{address,timestamp,reload}', { email: { address: email, timestamp: ts, reload: true } }]);
  inboxBodies.push(['email.address', { email: { address: email } }]);

  let arr = null;
  for (const [name, b] of inboxBodies) {
    const r = await post('/app/inbox', b);
    out.steps.push({ step: 'inbox:' + name, status: r.status, body: r.body.slice(0, 300) });
    if (r.status === 200) { try { arr = JSON.parse(r.body); } catch (e) {} if (arr) break; }
  }
  out.inboxRaw = JSON.stringify(arr).slice(0, 800);

  // 2. Тело письма. 🔴 POST -> 405 "Supported methods: GET, HEAD";
  //    GET без mid -> {"msg":"The mid field is required"}.
  //    `mid` ищем в ответе инбокса: перебираем вероятные имена полей.
  const qs = (o) => Object.entries(o).filter(([, v]) => v)
    .map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
  const msgs = Array.isArray(arr) ? arr : (arr && (arr.items || arr.data || arr.messages)) || [];
  const first = msgs[0] || {};
  out.msgKeys = Object.keys(first);
  const mid = first.mid || first.id || first.messageID || first.message_id || null;
  out.mid = mid;

  if (mid) {
    for (const [name, params] of [['mid', { mid }], ['mid+addr', { mid, address: email }]]) {
      try {
        const r = await get('/app/message?' + qs(params));
        out.steps.push({ step: 'message:' + name, status: r.status, body: r.body.slice(0, 700) });
        if (r.status === 200) out.messageWorked = name;
      } catch (e) {
        out.steps.push({ step: 'message:' + name, error: String(e) });
      }
    }
  }
  return out;
}"""


def log(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)


async def main():
    log(f"probe message, wait={WAIT}s")
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
            while time.time() - t0 < WAIT:
                try:
                    st = await page.evaluate(MAILBOX_JS)
                except Exception as e:
                    log(f"err {str(e)[:60]}")
                    break
                if st.get("limitN", 0) >= 1:
                    log(f"✅ ящик {st['addr']} ({st['limit']})")
                    result["mailbox"] = st
                    break
                await asyncio.sleep(3)
            if not result.get("mailbox"):
                log("❌ ящик не создался - запросы всё равно пробуем")

            log("пробую /app/inbox и /app/message…")
            result["probe"] = await page.evaluate(PROBE_JS)
            for s in result["probe"].get("steps", []):
                log(f"  {s.get('step')}: {s.get('status')} {str(s.get('body') or s.get('error'))[:200]}")
    except Exception as e:
        result["error"] = str(e)[:300]
        log(f"FATAL: {result['error']}")

    (OUT / "probe-message.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    log("dump -> probe-message.json")


asyncio.run(main())
