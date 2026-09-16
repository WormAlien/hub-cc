#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
_research/recover-od-session.py

Восстановление сессии УЖЕ СОЗДАННОГО аккаунта Odyssey: снимает куки и localStorage из
профиля Camoufox и кладёт снимок туда, откуда его берёт кнопка 🌐 дашборда.

Зачем отдельный скрипт. Прогоны 16.09 заводили аккаунты, но сессии не сохраняли: куки
оставались внутри firefox-профиля, а дашборд открывает свой (`acct_<id>`) и подкладывает
в него `odyssey/sessions/acct_<id>.json`. Снаружи это выглядело как «аккаунт есть, а
зайти нельзя» (владелец, 16.09). Рерун регистрации для починки не нужен - сессия в
профиле живая.

Формат снимка - storage_state() Playwright: `{cookies, origins}`. Он браузерно-нейтральный,
поэтому firefox-снимок открывается в chromium-профиле дашборда.

Запуск:
  python _research/recover-od-session.py acct_run11 od_1789542441438_0
      <профиль Camoufox>  <id аккаунта в пуле дашборда>
"""

import asyncio
import json
import sys
from pathlib import Path

from camoufox import AsyncCamoufox

DIR = Path(__file__).resolve().parent.parent / "odyssey"
SESSIONS = DIR / "sessions"


async def main():
    label = sys.argv[1] if len(sys.argv) > 1 else ""
    account_id = sys.argv[2] if len(sys.argv) > 2 else ""
    if not label or not account_id:
        print("нужно: recover-od-session.py <профиль> <id аккаунта>")
        return 1

    profile = DIR / "profiles" / label
    if not profile.exists():
        print(f"❌ профиля нет: {profile}")
        return 1

    out = SESSIONS / f"acct_{account_id}.json"
    print(f"профиль: {profile}")
    print(f"снимок:  {out}")

    # persistent_context - профиль открывается как есть, чтобы куки были НА МЕСТЕ.
    # headless: это служебная операция, окно на экране владельца ей ни к чему.
    async with AsyncCamoufox(headless=True, os="windows", humanize=1.0,
                             persistent_context=True, user_data_dir=str(profile),
                             main_world_eval=True, i_know_what_im_doing=True) as ctx:
        page = ctx.pages[0]
        await page.goto("https://odysseyapi.tech/dashboard",
                        wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(6000)
        # Заодно смотрим, ЖИВА ли сессия в самом профиле и что кабинет показывает про деньги.
        # Это и есть ответ на «не даёт баланс»: пустой кабинет и кабинет с нулём - разное.
        try:
            body = await page.inner_text("body")
        except Exception:
            body = ""
        import re as _re
        bal = _re.search(r"Credit balance[\s\S]{0,300}?\$([0-9]+\.[0-9]{2})", body)
        print(f"кабинет: {page.url}")
        print(f"баланс на странице: {'$' + bal.group(1) if bal else 'не виден'}")
        print(f"текст (начало): {' '.join(body.split())[:180]}")
        state = await ctx.storage_state()

    cookies = [c for c in (state.get("cookies") or []) if "odysseyapi.tech" in (c.get("domain") or "")]
    origins = [o for o in (state.get("origins") or []) if "odysseyapi.tech" in (o.get("origin") or "")]
    SESSIONS.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"cookies": cookies, "origins": origins}, ensure_ascii=False, indent=1),
                   encoding="utf-8")

    names = ", ".join(sorted({c.get("name", "?") for c in cookies}))
    print(f"✅ сохранено: {len(cookies)} кук, {len(origins)} origin'ов")
    print(f"   имена кук: {names or '(пусто)'}")
    if not cookies:
        print("⚠️ кук нет - похоже, сессия в профиле уже не жива: нужен вход по паролю")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
