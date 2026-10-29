"""smailpro/probe_create.py - создаётся ли ящик на smailpro САМ, без кликов.

Замер 28.10 04:48 (probe_turnstile): на чистом профиле Camoufox ящик появился
сам - body показал `loachmuanhmu.an.h12.23@gmail.com`, `Limit 1/5`. Turnstile
в invisible-режиме токен в input не оставляет, поэтому судить по нему нельзя:
признак успеха - АДРЕС в тексте страницы и счётчик `Limit N/5`.

Проба отвечает на два вопроса:
  1) сколько времени от загрузки до появления адреса (для таймаута в автореге);
  2) воспроизводится ли это на ЧИСТОМ профиле (второй прогон подряд).

Запуск: python smailpro/probe_create.py [секунды]
"""
import asyncio, json, re, sys, time
from pathlib import Path

from camoufox import AsyncCamoufox

URL = "https://smailpro.com/temporary-email"
OUT = Path(__file__).parent / "recordings"
LIMIT = int(sys.argv[1]) if len(sys.argv) > 1 else 120
PROFILE = OUT / "probe-create-profile"
PROFILE.mkdir(parents=True, exist_ok=True)

ADDR_RE = re.compile(r"[A-Za-z0-9._%+-]+@(?:gmail|outlook|googlemail)\.com", re.I)


def log(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)


STATE_JS = """() => {
  const txt = document.body ? document.body.innerText : '';
  const m = txt.match(/[A-Za-z0-9._%+\\-]+@(?:gmail|outlook|googlemail)\\.com/i);
  const lim = txt.match(/Limit\\s*(\\d+)\\s*\\/\\s*(\\d+)/i);
  return {
    addr: m ? m[0] : null,
    limit: lim ? lim[0] : null,
    hasTs: !!document.querySelector('input[name="cf-turnstile-response"]'),
    tsToken: (document.querySelector('input[name="cf-turnstile-response"]') || {}).value || null,
    lines: txt.split('\\n').filter(l => l.trim()).slice(0, 25),
  };
}"""


async def main():
    log(f"probe create, limit={LIMIT}s, profile={PROFILE.name}")
    t0 = time.time()
    result = {"addr": None, "seconds": None}
    try:
        async with AsyncCamoufox(
            headless=False, os="windows", window=(1280, 800),
            persistent_context=True, user_data_dir=str(PROFILE),
            disable_coop=True, humanize=10.0,
            main_world_eval=True, i_know_what_im_doing=True,
            firefox_user_prefs={
                "widget.windows.window_occlusion_tracking.enabled": False,
                "dom.min_background_timeout_value": 4,
                "dom.timeout.enable_budget_timer_throttling": False,
                "media.suspend-bkgnd-video.enabled": False,
                "browser.tabs.unloadOnLowMemory": False,
            },
        ) as ctx:
            page = ctx.pages[0] if ctx.pages else await ctx.new_page()
            log("goto smailpro…")
            await page.goto(URL, wait_until="domcontentloaded", timeout=60000)
            log(f"loaded t={int(time.time()-t0)}s, ждём адрес…")

            while time.time() - t0 < LIMIT:
                try:
                    st = await page.evaluate(STATE_JS)
                except Exception as e:
                    log(f"page error: {str(e)[:80]}")
                    break
                if st.get("addr"):
                    result["addr"] = st["addr"]
                    result["seconds"] = round(time.time() - t0, 1)
                    result["limit"] = st.get("limit")
                    log(f"✅ АДРЕС через {result['seconds']}s: {st['addr']} ({st.get('limit')})")
                    break
                await asyncio.sleep(3)
            else:
                st = await page.evaluate(STATE_JS)
                log(f"❌ адреса нет за {LIMIT}s; limit={st.get('limit')}, hasTs={st.get('hasTs')}")
                log(f"строки: {json.dumps(st.get('lines', [])[:12], ensure_ascii=False)}")
    except Exception as e:
        log(f"FATAL: {str(e)[:160]}")

    log("RESULT " + json.dumps(result, ensure_ascii=False))


asyncio.run(main())
