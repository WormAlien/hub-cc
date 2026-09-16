#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
odyssey/backfill-passwords.py

Переносит пароли из мета-файлов прогонов в записи пула дашборда.

🔴 Зачем. Аккаунты, заведённые до 16.09, пароля в записи не имеют: авторега придумывает
пароль сама (`gen_password`), но раньше никуда его не писала - войти в кабинет руками было
нечем. Сами пароли сохранились в `odyssey/sessions/_meta/<label>.json` (файл каждого прогона),
так что терять нечего: переносим их в пул штатной ручкой `/__switch/api/od/set-password`.

Сопоставление - по адресу почты: в мета-файле `email`, в записи пула `email`.

Запуск (после рестарта дашборда, иначе ручки ещё нет):
  python odyssey/backfill-passwords.py            # показать, что перенесётся
  python odyssey/backfill-passwords.py --yes      # перенести
"""

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

DIR = Path(__file__).resolve().parent
DASH = "http://127.0.0.1:8200"


def api(method, path, body=None, timeout=15):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(DASH + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8") or "{}")
        except Exception:
            return e.code, {}
    except Exception as e:
        return 0, {"error": str(e)}


def main():
    apply = "--yes" in sys.argv

    # Пароли из мета-файлов прогонов: адрес -> пароль (последний прогон по времени важнее).
    known = {}
    for f in sorted((DIR / "sessions" / "_meta").glob("*.json"), key=lambda p: p.stat().st_mtime):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        email, password = (d.get("email") or "").strip().lower(), (d.get("password") or "").strip()
        if email and password:
            known[email] = password
    print(f"паролей в мета-файлах: {len(known)}")

    code, doc = api("GET", "/__switch/api/od/sessions")
    if code != 200:
        print(f"❌ пул не прочитался (HTTP {code}): {doc.get('error') or doc}")
        return 1
    sessions = doc.get("sessions") or doc.get("response") or []
    if isinstance(sessions, dict):
        sessions = sessions.get("sessions") or []
    print(f"аккаунтов в пуле: {len(sessions)}")

    todo = [s for s in sessions
            if not (s.get("password") or "").strip()
            and (s.get("email") or "").strip().lower() in known]
    print(f"к переносу: {len(todo)}")
    for s in todo:
        print(f"  {s.get('id')} · {s.get('email')}")

    if not todo:
        print("нечего переносить")
        return 0
    if not apply:
        print("\n(это план; для переноса добавь --yes)")
        return 0

    ok = 0
    for s in todo:
        email = (s.get("email") or "").strip().lower()
        code, res = api("POST", "/__switch/api/od/set-password",
                        {"id": s.get("id"), "password": known[email]})
        if code == 200 and res.get("ok"):
            ok += 1
            print(f"  ✅ {s.get('email')}")
        else:
            print(f"  ❌ {s.get('email')}: {res.get('error') or code}")
    print(f"\nперенесено {ok} из {len(todo)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
