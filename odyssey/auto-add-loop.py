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
# Долив пула скрапером. Живёт ЗДЕСЬ, а не отдельной ручной командой: владелец 17.09 -
# «ему надо скрапить сразу же со авторегом по кнопке». Кнопка на вкладке запускает эту обёртку,
# значит долив обязан быть её первым шагом, иначе пул остаётся пустым, а прогон уходит
# перебирать траченые сети.
SCRAPER = DIR.parent / "routing" / "lib" / "proxy-refeed.js"
SCRAPE_WANT = 12        # сколько живых адресов просим у скрапера за один долив
SCRAPE_MAX = 4000       # сколько кандидатов он смеет проверить, добиваясь этой цифры
CANDIDATES = DIR / "candidates.json"
# 🔴 Адрес для Odyssey берётся ТОЛЬКО из скрапера (решение владельца 25.09: «одисей только из
# прокси скрапера, свой (наш) пул там не должен быть»). Свои выходы - это хостинги (Private
# Layer, HOSTKEY, VPSPay), подарок $5 по ним давно разобран чужими клиентами, и прогон на таком
# адресе стоит созданного и выброшенного аккаунта: замер 25.09 - три $0 из четырёх попыток.
# Перекрываем источник переменной окружения, а НЕ правкой `proxy-pool.json`: переменная читается
# выше файла конфига (`proxy-pool.js`), поэтому остальная система, у которой там стоит
# `source: "own"`, этим не задевается.
POOL_ENV = {"PROXY_POOL_SOURCE": "scraped"}
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
# 🔴 Попыток даём ТРОЕ на аккаунт, а не «+2». Замер 18.09: из пяти адресов годен примерно
# один (два класса отказа - приложение не собралось и виджет Turnstile не приехал), поэтому
# на десяток аккаунтов нужен запас втрое. И потолок по ВРЕМЕНИ тоже нужен: круги стоят
# минуты, и «вечный ретрай» владелец справедливо не хочет (заявка 18.09).
MAX_MINUTES_DEFAULT = 120


def parse(argv):
    positional = [a for a in argv if not a.startswith("--")]
    label = positional[0] if positional else f"acct_{int(datetime.now().timestamp())}"
    # Параллель по умолчанию - три. Замер 19.09: попытка идёт ~2.5 минуты, годен примерно
    # каждый пятый-шестой адрес, и с двумя параллельными аккаунт выходил за 8-10 минут.
    # Машина держит три попытки (около 700 МБ каждая при 6-8 ГБ свободных), это ~1 аккаунт
    # за 5-6 минут.
    tier, attempts, count, mail, parallel = "scraper", None, 1, "22do", 3
    for i, a in enumerate(argv):
        if a.startswith("--tier"):
            tier = (a.split("=", 1)[1] if "=" in a
                    else (argv[i + 1] if i + 1 < len(argv) else "own")).lower()
        elif a.startswith("--attempts"):
            try:
                attempts = max(1, int(a.split("=", 1)[1] if "=" in a else argv[i + 1]))
            except Exception:
                attempts = None
        elif a.startswith("--mail"):
            # Какая почта: 22do (по умолчанию) или emailnator. Пробрасываем как есть -
            # проверяет значение драйвер, у него же и значения по умолчанию.
            mail = (a.split("=", 1)[1] if "=" in a
                    else (argv[i + 1] if i + 1 < len(argv) else "22do")).lower()
        elif a.startswith("--parallel"):
            # Сколько попыток вести ОДНОВРЕМЕННО. Замер 19.09: одна попытка идёт ~2.5 минуты,
            # и годен примерно каждый третий адрес - то есть аккаунт выходит за 10-15 минут.
            # Две параллельные попытки почти вдвое сокращают это, не меняя логику выбора.
            try:
                parallel = max(1, min(4, int(a.split("=", 1)[1] if "=" in a else argv[i + 1])))
            except Exception:
                parallel = 3
        elif a.startswith("--count"):
            # Сколько аккаунтов завести за ОДИН запуск (ручка на вкладке). Раньше прогон
            # останавливался на первом успехе, и «завести три» означало три нажатия кнопки.
            try:
                count = max(1, min(30, int(a.split("=", 1)[1] if "=" in a else argv[i + 1])))
            except Exception:
                count = 1
    # На каждый аккаунт нужен свой адрес и своя сеть, а адрес может не пропустить
    # регистрацию - поэтому попыток даём с запасом, но не меньше четырёх.
    if attempts is None:
        attempts = max(MAX_ATTEMPTS_DEFAULT, count * 3)
    return label, tier, attempts, count, mail, parallel


def read_candidates(log):
    """Список адресов от пробы: свежий и только из ещё не траченных сетей.

    Возвращает None, если списка нет ИЛИ он протух. Протухший список опаснее отсутствующего:
    адреса скрапера живут часами, но «какие из них сегодня открывают страницу» стареет за
    минуты, а прогон по старому списку выглядит как обычный перебор мёртвых адресов.
    """
    try:
        doc = json.loads(CANDIDATES.read_text(encoding="utf-8"))
    except Exception:
        return None
    try:
        at = datetime.fromisoformat(str(doc.get("at")).replace("Z", "+00:00"))
        age = time.time() - at.timestamp()
    except Exception:
        log("проба", "у списка кандидатов нечитаемая дата - беру новый")
        return None
    fresh = doc.get("candidates") or []
    if age > CANDIDATES_TTL_S:
        log("проба", f"список кандидатов от {doc.get('at')} протух "
                     f"({round(age / 60)} мин > {CANDIDATES_TTL_S // 60} мин) - беру новый")
        return None
    log("проба", f"список кандидатов от {doc.get('at')} ({round(age / 60)} мин назад), "
                 f"адресов {len(fresh)}")
    return fresh


async def refresh_candidates(log, want=3):
    """Гоняет дешёвую пробу: страница + частая пачка скриптов + чужие хосты, без браузера.

    `want` - сколько годных достаточно: проба останавливается на этом числе, а не перебирает
    весь пул. Для запуска регистрации хватает одного адреса.

    🔴 Вывод пробы ПРОБРАСЫВАЕМ построчно, а не собираем в буфер. Первая версия звала её
    через `subprocess.run(capture_output=True)` и печатала только итог - полторы минуты в
    панели дашборда было пусто, и владелец справедливо спросил «чёт не вижу прогресс»:
    от зависшего прогона это неотличимо. Проба печатает строку на каждого кандидата, так
    что теперь видно, как идёт перебор.
    """
    if not PROBE.exists():
        log("проба", f"пробы нет по пути {PROBE} - иду по пулу, как раньше")
        return None
    node = shutil.which("node") or "node"
    log("проба", "беру свежие адреса: проверяю, какая страница открывается и чья сеть не трачена "
                 "(это занимает около минуты, строки пойдут по мере перебора)")
    try:
        proc = await asyncio.create_subprocess_exec(
            node, str(PROBE), "6", str(want),
            cwd=str(DIR.parent), stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env={**os.environ, "PYTHONIOENCODING": "utf-8", **POOL_ENV})
    except Exception as e:
        log("проба", f"проба не запустилась: {e}")
        return None
    while True:
        line = await proc.stdout.readline()
        if not line:
            break
        text = line.decode("utf-8", "replace").rstrip()
        if text.strip():
            log("проба", text.strip())
    try:
        await asyncio.wait_for(proc.wait(), timeout=60)
    except asyncio.TimeoutError:
        log("проба", "проба не завершилась - иду по пулу")
        return None
    return read_candidates(log)


async def scrape_pool(log, want=SCRAPE_WANT):
    """Доливает пул свежими прокси до того, как пойдёт перебор адресов.

    🔴 Замер 17.09: к полудню проба находила **0 годных адресов** - все свежие сети в пуле
    кончились, и прогон уходил перебирать траченые (по 2.5 минуты на адрес впустую).
    Источник адресов должен пополняться сам, в том же нажатии кнопки, иначе «авторега»
    превращается в ручную работу.

    Коды возврата скрапера не разбираем: он пишет свой итог, а мы просто сообщаем, что вышло.
    """
    if not SCRAPER.exists():
        log("скрап", f"скрапера нет по пути {SCRAPER} - иду с тем, что есть")
        return False
    node = shutil.which("node") or "node"
    log("скрап", f"доливаю пул: прошу {want} живых адресов (это несколько минут)")
    try:
        proc = await asyncio.create_subprocess_exec(
            node, str(SCRAPER), "--host", "odysseyapi.tech",
            "--want", str(want), "--max", str(SCRAPE_MAX),
            "--path", "/api/auth/altcha/challenge",
            cwd=str(DIR.parent), stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env={**os.environ, "PYTHONIOENCODING": "utf-8", "MSYS_NO_PATHCONV": "1"})
    except Exception as e:
        log("скрап", f"скрапер не запустился: {e}")
        return False
    while True:
        line = await proc.stdout.readline()
        if not line:
            break
        text = line.decode("utf-8", "replace").rstrip()
        if text.strip():
            log("скрап", text.strip()[:200])
    code = await proc.wait()
    log("скрап", f"скрапер закончил (код {code})")
    return True


def fresh_only(cands, log):
    """Выбрасывает адреса из уже траченых сетей.

    🔴 Фильтруем при НАПОЛНЕНИИ буфера, а не при выдаче. Замер 18.09: в буфере лежал адрес
    из прошлого прогона, его сеть за это время ушла в траченые - проверка при выдаче его
    сняла, буфер опустел, и обёртка ушла на старый путь «через пул», где висела мёртвая
    привязка (прогон умер кодом 5). Правильное поведение в этой ситуации - не падать в пул,
    а дождаться долива, и для этого фильтр должен срабатывать раньше.
    """
    used = spent_networks()
    keep, dropped = [], 0
    for c in cands or []:
        asn = str(c.get("as") or "")
        if asn and asn in used:
            dropped += 1
            continue
        keep.append(c)
    if dropped:
        log("сеть", f"{dropped} адрес(ов) из пробы отсеяно: их сети уже трачены")
    return keep


def spent_networks():
    """Сети из леджера - читаем файл КАЖДЫЙ раз: за время прогона он меняется."""
    try:
        return set(json.loads((DIR / "networks-used.json").read_text(encoding="utf-8")).keys())
    except Exception:
        return set()


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
        cwd=str(DIR.parent), env={**os.environ, "PYTHONIOENCODING": "utf-8", **POOL_ENV})
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
    label, tier, attempts, count, mail, parallel = parse(argv)
    tried = []
    made = 0
    started = time.time()
    max_minutes = MAX_MINUTES_DEFAULT
    for i, a in enumerate(argv):
        if a.startswith("--max-minutes"):
            try:
                max_minutes = max(5, int(a.split("=", 1)[1] if "=" in a else argv[i + 1]))
            except Exception:
                pass

    def log(kind, msg):
        print(f"loop {kind}: {msg}", flush=True)

    if count > 1:
        log("задача", f"завести аккаунтов: {count} (попыток до {attempts})")

    # 🔴 Адреса пополняются САМИ, в фоне, и с запасом. Заявка владельца 17.09: «я нажимаю
    # кнопку, оно скрапит в фоне, находит адрес с незанятой сетью, регает, скрапит дальше;
    # если аккаунтов два - скрапит адреса три, и наперёд чуть запасом». Поэтому здесь буфер:
    # долив скрапером + проба по нему идут отдельной задачей, а цикл регистрации только берёт
    # из буфера готовое. Пустой буфер не ошибка - цикл просто дожидается долива.
    buffer = []
    prefetch = None

    async def refill(fast=False):
        """Долив пула скрапером и проба по нему: возвращает годные адреса.

        🔴 `fast` - режим ПЕРВОГО адреса, и это заявка владельца 18.09: «оно должно как найдёт
        уже первый адрес стартовать, а то запуск долгий». В нём скрапер просит ОДИН живой
        адрес и останавливается, проба тоже ищет один. Регистрация начинается сразу, а
        остальные адреса добираются в фоне, пока идёт первая попытка.
        """
        # 🔴 Два адреса вперёд, а не один. Замер 18.09 по секундам: скрап с пробой занимают
        # около 2.5 минуты, а попытка регистрации - 2, поэтому с одним адресом цикл почти
        # всегда ждал долив, и в эти минуты простоя ничего не происходило. Два в буфере
        # закрывают разрыв: пока идёт попытка, следующий адрес успевает готовиться.
        # 🔴 Просим ПАЧКУ, а не один адрес, и это исправление причины вчерашних остановок.
        # Замер 19.09: до полного фильтра доходит примерно один адрес из пяти (30 живых по
        # ручке ALTCHA → 6 годных по странице, чанкам и чужим хостам). Прося один, обёртка
        # почти всегда получала адрес, который проба тут же отбраковывала, и после трёх таких
        # кругов останавливалась с «ни одного годного адреса». Скрап при этом быстрый:
        # 30 живых за 93 секунды, так что просить пачку дешевле, чем ждать впустую.
        with_budget = 8 if fast else max(12, (count - made) + 4)
        log("скрап", f"нужно ещё {count - made}, беру: {with_budget}")
        await scrape_pool(log, with_budget)
        return fresh_only(await refresh_candidates(log, want=2 if fast else 4) or [], log)

    if "--no-candidates" not in argv:
        buffer = fresh_only(read_candidates(log) or [], log)
        if buffer:
            log("проба", f"из прошлого списка готовы: {', '.join(c['label'] for c in buffer)}")
        elif "--no-scrape" not in argv:
            # Предзагрузка идёт ФОНОМ: пока цикл начнёт первую попытку, адреса уже копятся.
            prefetch = asyncio.create_task(refill(fast=True))
    if "--no-candidates" in argv:
        log("проба", "адреса от пробы отключены - иду через пул (--tier), как раньше")

    # 🔴 Попытки идут ПАРАЛЛЕЛЬНО, а не по одной. Замер 19.09: попытка занимает ~2.5 минуты,
    # а годен примерно каждый третий адрес - то есть один аккаунт выходил за 10-15 минут.
    # Логика выбора адреса при этом не меняется: каждая попытка берёт свой адрес из буфера, и
    # у каждой свои профили - браузера и ящика (два Firefox в один каталог не пустят).
    inflight = {}       # задача → (номер попытки, метка профиля, адрес)
    n = 0
    empty_refills = 0

    async def pick_address():
        """Свежий адрес из буфера. Пополняет буфер сам; None - годных адресов нет."""
        nonlocal empty_refills, prefetch
        while True:
            while buffer:
                nxt = buffer.pop(0)
                if nxt.get("label") in tried:
                    continue
                # Последний сторож свежести: между наполнением буфера и выдачей проходит время,
                # и сеть могла уйти под другой прогон (замер 17.09 12:43 - адрес пролежал в
                # буфере 14 минут, и попытка на нём сгорела впустую).
                asn = str(nxt.get("as") or "")
                if asn and asn in spent_networks():
                    log("сеть", f"{asn} потрачена, пока адрес лежал в буфере - пропускаю {nxt.get('label')}")
                    continue
                return nxt
            if "--no-candidates" in argv:
                return None
            if prefetch is not None:
                log("скрап", f"жду долив: заведено {made} из {count}, адрес ещё готовится")
                buffer.extend(await prefetch)
                prefetch = None
            else:
                buffer.extend(await refill(fast=(count - made <= 1)))
            if not buffer:
                empty_refills += 1
                if empty_refills >= 3:
                    log("стоп", "три долива подряд не дали ни одного годного адреса - выхожу")
                    return None
                log("скрап", f"долив пустой ({empty_refills}/3) - пробую ещё раз")

    while made < count and (n < attempts or inflight):
        spent_min = (time.time() - started) / 60
        if spent_min > max_minutes:
            log("стоп", f"прошло {round(spent_min)} мин (потолок {max_minutes}) - "
                        f"заведено {made} из {count}, дальше не кручу")
            break
        # Добираем попытки, пока есть место в пуле и не выбраны ни попытки, ни аккаунты.
        while len(inflight) < parallel and n < attempts and (made + len(inflight)) < count:
            pin = await pick_address()
            if pin is None:
                break
            n += 1
            # Метка профиля на каждую попытку своя: браузер поднимается заново, и общий профиль
            # притащил бы в новую попытку состояние предыдущей (в том числе куки).
            attempt_label = label if n == 1 else f"{label}_r{n}"
            args = [sys.executable, "-u", str(DRIVER), attempt_label, "--tier", tier,
                    "--captcha-wait", "75", "--mail", mail]
            if pin:
                args += ["--proxy", pin["label"]]
                log("попытка", f"{n}/{attempts} · профиль {attempt_label} · адрес {pin['label']} "
                               f"({pin.get('as', '?')} · {pin.get('country', '?')})")
            else:
                args += ["--exclude", ",".join(tried)]
                log("попытка", f"{n}/{attempts} · профиль {attempt_label} · исключено {len(tried)}")
            inflight[asyncio.create_task(run_attempt(args, log))] = (n, attempt_label, pin)
            # Следующий адрес готовим сразу: пока попытка идёт, долив успевает отработать.
            ahead_need = 2 if (count - made) > 1 else 1
            if (prefetch is None or prefetch.done()) and len(buffer) < ahead_need                     and "--no-candidates" not in argv:
                prefetch = asyncio.create_task(refill(fast=(count - made <= 1)))
        if not inflight:
            break
        done, _pending = await asyncio.wait(list(inflight), return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            num, attempt_label, pin = inflight.pop(task)
            code, marker = task.result()
            if code == 0 and (marker or {}).get("ok"):
                made += 1
                log("успех", f"аккаунт {made} из {count} заведён с адреса {(marker or {}).get('proxy')}")
                continue
            # Неудача не останавливает прогон: исключаем адрес и берём следующий. Останавливают
            # только потолки - попытки, время и три пустых долива подряд.
            proxy = (marker or {}).get("proxy") or (pin or {}).get("label")
            if proxy and proxy not in tried:
                tried.append(proxy)
            log("ротация", f"попытка {num}: {str((marker or {}).get('error'))[:70]} - беру следующий адрес")
    return 0 if made >= count else 1


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        sys.exit(130)
