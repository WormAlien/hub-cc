from __future__ import annotations

import argparse
import json
import os
import random
import time
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Dict, List
from urllib.parse import urlsplit, urlunsplit

from .checker import ProxyChecker
from .console_ui import ConsoleUI
from .models import ProxyRecord
from .scraper import ProxyScraper
from .services import load_services


def _build_export_text(rows: List[ProxyRecord]) -> str:
    if not rows:
        return ""
    return "\n".join(row.address for row in rows) + "\n"


def _write_text_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    with temp_path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp_path, path)


def _flush_output(rows: List[ProxyRecord], out_file: str) -> None:
    _write_text_atomic(Path(out_file), _build_export_text(rows))


def _build_source_export_text(
    rows_by_source: Dict[str, Dict[str, ProxyRecord]],
    service_urls: Dict[str, str],
) -> str:
    if not rows_by_source:
        return ""

    blocks: List[str] = []
    for source_name in sorted(rows_by_source):
        bucket = rows_by_source.get(source_name, {})
        if not bucket:
            continue
        rows = sorted(bucket.values(), key=lambda rec: (rec.protocol, rec.ip, rec.port))
        lines = [f"[{source_name}]"]
        url = service_urls.get(source_name, "").strip()
        if url:
            lines.append(f"url={url}")
        lines.append(f"count={len(rows)}")
        lines.extend(f"{row.address} | protocol={row.protocol}" for row in rows)
        blocks.append("\n".join(lines))

    if not blocks:
        return ""
    return "\n\n".join(blocks) + "\n"


def _flush_sources_output(
    rows_by_source: Dict[str, Dict[str, ProxyRecord]],
    service_urls: Dict[str, str],
    out_file: str,
) -> None:
    _write_text_atomic(Path(out_file), _build_source_export_text(rows_by_source, service_urls))


def _normalize_service_url(raw_url: str) -> str:
    text = str(raw_url or "").strip()
    if not text:
        return ""
    try:
        parts = urlsplit(text)
        return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path.rstrip("/"), parts.query, ""))
    except Exception:
        return text.rstrip("/").lower()


def _cleanup_duplicate_service_urls(services_file: str) -> None:
    path = Path(services_file)
    if not path.exists():
        return
    try:
        raw = json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception:
        return
    if not isinstance(raw, list):
        return

    seen = set()
    cleaned = []
    changed = False
    for item in raw:
        if not isinstance(item, dict):
            continue
        norm = _normalize_service_url(item.get("url", ""))
        if norm and norm in seen:
            changed = True
            continue
        if norm:
            seen.add(norm)
        cleaned.append(item)

    if changed:
        path.write_text(json.dumps(cleaned, ensure_ascii=False, indent=2), encoding="utf-8")


def _move_sources_to_bad_file(
    services_file: str,
    bad_services_file: str,
    names: List[str],
    checked_by_source: Dict[str, int],
    working_by_source: Dict[str, int],
    reason: str = "runtime_low_yield",
) -> tuple[int, List[str]]:
    if not names:
        return 0, []
    path = Path(services_file)
    if not path.exists():
        return 0, []
    try:
        raw = json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception:
        return 0, []
    if not isinstance(raw, list):
        return 0, []

    bad_path = Path(bad_services_file)
    bad_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        bad_raw = json.loads(bad_path.read_text(encoding="utf-8-sig")) if bad_path.exists() else []
    except Exception:
        bad_raw = []
    if not isinstance(bad_raw, list):
        bad_raw = []

    now_iso = datetime.now().isoformat()
    target = set(names)
    changed_names: List[str] = []
    kept_items = []
    moved_items = []
    for item in raw:
        if not isinstance(item, dict):
            kept_items.append(item)
            continue
        name = str(item.get("name", "")).strip()
        if name not in target:
            kept_items.append(item)
            continue

        changed_names.append(name)
        moved_items.append(
            {
                "name": name,
                "url": str(item.get("url", "")).strip(),
                "protocol": str(item.get("protocol", "")).strip().upper(),
                "parser": str(item.get("parser", "regex")).strip().lower(),
                "origin_repo": str(item.get("origin_repo", "")).strip(),
                "added_at": now_iso,
                "reason": reason,
                "checked_last": int(checked_by_source.get(name, 0)),
                "working_last": int(working_by_source.get(name, 0)),
            }
        )

    if not moved_items:
        return 0, []

    bad_raw.extend(moved_items)
    path.write_text(json.dumps(kept_items, ensure_ascii=False, indent=2), encoding="utf-8")
    bad_path.write_text(json.dumps(bad_raw, ensure_ascii=False, indent=2), encoding="utf-8")
    return len(moved_items), sorted(changed_names)


def _parse_args(argv: List[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Public proxy scraper with simple alive check")
    parser.add_argument("--services-file", default="config/proxy_services.json", help="JSON file with proxy sources")
    parser.add_argument("--threads", type=int, default=220, help="Scrape threads")
    parser.add_argument("--timeout", type=int, default=6, help="Scrape timeout, sec")
    parser.add_argument("--retries", type=int, default=0, help="Scrape retries")
    parser.add_argument("--protocol", choices=["all", "http", "https", "socks4", "socks5"], default="all")
    parser.add_argument("--max-sources", type=int, default=0, help="Use only first N active services after shuffle")
    parser.add_argument("--max-per-source", type=int, default=0, help="Limit proxies fetched from one source (0 = no limit)")
    parser.add_argument("--check-workers", type=int, default=600, help="Concurrent proxy checks")
    parser.add_argument("--check-timeout", type=int, default=6, help="Proxy check timeout, sec")
    parser.add_argument("--check-retries", type=int, default=0, help="Proxy check retries")
    parser.add_argument("--check-limit", type=int, default=5000, help="Batch size per source")
    parser.add_argument("--max-check-total", type=int, default=0, help="Global limit of checked proxies (0 = all)")
    parser.add_argument(
        "--prefilter-timeout",
        type=float,
        default=3.0,
        help="Fast TCP connect probe timeout, sec (0 = disable prefilter)",
    )
    parser.add_argument(
        "--no-dedupe",
        dest="dedupe",
        action="store_false",
        help="Do not drop duplicate ip:port across sources before checking",
    )
    parser.set_defaults(dedupe=True)
    parser.add_argument("--progress-every", type=int, default=50, help="Progress update step")
    parser.add_argument("--runtime-source-min-checked", type=int, default=5000, help="Disable source after this many checked proxies")
    parser.add_argument("--runtime-source-min-valid-rate", type=float, default=0.02, help="Minimum alive ratio after threshold")
    parser.add_argument("--output-dir", default="export", help="Directory for output file")
    parser.add_argument("--out-file", default="", help="Output file for alive proxies")
    parser.add_argument("--sources-out-file", default="", help="Output file with alive proxies grouped by source")
    parser.add_argument("--bad-services-file", default="config/bad_service.json", help="JSON file for removed low-yield sources")
    runtime_group = parser.add_mutually_exclusive_group()
    runtime_group.add_argument("--runtime-source-early-disable", dest="runtime_source_early_disable", action="store_true")
    runtime_group.add_argument("--no-runtime-source-early-disable", dest="runtime_source_early_disable", action="store_false")
    # A source's yield swings with public-proxy churn. Mutating the source
    # registry from one runtime sample made each run permanently shrink its own
    # input set (70 -> 21 sources was observed). Keep quarantine opt-in; a bad
    # run remains visible in the log, but it no longer rewrites configuration.
    parser.set_defaults(runtime_source_early_disable=False)
    return parser.parse_args(argv if argv is not None else [])


def main(argv: List[str] | None = None) -> int:
    args = _parse_args(argv)
    ui = ConsoleUI()
    rng = random.SystemRandom()

    _cleanup_duplicate_service_urls(args.services_file)
    services = [service for service in load_services(args.services_file) if service.enabled]
    if args.protocol != "all":
        services = [service for service in services if service.protocol.lower() == args.protocol]
    rng.shuffle(services)
    if args.max_sources > 0:
        services = services[: args.max_sources]
    if not services:
        ui.log("ОШИБКА", "Нет активных сервисов для запуска.", "red")
        return 1

    Path(args.output_dir).mkdir(parents=True, exist_ok=True)
    out_file = args.out_file or os.path.join(args.output_dir, "proxies.txt")
    sources_out_file = args.sources_out_file or os.path.join(args.output_dir, "proxy_sources.txt")
    service_urls = {service.name: service.url for service in services}
    _flush_output([], out_file)
    _flush_sources_output({}, service_urls, sources_out_file)

    ui.log(
        "ПАРАМЕТРЫ",
        (
            f"services={len(services)} protocol={args.protocol} "
            f"workers(scrape/check)={args.threads}/{args.check_workers} "
            f"packet={args.check_limit} prefilter={'off' if args.prefilter_timeout <= 0 else f'{args.prefilter_timeout:.1f}s'} "
            f"dedupe={'on' if args.dedupe else 'off'} disable_if_alive<{args.runtime_source_min_valid_rate * 100:.1f}%"
        ),
        "blue",
    )

    scraper = ProxyScraper(
        services=services,
        threads=args.threads,
        timeout=args.timeout,
        retries=args.retries,
        max_per_source=args.max_per_source,
    )
    scrape_ok = 0
    scrape_fail = 0
    scrape_started = time.perf_counter()
    scrape_bar = ui.progress("СКРАП", "Получаю прокси из сервисов", len(services), "blue")

    def on_scrape(done: int, total: int, row) -> None:
        nonlocal scrape_ok, scrape_fail
        if row.ok:
            scrape_ok += 1
            note = f"{row.service} +{row.proxies_found}"
        else:
            scrape_fail += 1
            note = f"{row.service} err"
        scrape_bar.update(done, ok=scrape_ok, bad=scrape_fail, note=note)

    records = scraper.run(progress_cb=on_scrape)
    scrape_elapsed = int(time.perf_counter() - scrape_started)
    scrape_bar.finish(
        f"Скрап завершен за {scrape_elapsed}s | ok={scrape_ok} fail={scrape_fail} | proxies={len(records)}",
        "green",
    )
    scrape_failed = [row.service for row in scraper.results if not row.ok]
    scrape_empty = [row.service for row in scraper.results if row.ok and row.proxies_found <= 0]
    if scrape_failed:
        moved, _ = _move_sources_to_bad_file(
            args.services_file,
            args.bad_services_file,
            scrape_failed,
            {},
            {},
            reason="scrape_failed",
        )
        if moved > 0:
            ui.log("QUALITY", f"Moved services after scrape_failed: {moved}", "yellow")
    if scrape_empty:
        moved, _ = _move_sources_to_bad_file(
            args.services_file,
            args.bad_services_file,
            scrape_empty,
            {},
            {},
            reason="scrape_empty",
        )
        if moved > 0:
            ui.log("QUALITY", f"Moved services after scrape_empty: {moved}", "yellow")
    if not records:
        _flush_output([], out_file)
        _flush_sources_output({}, service_urls, sources_out_file)
        ui.log("ГОТОВО", "Не найдено ни одного прокси.", "red")
        ui.log("ФАЙЛ", f"Сохранено: {out_file}", "blue")
        return 2

    per_source_records: Dict[str, Dict[str, ProxyRecord]] = {}
    for rec in records:
        bucket = per_source_records.setdefault(rec.source, {})
        key = f"{rec.protocol}|{rec.address}"
        if key not in bucket:
            bucket[key] = rec

    records_by_source: Dict[str, List[ProxyRecord]] = {}
    seen_addresses: set[str] = set() if args.dedupe else None
    deduped_total = 0
    for source_name, bucket in per_source_records.items():
        rows = []
        for rec in bucket.values():
            if seen_addresses is not None:
                if rec.address in seen_addresses:
                    continue
                seen_addresses.add(rec.address)
            rows.append(rec)
        deduped_total += len(rows)
        rng.shuffle(rows)
        records_by_source[source_name] = rows
    if args.dedupe:
        ui.log(
            "DEDUP",
            f"Уникальных ip:port к проверке: {deduped_total} (убрано дубликатов: {len(records) - deduped_total})",
            "cyan",
        )

    source_order = list(records_by_source.keys())
    rng.shuffle(source_order)

    checker = ProxyChecker(
        workers=args.check_workers,
        timeout=args.check_timeout,
        retries=args.check_retries,
        prefilter_timeout=args.prefilter_timeout,
    )

    checked_total = 0
    checked_by_source: Dict[str, int] = {}
    working_by_source: Dict[str, int] = {}
    working_map: Dict[str, ProxyRecord] = {}
    working_rows_by_source: Dict[str, Dict[str, ProxyRecord]] = {}
    interrupted = False
    batch_idx = 0

    ui.log(
        "ПРОВЕРКА",
        (
            "Проверяю только жив ли прокси. "
            f"Источник удаляется из proxy_services.json и переносится в bad_service.json, если alive < {args.runtime_source_min_valid_rate * 100:.1f}%."
        ),
        "magenta",
    )

    for source_idx, source_name in enumerate(source_order, start=1):
        if interrupted:
            break

        source_rows = records_by_source.get(source_name, [])
        if not source_rows:
            continue

        remaining_total = (args.max_check_total - checked_total) if args.max_check_total > 0 else len(source_rows)
        if remaining_total <= 0:
            break

        source_cap = min(len(source_rows), remaining_total)
        source_threshold = min(max(1, int(args.runtime_source_min_checked)), source_cap)
        source_offset = 0
        source_checked_before = int(checked_by_source.get(source_name, 0))
        source_working_before = int(working_by_source.get(source_name, 0))
        source_disabled = False

        ui.log(
            "ИСТОЧНИК",
            (
                f"[{source_idx}/{len(source_order)}] {source_name} | "
                f"получено={len(source_rows)} к_чеку={source_cap} порог={source_threshold}"
            ),
            "blue",
        )

        while source_offset < source_cap:
            batch_size = min(max(1, args.check_limit), source_cap - source_offset)
            batch = source_rows[source_offset : source_offset + batch_size]
            if not batch:
                break

            batch_idx += 1
            batch_working = 0
            done_mark = 0
            check_bar = ui.progress("ПРОВЕРКА", f"Пакет {batch_idx} [{source_name}]", len(batch), "magenta")

            def on_check(done: int, total: int, rec: ProxyRecord) -> None:
                nonlocal batch_working, done_mark
                if rec.working:
                    batch_working += 1
                if done == total or done - done_mark >= max(1, args.progress_every):
                    done_mark = done
                check_bar.update(done, ok=batch_working, bad=done - batch_working)

            checked = checker.check_many(batch, progress_cb=on_check)
            checked_total += len(checked)

            for rec in checked:
                checked_by_source[source_name] = checked_by_source.get(source_name, 0) + 1
                if not rec.working:
                    continue
                working_by_source[source_name] = working_by_source.get(source_name, 0) + 1
                source_bucket = working_rows_by_source.setdefault(source_name, {})
                if rec.address not in source_bucket:
                    source_bucket[rec.address] = rec
                key = rec.address
                if key not in working_map:
                    working_map[key] = rec

            snapshot = list(working_map.values())
            if snapshot:
                _flush_output(snapshot, out_file)
            _flush_sources_output(working_rows_by_source, service_urls, sources_out_file)

            check_bar.finish(
                (
                    f"Пакет {batch_idx} завершен | проверено={len(checked)} "
                    f"| живых={batch_working} | накоплено живых={len(snapshot)}"
                ),
                "yellow" if checker.last_interrupted else "green",
            )

            if checker.last_interrupted:
                interrupted = True
                ui.log("ПРЕРВАНО", "Остановка пользователем. Уже найденное сохранено.", "yellow")
                break

            source_checked = int(checked_by_source.get(source_name, 0))
            source_working = int(working_by_source.get(source_name, 0))
            valid_rate = (source_working / source_checked) if source_checked > 0 else 0.0
            if (
                args.runtime_source_early_disable
                and source_checked >= source_threshold
                and valid_rate < float(args.runtime_source_min_valid_rate)
            ):
                changed, _ = _move_sources_to_bad_file(
                    args.services_file,
                    args.bad_services_file,
                    [source_name],
                    checked_by_source,
                    working_by_source,
                )
                source_disabled = changed > 0
                ui.log(
                    "QUALITY",
                    (
                        f"{'Moved' if source_disabled else 'Failed to move'} "
                        f"source {'to bad_service.json' if source_disabled else 'from proxy_services.json'}: {source_name} | "
                        f"checked={source_checked} alive={source_working} "
                        f"alive={valid_rate * 100:.2f}%"
                    ),
                    "yellow" if source_disabled else "red",
                )
                break

            source_offset += len(batch)

        source_checked_after = int(checked_by_source.get(source_name, 0))
        source_working_after = int(working_by_source.get(source_name, 0))
        checked_delta = max(0, source_checked_after - source_checked_before)
        working_delta = max(0, source_working_after - source_working_before)
        if checked_delta > 0:
            valid_rate = (working_delta / checked_delta) if checked_delta > 0 else 0.0
            ui.log(
                "ИСТОЧНИК",
                (
                    f"{source_name}: {'перенесен в bad_service.json' if source_disabled else 'завершен'} | "
                    f"проверено={checked_delta}/{source_cap} | живых={working_delta} "
                    f"({valid_rate * 100:.2f}%)"
                ),
                "yellow" if source_disabled else "cyan",
            )

    working = list(working_map.values())
    _flush_output(working, out_file)
    _flush_sources_output(working_rows_by_source, service_urls, sources_out_file)

    ui.log("ФАЙЛ", f"Сохранено: {out_file}", "blue")

    ui.log("FILE", f"Saved source map: {sources_out_file}", "blue")

    proto_count = Counter(row.protocol for row in records)
    live_count = Counter(row.protocol for row in working)
    ui.log(
        "ИТОГ",
        (
            f"scraped={len(records)} "
            f"HTTP={proto_count.get('HTTP', 0)} HTTPS={proto_count.get('HTTPS', 0)} "
            f"SOCKS4={proto_count.get('SOCKS4', 0)} SOCKS5={proto_count.get('SOCKS5', 0)}"
        ),
        "white",
    )
    ui.log(
        "ИТОГ",
        (
            f"alive={len(working)} "
            f"HTTP={live_count.get('HTTP', 0)} HTTPS={live_count.get('HTTPS', 0)} "
            f"SOCKS4={live_count.get('SOCKS4', 0)} SOCKS5={live_count.get('SOCKS5', 0)}"
        ),
        "white",
    )
    return 130 if interrupted else 0
