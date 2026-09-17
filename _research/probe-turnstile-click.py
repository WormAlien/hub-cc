#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
_research/probe-turnstile-click.py <прокси-строка>

Проба: КАК прожать виджет Turnstile, если Clerk выставил его модальным окном.

🔴 Зачем. Диагностика провала 16.09 20:39 показала, что «строгий адрес» - это не загадка, а
вполне конкретное состояние страницы: фрейм Turnstile `300×65` живой, а поля формы Clerk
«найдено 1, видимых 0» - то есть капча перекрыла форму модальным окном, и без клика по ней
регистрация не уйдёт. Клик у нас есть (решатель из anymodel), но он **зависает** под
`humanize` - и именно поэтому такие адреса мы теряем.

Здесь перебираются способы клика по возрастанию «натуральности», каждый под жёстким сроком:
  1. мышь Playwright по координатам фрейма (то, чем кликает человек);
  2. клик по элементу виджета через локатор фрейма;
  3. синтетические события мыши из JS внутри фрейма.
После каждого - короткая проверка: форма стала видимой? ушла заявка в Clerk?

Печатает строки `клик: …` и итог JSON.
"""

import asyncio
import json
import re
import sys
from pathlib import Path

# 🪤 Вывод в UTF-8: в консоли Windows cp866, и `×` в строке про размер виджета уронил
# пробу на ровном месте - ровно та же грабля, что и в od_common.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

from camoufox import AsyncCamoufox

URL = "https://odysseyapi.tech/sign-up"
DIR = Path(__file__).resolve().parent
# 🪤 Адрес на `example.com`: письмо-подтверждение Clerk отправит, и оно не должно уйти
# живому человеку. Формат Clerk принимает, домен не одноразовый и не плюс-алиас.
EMAIL = "probe-click-2026@example.com"
PASSWORD = "OdProbeClick2026!7"


def p(*a):
    print("клик:", *a, flush=True)


async def cf_frame(page, min_w=50, min_h=20):
    """Видимый фрейм Turnstile (скрытый часовой 1×1 отсеивается)."""
    for f in page.frames:
        if "challenges.cloudflare" not in (f.url or "") and "turnstile" not in (f.url or ""):
            continue
        try:
            el = await f.frame_element()
            box = await page.evaluate(
                "el => { const r = el.getBoundingClientRect(); return r.width > 0 ? "
                "{x:r.x, y:r.y, w:r.width, h:r.height} : null; }", el)
        except Exception:
            continue
        if box and box["w"] >= min_w and box["h"] >= min_h:
            return f, box
    return None, None


async def form_visible(page):
    try:
        return await page.locator("input#emailAddress-field").is_visible()
    except Exception:
        return False


async def main():
    pin = sys.argv[1] if len(sys.argv) > 1 else ""
    m = re.match(r"^(?P<scheme>\w+)://(?:(?P<user>[^:@/]+):(?P<pass>[^@/]*)@)?"
                 r"(?P<host>[^:/]+):(?P<port>\d+)$", pin)
    if not m:
        p("нужна строка прокси: socks5://ip:port")
        return 1
    proxy = {"server": f"{m.group('scheme')}://{m.group('host')}:{m.group('port')}"}
    if m.group("user"):
        proxy.update({"username": m.group("user"), "password": m.group("pass") or ""})

    sent = {"signup": False}
    out = {"ok": False, "methods": []}
    # `--geoip` включает расчёт пояса и локали по IP - ровно то, что появилось в драйвере
    # 16.09 вечером. Проверяем гипотезу «клик вешается из-за geoip».
    opts = dict(headless=False, os="windows", humanize=True, persistent_context=True,
                user_data_dir=str(DIR / "profiles" / "_click_probe"),
                disable_coop=True, main_world_eval=True, i_know_what_im_doing=True,
                proxy=proxy)
    if "--geoip" in sys.argv:
        opts["geoip"] = True
        p("geoip включён")
    cm = AsyncCamoufox(**opts)
    ctx = await cm.__aenter__()
    try:
        site = ctx.pages[0] if ctx.pages else await ctx.new_page()

        async def on_response(res):
            if "/v1/client/sign_ups" in res.url and res.request.method == "POST" \
                    and "/attempt_verification" not in res.url and "/prepare_verification" not in res.url:
                sent["signup"] = True
                p(f"⚠️ заявка ушла САМА (status {res.status}) - этот адрес не строгий")
        ctx.on("response", lambda r: asyncio.create_task(on_response(r)))

        await site.goto(URL, wait_until="domcontentloaded", timeout=60000)
        await site.wait_for_timeout(5000)
        try:
            box = site.locator('input[id^="altcha-checkbox"]').first
            if await box.count():
                await site.evaluate(
                    "() => { const el = document.querySelector('input[id^=\"altcha-checkbox\"]'); if (el) el.click(); }")
                p("ALTCHA нажата")
        except Exception as e:
            p("ALTCHA:", str(e).splitlines()[0][:60])
        try:
            await site.wait_for_selector("input#emailAddress-field", timeout=60000)
            await site.fill("input#emailAddress-field", EMAIL, timeout=20000)
            await site.fill("input#password-field", PASSWORD, timeout=20000)
            p("форма заполнена")
        except Exception as e:
            p("форма:", str(e).splitlines()[0][:70])

        try:
            await site.evaluate(
                "() => { const b = document.querySelector('button.cl-formButtonPrimary'); if (b) b.click(); }")
            p("«Continue» нажал")
        except Exception as e:
            p("Continue:", str(e).splitlines()[0][:60])

        for wait_s in (5, 10, 20, 30):
            await site.wait_for_timeout(5000)
            if sent["signup"]:
                break
            f, bx = await cf_frame(site)
            if f:
                p(f"виджет найден на {wait_s}-й секунде: {bx['w']:.0f}×{bx['h']:.0f} "
                  f"({bx['x']:.0f},{bx['y']:.0f}), форма видима: {await form_visible(site)}")
                break
        else:
            p("виджета не дождался")
            f, bx = None, None

        if f:
            # Способ 1: мышь по координатам, под сроком
            t0 = asyncio.get_event_loop().time()
            try:
                await asyncio.wait_for(
                    site.mouse.click(bx["x"] + 24, bx["y"] + bx["h"] / 2), timeout=10)
                dt = asyncio.get_event_loop().time() - t0
                p(f"способ 1 (мышь): {dt:.1f} с")
                out["methods"].append({"how": "mouse", "sec": round(dt, 1)})
            except asyncio.TimeoutError:
                dt = asyncio.get_event_loop().time() - t0
                p(f"способ 1 (мышь): ЗАВИСЛ, снят через {dt:.1f} с")
                out["methods"].append({"how": "mouse", "sec": round(dt, 1), "hang": True})
            except Exception as e:
                p("способ 1 (мышь): ошибка", str(e).splitlines()[0][:70])
                out["methods"].append({"how": "mouse", "err": str(e).splitlines()[0][:70]})
            for _ in range(10):
                await site.wait_for_timeout(1000)
                if sent["signup"]:
                    break
            p(f"после способа 1: заявка={'ушла' if sent['signup'] else 'нет'}, "
              f"форма видима={await form_visible(site)}")

            if not sent["signup"]:
                # Способ 2: клик по виджету локатором фрейма (Playwright сам ведёт мышь)
                try:
                    t0 = asyncio.get_event_loop().time()
                    await asyncio.wait_for(
                        f.locator("body").click(timeout=8000, force=True), timeout=14)
                    p(f"способ 2 (локатор фрейма): {asyncio.get_event_loop().time() - t0:.1f} с")
                    out["methods"].append({"how": "frame-locator"})
                except Exception as e:
                    p("способ 2 (локатор фрейма): не вышло", str(e).splitlines()[0][:70])
                    out["methods"].append({"how": "frame-locator", "err": str(e).splitlines()[0][:70]})
                for _ in range(10):
                    await site.wait_for_timeout(1000)
                    if sent["signup"]:
                        break

            if not sent["signup"]:
                # Способ 3: настоящие по форме события мыши из JS внутри фрейма
                try:
                    res = await f.evaluate("""() => {
                        const el = document.querySelector('#challenge-stage, .cb-lb, label, div') ;
                        const r = el.getBoundingClientRect();
                        const opts = {bubbles:true, cancelable:true, clientX:r.x+10, clientY:r.y+r.height/2, button:0};
                        for (const t of ['pointerdown','mousedown','pointerup','mouseup','click']) {
                            el.dispatchEvent(new MouseEvent(t, opts));
                        }
                        return true;
                    }""")
                    p("способ 3 (события из JS): отправлено", res)
                    out["methods"].append({"how": "js-events"})
                except Exception as e:
                    p("способ 3 (события из JS): ошибка", str(e).splitlines()[0][:70])
                    out["methods"].append({"how": "js-events", "err": str(e).splitlines()[0][:70]})
                for _ in range(15):
                    await site.wait_for_timeout(1000)
                    if sent["signup"]:
                        break

            out["form_visible_after"] = await form_visible(site)

        out["signup_sent"] = sent["signup"]
        out["ok"] = bool(sent["signup"])
        p(f"ИТОГ: заявка {'ушла' if sent['signup'] else 'НЕ ушла'}")
    except Exception as e:
        out["error"] = str(e).splitlines()[0][:140]
        p("упало:", out["error"])
    finally:
        try:
            await site.screenshot(path=str(DIR / "click-probe.png"))
        except Exception:
            pass
        try:
            await cm.__aexit__(None, None, None)
        except Exception:
            pass
    print(json.dumps(out, ensure_ascii=False))
    return 0 if out.get("ok") else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
