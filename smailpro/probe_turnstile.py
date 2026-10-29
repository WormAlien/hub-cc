"""smailpro/probe_turnstile.py - умеет ли Camoufox проходить Turnstile ВООБЩЕ.

Симптом 28.10: Turnstile "Verification failed" и в Chromium, и в Camoufox.
Две разные причины выглядят одинаково, поэтому различаем замером:

  demo   https://nopecha.com/demo/turnstile  - публичная демо-страница Turnstile
         (обычный managed-челлендж, тот же провайдер)
  sm     https://smailpro.com/temporary-email - целевой сайт

Вердикт по каждой: есть ли токен в input[name=cf-turnstile-response],
какой текст виджета (Success / Verification failed / ошибка NNNNNN).

  demo OK + sm FAIL  -> наш браузер умеет, дело в сайте/нашем IP (нужен прокси)
  demo FAIL + sm FAIL-> окружение: WebGL/GPU/сеть режутся на уровне машины
  обе OK             -> всё цело, повторяй прогон

Запуск: python smailpro/probe_turnstile.py [demo|sm|both] [секунды]
"""
import asyncio, json, sys, time
from pathlib import Path

from camoufox import AsyncCamoufox

DEMO = "https://nopecha.com/demo/turnstile"
SM = "https://smailpro.com/temporary-email"
OUT = Path(__file__).parent / "recordings"
TARGET = sys.argv[1] if len(sys.argv) > 1 else "both"
LIMIT = int(sys.argv[2]) if len(sys.argv) > 2 else 60

PROFILE = OUT / f"ts-probe-{TARGET}"
PROFILE.mkdir(parents=True, exist_ok=True)


def log(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)


TOKEN_JS = """() => {
  const el = document.querySelector('input[name="cf-turnstile-response"]');
  const frames = [...document.querySelectorAll('iframe')]
    .map(f => f.src || '').filter(s => s.includes('challenges.cloudflare'));
  return {
    token: el ? String(el.value || '') : null,
    frames: frames.length,
    body: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').slice(0, 250),
  };
}"""


async def check(page, label, seconds):
    log(f"{label}: ждём токен до {seconds}s")
    t0 = time.time()
    last = None
    while time.time() - t0 < seconds:
        try:
            st = await page.evaluate(TOKEN_JS)
        except Exception as e:
            log(f"{label}: страница мертва ({str(e)[:60]})")
            return {"label": label, "ok": False, "error": str(e)[:100]}
        last = st
        if st.get("token") and len(st["token"]) > 10:
            log(f"{label}: ✅ ТОКЕН ({(time.time()-t0):.0f}s) {st['token'][:25]}…")
            return {"label": label, "ok": True, "token": st["token"][:40], "body": st.get("body", "")[:200]}
        await asyncio.sleep(2)
    # текстовые маркеры неудачи
    body = (last or {}).get("body", "")
    bad = [w for w in ("Verification failed", "Error", "Troubleshoot", "не удалось") if w.lower() in body.lower()]
    log(f"{label}: ❌ токена нет; маркеры: {bad or 'нет'}; iframe-ов CF: {(last or {}).get('frames')}")
    log(f"{label}: body: {body[:160]}")
    return {"label": label, "ok": False, "markers": bad, "body": body[:300]}


async def main():
    log(f"probe={TARGET} limit={LIMIT}s profile={PROFILE.name}")
    results = []
    try:
        async with AsyncCamoufox(
            headless=False, os="windows", window=(1280, 800),
            persistent_context=True, user_data_dir=str(PROFILE),
            disable_coop=True, humanize=10.0,
            main_world_eval=True, i_know_what_im_doing=True,
        ) as ctx:
            page = ctx.pages[0] if ctx.pages else await ctx.new_page()

            if TARGET in ("demo", "both"):
                await page.goto(DEMO, wait_until="domcontentloaded", timeout=60000)
                await asyncio.sleep(3)
                results.append(await check(page, "demo", LIMIT))

            if TARGET in ("sm", "both"):
                await page.goto(SM, wait_until="domcontentloaded", timeout=60000)
                await asyncio.sleep(3)
                results.append(await check(page, "smailpro", LIMIT))

    except Exception as e:
        log(f"FATAL: {str(e)[:160]}")

    log("--- ВЕРДИКТ ---")
    print(json.dumps(results, ensure_ascii=False, indent=2), flush=True)


asyncio.run(main())
