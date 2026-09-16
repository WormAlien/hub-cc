#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
_research/probe-22do.py

Один вопрос: как на 22.do получить адрес НА GMAIL, и повторяемо ли это.

Из записи ручного прогона 16.09 известен путь: «Open» даёт одноразовый домен
(`…@tnbeta.com`), а Gmail появился после `#idChange` → «Change». Но это одно
наблюдение. Пробник жмёт «Change» несколько раз и печатает, какой домен выдаётся
каждый раз - из этого видно, всегда ли там Gmail или домены идут по кругу.

Регистрация тут не участвует: только публичный сервис почты, чтение адресов.

Запуск: python _research/probe-22do.py
"""

import asyncio
import sys
from camoufox import AsyncCamoufox

SITE = "https://22.do/"
ROUNDS = 4


def log(msg):
    print(msg, flush=True)


async def read_address(page):
    # Адрес живёт в разных местах на главной и в ящике, поэтому берём по нескольким
    # селекторам, а не по одному: пустая строка тут неотличима от «домен не тот».
    for sel in ("#copyEmail", ".card.email", "input#email", ".email-text"):
        try:
            loc = page.locator(sel).first
            if await loc.count():
                txt = (await loc.inner_text()).strip()
                if "@" in txt:
                    return " ".join(txt.split())
        except Exception:
            pass
    # Запасной путь - адрес в хеше URL: `22.do/inbox/#/<адрес>`
    url = page.url
    if "#" in url and "@" in url:
        return url.split("#")[-1].strip("/ ")
    try:
        body = await page.inner_text("body")
        for word in body.split():
            if "@" in word and "." in word:
                return word.strip()
    except Exception:
        pass
    return ""


async def main():
    async with AsyncCamoufox(
        headless=False,
        os="windows",
        window=(1200, 900),
        humanize=6.0,
        main_world_eval=True,
        i_know_what_im_doing=True,
    ) as browser:
        # 🪤 Без persistent_context=True Camoufox отдаёт Browser, а не BrowserContext:
        # `.pages` у него нет вовсе, страницу надо создавать.
        page = await browser.new_page()
        log(f"открываю {SITE}")
        await page.goto(SITE, wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(5000)

        # Шаг 1 - «Open»: он и создаёт ящик.
        try:
            btn = page.locator("button#into-mailbox").first
            if await btn.count():
                await btn.click(timeout=15000)
                await page.wait_for_timeout(6000)
                log("нажал «Open»")
            else:
                log("🪤 кнопки #into-mailbox нет - сайт изменился, смотрю что есть")
        except Exception as e:
            log(f"«Open» не нажался: {str(e)[:90]}")

        first = await read_address(page)
        log(f"адрес после «Open»: {first or '(не прочитался)'}")

        # Шаг 2 - «Change» несколько раз: интересует домен каждой выдачи.
        seen = []
        for i in range(1, ROUNDS + 1):
            opened_modal = False
            for sel in ("div.card.email button.btn-success", "i.icon-setting2",
                        "#userHistory", "div#idChange"):
                try:
                    loc = page.locator(sel).first
                    if await loc.count():
                        await loc.click(timeout=8000)
                        await page.wait_for_timeout(1500)
                        opened_modal = True
                        break
                except Exception:
                    continue
            try:
                chg = page.locator("div#idChange, span.change-text").first
                if await chg.count():
                    await chg.click(timeout=10000)
                    await page.wait_for_timeout(6000)
                else:
                    log(f"круг {i}: «Change» не найден (модалка открыта: {opened_modal})")
                    break
            except Exception as e:
                log(f"круг {i}: «Change» не нажался: {str(e)[:90]}")
                break

            addr = await read_address(page)
            dom = addr.split("@")[-1].lower() if "@" in addr else "?"
            seen.append(dom)
            log(f"круг {i}: {addr or '(не прочитался)'}   домен: {dom}")

        log("")
        log("=" * 56)
        gmail = [d for d in seen if d == "gmail.com"]
        log(f"кругов: {len(seen)} · из них gmail: {len(gmail)} · домены: {', '.join(seen) or '-'}")
        if seen and len(gmail) == len(seen):
            log("вывод: «Change» даёт Gmail стабильно")
        elif gmail:
            log("вывод: «Change» перебирает домены, Gmail выпадает не всегда - жать до gmail.com")
        else:
            log("вывод: Gmail через «Change» не выпал ни разу - путь другой, смотреть модалку руками")
        log("=" * 56)
        await page.wait_for_timeout(3000)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
