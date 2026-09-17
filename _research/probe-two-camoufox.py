#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
_research/probe-two-camoufox.py

Проба: живут ли ДВА окна Camoufox в одном процессе одновременно.

🔴 Зачем. Прогон 16.09 16:00 (t_est2) умер так: ящик взялся в отдельном headless-окне, а
окно площадки через полминуты ответило `Target page, context or browser has been closed` -
и все шаги после этого сыпались в «капчу не решал». Либо виновато второе окно, либо что-то
другое; проверяем ровно это, а не верим в догадку.

Печатает по строке на окно: открылось ли, живёт ли через 20 с.
"""

import asyncio
import sys
from pathlib import Path

from camoufox import AsyncCamoufox

DIR = Path(__file__).resolve().parent


async def check(name, page):
    try:
        await page.goto("https://example.com/", wait_until="domcontentloaded", timeout=30000)
        title = await page.title()
        return f"{name}: ок, заголовок «{title}»"
    except Exception as e:
        return f"{name}: ✗ {str(e).splitlines()[0][:100]}"


async def main():
    a_cm = AsyncCamoufox(headless=False, os="windows", humanize=True, persistent_context=True,
                         user_data_dir=str(DIR / "profiles" / "_two_a"), main_world_eval=True,
                         i_know_what_im_doing=True)
    a = await a_cm.__aenter__()
    a_page = a.pages[0] if a.pages else await a.new_page()
    print(await check("A (видимое, первым)", a_page), flush=True)

    b_cm = AsyncCamoufox(headless=True, os="windows", humanize=True, persistent_context=True,
                         user_data_dir=str(DIR / "profiles" / "_two_b"), main_world_eval=True,
                         i_know_what_im_doing=True)
    b = await b_cm.__aenter__()
    b_page = b.pages[0] if b.pages else await b.new_page()
    print(await check("B (headless, вторым)", b_page), flush=True)

    print("… жду 20 с и проверяю оба снова", flush=True)
    await asyncio.sleep(20)
    print(await check("A через 20 с", a_page), flush=True)
    print(await check("B через 20 с", b_page), flush=True)

    for cm in (b_cm, a_cm):
        try:
            await cm.__aexit__(None, None, None)
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
