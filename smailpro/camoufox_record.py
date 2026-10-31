"""smailpro/camoufox_record.py

Запись маршрута владельца "от почты до кода" для замены emailnator на SmailPro.
Camoufox (Firefox stealth) нужен потому, что smailpro.com закрыт Cloudflare
Turnstile: обычный Chromium отдаёт "Verification failed" (живой скрин 28.10),
Camoufox челлендж проходит сам.

Два таба в одном окне:
  1. smailpro.com/temporary-email - создание ящика
  2. threerouter.com/register?aff=VWCYM3TATVDX - регистрация с реф-кодом

Пишет JSONL: клики, ввод, навигацию, ответы API (smailpro + threerouter
+ turnstile), console-ошибки, DOM-слепки раз в 3 с, скриншоты после кликов.

Профиль ОДИН постоянный (не на сессию): CF-clearance куки копятся между
прогонами, Turnstile на втором запуске проходит теплее. Бloat'а как у
per-PID профилей emailnator (37 ГБ) не будет - каталог один.

Паттерн строго по рабочему camoufox_recorder.py (tmailor): evaluate-инжект
рекордера + expose_function, БЕЗ context.expose_binding и add_init_script -
те два на живом Camoufox роняли браузер за ~48 с (прогон 03:02 28.10).

Запуск:  python smailpro/camoufox_record.py
Выход:   smailpro/recordings/camoufox-<штамп>.jsonl (+ <штамп>_shots/)
Окончание: закрыть окно браузера - процесс завершится сам.
"""
import asyncio, json, sys, time, traceback
from pathlib import Path

from camoufox import AsyncCamoufox

SMAILPRO_URL = "https://smailpro.com/temporary-email"
TR_URL = "https://www.threerouter.com/register?aff=VWCYM3TATVDX"

OUT_DIR = Path(__file__).parent / "recordings"
OUT_DIR.mkdir(parents=True, exist_ok=True)
PROFILE_DIR = OUT_DIR / "camoufox-profile"
PROFILE_DIR.mkdir(parents=True, exist_ok=True)

SESSION_ID = time.strftime("%Y%m%d_%H%M%S")
LOG_FILE = OUT_DIR / f"camoufox-{SESSION_ID}.jsonl"
SHOT_DIR = OUT_DIR / f"{SESSION_ID}_shots"
SHOT_DIR.mkdir(parents=True, exist_ok=True)

STATIC_RE = (".css", ".js", ".png", ".jpg", ".jpeg", ".svg", ".ico",
             ".woff", ".woff2", ".gif", ".webp", ".map")


def log_event(kind, payload):
    entry = {"t": time.time(), "kind": kind, "payload": payload}
    line = json.dumps(entry, ensure_ascii=False, default=str)
    print(line, flush=True)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def tab_of(url):
    """Имя таба по хосту - чтобы в логе различать два таба."""
    u = (url or "").lower()
    if "smailpro" in u:
        return "smailpro"
    if "threerouter" in u:
        return "tr"
    if "challenges.cloudflare" in u:
        return "cf"
    return "other"


# Готов ли ящик. Turnstile на smailpro invisible: токен в input не остаётся,
# поэтому признак успеха - АДРЕС и счётчик `Limit N/5`.
#
# 🔴 Адрес берём из `input[name="limitEmail"]` (radio в списке ящиков), а НЕ из
# текста страницы. Замер 28.10: регулярка по bodyText поймала заглушку
# `william@gmail.com` при `Limit 0/5` - радиокнопки тогда ещё нет, а слово
# "gmail.com" в тексте есть. На созданном ящике radio имеет value=<адрес>
# (проверено probe_mailbox_dom.py: `eggerturnbu.ll24.2.2@gmail.com`).
MAILBOX_JS = """() => {
  const radio = document.querySelector('input[name="limitEmail"]');
  const addr = radio ? String(radio.value || '') : '';
  const txt = document.body ? document.body.innerText : '';
  const lim = txt.match(/Limit\\s*(\\d+)\\s*\\/\\s*(\\d+)/i);
  return {
    addr: /@(gmail|outlook|googlemail)\\.com$/i.test(addr) ? addr : null,
    limit: lim ? lim[0] : null,
    limitN: lim ? parseInt(lim[1], 10) : 0,
  };
}"""


# Инжектится evaluate'ом в КАЖДУЮ страницу после открытия. Клик уходит наружу
# через window.__recordClick (expose_function, как в рабочем tmailor-рекордере).
RECORDER_JS = r"""() => {
  const cssPath = (el) => {
    if (!el || el.nodeType !== 1) return '';
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 6) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) { part += '#' + cur.id; parts.unshift(part); break; }
      if (cur.className && typeof cur.className === 'string') {
        const cls = cur.className.trim().split(/\s+/).filter(Boolean).slice(0, 3);
        if (cls.length) part += '.' + cls.join('.');
      }
      const parent = cur.parentElement;
      if (parent) {
        const sib = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
        if (sib.length > 1) part += ':nth-of-type(' + (sib.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(' > ');
  };
  const describe = (el) => ({
    tag: el.tagName ? el.tagName.toLowerCase() : '',
    id: el.id || '',
    name: (el.getAttribute && el.getAttribute('name')) || '',
    cls: (typeof el.className === 'string' ? el.className : '') || '',
    text: ((el.innerText || el.textContent || '') + '').trim().replace(/\s+/g, ' ').slice(0, 120),
    type: (el.getAttribute && el.getAttribute('type')) || '',
    aria: (el.getAttribute && el.getAttribute('aria-label')) || '',
    href: (el.getAttribute && el.getAttribute('href')) || '',
    path: cssPath(el),
  });
  document.addEventListener('click', (e) => {
    try {
      const data = { ...describe(e.target), url: location.href };
      window.__recordClicks = window.__recordClicks || [];
      window.__recordClicks.push(data);
      if (typeof window.__recordClick === 'function') {
        window.__recordClick(data).catch(() => {});
      }
    } catch (err) {}
  }, true);
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) {
      try {
        const data = { ...describe(t), value: String(t.value || '').slice(0, 200), url: location.href };
        window.__recordInput = window.__recordInput || [];
        window.__recordInput.push(data);
        if (typeof window.__recordChange === 'function') {
          window.__recordChange(data).catch(() => {});
        }
      } catch (err) {}
    }
  }, true);
}"""


async def snapshot_dom(page, label):
    """Слепок страницы: URL, титул, инпуты (со значениями), кнопки, turnstile-токен."""
    try:
        data = await page.evaluate("""() => {
            const inputs = [...document.querySelectorAll('input, textarea')].map(e => ({
                tag: e.tagName.toLowerCase(), type: e.type || '', id: e.id || '',
                name: e.name || '', value: String(e.value || '').slice(0, 80),
            }));
            const buttons = [...document.querySelectorAll('button, a')].slice(0, 60).map(b => ({
                tag: b.tagName.toLowerCase(), text: (b.innerText || '').trim().slice(0, 80),
                id: b.id || '', href: b.getAttribute('href') || null,
            }));
            const ts = document.querySelector('input[name="cf-turnstile-response"]');
            return {
                url: location.href,
                title: document.title,
                inputs,
                buttons,
                turnstileToken: ts ? String(ts.value || '').slice(0, 40) : null,
                bodyText: document.body ? document.body.innerText.replace(/\\s+/g, ' ').slice(0, 400) : '',
            };
        }""")
        log_event("dom", {"tab": tab_of(page.url), "label": label, "data": data})
    except Exception as e:
        # Страница могла закрыться под ногами - это не поломка записи
        log_event("dom_error", {"tab": tab_of(page.url), "label": label, "error": str(e)[:120]})


async def log_response(res):
    """Ответы API: smailpro (не статика), threerouter /api/v1, turnstile."""
    try:
        url = res.url
        low = url.lower()
        tab = tab_of(url)
        if tab == "other":
            return
        if tab == "cf":
            log_event("cf", {"status": res.status, "url": url[:160]})
            return
        path = url.split("?", 1)[0]
        if path.endswith(STATIC_RE):
            return
        if tab == "tr" and "/api/" not in low and "/v1/" not in low:
            return
        try:
            body = await res.text()
            if len(body) > 2000:
                body = body[:2000] + "..."
        except Exception:
            body = "<unreadable>"
        log_event("api", {
            "tab": tab, "status": res.status,
            "method": res.request.method if res.request else "?",
            "url": url[:300], "body": body,
        })
    except Exception:
        pass


async def click_handler(page, data):
    log_event("click", {"tab": tab_of(page.url), **data})
    try:
        shot = SHOT_DIR / f"{int(time.time() * 1000)}.png"
        await page.screenshot(path=str(shot))
        log_event("shot", {"tab": tab_of(page.url), "path": str(shot)})
    except Exception as e:
        log_event("shot_error", {"error": str(e)[:120]})
    await snapshot_dom(page, "after_click")


async def change_handler(page, data):
    log_event("input", {"tab": tab_of(page.url), **data})


async def wire_page(page):
    """Ровно как в рабочем tmailor-рекордере: слушатели страницы + expose_function.
    Никаких context.expose_binding/add_init_script - они роняли Camoufox."""
    page.on("pageerror", lambda e: log_event("pageerror", {"tab": tab_of(page.url), "msg": str(e)[:200]}))
    page.on("console", lambda m: log_event("console", {"tab": tab_of(page.url), "type": m.type, "text": m.text[:300]})
            if m.type in ("error", "warning") else None)
    page.on("response", lambda res: asyncio.create_task(log_response(res)))
    page.on("framenavigated",
            lambda f: log_event("nav", {"tab": tab_of(f.url), "url": f.url[:300]}) if f == page.main_frame else None)
    page.on("close", lambda: log_event("tab_closed", {"url": page.url[:200]}))
    await page.expose_function("__recordClick", lambda data: click_handler(page, data))
    await page.expose_function("__recordChange", lambda data: change_handler(page, data))


async def main():
    print(f"log: {LOG_FILE}", flush=True)
    print(f"shots: {SHOT_DIR}", flush=True)

    try:
        async with AsyncCamoufox(
            headless=False,
            os="windows",
            window=(1600, 900),
            persistent_context=True,
            user_data_dir=str(PROFILE_DIR),
            disable_coop=True,
            humanize=10.0,
            main_world_eval=True,
            i_know_what_im_doing=True,
            # 🔴 Префы против троттлинга фонового окна - БЕЗ них Turnstile на smailpro
            # не решается: в консоли `WebGL context was lost` + `Error: 600010` +
            # потеря postMessage-канала виджета (живой прогон 28.10 03:28).
            # Тот же набор стоит в рабочих ourtoken/camoufox_autoreg.py и
            # vani/auto-add.py - там Turnstile проходит.
            # 🔴 WebGL-префы (`webgl.force-enabled`, `gfx.webrender.all`,
            # `layers.acceleration.force-enabled`) здесь СТОЯЛИ и мешали: с ними ящик
            # не создавался вовсе (прогон 05:11, 133 с, `Limit 0/5`, ни одного запроса
            # на создание), а пробы БЕЗ них создавали за 2-26 с. Убраны 28.10.
            # Остальные пять - против троттлинга фонового таба, как в рабочих
            # ourtoken/camoufox_autoreg.py и vani/auto-add.py.
            firefox_user_prefs={
                "widget.windows.window_occlusion_tracking.enabled": False,
                "dom.min_background_timeout_value": 4,
                "dom.timeout.enable_budget_timer_throttling": False,
                "media.suspend-bkgnd-video.enabled": False,
                "browser.tabs.unloadOnLowMemory": False,
            },
        ) as browser:
            pages = browser.pages or []
            mail = pages[0] if pages else await browser.new_page()

            # 🔴 SMAILPRO ГРУЗИТСЯ ГОЛЫМ - без слушателей страницы и без инжекта
            # рекордера ДО загрузки. Замеры 28.10 разложились ровно по этому признаку:
            #   probe_create / probe_mailbox_dom / probe_turnstile - страница чистая,
            #     ни wire_page, ни evaluate(RECORDER_JS) - ящик создан за 2-26 с;
            #   рекордер - wire_page повешен ДО goto, RECORDER_JS инжектился сразу
            #     после загрузки - `Limit 0/5` и через 133 с, ни одного запроса
            #     на создание ящика.
            # Turnstile invisible на smailpro не докручивается, если к моменту
            # загрузки на странице уже висят посторонние обработчики (клики,
            # change, поллинг). Поэтому: сначала ящик, потом инструментация.
            if mail.url in ("about:blank", ""):
                await mail.goto(SMAILPRO_URL, wait_until="domcontentloaded", timeout=60000)

            # 🔴 ЯЩИК ДО ИНСТРУМЕНТАЦИИ И ДО ВТОРОГО ТАБА. Замеры 28.10:
            #   проба с ОДНИМ голым табом - адрес за 2-26 с;
            #   рекордер с двумя табами и слушателями - `Limit 0/5` и через 133 с.
            # Пока ждём - НИЧЕГО к странице не прицеплено: только evaluate детектора
            # (то же делает проба), ни поллинга, ни слушателей, ни инжекта.
            log_event("wait_mailbox", {"note": "ждём автосоздания ящика на голой странице"})
            addr = None
            for _ in range(90):                     # до 4.5 мин: замер был 26 с
                try:
                    st = await mail.evaluate(MAILBOX_JS)
                except Exception as e:
                    log_event("mailbox_probe_error", {"error": str(e)[:120]})
                    break
                if st.get("addr"):
                    addr = st["addr"]
                    log_event("mailbox_ready", {"addr": addr, "limit": st.get("limit")})
                    print(f"ЯЩИК: {addr} ({st.get('limit')})", flush=True)
                    break
                await asyncio.sleep(3)
            if not addr:
                log_event("mailbox_timeout", {"note": "адрес не появился за 4.5 мин"})
                print("⚠️ ящик не создался автоматически", flush=True)

            # Ящик готов (или время вышло) - ВОТ ТЕПЕРЬ прицепляем рекордер.
            await wire_page(mail)
            await mail.evaluate(RECORDER_JS)
            await snapshot_dom(mail, "start")

            tr = await browser.new_page()
            await wire_page(tr)
            await tr.goto(TR_URL, wait_until="domcontentloaded", timeout=60000)
            await tr.evaluate(RECORDER_JS)
            await tr.bring_to_front()
            await mail.bring_to_front()

            await snapshot_dom(tr, "start")

            # Слепки раз в 3 с - после инструментации, чтобы не мешать виждету.
            async def poll():
                while True:
                    await asyncio.sleep(3)
                    for p in list(browser.pages):
                        try:
                            if not p.is_closed():
                                await snapshot_dom(p, "poll")
                        except Exception:
                            pass

            poll_task = asyncio.create_task(poll())

            # Рекордер живёт ДО навигации, но SPA может перезагрузить страницу -
            # после каждой навигации реинжектим, иначе клики молча перестают писаться.
            async def reinject(page):
                try:
                    await page.evaluate(RECORDER_JS)
                    log_event("reinject", {"tab": tab_of(page.url), "url": page.url[:200]})
                except Exception:
                    pass

            def on_nav(page):
                def handler(frame):
                    if frame == page.main_frame:
                        asyncio.create_task(reinject(page))
                return handler

            mail.on("framenavigated", on_nav(mail))
            tr.on("framenavigated", on_nav(tr))

            # 🪤 Конец - ТОЛЬКО по реальной смерти страниц, не по событию close контекста.
            # Оба прогона (03:02 и 03:22) гасли на 42-52 с без краша в WER: событие
            # "close" контекста Camoufox срабатывало САМО (браузер жив, окна целы),
            # wait_for_event("close") на него честно отвечал "закрылись" - и скрипт
            # выходил из async with, гася браузер своими руками. Пробы без этого
            # wait'а жили 100-120 с на всех стадиях. Теперь ждём, пока умрёт
            # РЕАЛЬНАЯ страница (проба evaluate - на мёртвом браузере бросит).
            while True:
                await asyncio.sleep(3)
                try:
                    await mail.evaluate("1")
                except Exception:
                    log_event("done", {"note": "mail page dead"})
                    break

            poll_task.cancel()
            log_event("done", {"note": "browser closed"})
            print(f"Готово. Лог: {LOG_FILE}", flush=True)

    except Exception as e:
        log_event("fatal", {"error": str(e), "trace": traceback.format_exc()[-1500:]})
        print(f"FAILED: {e}", file=sys.stderr, flush=True)
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
