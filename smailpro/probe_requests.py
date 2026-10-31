"""smailpro/probe_requests.py - перехват ТЕЛ запросов, которые страница шлёт сама.

Тупик: формат `POST /app/inbox` угадать не выходит - API ведёт по шагам
("Data is empty" -> "The email.address field is required" -> "The email.timestamp
field is required"), а timestamp в localStorage/sessionStorage не нашёлся.

Между тем в первой записи (camoufox-20261028_053526) сама страница вызвала
`POST /app/inbox` 463 раза УСПЕШНО - значит её тело всегда правильное.
Пишем `request.post_data` для всех `/app/*` - получаем точный формат, а не догадку.

Запуск: python smailpro/probe_requests.py [секунды]
Выход: smailpro/recordings/requests.json
"""
import asyncio, json, sys, time
from pathlib import Path

from camoufox import AsyncCamoufox

URL = "https://smailpro.com/temporary-email"
OUT = Path(__file__).parent / "recordings"
WAIT = int(sys.argv[1]) if len(sys.argv) > 1 else 90
PROFILE = OUT / "probe-requests-profile"
PROFILE.mkdir(parents=True, exist_ok=True)


def log(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)


async def main():
    log(f"probe requests, wait={WAIT}s")
    captured = []
    try:
        async with AsyncCamoufox(
            headless=False, os="windows", window=(1280, 800),
            persistent_context=True, user_data_dir=str(PROFILE),
            disable_coop=True, humanize=10.0,
            main_world_eval=True, i_know_what_im_doing=True,
        ) as ctx:
            page = ctx.pages[0] if ctx.pages else await ctx.new_page()

            def on_request(req):
                u = req.url
                if "/app/" not in u:
                    return
                try:
                    post = req.post_data
                except Exception:
                    post = None
                captured.append({
                    "t": round(time.time(), 1),
                    "method": req.method,
                    "url": u.split("?")[0],
                    "query": u.split("?", 1)[1] if "?" in u else None,
                    "post": (post or "")[:900],
                })
                if post:
                    log(f"{req.method} {u.split('?')[0]} BODY={post[:300]}")

            page.on("request", on_request)
            await page.goto(URL, wait_until="domcontentloaded", timeout=60000)
            log("loaded, 40 с наблюдения за естественным трафиком…")
            await asyncio.sleep(40)

            # Пробуем заставить страницу пнуть инбокс: клик по ящику в списке.
            # Это тот же путь, что делает владелец руками, и он уже работал (463 вызова).
            try:
                before = len(captured)
                el = await page.query_selector('input[name="limitEmail"]')
                if el:
                    box = await el.bounding_box()
                    if box:
                        await page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
                        log("кликнул по radio ящика")
                        await asyncio.sleep(6)
                log(f"после клика новых запросов: {len(captured) - before}")
            except Exception as e:
                log(f"клик не вышел: {str(e)[:80]}")

            await asyncio.sleep(max(5, WAIT - 46))
    except Exception as e:
        log(f"FATAL: {str(e)[:200]}")

    (OUT / "requests.json").write_text(json.dumps(captured, ensure_ascii=False, indent=2), encoding="utf-8")
    bodies = [c for c in captured if c["post"]]
    log(f"итого /app/*: {len(captured)}, с телом: {len(bodies)}")
    for c in bodies[:10]:
        log(f"  {c['method']} {c['url']} :: {c['post'][:400]}")


asyncio.run(main())
