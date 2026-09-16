#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
_research/probe-22do-api.py

Ищет, каким запросом ящик 22.do отдаёт список писем и текст письма.

Зачем. Владелец 16.09: «почта с кодом очень долго парсится со страницы». Сейчас драйвер
вычитывает `inner_text` всей страницы и ищет шесть цифр регуляркой - это медленно (перезагрузка
+ полный текст каждые 8 секунд) и хрупко. Если у ящика есть свой JSON-эндпоинт, код можно
брать прямо из ответа: быстро и по структуре, а не по вёрстке.

Слушаем сетевые ответы страницы ящика и печатаем те, что похожи на данные (JSON или текст
письма), вместе с временем до готовности.

Запуск: python _research/probe-22do-api.py <профиль Camoufox>
"""

import asyncio
import json
import sys
from pathlib import Path

from camoufox import AsyncCamoufox

DIR = Path(__file__).resolve().parent.parent / "odyssey"


async def main():
    label = sys.argv[1] if len(sys.argv) > 1 else ""
    profile = DIR / "profiles" / label
    if not label or not profile.exists():
        print(f"нужен профиль; нет такого: {profile}")
        return 1

    seen = []
    async with AsyncCamoufox(headless=True, os="windows", humanize=1.0,
                             persistent_context=True, user_data_dir=str(profile),
                             main_world_eval=True, i_know_what_im_doing=True) as ctx:
        page = ctx.pages[0]

        async def on_response(res):
            url = res.url
            if "22.do" not in url:
                return
            ctype = (res.headers or {}).get("content-type", "")
            # Ловим ВСЕ запросы, а не только JSON: опрос ящика может идти с другим
            # content-type, и именно он нам нужен - он и приносит письма.
            if "/action/" not in url and "json" not in ctype:
                return
            try:
                body = await res.text()
            except Exception:
                return
            entry = {"method": res.request.method, "url": url.split("?")[0],
                     "post": (res.request.post_data or "")[:200],
                     "ctype": ctype, "len": len(body), "sample": body[:220].replace("\n", " ")}
            if entry not in seen:
                seen.append(entry)

        ctx.on("response", lambda r: asyncio.create_task(on_response(r)))

        print("открываю ящик…")
        await page.goto("https://22.do/", wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(4000)
        # Кнопка Open подхватит текущий адрес сессии; если ящик уже открыт - просто перезагрузка.
        for sel in ("button#into-mailbox", "button:has-text('Refresh')", "button.mf-panel-btn"):
            try:
                loc = page.locator(sel).first
                if await loc.count():
                    await loc.click(timeout=8000)
                    await page.wait_for_timeout(3000)
            except Exception:
                pass
        await page.wait_for_timeout(30000)   # ждём опрос ящика: он и приносит письма

    print(f"\nпохожих на данные ответов: {len(seen)}")
    for e in seen[:12]:
        print(f"  {e['method']} {e['url'][:100]}  ({e['ctype'].split(';')[0]}, {e['len']} б)")
        if e.get("post"):
            print(f"      тело запроса: {e['post'][:160]}")
        if e.get('post'):
            print(f"      тело запроса: {e['post'][:160]}")
        print(f"      {e['sample'][:180]}")
    if not seen:
        print("  (ни одного JSON - ящик отдаёт письма только в вёрстке)")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
