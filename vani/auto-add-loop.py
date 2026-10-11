#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
vani/auto-add-loop.py

Ротация прокси вокруг регистрации vani: пробует адрес из пула, не вышло - берёт СЛЕДУЮЩИЙ
и повторяет. Аналог `odyssey/auto-add-loop.py`, и по той же причине.

🔴 Зачем обёртка, а не цикл внутри драйвера. Публичный скрап-прокси живёт минуты и часто
умирает ПОСРЕДИ прогона (замер 10.10: `NS_ERROR_NET_PARTIAL_TRANSFER` на форме, зависание
на verify). Единственное лечение - сменить адрес. Вшивать цикл в драйвер значило бы
переписывать его середину (браузер, ящик, форма, капча) - а драйвер проверенный. Обёртка
делает то же, не трогая его: запускает `auto-add.py` подпроцессом и передаёт исключённые
адреса в `--exclude`.

🔴 Порядок: сначала ДОЛИВ свежих (скрап под c.vani.ai прямо перед прогоном), потом
попытки. Пул по вчерашнему файлу садится на дохлых.

Запуск (её и зовёт дашборд):
  python vani/auto-add-loop.py <label> [--tier scraper|own|none] [--attempts 4]

Маркеры пробрасываются как есть: VN_STAGE, VN_AUTOADD_RESULT.
Код возврата: 0 - аккаунт заведён, иначе код последнего драйвера.
"""

import asyncio
import json
import os
import re
import subprocess
import sys
from pathlib import Path

DIR = Path(__file__).resolve().parent
DRIVER = DIR / "auto-add.py"

argv = sys.argv[1:]
label = "autoreg"
tier = "scraper"
attempts = 4          # потолок ПОПЫТОК на весь прогон
want = 1              # ЦЕЛЬ: сколько аккаунтов завести (сколько успехов нужно)
mail = "emailnator"
i = 0
while i < len(argv):
    a = argv[i]
    if a == "--tier" and i + 1 < len(argv):
        tier = argv[i + 1]; i += 1
    elif a.startswith("--tier="):
        tier = a.split("=", 1)[1]
    elif a == "--attempts" and i + 1 < len(argv):
        attempts = int(argv[i + 1]); i += 1
    elif a.startswith("--attempts="):
        attempts = int(a.split("=", 1)[1])
    elif a == "--want" and i + 1 < len(argv):
        want = int(argv[i + 1]); i += 1
    elif a.startswith("--want="):
        want = int(a.split("=", 1)[1])
    elif a == "--mail" and i + 1 < len(argv):
        mail = argv[i + 1]; i += 1
    elif not a.startswith("--"):
        label = a
    i += 1
label = re.sub(r"[^\w-]", "_", label) or "autoreg"
if tier not in ("none", "scraper", "own"):
    tier = "scraper"
want = max(1, min(50, want))
# 🪤 Прежний потолок был 8 попыток И цикл выходил на ПЕРВОМ успехе - то есть за прогон
# заводился ровно один аккаунт. Теперь цель (`--want`) задаёт, СКОЛЬКО нужно, а попыток
# под неё поднимаем: прокси скрапера мрут, и на пачку аккаунтов дефолтных 4 не хватило бы -
# цикл сдался бы на середине, выглядя как «авторега сломалась».
attempts = max(attempts, want * 4) if want > 1 else attempts
attempts = max(1, min(160, attempts))


def log(kind, msg):
    from datetime import datetime
    print(f"[{datetime.now():%H:%M:%S}] {kind:<9} {msg}", flush=True)


def stage(name, note=""):
    print("VN_STAGE " + json.dumps({"stage": name, "note": note or None}, ensure_ascii=False), flush=True)


async def refeed():
    """Долив свежих прокси под c.vani.ai прямо перед прогоном (как odyssey `refill`)."""
    script = DIR.parent / "routing" / "lib" / "proxy-refeed.js"
    if not script.exists():
        log("ПРОКСИ", "proxy-refeed.js нет - долив пропущен")
        return
    log("ПРОКСИ", "доливаю свежие прокси (скрап под c.vani.ai)...")
    cmd = ["node", str(script), "--host", "c.vani.ai", "--path", "/api/announcements",
           "--want", "12", "--max-candidates", "4000"]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, cwd=str(DIR.parent),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env={**os.environ, "PROXY_POOL_SOURCE": "scraped", "PYTHONIOENCODING": "utf-8"})
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=600)
        for l in (out or b"").decode("utf-8", "replace").strip().splitlines()[-2:]:
            log("ПРОКСИ", f"  {l.strip()[:120]}")
    except asyncio.TimeoutError:
        log("ПРОКСИ", "долив не уложился в 10 мин - иду с тем, что есть")
    except Exception as e:
        log("ПРОКСИ", f"долив сорвался: {str(e)[:100]}")


def run_one(attempt, exclude):
    """Один прогон драйвера. Возвращает (code, result_dict, proxy_label)."""
    cmd = [sys.executable, str(DRIVER), f"{label}_a{attempt}", "--tier", tier, "--mail", mail]
    if exclude:
        cmd += ["--exclude", ",".join(exclude)]
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PROXY_POOL_SOURCE": "scraped"}
    result = {}
    proxy_used = None
    proc = subprocess.Popen(cmd, cwd=str(DIR.parent), stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, encoding="utf-8",
                            errors="replace", env=env, bufsize=1)
    for line in proc.stdout:
        line = line.rstrip("\n")
        print(line, flush=True)                      # пробрасываем лог и маркеры в дашборд
        if '"VN_STAGE' in line or line.startswith("VN_STAGE"):
            continue
        if line.startswith("VN_AUTOADD_RESULT"):
            try:
                result = json.loads(line[len("VN_AUTOADD_RESULT"):].strip())
            except Exception:
                pass
        m = re.search(r"ПРОКСИ\s+(\S+://\S+)\s+·\s+ярус", line)
        if m:
            proxy_used = m.group(1)
    proc.wait()
    if result.get("proxy"):
        proxy_used = result["proxy"]
    return proc.returncode, result, proxy_used


async def main():
    stage("refeed", "долив свежих прокси")
    await refeed()

    exclude = []
    last_code = 1
    ok = 0
    for attempt in range(1, attempts + 1):
        stage("attempt", f"попытка {attempt}/{attempts} · заведено {ok}/{want}")
        log("ПОПЫТКА", f"{attempt}/{attempts} · заведено {ok}/{want}" + (f" · исключено {len(exclude)}" if exclude else ""))
        code, result, proxy_used = await asyncio.get_event_loop().run_in_executor(
            None, run_one, attempt, list(exclude))
        last_code = code
        if code == 0 and result.get("ok"):
            ok += 1
            log("ИТОГ", f"✅ аккаунт {ok}/{want} заведён с {attempt}-й попытки (прокси {proxy_used or 'прямой'})")
            if ok >= want:
                log("ИТОГ", f"✅ ЦЕЛЬ достигнута: заведено {ok}/{want}")
                return 0
            continue
        if proxy_used:
            exclude.append(proxy_used)
            log("ПОПЫТКА", f"адрес {proxy_used} отпал - беру следующий")
        else:
            log("ПОПЫТКА", "прокси не был назначен - пробую ещё")
    log("ИТОГ", f"❌ за {attempts} попыток заведено {ok}/{want} (последний код {last_code})")
    return 0 if ok >= want else last_code


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        sys.exit(130)
