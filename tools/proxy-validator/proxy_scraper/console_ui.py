from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from datetime import datetime


_ANSI = {
    "reset": "\x1b[0m",
    "dim": "\x1b[2m",
    "red": "\x1b[31m",
    "green": "\x1b[32m",
    "yellow": "\x1b[33m",
    "blue": "\x1b[34m",
    "magenta": "\x1b[35m",
    "cyan": "\x1b[36m",
    "white": "\x1b[37m",
}


def _isatty() -> bool:
    try:
        return bool(sys.stdout.isatty())
    except Exception:
        return False


def _supports_color() -> bool:
    if os.getenv("NO_COLOR"):
        return False
    return _isatty()


def _enable_windows_vt_mode() -> None:
    if os.name != "nt":
        return
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32
        handle = kernel32.GetStdHandle(-11)  # STD_OUTPUT_HANDLE
        if handle == 0 or handle == -1:
            return
        mode = ctypes.c_uint()
        if kernel32.GetConsoleMode(handle, ctypes.byref(mode)) == 0:
            return
        kernel32.SetConsoleMode(handle, mode.value | 0x0004)  # ENABLE_VIRTUAL_TERMINAL_PROCESSING
    except Exception:
        return


def _truncate(text: str, max_len: int) -> str:
    if len(text) <= max_len:
        return text
    if max_len <= 1:
        return text[:max_len]
    if max_len <= 3:
        return text[:max_len]
    return text[: max_len - 3] + "..."


class ConsoleUI:
    def __init__(self) -> None:
        _enable_windows_vt_mode()
        self.use_color = _supports_color()
        self.use_live = _isatty()
        self._active_line_len = 0

    def _paint(self, text: str, color: str) -> str:
        if not self.use_color:
            return text
        code = _ANSI.get(color, "")
        if not code:
            return text
        return f"{code}{text}{_ANSI['reset']}"

    def _clear_live(self) -> None:
        if self._active_line_len <= 0:
            return
        sys.stdout.write("\r" + (" " * self._active_line_len) + "\r")
        sys.stdout.flush()
        self._active_line_len = 0

    def log(self, stage: str, message: str, color: str = "cyan") -> None:
        self._clear_live()
        ts = datetime.now().strftime("%H:%M:%S")
        head = f"[{stage}]"
        print(f"{self._paint(ts, 'dim')} {self._paint(head, color)} {message}")

    def progress(self, stage: str, title: str, total: int, color: str = "blue") -> "ProgressLine":
        return ProgressLine(ui=self, stage=stage, title=title, total=max(1, total), color=color)


@dataclass
class ProgressLine:
    ui: ConsoleUI
    stage: str
    title: str
    total: int
    color: str = "blue"
    _last_plain_len: int = 0
    _last_nonlive_done: int = 0

    def _bar(self, done: int, width: int = 30) -> str:
        ratio = 0.0 if self.total <= 0 else min(1.0, max(0.0, done / self.total))
        filled = int(width * ratio)
        return "[" + ("#" * filled) + ("-" * (width - filled)) + "]"

    def update(self, done: int, ok: int = 0, bad: int = 0, note: str = "") -> None:
        done = max(0, min(done, self.total))
        note = _truncate(note.strip(), 42) if note else ""

        if not self.ui.use_live:
            if done == self.total or done - self._last_nonlive_done >= max(1, self.total // 10):
                self._last_nonlive_done = done
                msg = f"{self.title}: {done}/{self.total} ok={ok} fail={bad}"
                if note:
                    msg += f" | {note}"
                self.ui.log(self.stage, msg, self.color)
            return

        ts = datetime.now().strftime("%H:%M:%S")
        parts = [
            self.ui._paint(ts, "dim"),
            self.ui._paint(f"[{self.stage}]", self.color),
            self.title,
            self._bar(done),
            f"{done}/{self.total}",
            f"ok={ok}",
            f"fail={bad}",
        ]
        if note:
            parts.append(note)
        plain_line = " ".join(parts)
        rendered = plain_line
        if len(plain_line) < self._last_plain_len:
            rendered = plain_line + (" " * (self._last_plain_len - len(plain_line)))
        self._last_plain_len = len(plain_line)
        self.ui._active_line_len = len(rendered)
        sys.stdout.write("\r" + rendered)
        sys.stdout.flush()

    def finish(self, summary: str, color: str = "green") -> None:
        self.ui._clear_live()
        self.ui.log(self.stage, summary, color=color)
