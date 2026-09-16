#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
_research/probe-od-grant.py

Что вообще положено аккаунту при регистрации: смотрит страницы кабинета В ПРОФИЛЕ
браузера (не по кукам - снимок сессии недолговечен, замер 16.09) и печатает всё, что
похоже на деньги, подписку или подарок.

Зачем: владелец 16.09 - «оно не даёт баланс, вообще 0», а знакомый получил баланс, регистрируя
через Tor. Чтобы спорить фактами, надо сначала увидеть, есть ли у наших аккаунтов хоть
какой-то начисленный подарок (credit, trial, subscription) - или там действительно пусто.

Запуск: python _research/probe-od-grant.py <профиль Camoufox>
"""

import asyncio
import re
import sys
from pathlib import Path

from camoufox import AsyncCamoufox

DIR = Path(__file__).resolve().parent.parent / "odyssey"
PAGES = ["/dashboard", "/billing", "/referrals", "/usage"]
WANT = re.compile(r"(credit|\$[0-9]+\.[0-9]{2}|trial|subscription|referral|grant|promo|free)", re.I)


async def main():
    label = sys.argv[1] if len(sys.argv) > 1 else ""
    profile = DIR / "profiles" / label
    if not label or not profile.exists():
        print(f"нужно имя профиля; нет такого: {profile}")
        return 1

    async with AsyncCamoufox(headless=True, os="windows", humanize=1.0,
                             persistent_context=True, user_data_dir=str(profile),
                             main_world_eval=True, i_know_what_im_doing=True) as ctx:
        page = ctx.pages[0]
        for path in PAGES:
            url = "https://odysseyapi.tech" + path
            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=60000)
                await page.wait_for_timeout(5000)
                text = " ".join((await page.inner_text("body")).split())
            except Exception as e:
                print(f"--- {path}: не открылась ({str(e).splitlines()[0][:60]})")
                continue
            # Печатаем только осмысленные куски: страница длинная, а интересны деньги и сроки.
            bits = []
            for m in WANT.finditer(text):
                start = max(0, m.start() - 60)
                bits.append(text[start:m.end() + 80].strip())
            uniq = []
            for b in bits:
                if b not in uniq:
                    uniq.append(b)
            print(f"--- {path} (заголовок: {text[:70]})")
            for b in uniq[:6]:
                print(f"    · {b}")
            if not uniq:
                print("    (ничего про деньги и подарки)")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
