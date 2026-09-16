#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
odyssey/auto-add-loop.py

Ротация прокси вокруг авторегистрации: пробует адрес из пула, и если капча Turnstile
на нём не поддалась - берёт СЛЕДУЮЩИЙ и повторяет.

🔴 Почему отдельной обёрткой, а не внутри `auto-add.py`. Замер 16.09 показал, что
требовательность капчи Clerk зависит от IP выхода: с одного адреса регистрация уходит
молча за 9 секунд, а на другом виджет «Verify you are human» висит и **не нажимается ни
из кода, ни человеком** - то есть прогон встаёт намертво. Единственное лечение - сменить
адрес. Вшивать этот цикл в драйвер значило бы переписывать его середину (запуск браузера,
ящик, форма, капча) - а драйвер рабочий и проверенный. Обёртка делает ту же работу, не
трогая его: запускает `auto-add.py` как подпроцесс и передаёт исключённые адреса.

🔴 ПОРЯДОК АДРЕСОВ БЕРЁТСЯ ИЗ ПРОБЫ, а не из пула. Замер 16.09: пул считал адреса живыми
по одной ручке `/api/auth/altcha/challenge`, а четыре прогона подряд умирали на том, что
страница регистрации вообще не открывалась (`Page.goto: Timeout 60000ms`) - и драйвер
записывал это как «капча не пройдена». Поэтому перед регистрацией адреса прогоняются
дешёвой пробой без браузера (`_research/probe-odyssey-candidates.js`): она смотрит, что
страница отдаёт 200, что сеть (ASN) ещё не трачена под подарок и что на сеть приходится
один адрес. Проба кладёт список в `odyssey/candidates.json`, а обёртка идёт по нему.

Драйвер сообщает, с какого адреса он работал: в маркере `OD_AUTOADD_RESULT` есть поле
`proxy`, а отказ помечен `retryable: true`. Обёртка собирает исключённые из этих
сообщений - гадать по логам не нужно.

Запуск (её и зовёт дашборд):
  python odyssey/auto-add-loop.py <label> [--tier own|scraper|none] [--attempts 4]
                                  [--no-candidates]   # идти по пулу, как раньше

Коды возврата: 0 - аккаунт заведён (маркер проброшен), иначе - код последнего драйвера.
"""

import asyncio
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

DIR = Path(__file__).resolve().parent
DRIVER = DIR / "auto-add.py"
PROBE = DIR.parent / "_research" / "probe-odyssey-candidates.js"
CANDIDATES = DIR / "candidates.json"
# Эмодзи в консоли cp866 роняют вывод целиком (замер 16.09) - кодировку задаём явно.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
MAX_ATTEMPTS_DEFAULT = 4   # прокси в пуле смертны: 4 попытки покрывают и мёртвый адрес, и капчу
# Сколько держать список пробы, прежде чем сходить за новым. Адреса скрапера живут часы,
# но выборка «какие из них сегодня открывают страницу» стареет за минуты - поэтому срок мал.
CANDIDATES_TTL_S = 20 * 60


def parse(argv):
    positional = [a for a in argv if not a.startswith("--")]
    label = positional[0] if positional else f"acct_{int(datetime.now().timestamp())}"
    tier, attempts = "own", MAX_ATTEMPTS_DEFAULT
    for i, a in enumerate(argv):
        if a.startswith("--tier"):
            tier = (a.split("=", 1)[1] if "=" in a
                    else (argv[i + 1] if i + 1 < len(argv) else "own")).lower()
        elif a.startswith("--attempts"):
            try:
                attempts = max(1, int(a.split("=", 1)[1] if "=" in a else argv[i + 1]))
            except Exception:
                attempts = MAX_ATTEMPTS_DEFAULT
    return label, tier, attempts


def read_candidates(log):
    """Список адресов от пробы: свежий и только из ещё не траченных сетей."""
    try:
        doc = json.loads(CANDIDATES.read_text(encoding="utf-8"))
    except Exception:
        return None
    age = time.time() - datetime.fromisoformat(str(doc.get("at")).replace("Z", "+00:00")).timestamp()
    log("проба", f"список кандидатов от {doc.get('at')} ({round(age / 60)} мин назад), "
                 f"адресов {len(doc.get('candidates') or [])}")
    return doc.get("candidates") or []


def refresh_candidates(log):
    """Гоняет дешёвую пробу: страница + свежесть сети, без браузера (~1 минута)."""
    if not PROBE.exists():
        log("проба", f"пробы нет по пути {PROBE} - иду по пулу, как раньше")
        return None
    node = shutil.which("node") or "node"
    log("проба", "беру свежие адреса: проверяю, какая страница открывается и чья сеть не трачена")
    try:
        r = subprocess.run([node, str(PROBE), "6", "3"], cwd=str(DIR.parent),
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=600,
                           env={**os.environ, "PYTHONIOENCODING": "utf-8"})
    except Exception as e:
        log("проба", f"проба не запустилась: {e}")
        return None
    for line in (r.stdout or "").splitlines():
        if line.strip().startswith(("🔴", "  --proxy", "  …", "⚠️")) or "ГОДНЫХ" in line:
            log("проба", line.strip())
    return read_candidates(log)


def marker_of(text):
    """Последний машинный маркер драйвера. Он же несёт метку отработавшего прокси."""
    found = None
    for line in (text or "").splitlines():
        if line.startswith("OD_AUTOADD_RESULT "):
            try:
                found = json.loads(line[len("OD_AUTOADD_RESULT "):])
            except Exception:
                pass
    return found


async def run_attempt(args, log):
    proc = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        cwd=str(DIR.parent), env={**os.environ, "PYTHONIOENCODING": "utf-8"})
    out = []
    while True:
        line = await proc.stdout.readline()
        if not line:
            break
        text = line.decode("utf-8", "replace").rstrip()
        out.append(text)
        # Пробрасываем строки драйвера НАВЕРХ без изменений: дашборд разбирает `OD_STAGE`
        # и `stage:`, и вторая обработка тут всё сломала бы.
        print(text, flush=True)
    code = await proc.wait()
    return code, marker_of("\n".join(out))


async def main():
    argv = sys.argv[1:]
    label, tier, attempts = parse(argv)
    tried = []

    def log(kind, msg):
        print(f"loop {kind}: {msg}", flush=True)

    # Адреса для перебора: сначала список пробы, при пустоте - прежний путь через пул.
    candidates = None
    if "--no-candidates" not in argv:
        candidates = read_candidates(log)
        if not candidates:
            candidates = refresh_candidates(log)
    if candidates:
        log("проба", f"перебираю адреса пробы: {', '.join(c['label'] for c in candidates)}")
    else:
        log("проба", "адресов от пробы нет - иду через пул (--tier), как раньше")

    for n in range(1, attempts + 1):
        # Метка профиля на каждую попытку своя: браузер поднимается заново, и общий профиль
        # на второй попытке мог бы притащить состояние неудачной (в том числе куки).
        attempt_label = label if n == 1 else f"{label}_r{n}"
        # Окно ожидания капчи короткое: на «строгом» адресе она не нажимается ни кодом, ни
        # человеком, поэтому ждать 10 минут бессмысленно - лучше сразу взять другой адрес.
        args = [sys.executable, "-u", str(DRIVER), attempt_label, "--tier", tier,
                "--captcha-wait", "45"]

        pin = None
        while candidates:
            nxt = candidates.pop(0)
            if nxt.get("label") not in tried:
                pin = nxt
                break
        if pin:
            args += ["--proxy", pin["label"]]
            log("попытка", f"{n}/{attempts} · профиль {attempt_label} · адрес {pin['label']} "
                           f"({pin.get('as', '?')} · {pin.get('country', '?')})")
        else:
            if tried:
                args += ["--exclude", ",".join(tried)]
            log("попытка", f"{n}/{attempts} · профиль {attempt_label} · исключено {len(tried)}")
        code, marker = await run_attempt(args, log)

        if code == 0 and marker and marker.get("ok"):
            log("успех", f"аккаунт заведён с адреса {marker.get('proxy')}")
            return 0

        proxy = (marker or {}).get("proxy")
        retryable = bool((marker or {}).get("retryable"))
        if proxy and proxy not in tried:
            tried.append(proxy)
        # 🪤 Адреса нет - исключать нечего, и повтор прогонит те же прокси по кругу (видели
        # 16.09: четыре попытки подряд упирались в одни и те же две сети, «исключено 0»).
        # Такой отказ лечится не повтором, а другим ярусом.
        if not proxy:
            log("стоп", f"код {code}: адрес неизвестен, повтор ничего не изменит")
            return code or 1
        if not retryable or n == attempts:
            log("стоп", f"код {code}: {str((marker or {}).get('error'))[:80]}")
            return code or 1
        log("ротация", f"адрес {proxy} не пропустил регистрацию ({(marker or {}).get('error')}) - "
                       f"беру следующий")

    return 1


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        sys.exit(130)
