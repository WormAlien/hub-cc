#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
_research/probe-firefox-page.py <прокси-строка>

Проба: грузит ли Firefox (Camoufox) страницу регистрации Odyssey через конкретный прокси.

🔴 Зачем. Замер 16.09 16:04: адрес `socks5://5.45.119.70:1080` отдаёт страницу `/sign-up`
через Node за 2.4 с (`200`, 49506 байт), а Firefox через тот же прокси вернул
`Page.goto: NS_ERROR_ABORT`, и окно осталось на `about:blank`. То есть «адрес мёртв» и
«браузер через этот адрес не ходит» - РАЗНЫЕ вещи, и проверять их надо порознь. Здесь
проверяем вторую: сколько ждать, что в итоге на странице и какие фреймы.

Печатает строки `проба: …` и итог JSON.
"""

import asyncio
import json
import re
import sys
from pathlib import Path

from camoufox import AsyncCamoufox

URL = "https://odysseyapi.tech/sign-up"
DIR = Path(__file__).resolve().parent


def p(*a):
    print("проба:", *a, flush=True)


async def main():
    pin = sys.argv[1] if len(sys.argv) > 1 else ""
    m = re.match(r"^(?P<scheme>\w+)://(?:(?P<user>[^:@/]+):(?P<pass>[^@/]*)@)?(?P<host>[^:/]+):(?P<port>\d+)$", pin)
    if not m:
        p("нужна строка прокси: socks5://ip:port")
        return 1
    proxy = {"server": f"{m.group('scheme')}://{m.group('host')}:{m.group('port')}"}
    if m.group("user"):
        proxy.update({"username": m.group("user"), "password": m.group("pass") or ""})

    out = {"ok": False, "proxy": pin}
    cm = AsyncCamoufox(headless=False, os="windows", humanize=True, persistent_context=True,
                       user_data_dir=str(DIR / "profiles" / "_ff_probe"),
                       disable_coop=True, main_world_eval=True, i_know_what_im_doing=True,
                       proxy=proxy)
    ctx = await cm.__aenter__()
    try:
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        for attempt in (1, 2, 3):
            try:
                await page.goto(URL, wait_until="domcontentloaded", timeout=45000)
                p(f"попытка {attempt}: открылось, url={page.url}")
                break
            except Exception as e:
                p(f"попытка {attempt}: {str(e).splitlines()[0][:110]}")
                await page.wait_for_timeout(3000)
        p("ждите: окно поднимаю в фокус и смотрю видимость")
        try:
            await page.bring_to_front()
            vis = await page.evaluate("() => [document.visibilityState, document.hasFocus()]")
            p(f"видимость {vis[0]}, фокус {vis[1]}")
        except Exception as e:
            p("состояние окна не спросилось:", str(e).splitlines()[0][:80])

        for i in range(1, 13):
            await page.wait_for_timeout(5000)
            try:
                text = " ".join((await page.inner_text("body")).split())[:120]
                n_alt = await page.locator("input[id^='altcha-checkbox']").count()
                n_mail = await page.locator("input#emailAddress-field").count()
                cfs = [f.url for f in page.frames if "challenge" in (f.url or "") or "turnstile" in (f.url or "")]
                p(f"{i * 5}с: url={page.url.replace('https://odysseyapi.tech', '')} · altcha={n_alt} · "
                  f"поле={n_mail} · cf-фреймов={len(cfs)} · «{text[:70]}»")
                if n_alt:
                    out["ok"] = True
                    break
            except Exception as e:
                p(f"{i * 5}с: страница не отвечает ({str(e).splitlines()[0][:80]})")
                break
        out["url"] = page.url
    finally:
        try:
            await cm.__aexit__(None, None, None)
        except Exception:
            pass
    print(json.dumps(out, ensure_ascii=False))
    return 0 if out.get("ok") else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
