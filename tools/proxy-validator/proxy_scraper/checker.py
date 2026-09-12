from __future__ import annotations

import ipaddress
import random
import re
import socket
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List

from .models import ProxyRecord
from .strict_checker import StrictProxyChecker


FULL_IP_RE = re.compile(r"^(?:\d{1,3}\.){3}\d{1,3}$")
UA_POOL = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36",
]
TARGET_HOST = "api.ipify.org"
TARGET_PORT = 80
TARGET_PATH = "/"


def _is_public_ipv4(ip: str) -> bool:
    try:
        return ipaddress.IPv4Address(ip).is_global
    except ipaddress.AddressValueError:
        return False


class ProxyChecker:
    def __init__(
        self,
        workers: int = 500,
        timeout: int = 6,
        retries: int = 0,
        prefilter_timeout: float = 0.0,
    ):
        self.workers = max(1, workers)
        self.timeout = max(2, timeout)
        self.retries = max(0, retries)
        self.prefilter_timeout = max(0.0, float(prefilter_timeout))
        self.last_interrupted = False
        self._partial_results: List[ProxyRecord] = []
        # Public-mode used to call api.ipify.org over plain HTTP. That labelled
        # forward-only web proxies as "alive", although every real consumer in
        # this project connects to HTTPS panels and needs a working CONNECT/TLS
        # tunnel. Reuse the strict transport probes here so the first-stage
        # number means "usable by the hub", not merely "answered on a port".
        self._strict = StrictProxyChecker(
            workers=self.workers,
            timeout=self.timeout,
            retries=self.retries,
        )

    def _http_body(self, text: str) -> str:
        marker = "\r\n\r\n"
        return text.split(marker, 1)[1] if marker in text else text

    def _extract_ip(self, body: str) -> str:
        text = body.strip()
        if not text:
            return ""
        first = text.splitlines()[0].strip()
        if not FULL_IP_RE.fullmatch(first):
            return ""
        return first if _is_public_ipv4(first) else ""

    def _recv_exact(self, sock: socket.socket, size: int) -> bytes:
        chunks = []
        total = 0
        while total < size:
            chunk = sock.recv(size - total)
            if not chunk:
                raise OSError("connection closed before expected bytes")
            chunks.append(chunk)
            total += len(chunk)
        return b"".join(chunks)

    def _recv_text(self, sock: socket.socket, max_bytes: int = 65536) -> str:
        chunks = []
        total = 0
        while total < max_bytes:
            try:
                chunk = sock.recv(min(4096, max_bytes - total))
            except socket.timeout:
                break
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        return b"".join(chunks).decode("utf-8", errors="ignore")

    def _open_socket(self, host: str, port: int) -> socket.socket:
        sock = socket.create_connection((host, port), timeout=self.timeout)
        sock.settimeout(self.timeout)
        try:
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass
        return sock

    def _connect_probe(self, record: ProxyRecord) -> None:
        sock = None
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(self.prefilter_timeout)
            sock.connect((record.ip, record.port))
        finally:
            self._close_socket(sock)

    def _close_socket(self, sock: socket.socket | None) -> None:
        if sock is None:
            return
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            sock.close()
        except OSError:
            pass

    def _check_http_like(self, record: ProxyRecord) -> str:
        sock = None
        try:
            sock = self._open_socket(record.ip, record.port)
            request = (
                f"GET http://{TARGET_HOST}{TARGET_PATH} HTTP/1.1\r\n"
                f"Host: {TARGET_HOST}\r\n"
                f"User-Agent: {random.choice(UA_POOL)}\r\n"
                "Accept: text/plain,*/*\r\n"
                "Connection: close\r\n\r\n"
            )
            sock.sendall(request.encode("ascii", errors="ignore"))
            text = self._recv_text(sock)
        finally:
            self._close_socket(sock)

        ip = self._extract_ip(self._http_body(text))
        if not ip:
            raise OSError("http-like proxy did not return public IP")
        return ip

    def _check_socks5(self, record: ProxyRecord) -> str:
        sock = None
        try:
            sock = self._open_socket(record.ip, record.port)
            sock.sendall(b"\x05\x01\x00")
            if self._recv_exact(sock, 2) != b"\x05\x00":
                raise OSError("socks5 auth failed")

            host_b = TARGET_HOST.encode("idna")
            sock.sendall(b"\x05\x01\x00\x03" + bytes([len(host_b)]) + host_b + TARGET_PORT.to_bytes(2, "big"))
            head = self._recv_exact(sock, 4)
            if head[0] != 5 or head[1] != 0:
                raise OSError("socks5 connect failed")

            atyp = head[3]
            if atyp == 1:
                self._recv_exact(sock, 4)
            elif atyp == 3:
                ln = self._recv_exact(sock, 1)[0]
                self._recv_exact(sock, ln)
            elif atyp == 4:
                self._recv_exact(sock, 16)
            self._recv_exact(sock, 2)

            request = (
                f"GET {TARGET_PATH} HTTP/1.1\r\n"
                f"Host: {TARGET_HOST}\r\n"
                f"User-Agent: {random.choice(UA_POOL)}\r\n"
                "Accept: text/plain,*/*\r\n"
                "Connection: close\r\n\r\n"
            )
            sock.sendall(request.encode("ascii", errors="ignore"))
            text = self._recv_text(sock)
        finally:
            self._close_socket(sock)

        ip = self._extract_ip(self._http_body(text))
        if not ip:
            raise OSError("socks5 proxy did not return public IP")
        return ip

    def _check_socks4(self, record: ProxyRecord) -> str:
        sock = None
        try:
            sock = self._open_socket(record.ip, record.port)
            host_b = TARGET_HOST.encode("idna")
            request = (
                b"\x04\x01"
                + TARGET_PORT.to_bytes(2, "big")
                + b"\x00\x00\x00\x01"
                + b"u\x00"
                + host_b
                + b"\x00"
            )
            sock.sendall(request)
            reply = self._recv_exact(sock, 8)
            if len(reply) != 8 or reply[1] != 90:
                raise OSError("socks4 connect failed")

            http_request = (
                f"GET {TARGET_PATH} HTTP/1.1\r\n"
                f"Host: {TARGET_HOST}\r\n"
                f"User-Agent: {random.choice(UA_POOL)}\r\n"
                "Accept: text/plain,*/*\r\n"
                "Connection: close\r\n\r\n"
            )
            sock.sendall(http_request.encode("ascii", errors="ignore"))
            text = self._recv_text(sock)
        finally:
            self._close_socket(sock)

        ip = self._extract_ip(self._http_body(text))
        if not ip:
            raise OSError("socks4 proxy did not return public IP")
        return ip

    def _check_once(self, record: ProxyRecord) -> ProxyRecord:
        started = time.perf_counter()

        if self.prefilter_timeout > 0:
            self._connect_probe(record)

        proto = record.protocol.upper()

        if proto in {"HTTP", "HTTPS"}:
            # A panel URL is HTTPS, therefore an HTTP-family proxy is useful
            # only when CONNECT + TLS + an actual response body all work. A
            # plain GET proxy is intentionally rejected here.
            exit_ip = self._strict._check_https_via_http_proxy(record)
        elif proto == "SOCKS4":
            exit_ip = self._strict._check_socks4(record)
        elif proto == "SOCKS5":
            exit_ip = self._strict._check_socks5(record)
        else:
            raise OSError(f"unsupported protocol {proto}")

        record.working = True
        record.exit_ip = exit_ip
        record.latency_ms = round((time.perf_counter() - started) * 1000, 1)
        record.check_error = ""
        return record

    def _check_with_retry(self, record: ProxyRecord) -> ProxyRecord:
        last_error = ""
        for attempt in range(self.retries + 1):
            try:
                return self._check_once(record)
            except Exception as exc:
                last_error = str(exc)
                if attempt < self.retries:
                    time.sleep(0.1 * (attempt + 1))

        record.working = False
        record.exit_ip = ""
        record.latency_ms = 0.0
        record.check_error = last_error
        return record

    def check_many(self, records: List[ProxyRecord], progress_cb=None) -> List[ProxyRecord]:
        self.last_interrupted = False
        checked: List[ProxyRecord] = []
        self._partial_results = checked

        total = len(records)
        if total <= 0:
            return checked

        max_workers = max(1, min(self.workers, total))
        pool = ThreadPoolExecutor(max_workers=max_workers)
        futures = [pool.submit(self._check_with_retry, rec) for rec in records]

        try:
            done = 0
            for future in as_completed(futures):
                rec = future.result()
                checked.append(rec)
                done += 1
                if progress_cb:
                    progress_cb(done, total, rec)
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
