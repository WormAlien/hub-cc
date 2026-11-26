"""Transport for an owned stdin/stdout JSON-lines subprocess.

JSON reply objects are returned unchanged. Consume an unsolicited startup
reply with ``read_response`` before calling ``ask``. This object takes exclusive
ownership of the supplied Popen's pipes; do not read or write them elsewhere.

``read_response(timeout)`` and ``ask(request, timeout=300)`` use one monotonic
budget, including request serialization/lock/write/reply. ``timeout`` is a
client option, never inserted into the JSON request. TimeoutError, EOFError,
and RuntimeError have fixed, secret-free messages. A timeout, EOF, pipe error,
or protocol desync poisons the client: close it and create a fresh process.

Diagnostics (including stderr while idle) are redacted and delivered as
``[stdout] ...`` / ``[stderr] ...`` strings by a separate log thread. The
callback should be fast and thread-safe; its exceptions are suppressed. JSON
responses, which may intentionally contain credentials, are never logged.

``close(timeout=2)`` allows ``timeout`` seconds for cooperative quit, then up
to two additional seconds for owned-process escalation and resource cleanup.
Windows uses PID-scoped taskkill /T /F; POSIX kills a process group only after
verifying an isolated child session (spawn with start_new_session=True).
An already-exited Windows owner cannot safely identify orphan descendants;
an inherited pipe then produces a bounded cleanup error, not a broad kill.
"""
import json
import math
import os
import queue
import re
import signal
import subprocess
import threading
import time
from urllib.parse import unquote


_JWT = re.compile(r"(?<![\w-])eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+")
_API_SECRET = re.compile(r"\bul_[A-Za-z0-9_-]+", re.IGNORECASE)
_QUERY_SECRET = re.compile(
    r"((?:[?&]|&amp;|%3f|%26)(?:[a-z]|%[0-9a-f]{2})+(?:=|%3d))"
    r"((?:(?!%26|%23)[^\s&#\"'<>])*)", re.IGNORECASE,
)
_SENSITIVE_FIELDS = {"token", "payload", "key", "code"}
_FIELD_SECRET = re.compile(
    r"((?<![\w-])[\"']?(?:token|payload|key|code)[\"']?\s*[:=]\s*)"
    r"(\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'|[^\s,;}&<>]+)",
    re.IGNORECASE,
)


def _redact_query(match):
    prefix = unquote(match[1]).replace("&amp;", "&")
    name = prefix[1:-1].lower()
    return match[1] + "[REDACTED]" if name in _SENSITIVE_FIELDS else match[0]


def _redact_json(value):
    if isinstance(value, dict):
        return {key: "[REDACTED]" if key.lower() in _SENSITIVE_FIELDS
                else _redact_json(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_redact_json(item) for item in value]
    if isinstance(value, str):
        return _redact(value)
    return value


def _redact(line):
    # Structured stderr diagnostics need whole sensitive subtrees removed,
    # not just the first whitespace-delimited part of their value.
    try:
        structured = json.loads(line)
    except ValueError:
        pass
    else:
        if isinstance(structured, (dict, list)):
            line = json.dumps(_redact_json(structured), ensure_ascii=False)
    line = _QUERY_SECRET.sub(_redact_query, line)
    line = _FIELD_SECRET.sub(lambda match: match[1] + "[REDACTED]", line)
    line = _JWT.sub("[REDACTED]", line)
    return _API_SECRET.sub("[REDACTED]", line)


def _reject_constant(value):
    raise ValueError("non-standard JSON constant")


class MailProcessClient:
    """Own the pipes and lifecycle of one supplied ``subprocess.Popen``."""

    def __init__(self, proc, on_log=None):
        if proc.stdin is None or proc.stdout is None or proc.stderr is None:
            raise ValueError("mail process requires stdin, stdout and stderr pipes")
        self.proc = proc
        self.on_log = on_log
        self._events = queue.Queue()
        self._logs = queue.Queue()
        self._writes = queue.Queue()
        self._closed = False
        self._poisoned = False
        self._request_lock = threading.Lock()
        self._close_lock = threading.Lock()
        self._close_complete = threading.Event()
        self._owned_pgid = None
        if os.name != "nt":
            try:
                if os.getpgid(proc.pid) == proc.pid and os.getsid(proc.pid) == proc.pid:
                    self._owned_pgid = proc.pid
            except OSError:
                pass
        self._writer = threading.Thread(
            target=self._write_loop, daemon=True, name="mail-rpc-stdin",
        )
        self._writer.start()
        self._logger = threading.Thread(
            target=self._dispatch_logs, daemon=True, name="mail-rpc-logs",
        )
        self._logger.start()
        self._readers = []
        for name, stream in (("stdout", proc.stdout), ("stderr", proc.stderr)):
            thread = threading.Thread(
                target=self._drain, args=(name, stream), daemon=True,
                name="mail-rpc-" + name,
            )
            self._readers.append(thread)
            thread.start()

    def _drain(self, name, stream):
        try:
            while True:
                line = stream.readline()
                if not line:
                    break
                if isinstance(line, bytes):
                    line = line.decode("utf-8", errors="replace")
                if name == "stdout":
                    try:
                        response = json.loads(line, parse_constant=_reject_constant)
                    except ValueError:
                        if line.lstrip().startswith("{"):
                            self._logs.put("[stdout] " + _redact(line.rstrip("\r\n")))
                            self._events.put(("protocol", None))
                            continue
                    else:
                        if isinstance(response, dict):
                            self._events.put(("response", response))
                        else:
                            self._logs.put("[stdout] " + _redact(line.rstrip("\r\n")))
                            self._events.put(("protocol", None))
                        continue
                self._logs.put("[" + name + "] " + _redact(line.rstrip("\r\n")))
        except (OSError, ValueError, UnicodeError):
            self._logs.put("[" + name + "] pipe read failed")
            self._events.put(("protocol", None))
        finally:
            self._events.put((name, None))

    def _dispatch_logs(self):
        while True:
            line = self._logs.get()
            if line is None:
                return
            if self.on_log is not None:
                try:
                    self.on_log(line)
                except Exception:
                    # A logging sink must never break pipe draining or RPC;
                    # exception text may itself contain a secret.
                    pass

    def _write_loop(self):
        while True:
            item = self._writes.get()
            if item is None:
                return
            payload, result = item
            try:
                if not self.proc.text_mode:
                    payload = payload.encode("utf-8")
                self.proc.stdin.write(payload)
                self.proc.stdin.flush()
            except (OSError, ValueError, UnicodeError):
                result.put(False)
            else:
                result.put(True)

    def _send(self, payload, deadline, during_close=False):
        result = queue.Queue(maxsize=1)
        if time.monotonic() >= deadline:
            self._poisoned = True
            raise TimeoutError("mail process write timed out")
        self._writes.put((payload, result))
        while True:
            if not during_close:
                self._check_usable()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                self._poisoned = True
                raise TimeoutError("mail process write timed out")
            try:
                succeeded = result.get(timeout=min(remaining, 0.05))
            except queue.Empty:
                if self.proc.poll() is not None:
                    self._poisoned = True
                    raise EOFError("mail process exited before accepting the request") from None
                continue
            if not succeeded:
                self._poisoned = True
                raise EOFError("mail process stdin write failed")
            return

    def _check_usable(self):
        if self._closed:
            raise RuntimeError("mail process client is closed")
        if self._poisoned:
            raise RuntimeError("mail process client is poisoned; create a new process")

    @staticmethod
    def _timeout(timeout):
        try:
            timeout = float(timeout)
        except (TypeError, ValueError, OverflowError):
            raise ValueError("timeout must be a finite non-negative number") from None
        if not math.isfinite(timeout) or not 0 <= timeout <= threading.TIMEOUT_MAX:
            raise ValueError("timeout must be a finite non-negative number")
        return timeout

    def read_response(self, timeout: float):
        """Read a startup/direct reply, serialized with ask; return a dict."""
        timeout = self._timeout(timeout)
        self._check_usable()
        deadline = time.monotonic() + timeout
        if not self._request_lock.acquire(timeout=max(0, timeout)):
            self._poisoned = True
            raise TimeoutError("mail process request lock timed out")
        try:
            return self._read_response(deadline)
        finally:
            self._request_lock.release()

    def _read_response(self, deadline):
        self._check_usable()
        while True:
            self._check_usable()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                self._poisoned = True
                raise TimeoutError("mail process response timed out")
            try:
                name, value = self._events.get(timeout=min(remaining, 0.05))
            except queue.Empty:
                if self.proc.poll() is not None:
                    self._poisoned = True
                    raise EOFError("mail process exited before its reply") from None
                continue
            if name == "protocol":
                self._poisoned = True
                raise RuntimeError("mail process protocol requires a JSON object reply")
            if value is None:
                if name == "stdout":
                    self._poisoned = True
                    raise EOFError("mail process stdout reached EOF")
                continue
            if name == "response":
                return value

    def ask(self, request, timeout: float = 300):
        """Send exactly one JSON request and return its matching object reply."""
        timeout = self._timeout(timeout)
        self._check_usable()
        deadline = time.monotonic() + timeout
        if not self._request_lock.acquire(timeout=max(0, timeout)):
            self._poisoned = True
            raise TimeoutError("mail process request lock timed out")
        try:
            self._check_usable()
            self._check_no_pending_reply()
            self._send(json.dumps(request) + "\n", deadline)
            return self._read_response(deadline)
        finally:
            self._request_lock.release()

    def _check_no_pending_reply(self):
        while True:
            try:
                name, _ = self._events.get_nowait()
            except queue.Empty:
                return
            if name == "stderr":
                continue
            if name == "stdout":
                self._poisoned = True
                raise EOFError("mail process stdout reached EOF")
            if name == "closed":
                self._check_usable()
            self._poisoned = True
            raise RuntimeError("mail process protocol has an unexpected pending reply")

    def close(self, timeout: float = 2):
        """Try quit for ``timeout`` seconds, then spend at most 2s cleaning up.

        Windows escalation kills only the supplied PID's process tree. POSIX
        groups are signalled only after verifying an isolated child session.
        """
        timeout = self._timeout(timeout)
        if not self._close_lock.acquire(blocking=False):
            if not self._close_complete.wait(max(0, timeout) + 2):
                raise TimeoutError("mail process cleanup timed out")
            return
        try:
            if self._closed:
                return
            self._closed = True
            self._events.put(("closed", None))
            cooperative_deadline = time.monotonic() + max(0, timeout)
            idle = self._request_lock.acquire(blocking=False)
            try:
                if idle and not self._poisoned and self.proc.poll() is None:
                    try:
                        self._send('{"cmd":"quit"}\n', cooperative_deadline,
                                   during_close=True)
                        self.proc.wait(timeout=max(0, cooperative_deadline - time.monotonic()))
                    except (EOFError, TimeoutError, subprocess.TimeoutExpired):
                        pass
            finally:
                if idle:
                    self._request_lock.release()

            cleanup_deadline = time.monotonic() + 2
            self._stop_owned(cleanup_deadline)
            self._writes.put(None)
            workers = [self._writer, *self._readers]
            for thread in workers:
                thread.join(timeout=max(0, cleanup_deadline - time.monotonic()))
            if any(thread.is_alive() for thread in workers):
                threading.Thread(target=self._finish_pipes, daemon=True,
                                 name="mail-rpc-cleanup").start()
                raise TimeoutError("mail process pipe cleanup timed out")
            self._finish_pipes()
            self._logger.join(timeout=max(0, cleanup_deadline - time.monotonic()))
            if self.proc.poll() is None:
                raise TimeoutError("mail process cleanup timed out")
        finally:
            self._close_complete.set()
            self._close_lock.release()

    def _stop_owned(self, deadline):
        if os.name == "nt":
            if self.proc.poll() is None:
                try:
                    subprocess.run(
                        ["taskkill.exe", "/PID", str(self.proc.pid), "/T", "/F"],
                        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        timeout=max(0.001, min(1.5, deadline - time.monotonic())),
                        check=False,
                    )
                except (OSError, subprocess.TimeoutExpired):
                    pass
        elif self._owned_pgid is not None:
            try:
                os.killpg(self._owned_pgid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        elif self.proc.poll() is None:
            self.proc.terminate()

        try:
            self.proc.wait(timeout=max(0, min(0.15, deadline - time.monotonic())))
        except subprocess.TimeoutExpired:
            pass
        if os.name != "nt" and self._owned_pgid is not None:
            try:
                os.killpg(self._owned_pgid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        elif self.proc.poll() is None:
            self.proc.kill()
        try:
            self.proc.wait(timeout=max(0, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            pass

    def _finish_pipes(self):
        for thread in [self._writer, *self._readers]:
            thread.join()
        for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            try:
                stream.close()
            except (OSError, ValueError):
                pass
        self._logs.put(None)
