"""Stability gate for the narrow AgentRouter proxy path.

A proxy that answers once is worthless: the pool is re-checked several times
with a pause between rounds, and only an address that survives *every* round is
written to ``export/agentrouter/stable.txt``.

The module is import-safe and does no network I/O by itself - the actual check
is injected via ``check_pass`` so the pipeline can be tested without traffic.
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import math
import os
import random
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional, Sequence

from .models import ProxyRecord
from .proxy_io import format_proxy_uri


DEFAULT_CAP = 500
DEFAULT_WORKERS = 40
DEFAULT_TIMEOUT = 8
DEFAULT_PASSES = 3
MIN_INTERVAL_SECONDS = 20
MAX_INTERVAL_SECONDS = 30
DEFAULT_INTERVAL_SECONDS = 25
# Сколько адресов максимум брать из одной /24. Лимит существует потому, что один блок-бан
# подсети уносит сразу все её адреса — но 2 оказалось слишком строго: на прогоне 12.09 так
# срезало 18 живых прокси из 96 SOCKS5. 10 — компромисс владельца: подсеть ещё не «одна
# точка отказа», но и потери заметно меньше.
MAX_PER_SUBNET = 10
DIALABLE_PROTOCOLS = ("HTTP", "HTTPS", "SOCKS4", "SOCKS5")
DEFAULT_PROTOCOL = "http"

CheckPass = Callable[[Sequence[ProxyRecord], int], Iterable[ProxyRecord]]


def _key(record: ProxyRecord) -> str:
    return f"{record.ip}:{record.port}"


def _latency_of(record: ProxyRecord) -> float:
    try:
        return float(record.latency_ms or 0.0)
    except (TypeError, ValueError):
        return 0.0


def _median(values: Sequence[float]) -> float:
    data = sorted(float(value) for value in values)
    if not data:
        return 0.0
    middle = len(data) // 2
    if len(data) % 2:
        return data[middle]
    return (data[middle - 1] + data[middle]) / 2


def _percentile(values: Sequence[float], percent: float) -> float:
    """Nearest-rank percentile - no interpolation between neighbours."""
    data = sorted(float(value) for value in values)
    if not data:
        return 0.0
    rank = max(1, math.ceil(percent / 100.0 * len(data)))
    return float(data[min(rank, len(data)) - 1])


def _subnet_of(host: str) -> Optional[str]:
    """/24 key for an IPv4 literal, None for a DNS hostname."""
    try:
        ipaddress.IPv4Address(host)
    except (ipaddress.AddressValueError, ValueError):
        return None
    return str(ipaddress.ip_network(f"{host}/24", strict=False))


def _pick_interval(interval: Optional[float]) -> float:
    if interval is None:
        return random.uniform(MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS)
    return max(MIN_INTERVAL_SECONDS, min(MAX_INTERVAL_SECONDS, float(interval)))


def _write_text_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(path.name + ".tmp")
    try:
        with temp_path.open("w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
    finally:
        if temp_path.exists():
            try:
                temp_path.unlink()
            except OSError:
                pass


def dedupe_candidates(records: Iterable[ProxyRecord]) -> List[ProxyRecord]:
    """One record per ``host:port``, keeping the fastest observation."""
    best: Dict[str, ProxyRecord] = {}
    order: List[str] = []
    for record in records:
        key = _key(record)
        current = best.get(key)
        if current is None:
            best[key] = record
            order.append(key)
        elif _latency_of(record) < _latency_of(current):
            best[key] = record
    return [best[key] for key in order]


def run_stability(
    records: Iterable[ProxyRecord],
    check_pass: CheckPass,
    output_dir: str | Path,
    source_urls: Optional[Sequence[str]] = None,
    sleep_fn: Callable[[float], None] = time.sleep,
    cap: int = DEFAULT_CAP,
    passes: int = DEFAULT_PASSES,
    interval: Optional[float] = None,
    workers: int = DEFAULT_WORKERS,
    timeout: int = DEFAULT_TIMEOUT,
) -> Dict[str, object]:
    """Run ``passes`` rounds and keep only the proxies that survived all of them.

    ``check_pass(candidates, pass_number)`` gets a 1-based pass number and must
    return the records that answered. Anything it does not return is out for
    good - survivors are carried forward, never resurrected.
    """
    incoming = list(records)
    candidates = dedupe_candidates(incoming)
    if cap and cap > 0:
        candidates = candidates[:cap]

    # A record parsed from a bare ``ip:port`` keeps protocol AUTO, and no tunnel
    # can dial that: the checker raises ``unsupported protocol``, so it would fail
    # every pass silently and - worse - an unfiltered survivor would land in
    # stable.txt as ``auto://host:port``, which the pool cannot parse either.
    undialable: Dict[str, str] = {}
    dialable: List[ProxyRecord] = []
    for record in candidates:
        protocol = (record.protocol or "").strip().upper()
        if protocol in DIALABLE_PROTOCOLS:
            dialable.append(record)
        else:
            undialable[_key(record)] = f"unresolved protocol {protocol or 'EMPTY'}"
    candidates = dialable

    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    latencies: Dict[str, List[float]] = {}
    current: List[ProxyRecord] = list(candidates)
    completed = 0
    interrupted = False

    for pass_number in range(1, max(1, passes) + 1):
        if pass_number > 1:
            sleep_fn(_pick_interval(interval))
        try:
            returned = list(check_pass(current, pass_number))
        except KeyboardInterrupt:
            interrupted = True
            break

        completed += 1
        alive: Dict[str, ProxyRecord] = {}
        for record in returned:
            alive[_key(record)] = record
        for key, record in alive.items():
            latencies.setdefault(key, []).append(_latency_of(record))
        current = [alive[_key(record)] for record in current if _key(record) in alive]

    survivors = [] if interrupted else current
    survivor_keys = {_key(record) for record in survivors}

    failures: Dict[str, str] = dict(undialable)
    if not interrupted:
        for record in candidates:
            key = _key(record)
            if key not in survivor_keys:
                failures[key] = f"failed pass {completed}"

    medians = {key: _median(values) for key, values in latencies.items()}
    ordered = sorted(survivors, key=lambda rec: (medians.get(_key(rec), 0.0), rec.ip, rec.port))

    kept: List[ProxyRecord] = []
    per_subnet: Dict[str, int] = {}
    dropped_by_subnet = 0
    for record in ordered:
        subnet = _subnet_of(record.ip)
        if subnet is not None:
            if per_subnet.get(subnet, 0) >= MAX_PER_SUBNET:
                dropped_by_subnet += 1
                failures[_key(record)] = f"dropped by /24 cap ({subnet})"
                continue
            per_subnet[subnet] = per_subnet.get(subnet, 0) + 1
        kept.append(record)

    # A record whose protocol never got pinned down cannot be tunnelled by any
    # consumer, so it is dropped here with a reason in the report instead of
    # being written as an ``auto://`` line that the pool bins as junk.
    stable_uris: List[str] = []
    kept_tunnelable: List[ProxyRecord] = []
    for record in kept:
        try:
            stable_uris.append(format_proxy_uri(record))
        except ValueError as exc:
            failures[_key(record)] = str(exc)
            continue
        kept_tunnelable.append(record)
    dropped_no_protocol = len(kept) - len(kept_tunnelable)
    kept = kept_tunnelable
    kept_latencies = [medians.get(_key(record), 0.0) for record in kept]

    report: Dict[str, object] = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "passes": completed,
        "requested_passes": max(1, passes),
        "interrupted": interrupted,
        "cap": cap,
        "workers": workers,
        "timeout": timeout,
        "input_records": len(incoming),
        "candidates": len(candidates),
        "stable_count": len(kept),
        "dropped_by_subnet": dropped_by_subnet,
        "dropped_no_protocol": dropped_no_protocol,
        "max_per_subnet": MAX_PER_SUBNET,
        "failures": failures,
        "source_urls": list(source_urls or []),
        "latency_ms": {
            "p50": _percentile(kept_latencies, 50),
            "p95": _percentile(kept_latencies, 95),
        },
        "stable": stable_uris,
    }

    if not interrupted:
        _write_text_atomic(
            out_dir / "stable.txt",
            "\n".join(stable_uris) + ("\n" if stable_uris else ""),
        )
    _write_text_atomic(
        out_dir / "report.json",
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
    )

    return report


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Re-check AgentRouter-capable proxies several times and keep only the stable ones",
    )
    parser.add_argument("--input", default="export/all_valid.txt", help="File with proxies to re-check")
    parser.add_argument("--targets-file", default="config/domain_targets.json", help="JSON file with target domains")
    parser.add_argument("--output-dir", default="export/agentrouter", help="Directory for stable.txt and report.json")
    parser.add_argument("--cap", type=int, default=DEFAULT_CAP, help="Max unique proxies to re-check")
    parser.add_argument("--workers", type=int, default=DEFAULT_WORKERS, help="Concurrent checks per pass")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT, help="Per-check timeout, sec")
    parser.add_argument("--passes", type=int, default=DEFAULT_PASSES, help="Number of successful passes required")
    parser.add_argument(
        "--interval",
        type=int,
        default=DEFAULT_INTERVAL_SECONDS,
        help=f"Pause between passes, sec ({MIN_INTERVAL_SECONDS}-{MAX_INTERVAL_SECONDS})",
    )
    parser.add_argument(
        "--default-protocol",
        default=DEFAULT_PROTOCOL,
        choices=[protocol.lower() for protocol in DIALABLE_PROTOCOLS],
        help="Scheme for bare ip:port lines (a list without schemes cannot be dialled otherwise)",
    )
    return parser.parse_args(list(argv) if argv is not None else [])


def build_live_check_pass(targets, workers: int, timeout: int) -> CheckPass:
    """Real network check: keep records that passed every enabled target."""
    from .domain_checker import DomainProxyChecker

    def check_pass(candidates: Sequence[ProxyRecord], pass_number: int) -> List[ProxyRecord]:
        checker = DomainProxyChecker(workers=workers, timeout=timeout, retries=0)
        results = checker.check_many(list(candidates), targets)
        if checker.last_interrupted:
            raise KeyboardInterrupt
        survivors: List[ProxyRecord] = []
        for result in results:
            if len(result.passed_targets) == len(targets) and targets:
                record = result.proxy
                record.working = True
                record.latency_ms = result.latency_ms
                survivors.append(record)
        return survivors

    return check_pass


def main(argv: Optional[Sequence[str]] = None) -> int:
    from .console_ui import ConsoleUI
    from .domain_mode import load_targets
    from .proxy_io import parse_proxy_file

    args = parse_args(argv if argv is not None else None)
    ui = ConsoleUI()

    targets = load_targets(args.targets_file)
    if not targets:
        ui.log("ERROR", f"No enabled targets found in: {args.targets_file}", "red")
        return 1

    records = parse_proxy_file(args.input, default_protocol=args.default_protocol.upper())
    if not records:
        ui.log("ERROR", f"No proxies found in: {args.input}", "red")
        return 1

    ui.log(
        "START",
        (
            f"input={args.input} proxies={len(records)} cap={args.cap} passes={args.passes} "
            f"interval={args.interval}s workers={args.workers} timeout={args.timeout}s"
        ),
        "blue",
    )

    report = run_stability(
        records,
        check_pass=build_live_check_pass(targets, args.workers, args.timeout),
        output_dir=args.output_dir,
        source_urls=[target.url for target in targets],
        cap=args.cap,
        passes=args.passes,
        interval=args.interval,
        workers=args.workers,
        timeout=args.timeout,
    )

    if report["interrupted"]:
        ui.log("STOP", f"Interrupted after {report['passes']} pass(es). Report saved.", "yellow")
        return 130

    ui.log(
        "DONE",
        (
            f"stable={report['stable_count']} of candidates={report['candidates']} "
            f"| dropped_by_subnet={report['dropped_by_subnet']} "
            f"| p50={report['latency_ms']['p50']}ms p95={report['latency_ms']['p95']}ms"
        ),
        "green",
    )
    ui.log("FILE", f"Stable list: {Path(args.output_dir) / 'stable.txt'}", "blue")
    ui.log("FILE", f"Report: {Path(args.output_dir) / 'report.json'}", "blue")
    return 0
