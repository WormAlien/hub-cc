from __future__ import annotations

import json
import random
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Sequence, Tuple

from .models import DomainCheckResult, DomainTarget, ProxyRecord
from .strict_checker import StrictProxyChecker, UA_POOL
import socket
from typing import Optional


STATUS_RE = re.compile(r"^HTTP/\d(?:\.\d)?\s+(\d{3})\b")

# Interception / WAF pages served with HTTP 200. Any of these means the proxy
# answered instead of the origin, so the check must fail even on "200 OK".
HTML_MARKERS = (
    "<html",
    "<!doctype",
    "<head",
    "<body",
    "<script",
    "attention required",
    "cloudflare",
    "access denied",
    "just a moment",
)

MAX_BODY_CHARS = 262144


class DomainProxyChecker(StrictProxyChecker):
    def _connect_proxy(self, record: ProxyRecord, target: DomainTarget):
        proto = (record.protocol or "").strip().upper()
        if proto in {"HTTP", "HTTPS"}:
            return self._connect_http_proxy(record, target.host, target.port)
        if proto == "SOCKS5":
            return self._connect_socks5(record, target.host, target.port)
        if proto == "SOCKS4":
            return self._connect_socks4(record, target.host, target.port)
        raise OSError(f"unsupported protocol {proto}")

    def _extract_status_code(self, text: str) -> int:
        first_line = text.splitlines()[0].strip() if text else ""
        match = STATUS_RE.match(first_line)
        return int(match.group(1)) if match else 0

    def _is_success_status(self, code: int) -> bool:
        return 200 <= code < 500 and code != 407

    @staticmethod
    def _decode_chunked(payload: str) -> str:
        parts: List[str] = []
        rest = payload
        while rest:
            line, sep, rest = rest.partition("\r\n")
            if not sep:
                break
            token = line.split(";", 1)[0].strip()
            try:
                size = int(token, 16)
            except ValueError:
                break
            if size <= 0:
                break
            parts.append(rest[:size])
            rest = rest[size:]
            if rest.startswith("\r\n"):
                rest = rest[2:]
        return "".join(parts)

    def parse_http_response(self, raw: str) -> Tuple[int, str]:
        """Split a raw HTTP response into (status code, decoded body).

        Status-only parsing used to be enough; the newapi_status criterion needs
        the body, including the chunked encoding that agentrouter.org uses.
        """
        if not raw:
            return 0, ""

        head, sep, body = raw.partition("\r\n\r\n")
        if not sep:
            head, sep, body = raw.partition("\n\n")
        if not sep:
            head, body = raw, ""

        lines = head.splitlines()
        status = self._extract_status_code(lines[0] if lines else "")

        headers = {}
        for line in lines[1:]:
            key, delim, value = line.partition(":")
            if delim:
                headers[key.strip().lower()] = value.strip()

        if "chunked" in headers.get("transfer-encoding", "").lower():
            body = self._decode_chunked(body)
        else:
            length = headers.get("content-length", "")
            if length.isdigit():
                body = body[: int(length)]

        return status, body[:MAX_BODY_CHARS]

    def is_success_response(self, status: int, body: str, response_kind: str = "html") -> bool:
        kind = (response_kind or "html").strip().lower()
        if kind != "newapi_status":
            return self._is_success_status(status)

        if status != 200:
            return False

        text = (body or "").strip()
        if not text:
            return False

        probe = text[:2048].lower()
        if probe.startswith("<") or any(marker in probe for marker in HTML_MARKERS):
            return False

        try:
            payload = json.loads(text)
        except (ValueError, TypeError):
            return False

        if not isinstance(payload, dict):
            return False
        if "success" in payload and not payload["success"]:
            return False
        return isinstance(payload.get("data"), dict)

    @staticmethod
    def _decode_chunked_bytes(payload: bytes) -> bytes:
        """De-chunk НА БАЙТАХ. Размер куска задан в байтах, и резать по символам нельзя.

        🔴 Именно здесь ломалась проверка живых прокси: панель agentrouter.org китайская,
        тело приходит chunked, иероглиф занимает 3 байта. Строковый вариант отсчитывал
        символы — из полного ответа в 6869 байт выходило 1111–3850 байт мусора, `json.loads`
        падал, и годный адрес объявлялся мёртвым.
        """
        out = bytearray()
        rest = payload
        sep = b"\r\n"
        while rest:
            line, found, rest = rest.partition(sep)
            if not found:
                break
            token = line.split(b";", 1)[0].strip()
            try:
                size = int(token, 16)
            except ValueError:
                break
            if size <= 0:
                break
            out.extend(rest[:size])
            rest = rest[size:]
            if rest.startswith(sep):
                rest = rest[2:]
        return bytes(out)

    def read_http_message(self, conn, max_bytes: int = 262144) -> Tuple[int, str]:
        """Прочитать ответ целиком и вернуть (status, тело). Вся работа — на байтах.

        Раньше путь был «прочитать в str → разобрать str», и на нём тело портилось дважды:
        `recv` обрывался по первому таймауту, а chunked резался по символам.
        """
        raw = self._read_raw_response(conn, max_bytes=max_bytes)
        head, sep, body = raw.partition(b"\r\n\r\n")
        if not sep:
            head, sep, body = raw.partition(b"\n\n")
        if not sep:
            head, body = raw, b""

        lines = head.split(b"\r\n") if b"\r\n" in head else head.split(b"\n")
        status = self._extract_status_code(lines[0].decode("latin-1") if lines else "")

        headers = {}
        for line in lines[1:]:
            key, delim, value = line.decode("latin-1").partition(":")
            if delim:
                headers[key.strip().lower()] = value.strip()

        if "chunked" in headers.get("transfer-encoding", "").lower():
            body = self._decode_chunked_bytes(body)
        else:
            length = headers.get("content-length", "")
            if length.isdigit():
                body = body[: int(length)]

        return status, body.decode("utf-8", errors="replace")[:MAX_BODY_CHARS]

    def read_http_response(self, conn, max_bytes: int = 262144) -> str:
        """Совместимость: тот же ответ строкой, без разбора тела."""
        return self._read_raw_response(conn, max_bytes=max_bytes).decode("utf-8", errors="ignore")

    def _read_raw_response(self, conn, max_bytes: int = 262144) -> bytes:
        """Дочитать ответ ЦЕЛИКОМ: до Content-Length, до конца chunked или до закрытия.

        🔴 Почему не `_recv_text`. Тот выходит из цикла на первом же `socket.timeout`, и на
        медленном прокси возвращает КУСОК тела. Один таймаут `recv` на медленном канале —
        это норма, а не конец ответа.
        """
        data = bytearray()
        header_end = -1
        content_length: Optional[int] = None
        chunked = False
        idle = 0
        deadline = time.monotonic() + max(self.timeout, 5) * 3

        while len(data) < max_bytes and time.monotonic() < deadline:
            try:
                chunk = conn.recv(min(8192, max_bytes - len(data)))
            except socket.timeout:
                idle += 1
                # Два молчания подряд считаем концом: дальше ждать смысла нет, но один
                # таймаут посреди медленной передачи ответ больше не обрубает.
                if idle >= 2:
                    break
                continue
            except OSError:
                break
            if not chunk:
                break                     # сервер закрыл соединение — тело кончилось
            idle = 0
            data.extend(chunk)

            if header_end < 0:
                marker = data.find(b"\r\n\r\n")
                if marker >= 0:
                    header_end = marker + 4
                    head = bytes(data[:marker]).decode("latin-1").lower()
                    for line in head.split("\r\n")[1:]:
                        if line.startswith("content-length:"):
                            try:
                                content_length = int(line.split(":", 1)[1].strip())
                            except ValueError:
                                content_length = None
                        elif line.startswith("transfer-encoding:") and "chunked" in line:
                            chunked = True

            if header_end >= 0:
                if content_length is not None and len(data) - header_end >= content_length:
                    break
                if chunked and data.find(b"0\r\n\r\n", header_end) >= 0:
                    break

        return bytes(data)

    def _request_target(self, record: ProxyRecord, target: DomainTarget) -> int:
        sock = None
        conn = None
        try:
            sock = self._connect_proxy(record, target)
            if target.use_tls:
                conn = self._wrap_tls(sock, target.host)
                sock = None
            else:
                conn = sock
                sock = None

            request = (
                f"GET {target.path} HTTP/1.1\r\n"
                f"Host: {target.host}\r\n"
                f"User-Agent: {random.choice(UA_POOL)}\r\n"
                "Accept: application/json,text/html;q=0.9,*/*;q=0.8\r\n"
                "Accept-Language: en-US,en;q=0.9\r\n"
                "Connection: close\r\n\r\n"
            )
            conn.sendall(request.encode("ascii", errors="ignore"))
            status_code, body = self.read_http_message(conn)
            if not self.is_success_response(status_code, body, getattr(target, "response", "html")):
                raise OSError(f"status {status_code or 'unknown'} body-check failed")
            return status_code
        finally:
            self._close_socket(conn)
            self._close_socket(sock)

    def _check_once(self, record: ProxyRecord, targets: Sequence[DomainTarget]) -> DomainCheckResult:
        started = time.perf_counter()
        passed: list[str] = []
        failed: list[str] = []
        errors: dict[str, str] = {}

        for target in targets:
            try:
                self._request_target(record, target)
                passed.append(target.name)
            except Exception as exc:
                failed.append(target.name)
                errors[target.name] = str(exc)

        return DomainCheckResult(
            proxy=record,
            passed_targets=passed,
            failed_targets=failed,
            errors=errors,
            latency_ms=round((time.perf_counter() - started) * 1000, 1),
        )

    def check_many(
        self,
        records: List[ProxyRecord],
        targets: Sequence[DomainTarget],
        progress_cb=None,
    ) -> List[DomainCheckResult]:
        self.last_interrupted = False
        checked: List[DomainCheckResult] = []
        self._partial_results = checked

        total = len(records)
        if total <= 0:
            return checked

        max_workers = max(1, min(self.workers, total))
        pool = ThreadPoolExecutor(max_workers=max_workers)
        futures = [pool.submit(self._check_once, rec, targets) for rec in records]

        try:
            done = 0
            for future in as_completed(futures):
                result = future.result()
                checked.append(result)
                done += 1
                if progress_cb:
                    progress_cb(done, total, result)
        except KeyboardInterrupt:
            self.last_interrupted = True
            for future in futures:
                future.cancel()
            pool.shutdown(wait=False, cancel_futures=True)
            return list(self._partial_results)
        finally:
            if not self.last_interrupted:
                pool.shutdown(wait=True, cancel_futures=False)

        return checked
