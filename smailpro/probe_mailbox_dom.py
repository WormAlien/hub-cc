"""smailpro/probe_mailbox_dom.py - где в DOM лежит созданный адрес smailpro.

Зачем: рекордер поймал ложное срабатывание - `william@gmail.com` при `Limit 0/5`.
Это заглушка из текста страницы, а не ящик. Настоящий ящик даёт `Limit 1/5`
(замеры probe_create 28.10: craigellm.r1.4.19.92@gmail.com, Limit 1/5).

Проба ждёт `Limit N/5` с N>=1 и снимает:
  - селектор и outerHTML элемента, где лежит адрес;
  - все input'ы со значениями (чтобы отличить поле от вывода);
  - строки bodyText вокруг адреса.

Запуск: python smailpro/probe_mailbox_dom.py [секунды]
Выход: JSON в stdout + smailpro/recordings/mailbox-dom.json
"""
import asyncio, json, re, sys, time
from pathlib import Path

from camoufox import AsyncCamoufox

URL = "https://smailpro.com/temporary-email"
OUT = Path(__file__).parent / "recordings"
LIMIT = int(sys.argv[1]) if len(sys.argv) > 1 else 150
PROFILE = OUT / "probe-dom-profile"
PROFILE.mkdir(parents=True, exist_ok=True)

ADDR_RE = r"[A-Za-z0-9._%+\-]+@(?:gmail|outlook|googlemail)\.com"


def log(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)


# Состояние + структура. Считаем ящик созданным ТОЛЬКО при Limit N/5, N>=1.
STATE_JS = """() => {
  const txt = document.body ? document.body.innerText : '';
  const lim = txt.match(/Limit\\s*(\\d+)\\s*\\/\\s*(\\d+)/i);
  const n = lim ? parseInt(lim[1], 10) : 0;
  const addrRe = /%s/i;
  const inputs = [...document.querySelectorAll('input, textarea')].map(e => ({
    type: e.type || '', id: e.id || '', name: e.name || '',
    value: String(e.value || '').slice(0, 60), ph: e.placeholder || '',
  }));
  // Кандидаты: элементы, чей ТЕКСТ (не атрибут) содержит адрес
  const hits = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.children.length > 2) continue;           // только листовые-ish
    const t = (el.innerText || '').trim();
    if (!t || t.length > 120) continue;
    if (!addrRe.test(t)) continue;
    const cls = typeof el.className === 'string' ? el.className : '';
    hits.push({
      tag: el.tagName.toLowerCase(), id: el.id || '', cls: cls.slice(0, 120),
      text: t.slice(0, 120), title: el.getAttribute('title') || '',
      html: el.outerHTML.slice(0, 300),
    });
    if (hits.length >= 12) break;
  }
  return {
    limit: lim ? lim[0] : null, limitN: n,
    inputs,
    hits,
    body: txt.replace(/\\s+/g, ' ').slice(0, 400),
  };
}""" % ADDR_RE


async def main():
    log(f"probe dom, limit={LIMIT}s")
    dump = {"found": None}
    try:
        async with AsyncCamoufox(
            headless=False, os="windows", window=(1280, 800),
            persistent_context=True, user_data_dir=str(PROFILE),
            disable_coop=True, humanize=10.0,
            main_world_eval=True, i_know_what_im_doing=True,
        ) as ctx:
            page = ctx.pages[0] if ctx.pages else await ctx.new_page()
            await page.goto(URL, wait_until="domcontentloaded", timeout=60000)
            log("loaded, ждём Limit N/5 с N>=1…")
            t0 = time.time()
            while time.time() - t0 < LIMIT:
                try:
                    st = await page.evaluate(STATE_JS)
                except Exception as e:
                    log(f"err {str(e)[:70]}")
                    await asyncio.sleep(2)
                    continue
                if st.get("limitN", 0) >= 1:
                    dump = {"found": round(time.time() - t0, 1), "state": st}
                    log(f"✅ ЯЩИК через {dump['found']}s ({st['limit']})")
                    for h in st["hits"]:
                        log(f"  <{h['tag']}> id={h['id']!r} cls={h['cls'][:60]!r} text={h['text'][:50]!r}")
                    log("  inputs: " + json.dumps(st["inputs"], ensure_ascii=False)[:400])
                    break
                await asyncio.sleep(2)
            else:
                st = await page.evaluate(STATE_JS)
                dump = {"found": None, "state": st}
                log(f"❌ за {LIMIT}s нет (limit={st.get('limit')})")
    except Exception as e:
        dump = {"error": str(e)[:200]}
        log(f"FATAL: {dump['error']}")

    (OUT / "mailbox-dom.json").write_text(json.dumps(dump, ensure_ascii=False, indent=2), encoding="utf-8")
    log("dump -> mailbox-dom.json")


asyncio.run(main())
