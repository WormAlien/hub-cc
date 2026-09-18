#!/usr/bin/env python3
"""Find a small number of live proxies for one specific host.

Why this exists
---------------
Public proxies are short-lived: the pool scraped an hour ago is mostly dead by
the time autoreg runs, and re-running the whole scraper pipeline (scrape ->
classify -> three stability passes over thousands of candidates) takes minutes.
For "I need N accounts right now" that is the wrong shape.

This tool answers exactly one question: *which proxies can reach this host right
now?* It scrapes the enabled sources, keeps only CONNECT/TLS-capable transport
(both HTTP-family and SOCKS), checks every candidate against the target host's
real HTTPS endpoint, and stops as soon as ``--want`` usable proxies are found.
SOCKS is tried first because that is what actually survives here: 148 of 244
HTTP/HTTPS entries could not tunnel at all.

Output is written in the same per-line-scheme format the pool reads, so
``routing/proxy-pool.json`` can point ``file`` straight at it.

Usage
-----
    python -m proxy_scraper.find_for_host --host www.aikeysapi.com --want 3
    python -m proxy_scraper.find_for_host --host www.aikeysapi.com --want 3 --json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
from dataclasses import replace
from pathlib import Path
from typing import List, Optional, Sequence

from .domain_checker import DomainProxyChecker
from .models import DomainTarget, ProxyRecord
from .proxy_io import format_proxy_uri, parse_proxy_file, parse_proxy_files
from .scraper import ProxyScraper
from .services import load_services

# Public sources are re-scraped on every run on purpose: a cached list is the
# thing that goes stale. This is the whole point of the tool.
DEFAULT_SOURCES = Path(__file__).resolve().parents[1] / "config" / "proxy_services.json"
DEFAULT_OUT = Path(__file__).resolve().parents[1] / "export" / "live-for-host.txt"

# Cheap proxy-type prefilter: only keep candidates whose port looks like a proxy.
# A public list is mostly web servers and CDN edges that answer 400 to CONNECT
# (measured 12.09: 16 of 30 sampled "HTTP proxies" were Cloudflare edges). The
# real verdict is still the HTTPS check below; this only avoids paying for it.
PROXY_PORTS = {
    80, 443, 1080, 1081, 1088, 1147, 2080, 3128, 3129, 3310, 4145, 5432,
    8008, 8020, 8080, 8081, 8088, 8118, 8888, 9000, 9090, 9098, 9200, 9677,
    10007, 10080, 10800, 10801, 10809, 10811, 10997, 11108, 11209, 12648,
    12677, 14222, 20800,
}

# 🔴 Формат строки прогресса — контракт с дашбордом, а не украшение лога.
# `routing/transparent-proxy.js` (akFindProxyLine / rmFindProxyLine) читает stderr
# валидатора регуляркой /^…\s*проверено\s+(\d+)\/(\d+),\s*живых\s+(\d+)/ и только из неё
# берёт счётчики `checked` / `total` и текст фазы. В скобках строки `✓` стоит
# найдено/нужно, а не проверено/всего, поэтому честные счётчики приходят ТОЛЬКО отсюда.
# Пока проверка шла чанками, строка печаталась после каждого чанка; окно проверок теперь
# скользящее, границ батча нет — расписание ниже её и заменяет. Любая правка слов, «/»
# или «, живых » оставит панель с надписью «ищу…» и нулями на всё время прогона
# (ровно баг 13.09: минуты без единой цифры).
PROGRESS_EVERY = 25          # каждые N завершённых проверок
PROGRESS_SECONDS = 1.5       # и не реже, чем раз в столько секунд — период опроса вкладки


def _pool_protocol(record: ProxyRecord) -> str:
    """Protocol as the pool must read it.

    HTTP-family collapses to ``http``: the strict checker labels a CONNECT-capable
    proxy ``HTTPS`` ("can tunnel TLS"), while the pool reads ``https://`` as "speak
    TLS to the proxy itself", which public proxies do not do.
    """
    protocol = (record.protocol or "").strip().lower()
    return "http" if protocol in {"http", "https"} else protocol


def _safe_uri(record: ProxyRecord) -> str:
    """URI for log lines. Never raises: a log line must not abort a run.

    ``format_proxy_uri`` rejects non-tunnelable protocols on purpose, but it is
    called here from inside the progress callback, and an exception there would
    propagate out of ``check_many`` and lose every proxy already found.
    """
    try:
        return format_proxy_uri(record)
    except ValueError:
        return f"{(record.protocol or '?').strip().lower()}://{record.address}"


def _target_for(host: str, path: str) -> DomainTarget:
    return DomainTarget(
        name="host",
        url=f"https://{host}{path}",
        host=host,
        path=path,
        port=443,
        use_tls=True,
        enabled=True,
        # У Odyssey ответ ручки ALTCHA - `{"parameters":…}`, а не форма New API: критерий
        # `newapi_status` требовал `data` словарём и браковал живые прокси (замер 17.09).
        response="json_any",
    )


def _socks_first(records: Sequence[ProxyRecord]) -> List[ProxyRecord]:
    """SOCKS before HTTP-family, each group shuffled.

    SOCKS entries are the ones that actually tunnel HTTPS here, so spending the
    time budget on them first means a run reaches its target count sooner.
    """
    import random

    socks = [r for r in records if (r.protocol or "").upper() in {"SOCKS4", "SOCKS5"}]
    http = [r for r in records if (r.protocol or "").upper() in {"HTTP", "HTTPS"}]
    random.shuffle(socks)
    random.shuffle(http)
    return socks + http


def find(
    host: str,
    want: int,
    *,
    path: str = "/api/status",
    sources_file: Path = DEFAULT_SOURCES,
    max_candidates: int = 0,
    workers: int = 60,
    timeout: int = 8,
    log=print,
) -> List[ProxyRecord]:
    services = [s for s in load_services(str(sources_file)) if s.enabled]
    # 🔴 Ограничиваем СБОР, а не только проверку. Раньше скрапер тянул все адреса со всех
    # источников (живой замер 17.09: 288 312 кандидатов) и лишь потом обрезал список до
    # `--max`. Держать это в памяти на ровном месте - сотни мегабайт, и 17.09 систему
    # прибило по нехватке памяти прямо посреди прогона. Берём по 200 адресов с источника:
    # 70 источников × 200 ≈ 14 тысяч, чего с большим запасом хватает перебору.
    per_source = 200 if not max_candidates else max(100, min(2000, max_candidates * 4 // max(1, len(services))))
    scraper = ProxyScraper(
        services,
        threads=workers, timeout=timeout, retries=0, max_per_source=per_source,
    )
    log(f"скраплю источники → {host}")
    records = scraper.run()
    log(f"собрано кандидатов: {len(records)}")

    candidates = [r for r in records if r.port in PROXY_PORTS]
    log(f"похожи на прокси (порт): {len(candidates)}")

    ordered = _socks_first(candidates)
    if max_candidates > 0:
        ordered = ordered[:max_candidates]

    target = _target_for(host, path)
    checker = DomainProxyChecker(workers=workers, timeout=timeout, retries=0)

    found: List[ProxyRecord] = []
    started = time.perf_counter()
    # Состояние строк прогресса. Раньше их печатал внешний цикл по батчам: батч
    # закончился — вывели «проверено X/Y». Окно проверок теперь скользящее, границ
    # батча нет, поэтому счётчик ведём здесь и печатаем по своему расписанию.
    progress_state = {"last_done": 0, "last_at": time.monotonic()}

    def emit_progress(done: int, total: int) -> None:
        progress_state["last_done"] = done
        progress_state["last_at"] = time.monotonic()
        # Формат дословный, его читает дашборд. См. PROGRESS_EVERY выше.
        log(f"  … проверено {done}/{total}, живых {len(found)}")

    def collect(done: int, total: int, res) -> None:
        if res.passed_targets:
            rec = res.proxy
            rec.working = True
            rec.latency_ms = res.latency_ms
            found.append(rec)
            log(f"  ✓ {_safe_uri(rec)}  {res.latency_ms:.0f} мс  ({len(found)}/{want})")
        due = (
            done - progress_state["last_done"] >= PROGRESS_EVERY
            or time.monotonic() - progress_state["last_at"] >= PROGRESS_SECONDS
            or done >= total
        )
        if due:
            emit_progress(done, total)

    checked = checker.check_many(list(ordered), [target], progress_cb=collect, stop_after=want)
    # Досылаем итоговую строку, если последняя проверка попала между расписаниями:
    # панель иначе замрёт на промежуточной цифре до конца прогона.
    if len(checked) != progress_state["last_done"]:
        emit_progress(len(checked), len(ordered))
    if len(found) >= want:
        log(f"набрал {len(found)} за {time.perf_counter() - started:.0f} с — останавливаюсь")
        return found[:want]

    log(f"живых найдено {len(found)} из {len(ordered)} за {time.perf_counter() - started:.0f} с")
    return found


def write_pool(records: Sequence[ProxyRecord], out_file: Path, *, log=print) -> Path:
    """Write pool-ready lines, translating the checker's protocol semantics.

    The strict checker labels a CONNECT-capable HTTP-family proxy as ``HTTPS``,
    meaning "this proxy can tunnel TLS". The pool reads ``https://`` differently:
    "open a TLS session TO the proxy first", which public proxies do not speak.
    Writing the checker's label straight through made every one of 41 freshly
    verified proxies fail in the pool (measured 12.09), so the translation
    happens here, at the boundary, instead of changing either side's meaning.

    A record whose protocol is not tunnelable (``AUTO`` from a bare ``ip:port``
    line) is skipped with a warning rather than aborting the write: the
    ``ValueError`` from ``format_proxy_uri`` used to escape this function and
    take every verified proxy of the run down with it. The gate stays — such a
    line is junk for ``routing/lib/proxy-pool.js`` — but it now costs one entry,
    not the whole file.

    The write is atomic: contents land in a sibling temp file that is flushed and
    fsynced, then ``os.replace``d over the target. A crash mid-write therefore
    leaves the previous pool file intact instead of a truncated one, and readers
    never see a half-written list.
    """
    out_file.parent.mkdir(parents=True, exist_ok=True)
    # Canonicalize before writing so retries/source overlap cannot produce
    # duplicate lines, while format_proxy_uri remains the safety gate.
    seen: set[str] = set()
    for record in records:
        try:
            seen.add(format_proxy_uri(replace(record, protocol=_pool_protocol(record))))
        except ValueError as exc:
            log(f"  ! пропускаю запись: {exc}")
    lines = sorted(seen)
    temp_name: Optional[str] = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", newline="\n", dir=out_file.parent,
            prefix=f".{out_file.name}.", suffix=".tmp", delete=False,
        ) as temp:
            temp_name = temp.name
            if lines:
                temp.write("\n".join(lines) + "\n")
            temp.flush()
            os.fsync(temp.fileno())
        os.replace(temp_name, out_file)
    except BaseException:
        if temp_name:
            try:
                os.unlink(temp_name)
            except FileNotFoundError:
                pass
        raise
    return out_file


def main(argv: Optional[Sequence[str]] = None) -> int:
    # Windows console is cp1252 by default: a stray arrow or a Russian word in a
    # log line kills the run with UnicodeEncodeError before anything is checked.
    # Reconfiguring is cheaper than policing every message.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    p = argparse.ArgumentParser(description="Find live proxies able to reach one host")
    p.add_argument("--host", required=True, help="Target host, e.g. www.aikeysapi.com")
    p.add_argument("--want", type=int, default=3, help="How many live proxies are enough")
    p.add_argument("--path", default="/api/status", help="HTTPS path used as the probe")
    p.add_argument("--sources-file", default=str(DEFAULT_SOURCES))
    p.add_argument("--max-candidates", type=int, default=0, help="Cap candidates checked (0 = all)")
    p.add_argument("--workers", type=int, default=60)
    p.add_argument("--timeout", type=int, default=8)
    p.add_argument("--out", default=str(DEFAULT_OUT))
    p.add_argument("--json", action="store_true", help="Print a machine-readable summary")
    args = p.parse_args(argv)

    # При --json stdout зарезервирован под ровно одну машинную строку — итоговый
    # JSON, поэтому прогресс уходит в stderr, и потоки не смешиваются. Раньше он
    # глушился совсем, и панель дашборда, которая парсит эти же строки, минутами
    # показывала «ищу…» без единой цифры. flush нужен, чтобы строки шли по ходу.
    progress = (lambda *a, **kw: print(*a, file=sys.stderr, flush=True, **kw)) if args.json else print

    try:
        found = find(
            args.host, max(1, args.want),
            path=args.path, sources_file=Path(args.sources_file),
            max_candidates=args.max_candidates, workers=args.workers, timeout=args.timeout,
            log=progress,
        )
    except Exception as exc:  # noqa: BLE001 - CLI boundary
        if args.json:
            print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            print(f"ОШИБКА: {exc}", file=sys.stderr)
        return 1

    # log=progress: под --json предупреждения о пропущенных записях обязаны уйти в
    # stderr, иначе они встанут в stdout рядом с единственной машинной строкой.
    out = write_pool(found, Path(args.out), log=progress)
    if args.json:
        print(json.dumps({
            "ok": True,
            "host": args.host,
            "found": len(found),
            "want": args.want,
            "out": str(out),
            "proxies": [_safe_uri(r) for r in found],
            "latency_ms": [round(r.latency_ms or 0) for r in found],
        }, ensure_ascii=False))
    else:
        print(f"Записано {len(found)} в {out}")
    return 0 if found else 2


if __name__ == "__main__":
    raise SystemExit(main())
