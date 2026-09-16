#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
_research/probe-turnstile.py

Диагностика интерактивного виджета Turnstile Clerk: где он лежит в разметке и можно ли
прожать его из кода.

🔴 Зачем. Авторега 16.09 «пыталась» кликать по виджету и НЕ НАХОДИЛА его: в трёх прогонах
ни одной строки в логе. Селектор `iframe[src*="challenges.cloudflare.com"]` не совпал, а
почему - неизвестно: либо виджет в теневом DOM, либо iframe создаётся иначе, либо его в
тот момент ещё не было. Владелец: «надо было сразу сделать» - делаем.

Признак успеха у Turnstile машинный: скрытое поле `input[name="cf-turnstile-response"]`
получает токен, когда проверка пройдена. Поэтому пробуем клики и после каждого смотрим,
появился ли токен, - гадать «сработало или нет» не нужно.

Запуск:
  python _research/probe-turnstile.py --proxy 'socks5://1.2.3.4:1080' [--wait 90]
"""

import asyncio
import json
import sys
from pathlib import Path

from camoufox import AsyncCamoufox

DIR = Path(__file__).resolve().parent.parent / "odyssey"
SIGNUP = "https://odysseyapi.tech/sign-up"
SHOTS = DIR / "recordings"

# Что искать в разметке: всё, что похоже на капчу/виджет Cloudflare.
DUMP_JS = """() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const rect = (e) => { const r = e.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; };
    const out = { iframes: [], suspects: [], token: null };
    for (const f of document.querySelectorAll('iframe')) {
        out.iframes.push({ src: (f.src || '').slice(0, 120), rect: rect(f), vis: vis(f) });
    }
    for (const e of document.querySelectorAll('*')) {
        const cls = (typeof e.className === 'string' ? e.className : '') + ' ' + (e.id || '');
        if (!/captcha|turnstile|cf-|cl-|altcha/.test(cls)) continue;
        if (!vis(e)) continue;
        const r = rect(e);
        if (r.w < 20 || r.h < 20) continue;      // мелочь неинтересна
        out.suspects.push({ tag: e.tagName.toLowerCase(), cls: cls.trim().slice(0, 70), rect: r });
        if (out.suspects.length > 25) break;
    }
    const t = document.querySelector('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]');
    out.token = t ? String(t.value || '').slice(0, 24) : null;
    return out;
}"""


def log(*parts):
    print(*parts, flush=True)


async def main():
    argv = sys.argv[1:]
    proxy = None
    wait_s = 90
    for i, a in enumerate(argv):
        if a == "--proxy" and i + 1 < len(argv):
            proxy = argv[i + 1]
        elif a.startswith("--proxy="):
            proxy = a.split("=", 1)[1]
        elif a == "--wait" and i + 1 < len(argv):
            wait_s = int(argv[i + 1])
    if not proxy:
        log("нужен --proxy: диагностика имеет смысл только на «строгом» адресе")
        return 1

    m = proxy.split("://", 1)[1]
    creds, hostport = (m.split("@", 1) if "@" in m else (None, m))
    cfg = {"server": proxy.split("://")[0] + "://" + hostport}
    if creds:
        cfg["username"], _, cfg["password"] = creds.partition(":")
    log(f"прокси: {cfg['server']} (чел. {bool(creds)})")

    SHOTS.mkdir(parents=True, exist_ok=True)
    cm = AsyncCamoufox(headless=False, os="windows", window=(1400, 950),
                       proxy=cfg, humanize=3.0, main_world_eval=True,
                       i_know_what_im_doing=True)
    browser = await cm.__aenter__()
    try:
        page = await browser.new_page()
        await page.goto(SIGNUP, wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(6000)

        # ALTCHA - proof-of-work: жмём галочку, она нужна до формы.
        try:
            await page.evaluate("""() => {
                const el = document.querySelector('input[id^="altcha-checkbox"]');
                if (el) el.click();
            }""")
            log("ALTCHA: галочку нажал")
        except Exception as e:
            log(f"ALTCHA: {str(e).splitlines()[0][:70]}")
        await page.wait_for_timeout(12000)

        # Может появиться либо форма, либо виджет капчи. Смотрим, что видим.
        deadline = asyncio.get_event_loop().time() + wait_s
        seen_widget = False
        lap = 0
        while asyncio.get_event_loop().time() < deadline:
            lap += 1
            # Состояние словами: «Verifying…» - это ALTCHA, «Verify you are human» - Turnstile.
            try:
                txt = " ".join((await page.inner_text("body")).split())[:110]
            except Exception:
                txt = ""
            print(f"  [{lap}] {txt}", flush=True)
            dump = await page.evaluate(DUMP_JS)
            if dump["iframes"] or dump["suspects"]:
                log("\n--- разметка ---")
                for f in dump["iframes"][:6]:
                    log(f"  iframe vis={f['vis']} rect={f['rect']} src={f['src'][:90]}")
                for s in dump["suspects"][:10]:
                    log(f"  <{s['tag']}> {s['cls'][:60]} rect={s['rect']}")
                log(f"  токен Turnstile: {dump['token'] or 'нет'}")
                seen_widget = True
                break
            await page.wait_for_timeout(8000)

        shot = SHOTS / "turnstile-diag.png"
        await page.screenshot(path=str(shot))
        log(f"\nснимок окна: {shot}")

        if not seen_widget:
            log("виджета не дождались: возможно, капча на этом адресе не потребовалась")
            return 0

        # ── пробуем прожать и проверяем результат по токену ──
        dump = await page.evaluate(DUMP_JS)
        targets = []
        for f in dump["iframes"]:
            if f["vis"] and f["rect"]["w"] > 50:
                targets.append(("iframe", f["rect"]))
        for s in dump["suspects"]:
            if s["rect"]["w"] > 80 and s["rect"]["h"] > 30:
                targets.append((s["cls"][:40], s["rect"]))

        for name, r in targets[:6]:
            x, y = r["x"] + 30, r["y"] + max(10, r["h"] // 2)
            log(f"\nклик мышью в ({x},{y}) по «{name}»")
            try:
                await page.mouse.move(x, y, steps=12)
                await page.mouse.click(x, y)
            except Exception as e:
                log(f"  клик не прошёл: {str(e).splitlines()[0][:60]}")
                continue
            await page.wait_for_timeout(6000)
            after = await page.evaluate(DUMP_JS)
            log(f"  токен после клика: {after['token'] or 'нет'} · iframe'ов: {len(after['iframes'])}")
            if after["token"]:
                log("  ✅ Turnstile принял синтетический клик")
                await page.screenshot(path=str(SHOTS / "turnstile-diag-after.png"))
                return 0

        await page.screenshot(path=str(SHOTS / "turnstile-diag-after.png"))
        log("\n❌ токена нет ни после одного клика: синтетический клик Turnstile не принимает")
        log("   (либо мимо цели, либо проверка требует настоящего ввода - смотреть снимок)")
        return 0
    finally:
        try:
            await cm.__aexit__(None, None, None)
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
