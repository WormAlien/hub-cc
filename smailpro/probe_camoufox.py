"""smailpro/probe_camoufox.py - ступенчатая проба вылета Camoufox (28.10).

Симптом: оба прогона рекордера умерли на ~48-49 с - слишком точно для
случайности. Стадии изолируют виновника:

  blank  голый Camoufox, about:blank, 60 с   - базовая стабильность в этом окружении
  sm     + smailpro.com/temporary-email      - не убивает ли сам сайт
  rec    + рекордер JS (клики)               - не убивает ли instrumentation
  full   + второй таб ThreeRouter            - не убивает ли два таба с Turnstile

Сердцебиение раз в 5 с: page.evaluate("1") - на мёртвом браузере бросит,
и мы получим ТОЧНОЕ время смерти по каждой стадии.

Запуск: python smailpro/probe_camoufox.py <blank|sm|rec|full> [секунды]
"""
import asyncio, sys, time, traceback
from pathlib import Path

from camoufox import AsyncCamoufox

SMAILPRO = "https://smailpro.com/temporary-email"
TR = "https://www.threerouter.com/register?aff=VWCYM3TATVDX"
OUT = Path(__file__).parent / "recordings"
PROFILE = OUT / "probe-profile"
PROFILE.mkdir(parents=True, exist_ok=True)

STAGE = sys.argv[1] if len(sys.argv) > 1 else "blank"
LIMIT = int(sys.argv[2]) if len(sys.argv) > 2 else 120

RECORDER_JS = """() => {
  document.addEventListener('click', (e) => {
    try { window.__recordClick({ tag: e.target.tagName, t: Date.now() }); } catch (err) {}
  }, true);
}"""


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


async def main():
    t0 = time.time()
    log(f"probe stage={STAGE} limit={LIMIT}s")
    try:
        async with AsyncCamoufox(
            headless=False, os="windows", window=(1280, 720),
            persistent_context=True, user_data_dir=str(PROFILE),
            disable_coop=True, humanize=10.0,
            main_world_eval=True, i_know_what_im_doing=True,
        ) as ctx:
            page = ctx.pages[0] if ctx.pages else await ctx.new_page()
            if STAGE == "blank":
                log("about:blank, ничего не делаю")
            else:
                await page.goto(SMAILPRO, wait_until="domcontentloaded", timeout=60000)
                log(f"smailpro loaded t={int(time.time() - t0)}s")
                if STAGE in ("rec", "full"):
                    await page.expose_function("__recordClick", lambda d: None)
                    await page.evaluate(RECORDER_JS)
                    log(f"recorder injected t={int(time.time() - t0)}s")
                if STAGE == "full":
                    p2 = await ctx.new_page()
                    await p2.expose_function("__recordClick", lambda d: None)
                    await p2.goto(TR, wait_until="domcontentloaded", timeout=60000)
                    await p2.evaluate(RECORDER_JS)
                    log(f"TR loaded t={int(time.time() - t0)}s")
            while True:
                await asyncio.sleep(5)
                t = int(time.time() - t0)
                await page.evaluate("1")
                log(f"hb t={t}s OK")
                if t >= LIMIT:
                    log(f"SURVIVED {LIMIT}s")
                    break
    except Exception as e:
        log(f"FATAL t={int(time.time() - t0)}s: {str(e)[:140]}")
        traceback.print_exc()


asyncio.run(main())
