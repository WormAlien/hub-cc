#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
odyssey/read-account.py

Читает состояние аккаунта Odyssey БРАУЗЕРОМ: подарок, остаток кредита и расход.

🔴 Почему браузером, а не запросом с куками. Снимок сессии недолговечен: первый запрос с
ним проходит, второй получает 307 - Clerk проворачивает сессию, и без браузера она не
подхватывается (замер 16.09 на двух аккаунтах). Поэтому открываем профиль аккаунта тем же
прокси, которым он заведён (`cf_clearance` привязан к IP), и читаем страницы кабинета.

🎯 Зачем расход. Владелец 16.09: «у кого успешный баланс - надо придумать, как читать трату
по API, потому что там $5 фиксировано». Остаток кредита у подарочного аккаунта не меняется
от слова «запрос»: $5 начислено и лежит, а трата идёт по расходу. Поэтому читаем и баланс,
и расход - по отдельности.

Запуск:
  python odyssey/read-account.py <профиль> [--proxy <строка>] [--account <id>]
  # профиль - имя папки odyssey/profiles/<профиль> (для аккаунта из пула это метка прогона)

Печатает одну строку JSON: {"ok":…,"gift":…,"balance":…,"spend7":…,"spend":…}
"""

import asyncio
import json
import re
import sys
from pathlib import Path

from camoufox import AsyncCamoufox

DIR = Path(__file__).resolve().parent
BRIDGE = DIR.parent / "routing" / "lib" / "proxy-for.js"

PAGES = ("/billing", "/usage")


def log(*parts):
    print(*parts, file=sys.stderr, flush=True)


def money(text, label):
    """Число рядом с подписью. Ищем по ключевому слову, а не «первый доллар на странице»:
    на /billing доллары есть и в правилах («пока не купишь $10 кредита»)."""
    for m in re.finditer(re.escape(label) + r"[\s\S]{0,120}?\$([0-9]+(?:\.[0-9]{1,2})?)", text, re.I):
        try:
            return float(m.group(1))
        except ValueError:
            pass
    return None


def parse_page(text):
    low = text or ""
    out = {}
    if re.search(r"wasn't added|was not added|already received", low, re.I):
        out["gift"] = False
    elif re.search(r"credit balance[\s\S]{0,60}?\$5", low, re.I) or "$5.00" in low:
        out["gift"] = True
    bal = money(low, "credit balance")
    if bal is not None:
        out["balance"] = bal
    # Расход площадка показывает отдельными строками: «Spend, last 7 days $0.00» и,
    # на странице Usage, расход по периодам. Берём всё, что найдётся.
    s7 = money(low, "spend, last 7 days")
    if s7 is None:
        s7 = money(low, "last 7 days")
    if s7 is not None:
        out["spend7"] = s7
    st = money(low, "total spend")
    if st is None:
        st = money(low, "spend")
    if st is not None:
        out["spend"] = st
    return out


async def proxy_for(account_id, tier):
    if not account_id:
        return None
    cmd = ["node", str(BRIDGE), "--key", account_id, "--host", "odysseyapi.tech",
           "--path", "/api/auth/altcha/challenge", "--tier", tier]
    proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE,
                                                stderr=asyncio.subprocess.PIPE)
    raw, _ = await proc.communicate()
    line = [l for l in (raw or b"").decode("utf-8", "replace").splitlines() if l.strip().startswith("{")]
    if not line:
        return None
    ans = json.loads(line[-1])
    if ans.get("ok") and not ans.get("direct"):
        return ans.get("browser"), ans.get("label")
    return None, None


async def main():
    argv = sys.argv[1:]
    positional = [a for a in argv if not a.startswith("--")]
    if not positional:
        log("нужно имя профиля: python odyssey/read-account.py <профиль> [--account <id>]")
        return 1
    profile = DIR / "profiles" / positional[0].replace("/", "_")
    if not profile.exists():
        print(json.dumps({"ok": False, "error": f"профиля нет: {profile}"}, ensure_ascii=False))
        return 1

    pin = None
    account_id = None
    for i, a in enumerate(argv):
        if a.startswith("--proxy"):
            pin = a.split("=", 1)[1] if "=" in a else (argv[i + 1] if i + 1 < len(argv) else None)
        elif a.startswith("--account"):
            account_id = a.split("=", 1)[1] if "=" in a else (argv[i + 1] if i + 1 < len(argv) else None)

    proxy_cfg, proxy_label = None, None
    if pin:
        scheme, _, rest = pin.partition("://")
        creds, _, hostport = rest.rpartition("@")
        proxy_cfg = {"server": f"{scheme}://{hostport}"}
        if creds:
            user, _, pwd = creds.partition(":")
            proxy_cfg.update({"username": user, "password": pwd})
        proxy_label = pin
    elif account_id:
        proxy_cfg, proxy_label = await proxy_for(account_id, "scraper")
    if proxy_cfg:
        log(f"прокси аккаунта: {proxy_label}")

    out = {"ok": False, "profile": positional[0]}
    try:
        kwargs = dict(headless=True, os="windows", humanize=1.0, persistent_context=True,
                      user_data_dir=str(profile), main_world_eval=True, i_know_what_im_doing=True)
        if proxy_cfg:
            kwargs["proxy"] = proxy_cfg
        async with AsyncCamoufox(**kwargs) as ctx:
            page = ctx.pages[0]
            for path in PAGES:
                try:
                    await page.goto("https://odysseyapi.tech" + path,
                                    wait_until="domcontentloaded", timeout=60000)
                    await page.wait_for_timeout(5000)
                    text = " ".join((await page.inner_text("body")).split())
                except Exception as e:
                    log(f"{path}: не открылась ({str(e).splitlines()[0][:60]})")
                    continue
                if "sign in" in text[:400].lower() and "credit balance" not in text.lower():
                    out["ok"] = False
                    out["error"] = "кабинет просит вход: сессия в профиле не жива"
                    break
                if "--dump" in argv:
                    # Диагностика: показать всё, что на странице похоже на деньги и расход.
                    for frag in re.findall(r"[^.]{0,80}(?:\$[0-9]|spend|usage|requests|tokens)[^.]{0,80}", text, re.I)[:25]:
                        log("   · " + frag.strip()[:150])
                got = parse_page(text)
                out.update({k: v for k, v in got.items() if k not in out or out[k] is None})
                out["ok"] = True
                log(f"{path}: {json.dumps(got, ensure_ascii=False)}")
    except Exception as e:
        out["error"] = str(e).splitlines()[0][:120]

    out["proxy"] = proxy_label
    print(json.dumps(out, ensure_ascii=False))
    return 0 if out.get("ok") else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
