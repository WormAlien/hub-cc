from __future__ import annotations

import argparse
import os
from pathlib import Path
from typing import Dict, List

from .console_ui import ConsoleUI
from .dolphin_checker import DolphinProxyChecker
from .models import ProxyRecord
from .proxy_io import parse_proxy_file


def _parse_args(argv: List[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Dolphin-style validation for export/proxies.txt")
    parser.add_argument("--input-file", default="export/proxies.txt", help="Input file with scraped proxies")
    parser.add_argument("--output-dir", default="export/dolphin_proxy", help="Output directory for Dolphin-valid proxy files")
    parser.add_argument("--workers", type=int, default=80, help="Concurrent proxy checks")
    parser.add_argument("--timeout", type=int, default=15, help="Dolphin check timeout, sec")
    parser.add_argument("--retries", type=int, default=1, help="Dolphin check retries")
    parser.add_argument("--progress-every", type=int, default=25, help="Progress update step")
    return parser.parse_args(argv if argv is not None else [])


def _prepare_output_dir(path: str) -> Dict[str, Path]:
    folder = Path(path)
    folder.mkdir(parents=True, exist_ok=True)
    files = {
        "HTTP": folder / "http.txt",
        "HTTPS": folder / "https.txt",
        "SOCKS4": folder / "socks4.txt",
        "SOCKS5": folder / "socks5.txt",
        "ALL": folder / "all_valid.txt",
    }
    for file in files.values():
        file.write_text("", encoding="utf-8")
    return files


def _append_valid(path: Path, line: str) -> None:
    with path.open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(line + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def main(argv: List[str] | None = None) -> int:
    args = _parse_args(argv)
    ui = ConsoleUI()

    records = parse_proxy_file(args.input_file)
    output_files = _prepare_output_dir(args.output_dir)

    if not records:
        ui.log("ERROR", f"No proxies to check: {args.input_file}", "red")
        ui.log("FILE", f"Prepared folder: {args.output_dir}", "blue")
        return 1

    ui.log(
        "START",
        (
            f"Dolphin-style check | file={args.input_file} proxies={len(records)} "
            f"workers={args.workers} timeout={args.timeout}s retries={args.retries}"
        ),
        "blue",
    )

    checker = DolphinProxyChecker(
        workers=args.workers,
        timeout=args.timeout,
        retries=args.retries,
    )

    saved_by_protocol: Dict[str, set[str]] = {proto: set() for proto in ("HTTP", "HTTPS", "SOCKS4", "SOCKS5")}
    all_saved: set[str] = set()
    invalid_total = 0
    done_mark = 0
    progress = ui.progress("DOLPHIN", "Checking proxies like Dolphin", len(records), "magenta")

    def on_check(done: int, total: int, rec: ProxyRecord) -> None:
        nonlocal invalid_total, done_mark
        line = rec.address
        if rec.working:
            if line not in all_saved:
                all_saved.add(line)
                _append_valid(output_files["ALL"], line)
            for proto in rec.supported_protocols:
                store = saved_by_protocol.get(proto)
                target = output_files.get(proto)
                if store is None or target is None or line in store:
                    continue
                store.add(line)
                _append_valid(target, line)
        else:
            invalid_total += 1

        if done == total or done - done_mark >= max(1, args.progress_every):
            done_mark = done
        progress.update(done, ok=len(all_saved), bad=invalid_total)

    checked = checker.check_many(records, progress_cb=on_check)
    progress.finish(
        (
            f"Dolphin check finished | checked={len(checked)} "
            f"| valid={len(all_saved)} | invalid={invalid_total}"
        ),
        "yellow" if checker.last_interrupted else "green",
    )

    ui.log(
        "RESULT",
        (
            f"HTTP={len(saved_by_protocol['HTTP'])} HTTPS={len(saved_by_protocol['HTTPS'])} "
            f"SOCKS4={len(saved_by_protocol['SOCKS4'])} SOCKS5={len(saved_by_protocol['SOCKS5'])}"
        ),
        "white",
    )
    ui.log("FILE", f"Saved to folder: {args.output_dir}", "blue")
    return 130 if checker.last_interrupted else 0
