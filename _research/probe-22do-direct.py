#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
_research/probe-22do-direct.py

Проба: берётся ли gmail-ящик на 22.do БЕЗ прокси (напрямую).

🔴 Зачем. Замер 16.09 15:45: адрес AS198068 открывал odysseyapi.tech за 2 с, а ящик через
него не открылся (`NS_ERROR_CONNECTION_REFUSED`), и прогон умер на шаге почты. При этом
прямой запрос к 22.do из Node через ЛЮБОЙ прокси отдаёт `403` от Cloudflare - то есть по
коду ответа отличить «прокси не пускает» от «Cloudflare не пускает бота» нельзя, нужен
живой браузер. Если ящик берётся напрямую, шаг почты можно отвязать от прокси: его
надёжность перестанет зависеть от выбранного адреса регистрации.

Печатает JSON: {"ok":…,"email":…,"seconds":…}
"""

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "odyssey"))

from camoufox import AsyncCamoufox  # noqa: E402
from od_common import open_log, pick_22do_gmail  # noqa: E402


async def main():
    log = open_log(Path(__file__).resolve().parent / "probe-22do-direct.log")
    t0 = asyncio.get_event_loop().time()
    out = {"ok": False, "email": "", "seconds": 0}
    try:
        async with AsyncCamoufox(headless=True, os="windows", humanize=True,
                                 persistent_context=True,
                                 user_data_dir=str(Path(__file__).resolve().parent / "profiles" / "_mail_probe"),
                                 main_world_eval=True,
                                 i_know_what_im_doing=True) as ctx:
            page = ctx.pages[0] if ctx.pages else await ctx.new_page()
            email = await pick_22do_gmail(page, log)
            out["email"] = email
            out["ok"] = bool(email)
    except Exception as e:
        out["error"] = str(e).splitlines()[0][:160]
    out["seconds"] = round(asyncio.get_event_loop().time() - t0, 1)
    print(json.dumps(out, ensure_ascii=False))
    return 0 if out["ok"] else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
