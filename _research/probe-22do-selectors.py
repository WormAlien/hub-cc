#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
_research/probe-22do-selectors.py

Разведка 22.do под автоматический выбор адреса: какие элементы отвечают за адрес,
за кнопку «Random» и за «Open», и что происходит с адресом при повторных нажатиях.

Зачем: владелец 16.09 справедливо спросил - «а ты не научился оттуда брать gmail?».
Руками жать «Random» до попадания не должен ни он, ни я: адрес выбирается по правилу
(@gmail.com и без плюса - у Clerk `block_email_subaddresses`).

Окно headless: это разведка, а не работа, и на экране владельца ей делать нечего.

Запуск: python _research/probe-22do-selectors.py
"""

import asyncio
import re
import sys

from camoufox import AsyncCamoufox

SITE = "https://22.do/"
ROUNDS = 6


def log(*parts):
    # Принимает несколько частей: у print их тоже несколько, и `log('   ', r)`
    # иначе падает на несовпадении числа аргументов.
    print(*parts, flush=True)


async def dump(page, label):
    info = await page.evaluate("""() => {
        const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const rows = [];
        for (const el of document.querySelectorAll('input, button, [id], .mf-address-row, span, div')) {
            if (!vis(el)) continue;
            const txt = ((el.innerText || el.value || el.placeholder || '') + '').replace(/\\s+/g, ' ').trim();
            if (!txt) continue;
            if (!/@|random|open|custom|copy|change/i.test(txt)) continue;
            const cls = (typeof el.className === 'string' && el.className.trim()) ? '.' + el.className.trim().split(/\\s+/)[0] : '';
            rows.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls} [${el.tagName === 'INPUT' ? 'value' : 'text'}] «${txt.slice(0, 60)}»`);
        }
        return [...new Set(rows)].slice(0, 25);
    }""")
    log(f"--- {label} (url {page.url.replace(SITE, '')}) ---")
    for r in info:
        log("   ", r)
    return info


async def main():
    async with AsyncCamoufox(headless=True, os="windows", humanize=2.0,
                             main_world_eval=True, i_know_what_im_doing=True) as browser:
        page = await browser.new_page()
        await page.goto(SITE, wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(4000)
        await dump(page, "главная")

        # 🔴 «Random» крутит ДОМЕН (увидели: youxiang.dev → hotmail.com), а не локальную
        # часть. Значит вопрос не «нажать N раз», а «какие домены вообще есть». Открываем
        # выпадающий список (Choices.js) и читаем его целиком: если gmail.com в списке -
        # его надо выбирать прямо, а не ждать, пока выпадет случайно.
        domains = []
        try:
            inner = page.locator("div.choices__inner, div.choices").first
            if await inner.count():
                await inner.click(timeout=8000)
                await page.wait_for_timeout(1200)
            domains = await page.evaluate("""() => [...document.querySelectorAll('.choices__item, .choices__list--dropdown *')]
                .map(e => (e.innerText || '').trim()).filter(t => t && /@|\\./.test(t))""")
        except Exception as e:
            log("список доменов не открылся:", str(e).splitlines()[0][:80])
        log(f"домены в списке ({len(domains)}): {', '.join(sorted(set(domains))[:40])}")

        # И заодно - что даёт сам Random за двадцать нажатий: попадётся ли gmail.
        seen = []
        for i in range(1, 21):
            btn = page.locator("button#mail-random").first
            try:
                if not await btn.count():
                    log("кнопки #mail-random нет")
                    break
                await btn.click(timeout=8000)
            except Exception as e:
                log(f"круг {i}: клик не прошёл: {str(e).splitlines()[0][:70]}")
                break
            await page.wait_for_timeout(700)
            dom = await read_domain(page)
            seen.append(dom)
            if dom == "gmail.com":
                log(f"круг {i}: выпал gmail.com - запоминаю как удачный случай")
        log(f"домены за 20 нажатий: {', '.join(seen)}")

        await dump(page, "после Random")

        # Кнопка Open рядом с адресом.
        op = page.get_by_role("button", name=re.compile("^open$", re.I)).first
        log(f"кнопка Open найдена: {bool(await op.count())}")
        if await op.count():
            await op.click(timeout=10000)
            await page.wait_for_timeout(5000)
            log(f"после Open URL: {page.url.replace(SITE, '')}")
            await dump(page, "ящик")


async def read_domain(page):
    """Текущий выбранный домен - из того самого элемента, что видит человек."""
    for sel in ("div.choices__item", ".mail-con-input", ".choices__inner"):
        try:
            loc = page.locator(sel).first
            if await loc.count():
                t = (await loc.inner_text()).strip()
                m = re.search(r"@([A-Za-z0-9.-]+\.[A-Za-z]{2,})", t)
                if m:
                    return m.group(1).lower()
                if t.startswith("@"):
                    return t[1:].strip().lower()
        except Exception:
            pass
    return ""


async def read_addr(page):
    """Адрес: сначала по известным селекторам, потом по регулярке в тексте."""
    for sel in ("#copyEmail", ".mf-address-row .mf-mono", ".mf-panel-address", "input#email"):
        try:
            loc = page.locator(sel).first
            if await loc.count():
                v = (await loc.inner_text()).strip()
                if not v:
                    v = (await loc.get_attribute("value") or "").strip()
                if "@" in v:
                    return " ".join(v.split())
        except Exception:
            pass
    try:
        body = await page.inner_text("body")
        m = re.search(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", body)
        if m:
            return m.group(0)
    except Exception:
        pass
    return ""


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
