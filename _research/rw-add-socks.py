#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
_research/rw-add-socks.py

Добавляет SOCKS5-инбаунд (`mixed`, xray-стиль) в профиль Remnawave через API панели.
Панель 3.3.2, токен - в C:/Users/WormAlien/.secrets/remnawave.token.

Зачем через API, а не руками в UI: правка одного ключа в большом JSON руками - это
ровно тот случай, где теряется сосед. Скрипт читает профиль ИЗ ПАНЕЛИ, добавляет
инбаунд в конец и отправляет целиком, поэтому стереть чужие инбаунды не может.

Безопасность: перед отправкой печатает полный список инбаундов «до» и «после» и
требует `--yes`. Бэкап всех профилей лежит в configs/remnawave-live-<дата>/.

🪤 Грабли синтаксиса (из вики, [[SOCKS5 Proxy]]): протокол именно `mixed`, а не `socks`;
порт - в поле `port`, а не `listen_port`; учётки - в `settings.accounts[{user,pass}]`,
а не в `users[]`. Иначе панель сохранит, а xray не поднимется.

Запуск:
  python _research/rw-add-socks.py --profile DE --port 40081 --dry
  python _research/rw-add-socks.py --profile DE --port 40081 --yes
"""

import argparse
import json
import ssl
import sys
import urllib.error
import urllib.request

PANEL = "https://panel.xgate.online"
TOKEN_FILE = r"C:\Users\WormAlien\.secrets\remnawave.token"


def api(method, path, body=None, timeout=30):
    with open(TOKEN_FILE, encoding="utf-8") as f:
        token = f.read().strip()
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(PANEL + path, data=data, method=method)
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("Content-Type", "application/json")
    # Панель за своим сертификатом; проверку не отключаем без нужды - если упадёт
    # на сертификате, это сигнал, а не помеха.
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
            return r.status, json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw[:500]}
    except Exception as e:
        return 0, {"error": str(e)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", required=True, help="имя профиля, напр. DE")
    ap.add_argument("--port", type=int, default=40081)
    ap.add_argument("--tag", default="socks5-pool")
    ap.add_argument("--user", default="WormAlien")
    ap.add_argument("--pass", dest="password", default="W@W@W@123456789")
    ap.add_argument("--yes", action="store_true", help="без этого только показать план")
    args = ap.parse_args()

    code, doc = api("GET", "/api/config-profiles")
    if code != 200:
        print(f"❌ не прочитал профили: HTTP {code} {doc}")
        return 1
    profs = doc["response"]["configProfiles"]
    prof = next((p for p in profs if p.get("name") == args.profile), None)
    if not prof:
        print("❌ профиль не найден. Есть:", ", ".join(p.get("name", "?") for p in profs))
        return 1

    cfg = prof.get("config") or {}
    inbounds = cfg.get("inbounds") or []
    before = [f"{i.get('protocol')}@{i.get('port')}#{i.get('tag')}" for i in inbounds]
    print(f"профиль «{prof['name']}» ({prof['uuid'][:8]}), инбаундов: {len(inbounds)}")
    for t in before:
        print("   ", t)

    if any(i.get("tag") == args.tag for i in inbounds):
        print(f"⚠️ инбаунд с тегом {args.tag} уже есть - ничего не делаю")
        return 0

    # UDP выключен намеренно: через SOCKS5/UDP xray пойдёт в relay, а нам нужен
    # только TCP до панелей. Меньше поверхности - меньше причин для сюрпризов.
    new_inbound = {
        "tag": args.tag,
        "port": args.port,
        "listen": "0.0.0.0",
        "protocol": "mixed",
        "settings": {
            "udp": False,
            "auth": "password",
            "accounts": [{"user": args.user, "pass": args.password}],
        },
        "sniffing": {"enabled": True, "destOverride": ["http", "tls"]},
    }
    cfg["inbounds"] = inbounds + [new_inbound]

    after = before + [f"{new_inbound['protocol']}@{new_inbound['port']}#{new_inbound['tag']}"]
    print("\nстанет:")
    for t in after:
        print("   ", t)
    print(f"\nпорт {args.port}, учётка {args.user}, udp выключен")

    if not args.yes:
        print("\n(это план; для отправки добавь --yes)")
        return 0

    code, res = api("PATCH", "/api/config-profiles",
                    {"uuid": prof["uuid"], "name": prof["name"], "config": cfg})
    print(f"\nPATCH -> HTTP {code}")
    if code not in (200, 201):
        print(json.dumps(res, ensure_ascii=False)[:600])
        return 1

    # Проверяем ПО ПАНЕЛИ, а не по коду ответа: код 200 ещё не значит, что инбаунд
    # сохранился так, как мы его послали.
    code2, doc2 = api("GET", "/api/config-profiles")
    p2 = next((p for p in doc2["response"]["configProfiles"] if p.get("uuid") == prof["uuid"]), None)
    tags = [f"{i.get('protocol')}@{i.get('port')}#{i.get('tag')}" for i in (p2.get("config", {}) or {}).get("inbounds", [])]
    ok = any(i.get("tag") == args.tag for i in (p2.get("config", {}) or {}).get("inbounds", []))
    print("после записи в профиле:", ", ".join(tags))
    print("✅ инбаунд на месте" if ok else "❌ инбаунда в профиле НЕТ - правку надо откатывать")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
