from __future__ import annotations

import argparse
import os
from pathlib import Path
from typing import Dict, List

from .console_ui import ConsoleUI
from .models import ProxyRecord
from .proxy_io import parse_proxy_file
from .strict_checker import StrictProxyChecker, resolve_local_public_ip


def _parse_args(argv: List[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Strict validation for export/proxies.txt")
    parser.add_argument("--input-file", default="export/proxies.txt", help="Input file with scraped proxies")
    parser.add_argument("--output-dir", default="export/protocols", help="Output directory for valid proxy files")
    parser.add_argument("--workers", type=int, default=220, help="Concurrent strict checks")
    parser.add_argument("--timeout", type=int, default=6, help="Strict check timeout, sec")
    parser.add_argument("--retries", type=int, default=0, help="Strict check retries")
    parser.add_argument("--progress-every", type=int, default=25, help="Progress update step")
    return parser.parse_args(argv if argv is not None else [])


def _parse_input_file(path: str) -> List[ProxyRecord]:
    return parse_proxy_file(path)


def _prepare_output_dir(path: str) -> Dict[str, Path]:
    folder = Path(path)
    folder.mkdir(parents=True, exist_ok=True)
    files = {
        "HTTP": folder / "http.txt",
        "HTTPS": folder / "https.txt",
        "SOCKS4": folder / "socks4.txt",
        "SOCKS5": folder / "socks5.txt",
    }
    for file in files.values():
        file.write_text("", encoding="utf-8")
    (folder / "valids.txt").unlink(missing_ok=True)
    return files


def _append_valid(path: Path, line: str) -> None:
    with path.open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(line + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def _format_valid(record: ProxyRecord) -> str:
    return record.address


def main(argv: List[str] | None = None) -> int:
    args = _parse_args(argv)
    ui = ConsoleUI()

    records = _parse_input_file(args.input_file)
    output_files = _prepare_output_dir(args.output_dir)

    if not records:
        ui.log("ОШИБКА", f"Нет прокси для проверки: {args.input_file}", "red")
        ui.log("ФАЙЛ", f"Подготовлена папка: {args.output_dir}", "blue")
        return 1

    local_ip = resolve_local_public_ip(timeout=args.timeout)
    ui.log(
        "СТАРТ",
        (
            f"Файл={args.input_file} прокси={len(records)} workers={args.workers} timeout={args.timeout}s "
            f"local_ip={'не удалось определить' if not local_ip else local_ip}"
        ),
        "blue",
    )
    ui.log(
        "ЛОГИКА",
        "Проверяю реальные HTTP/HTTPS/SOCKS-сценарии, автоопределяю рабочий тип и сразу пишу по файлам протоколов.",
        "magenta",
    )

    checker = StrictProxyChecker(
        workers=args.workers,
        timeout=args.timeout,
        retries=args.retries,
        local_ip=local_ip,
    )

    saved_by_protocol: Dict[str, set[str]] = {proto: set() for proto in output_files}
    valid_total = 0
    invalid_total = 0
    by_protocol: Dict[str, int] = {}
    done_mark = 0
    progress = ui.progress("ВАЛИДАЦИЯ", "Проверяю export/proxies.txt", len(records), "magenta")

    def on_check(done: int, total: int, rec: ProxyRecord) -> None:
        nonlocal valid_total, invalid_total, done_mark
        if rec.working:
            line = _format_valid(rec)
            valid_total += 1
            for proto in rec.supported_protocols:
                store = saved_by_protocol.get(proto)
                target = output_files.get(proto)
                if store is None or target is None:
                    continue
                if line in store:
                    continue
                store.add(line)
                _append_valid(target, line)
                by_protocol[proto] = by_protocol.get(proto, 0) + 1
        else:
            invalid_total += 1

        if done == total or done - done_mark >= max(1, args.progress_every):
            done_mark = done
        progress.update(done, ok=sum(len(v) for v in saved_by_protocol.values()), bad=invalid_total)

    checked = checker.check_many(records, progress_cb=on_check)
    progress.finish(
        (
            f"Строгая проверка завершена | проверено={len(checked)} "
            f"| валидных={sum(len(v) for v in saved_by_protocol.values())} | невалидных={invalid_total}"
        ),
        "yellow" if checker.last_interrupted else "green",
    )

    if checker.last_interrupted:
        ui.log("ПРЕРВАНО", "Остановка пользователем. Уже найденные валидные прокси сохранены.", "yellow")

    ui.log(
        "ИТОГ",
        (
            f"HTTP={by_protocol.get('HTTP', 0)} HTTPS={by_protocol.get('HTTPS', 0)} "
            f"SOCKS4={by_protocol.get('SOCKS4', 0)} SOCKS5={by_protocol.get('SOCKS5', 0)}"
        ),
        "white",
    )
    ui.log("ФАЙЛ", f"Сохранено в папку: {args.output_dir}", "blue")
    return 130 if checker.last_interrupted else 0
