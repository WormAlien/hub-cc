from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
from typing import Dict, List
from urllib.parse import urlsplit

from .console_ui import ConsoleUI
from .domain_checker import DomainProxyChecker
from .models import DomainCheckResult, DomainTarget
from .proxy_io import format_proxy_uri, parse_proxy_files


DEFAULT_DOMAIN_TARGETS = [
    {
        "name": "agentrouter_status",
        "url": "https://agentrouter.org/api/status",
        "enabled": True,
        "response": "newapi_status",
    },
]

VALID_RESPONSE_KINDS = {"html", "newapi_status", "json_any"}

PROTOCOL_INPUTS = [
    ("http.txt", "HTTP"),
    ("https.txt", "HTTPS"),
    ("socks4.txt", "SOCKS4"),
    ("socks5.txt", "SOCKS5"),
]


def _safe_name(value: str) -> str:
    return re.sub(r"[^a-z0-9_.-]+", "_", value.strip().lower())


def _write_text_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    with temp_path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp_path, path)


def _write_lines_atomic(path: Path, rows: set[str]) -> None:
    text = "\n".join(sorted(rows)) + ("\n" if rows else "")
    _write_text_atomic(path, text)


def ensure_targets_file(path: str) -> None:
    file_path = Path(path)
    if file_path.exists():
        return
    file_path.parent.mkdir(parents=True, exist_ok=True)
    file_path.write_text(json.dumps(DEFAULT_DOMAIN_TARGETS, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def load_targets(path: str) -> List[DomainTarget]:
    """Load domain targets, failing loudly on a broken config file.

    A silent fallback to the built-in defaults used to hide a corrupted
    ``domain_targets.json`` (stray bytes before the opening bracket), so the
    run happily checked the wrong list of hosts. Now a broken file raises.
    """
    ensure_targets_file(path)
    file_path = Path(path)
    try:
        raw = json.loads(file_path.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"{file_path}: invalid JSON ({exc})") from exc
    except OSError as exc:
        raise ValueError(f"{file_path}: unreadable targets file ({exc})") from exc

    if not isinstance(raw, list):
        raise ValueError(
            f"{file_path}: invalid JSON structure, expected a list of targets, got {type(raw).__name__}"
        )

    result: List[DomainTarget] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        enabled = bool(item.get("enabled", True))
        if not enabled:
            continue

        name = _safe_name(str(item.get("name", "")))
        url = str(item.get("url", "")).strip()
        if not name or not url:
            continue

        parts = urlsplit(url)
        scheme = parts.scheme.lower()
        host = parts.hostname or ""
        if scheme not in {"http", "https"} or not host:
            continue

        path_value = parts.path or "/"
        if parts.query:
            path_value = f"{path_value}?{parts.query}"

        response = str(item.get("response", "html")).strip().lower() or "html"
        if response not in VALID_RESPONSE_KINDS:
            response = "html"

        result.append(
            DomainTarget(
                name=name,
                url=url,
                host=host,
                path=path_value,
                port=parts.port or (443 if scheme == "https" else 80),
                use_tls=(scheme == "https"),
                enabled=True,
                response=response,
            )
        )

    return result


def _load_protocol_records(input_dir: str) -> List:
    files = []
    for filename, protocol in PROTOCOL_INPUTS:
        path = Path(input_dir) / filename
        if path.exists():
            files.append((path, protocol))
    return parse_proxy_files(files)


def _prepare_domains_dir(path: str) -> Path:
    folder = Path(path)
    folder.mkdir(parents=True, exist_ok=True)
    for file in folder.glob("*.txt"):
        try:
            file.unlink()
        except OSError:
            continue
    return folder


def _parse_args(argv: List[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Check protocol-validated proxies against target domains")
    parser.add_argument("--input-dir", default="export/protocols", help="Directory with protocol-specific proxy files")
    parser.add_argument("--targets-file", default="config/domain_targets.json", help="JSON file with target domains")
    parser.add_argument("--output-dir", default="export/domains", help="Directory for per-domain valid proxy files")
    parser.add_argument("--all-valid-file", default="export/all_valid.txt", help="File for proxies that passed all enabled domains")
    parser.add_argument("--workers", type=int, default=160, help="Concurrent domain checks")
    parser.add_argument("--timeout", type=int, default=8, help="Domain check timeout, sec")
    parser.add_argument("--retries", type=int, default=0, help="Domain check retries")
    parser.add_argument("--progress-every", type=int, default=20, help="Progress update step")
    return parser.parse_args(argv if argv is not None else [])


def main(argv: List[str] | None = None) -> int:
    args = _parse_args(argv)
    ui = ConsoleUI()

    targets = load_targets(args.targets_file)
    if not targets:
        ui.log("ERROR", f"No enabled targets found in: {args.targets_file}", "red")
        return 1

    records = _load_protocol_records(args.input_dir)
    if not records:
        ui.log("ERROR", f"No protocol-validated proxies found in: {args.input_dir}", "red")
        return 1

    output_dir = _prepare_domains_dir(args.output_dir)
    all_valid_path = Path(args.all_valid_file)
    for target in targets:
        _write_lines_atomic(output_dir / f"{target.name}.txt", set())

    ui.log(
        "START",
        (
            f"input_dir={args.input_dir} proxies={len(records)} targets={len(targets)} "
            f"workers={args.workers} timeout={args.timeout}s"
        ),
        "blue",
    )

    checker = DomainProxyChecker(
        workers=args.workers,
        timeout=args.timeout,
        retries=args.retries,
    )

    passed_by_target: Dict[str, set[str]] = {target.name: set() for target in targets}
    all_valid: set[str] = set()
    done_mark = 0
    progress = ui.progress("DOMAINS", "Checking proxies against configured domains", len(records), "magenta")

    def flush_outputs() -> None:
        for target in targets:
            _write_lines_atomic(output_dir / f"{target.name}.txt", passed_by_target.get(target.name, set()))
        _write_lines_atomic(all_valid_path, all_valid)

    def on_check(done: int, total: int, result: DomainCheckResult) -> None:
        nonlocal done_mark
        try:
            proxy_text = format_proxy_uri(result.proxy)
        except ValueError:
            # No tunnelable protocol -> nothing downstream could use the line.
            # Counting it as checked but not exporting it keeps the progress
            # bar honest without poisoning the export with auto:// entries.
            proxy_text = None
        if proxy_text is not None:
            for target_name in result.passed_targets:
                passed_by_target.setdefault(target_name, set()).add(proxy_text)
            if len(result.passed_targets) == len(targets):
                all_valid.add(proxy_text)

        if done == total or done - done_mark >= max(1, args.progress_every):
            done_mark = done
            flush_outputs()
        progress.update(done, ok=len(all_valid), bad=done - len(all_valid), note=f"{len(result.passed_targets)}/{len(targets)} {proxy_text or result.proxy.address + ' (no protocol)'}")

    checked = checker.check_many(records, targets, progress_cb=on_check)
    flush_outputs()

    progress.finish(
        (
            f"Domain check finished | checked={len(checked)} "
            f"| all_valid={len(all_valid)} | partial={len(checked) - len(all_valid)}"
        ),
        "yellow" if checker.last_interrupted else "green",
    )

    if checker.last_interrupted:
        ui.log("STOP", "Interrupted by user. Current results are already saved.", "yellow")

    for target in targets:
        ui.log("DOMAIN", f"{target.name}={len(passed_by_target.get(target.name, set()))}", "white")
    ui.log("FILE", f"All-valid file: {all_valid_path}", "blue")
    ui.log("FILE", f"Domain results dir: {output_dir}", "blue")
    return 130 if checker.last_interrupted else 0
