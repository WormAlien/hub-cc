#!/usr/bin/env python3
"""Остаток B.AI с chat.b.ai/usage — браузером Camoufox.

Почему не HTTP и не Playwright: страница за Cloudflare, и `curl` даже с живыми куками профиля
получает `403 Cf-Mitigated: challenge`, а Playwright упирается в тот же экран и в headless, и в
видимом окне, и с `channel: 'chrome'` (проверено 16.09). Camoufox этот экран проходит.

CF-виджет обходим НЕ своим кодом: в репозитории уже есть рабочий обход — `solve_turnstile()`
в `anymodel/lib/camoufox_anymodel.py`, с человеческим кликом мышью по iframe (DOM-клик по iframe
Turnstile не видит). Если он не пройдёт сам — окно видимое, и рядом сидит человек: проверку
можно пройти руками, дальше профиль носит `cf_clearance` сам.

Печатает одну строку JSON:
  {"ok": true, "balance": 297604, "raw": "297,604"}
  {"ok": false, "reason": "...", "title": "...", "text": "..."}

Запуск:  python bai/read-balance.py [--headless]
"""
import asyncio
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / 'anymodel' / 'lib'))

from camoufox.async_api import AsyncCamoufox          # noqa: E402
from camoufox_anymodel import solve_turnstile          # noqa: E402  — переиспользуем обход CF

PROFILE = pathlib.Path(__file__).resolve().parent / 'camoufox-profile'
URL = 'https://chat.b.ai/usage'

# 🪤 Цепляемся не за класс (у них генерированные `acss-1h7d5nm`, меняются от сборки к сборке),
# а за СОСЕДА элемента с текстом ровно «Balance».
READ_JS = """
() => {
  const label = [...document.querySelectorAll('div')]
      .find(n => n.children.length === 0 && n.textContent.trim() === 'Balance');
  const txt = label && label.nextElementSibling && label.nextElementSibling.textContent.trim();
  return txt && /\\d/.test(txt) ? txt : null;
}
"""


async def read_once(page):
    try:
        return await page.evaluate(READ_JS)
    except Exception:
        return None


async def main():
    headless = '--headless' in sys.argv
    async with AsyncCamoufox(
        headless=headless,
        os='windows',
        window=(1280, 900),
        persistent_context=True,
        user_data_dir=str(PROFILE),
        disable_coop=True,
        humanize=True,
        main_world_eval=True,
        i_know_what_im_doing=True,
    ) as browser:
        page = browser.pages[0] if browser.pages else await browser.new_page()
        await page.goto(URL, wait_until='domcontentloaded', timeout=90000)

        raw = None
        for attempt in range(8):
            raw = await read_once(page)
            if raw:
                break
            # Экрана нет, но и числа нет — вероятно, ещё грузится; даём странице время.
            await asyncio.sleep(3)
            raw = await read_once(page)
            if raw:
                break
            # Показалась проверка Cloudflare — кликаем по виджету (и человеку есть куда нажать).
            await solve_turnstile(page, timeout=25)

        if not raw:
            title = await page.title()
            text = (await page.evaluate("() => document.body.innerText.slice(0, 160)")) or ''
            print(json.dumps({'ok': False, 'reason': 'число не найдено',
                              'title': title, 'text': re.sub(r'\s+', ' ', text)},
                             ensure_ascii=False))
            return 1

        digits = re.sub(r'[^\d.]', '', str(raw))
        print(json.dumps({'ok': True, 'balance': float(digits) if '.' in digits else int(digits),
                          'raw': raw}, ensure_ascii=False))
        return 0


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
