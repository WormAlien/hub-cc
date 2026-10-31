"""smailpro/probe_store.py - где лежит key/timestamp ящика (IndexedDB или Alpine-состояние).

Тупик: `POST /app/inbox` требует `[{address, timestamp, key}]`, но в localStorage
только `sessionToken` и `query`. Значит ящики хранит `email_storage_manager.js` -
скорее всего IndexedDB. Вторая гипотеза - состояние Alpine-компонента
`TemporaryEmail()`: у него есть `emails`.

Проба перебирает оба источника и печатает найденное, чтобы потом брать key
надёжным способом, а не угадывать формат запроса.

Запуск: python smailpro/probe_store.py [секунды]
Выход: smailpro/recordings/probe-store.json
"""
import asyncio, json, sys, time
from pathlib import Path

from camoufox import AsyncCamoufox

URL = "https://smailpro.com/temporary-email"
OUT = Path(__file__).parent / "recordings"
WAIT = int(sys.argv[1]) if len(sys.argv) > 1 else 80
PROFILE = OUT / "probe-store-profile"
PROFILE.mkdir(parents=True, exist_ok=True)

MAILBOX_JS = """() => {
  const r = document.querySelector('input[name="limitEmail"]');
  const a = r ? String(r.value || '') : '';
  const t = document.body ? document.body.innerText : '';
  const lim = t.match(/Limit\\s*(\\d+)\\s*\\/\\s*(\\d+)/i);
  return { addr: /@(gmail|outlook|googlemail)\\.com$/i.test(a) ? a : null,
           limit: lim ? lim[0] : null, limitN: lim ? parseInt(lim[1],10) : 0 };
}"""

# Перебор всех хранилищ: IndexedDB (все базы/сторы), Alpine-компонент, window-переменные.
STORE_JS = """async () => {
  const out = { idb: [], alpine: null, errors: [] };

  // 1. IndexedDB: перечисляем базы и читаем первые записи каждого стора
  try {
    const dbs = await indexedDB.databases();
    out.dbs = dbs.map(d => d.name + '@' + (d.version || '?'));
    for (const info of dbs) {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open(info.name);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const stores = [...db.objectStoreNames];
      for (const st of stores) {
        try {
          const rows = await new Promise((res, rej) => {
            const tx = db.transaction(st, 'readonly');
            const req = tx.objectStore(st).getAll();
            req.onsuccess = () => res(req.result);
            req.onerror = () => rej(req.error);
          });
          if (rows && rows.length) {
            out.idb.push({
              db: info.name, store: st, count: rows.length,
              sample: JSON.stringify(rows[0]).slice(0, 500),
            });
          }
        } catch (e) { out.errors.push('store ' + st + ': ' + e); }
      }
      db.close();
    }
  } catch (e) { out.errors.push('idb: ' + e); }

  // 2. Alpine: состояние компонента TemporaryEmail()
  try {
    if (window.Alpine) {
      const root = document.querySelector('[x-data^="TemporaryEmail"]');
      if (root) {
        const d = window.Alpine.$data(root);
        out.alpineKeys = Object.keys(d || {});
        const pick = (v) => {
          try { return JSON.stringify(v).slice(0, 600); } catch (e) { return String(v).slice(0, 200); }
        };
        out.alpine = {
          emails: d.emails ? pick(d.emails) : null,
          selectedEmail: d.selectedEmail ? pick(d.selectedEmail) : null,
          isLoggedIn: d.isLoggedIn,
        };
      }
    }
  } catch (e) { out.errors.push('alpine: ' + e); }

  return out;
}"""


def log(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)


async def main():
    log(f"probe store, wait={WAIT}s")
    result = {}
    try:
        async with AsyncCamoufox(
            headless=False, os="windows", window=(1280, 800),
            persistent_context=True, user_data_dir=str(PROFILE),
            disable_coop=True, humanize=10.0,
            main_world_eval=True, i_know_what_im_doing=True,
        ) as ctx:
            page = ctx.pages[0] if ctx.pages else await ctx.new_page()
            await page.goto(URL, wait_until="domcontentloaded", timeout=60000)
            log("loaded, ждём ящик…")
            t0 = time.time()
            addr = None
            while time.time() - t0 < WAIT:
                try:
                    st = await page.evaluate(MAILBOX_JS)
                except Exception as e:
                    log(f"err {str(e)[:60]}")
                    break
                if st.get("limitN", 0) >= 1 and st.get("addr"):
                    addr = st["addr"]
                    log(f"✅ ящик {addr}")
                    break
                await asyncio.sleep(3)
            result["mailbox"] = addr

            log("перебираю хранилища…")
            res = await page.evaluate(STORE_JS)
            result.update(res or {})
            log(f"  IndexedDB базы: {res.get('dbs')}")
            for s in (res.get("idb") or []):
                log(f"  idb {s['db']}/{s['store']} ({s['count']}): {s['sample'][:220]}")
            if res.get("alpineKeys"):
                log(f"  alpine keys: {res['alpineKeys'][:20]}")
                log(f"  alpine.emails: {str(res['alpine'].get('emails'))[:300]}")
                log(f"  alpine.selectedEmail: {str(res['alpine'].get('selectedEmail'))[:300]}")
            for e in (res.get("errors") or [])[:5]:
                log(f"  ошибка: {e[:120]}")
    except Exception as e:
        result["error"] = str(e)[:300]
        log(f"FATAL: {result['error']}")

    (OUT / "probe-store.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    log("dump -> probe-store.json")


asyncio.run(main())
