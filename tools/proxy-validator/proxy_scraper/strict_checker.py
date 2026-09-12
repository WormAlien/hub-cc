from __future__ import annotations

import ipaddress
import base64
import random
import re
import socket
import ssl
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Sequence

from .models import ProxyRecord


FULL_IP_RE = re.compile(r"^(?:\d{1,3}\.){3}\d{1,3}$")
DEBUG_MARKERS = (
    "REMOTE_ADDR",
    "REQUEST_METHOD",
    "REQUEST_URI",
    "HTTP_HOST",
    "CONNECTIVITYCHECK.GSTATIC.COM",
)
HTTP_TARGETS: Sequence[tuple[str, str]] = (
    ("api.ipify.org", "/"),
    ("ipv4.icanhazip.com", "/"),
)
TLS_TARGETS: Sequence[tuple[str, str]] = (
    ("api.ipify.org", "/"),
    ("ipv4.icanhazip.com", "/"),
)
HTTP_HINT_PORTS = {
    80,
    81,
    88,
    3128,
    8000,
    8001,
    8008,
    8080,
    8081,
    8088,
    8443,
    8888,
}
SOCKS_HINT_PORTS = {1080, 1081, 1085, 4145, 9050, 9051}
UA_POOL = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36",
]


def _is_public_ipv4(ip: str) -> bool:
    try:
        return ipaddress.IPv4Address(ip).is_global
    except ipaddress.AddressValueError:
        return False


def resolve_local_public_ip(timeout: int = 6) -> str:
    for url in ("https://api.ipify.org", "https://ipv4.icanhazip.com"):
        try:
            text = urllib.request.urlopen(url, timeout=timeout).read().decode().strip()
        except Exception:
            continue
        if FULL_IP_RE.fullmatch(text) and _is_public_ipv4(text):
            return text
    return ""


class StrictProxyChecker:
    def __init__(self, workers: int = 200, timeout: int = 6, retries: int = 0, local_ip: str = ""):
        self.workers = max(1, workers)
        self.timeout = max(2, timeout)
        self.retries = max(0, retries)
        self.local_ip = local_ip.strip()
        self.last_interrupted = False
        self._partial_results: List[ProxyRecord] = []

    def _open_socket(self, host: str, port: int) -> socket.socket:
        sock = socket.create_connection((host, port), timeout=self.timeout)
        sock.settimeout(self.timeout)
        return sock

    def _close_socket(self, sock: socket.socket | ssl.SSLSocket | None) -> None:
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

    def _recv_until(self, sock: socket.socket, marker: bytes = b"\r\n\r\n", max_bytes: int = 65536) -> bytes:
        data = bytearray()
        while len(data) < max_bytes:
            chunk = sock.recv(min(4096, max_bytes - len(data)))
            if not chunk:
                break
            data.extend(chunk)
            if marker in data:
                break
        return bytes(data)

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

    def _http_body(self, text: str) -> str:
        marker = "\r\n\r\n"
        return text.split(marker, 1)[1] if marker in text else text

    def _extract_ip(self, body: str) -> str:
        text = body.strip()
        if not text:
            return ""
        if any(marker in text.upper() for marker in DEBUG_MARKERS):
            return ""
        first = text.splitlines()[0].strip()
        if not FULL_IP_RE.fullmatch(first):
            return ""
        if not _is_public_ipv4(first):
            return ""
        if self.local_ip and first == self.local_ip:
            return ""
        return first

    def _wrap_tls(self, sock: socket.socket, host: str) -> ssl.SSLSocket:
        context = ssl.create_default_context()
        tls_sock = context.wrap_socket(sock, server_hostname=host)
        tls_sock.settimeout(self.timeout)
        return tls_sock

    def _proxy_auth_header(self, record: ProxyRecord) -> str:
        if not record.username and not record.password:
            return ""
        token = base64.b64encode(f"{record.username}:{record.password}".encode("utf-8", errors="ignore")).decode("ascii")
        return f"Proxy-Authorization: Basic {token}\r\n"

    def _connect_http_proxy(self, record: ProxyRecord, host: str, port: int) -> socket.socket:
        sock = self._open_socket(record.ip, record.port)
        request = (
            f"CONNECT {host}:{port} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            f"User-Agent: {random.choice(UA_POOL)}\r\n"
            f"{self._proxy_auth_header(record)}"
            "Proxy-Connection: keep-alive\r\n"
            "Connection: keep-alive\r\n\r\n"
        )
        sock.sendall(request.encode("ascii", errors="ignore"))
        headers = self._recv_until(sock)
        status_line = headers.decode("latin-1", errors="ignore").splitlines()[0] if headers else ""
        if " 200" not in status_line:
            self._close_socket(sock)
            raise OSError("http proxy connect failed")
        return sock

    def _connect_socks5(self, record: ProxyRecord, host: str, port: int) -> socket.socket:
        sock = self._open_socket(record.ip, record.port)
        methods = [0x00]
        use_auth = bool(record.username or record.password)
        if use_auth:
            methods.append(0x02)
        sock.sendall(bytes([0x05, len(methods), *methods]))
        auth_reply = self._recv_exact(sock, 2)
        if auth_reply[0] != 0x05 or auth_reply[1] == 0xFF:
            self._close_socket(sock)
            raise OSError("socks5 auth negotiation failed")
        if auth_reply[1] == 0x02:
            user_b = record.username.encode("utf-8", errors="ignore")
            pass_b = record.password.encode("utf-8", errors="ignore")
            if len(user_b) > 255 or len(pass_b) > 255:
                self._close_socket(sock)
                raise OSError("socks5 credentials too long")
            sock.sendall(bytes([0x01, len(user_b)]) + user_b + bytes([len(pass_b)]) + pass_b)
            auth_status = self._recv_exact(sock, 2)
            if auth_status[1] != 0x00:
                self._close_socket(sock)
                raise OSError("socks5 username/password rejected")
        elif use_auth and auth_reply[1] != 0x00:
            self._close_socket(sock)
            raise OSError("socks5 auth method mismatch")

        host_b = host.encode("idna")
        sock.sendall(b"\x05\x01\x00\x03" + bytes([len(host_b)]) + host_b + port.to_bytes(2, "big"))
        head = self._recv_exact(sock, 4)
        if head[0] != 5 or head[1] != 0:
            self._close_socket(sock)
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
        return sock

    def _connect_socks4(self, record: ProxyRecord, host: str, port: int) -> socket.socket:
        sock = self._open_socket(record.ip, record.port)
        host_b = host.encode("idna")
        user_b = (record.username or "u").encode("utf-8", errors="ignore")
        request = b"\x04\x01" + port.to_bytes(2, "big") + b"\x00\x00\x00\x01" + user_b + b"\x00" + host_b + b"\x00"
        sock.sendall(request)
        reply = self._recv_exact(sock, 8)
        if len(reply) != 8 or reply[1] != 90:
            self._close_socket(sock)
            raise OSError("socks4 connect failed")
        return sock

    def _fetch_tls_ip(self, sock: socket.socket, host: str, path: str) -> str:
        tls_sock = None
        try:
            tls_sock = self._wrap_tls(sock, host)
            request = (
                f"GET {path} HTTP/1.1\r\n"
                f"Host: {host}\r\n"
                f"User-Agent: {random.choice(UA_POOL)}\r\n"
                "Accept: text/plain,*/*\r\n"
                "Connection: close\r\n\r\n"
            )
            tls_sock.sendall(request.encode("ascii", errors="ignore"))
            text = self._recv_text(tls_sock)
        finally:
            self._close_socket(tls_sock)

        ip = self._extract_ip(self._http_body(text))
        if not ip:
            raise OSError("proxy did not return valid public ip over tls")
        return ip

    def _check_http_plain(self, record: ProxyRecord) -> str:
        last_error = "no plain http target worked"
        for host, path in HTTP_TARGETS:
            sock = None
            try:
                sock = self._open_socket(record.ip, record.port)
                request = (
                    f"GET http://{host}{path} HTTP/1.1\r\n"
                    f"Host: {host}\r\n"
                    f"User-Agent: {random.choice(UA_POOL)}\r\n"
                    f"{self._proxy_auth_header(record)}"
                    "Accept: text/plain,*/*\r\n"
                    "Connection: close\r\n\r\n"
                )
                sock.sendall(request.encode("ascii", errors="ignore"))
                text = self._recv_text(sock)
                ip = self._extract_ip(self._http_body(text))
                if not ip:
                    raise OSError("plain http proxy did not return public ip")
                return ip
            except Exception as exc:
                last_error = str(exc)
            finally:
                self._close_socket(sock)
        raise OSError(last_error)

    def _check_https_via_http_proxy(self, record: ProxyRecord) -> str:
        last_error = "no tls target worked"
        for host, path in TLS_TARGETS:
            sock = None
            try:
                sock = self._connect_http_proxy(record, host, 443)
                return self._fetch_tls_ip(sock, host, path)
            except Exception as exc:
                last_error = str(exc)
                self._close_socket(sock)
        raise OSError(last_error)

    def _check_http_family(self, record: ProxyRecord) -> tuple[list[str], str]:
        # The hub only talks to HTTPS panels. A forward-only plain HTTP proxy
        # cannot carry those requests, so it must not be exported as "valid".
        # Keep HTTPS as the protocol label: downstream writes a per-line scheme
        # and routes it through CONNECT (the transport for HTTP and HTTPS proxy
        # labels is deliberately the same there).
        https_ip = self._check_https_via_http_proxy(record)
        return ["HTTPS"], https_ip

    def _check_socks5(self, record: ProxyRecord) -> str:
        last_error = "no tls target worked"
        for host, path in TLS_TARGETS:
            sock = None
            try:
                sock = self._connect_socks5(record, host, 443)
                return self._fetch_tls_ip(sock, host, path)
            except Exception as exc:
                last_error = str(exc)
                self._close_socket(sock)
        raise OSError(last_error)

    def _check_socks4(self, record: ProxyRecord) -> str:
        last_error = "no tls target worked"
        for host, path in TLS_TARGETS:
            sock = None
            try:
                sock = self._connect_socks4(record, host, 443)
                return self._fetch_tls_ip(sock, host, path)
            except Exception as exc:
                last_error = str(exc)
                self._close_socket(sock)
        raise OSError(last_error)

    def _candidate_protocols(self, record: ProxyRecord) -> List[str]:
        hint = (record.protocol or "").strip().upper()
        if hint in {"HTTP", "HTTPS", "SOCKS4", "SOCKS5"}:
            if hint == "HTTPS":
                hint = "HTTP"
            rest = [proto for proto in ("HTTP", "SOCKS5", "SOCKS4") if proto != hint]
            return [hint] + rest
        if record.port in SOCKS_HINT_PORTS:
            return ["SOCKS5", "SOCKS4", "HTTP"]
        if record.port in HTTP_HINT_PORTS:
            return ["HTTP", "SOCKS5", "SOCKS4"]
        return ["HTTP", "SOCKS5", "SOCKS4"]

    def _check_once(self, record: ProxyRecord) -> ProxyRecord:
        started = time.perf_counter()
        last_error = "all protocols failed"
        for proto in self._candidate_protocols(record):
            try:
                if proto == "HTTP":
                    supported_protocols, exit_ip = self._check_http_family(record)
                elif proto == "SOCKS5":
                    exit_ip = self._check_socks5(record)
                    supported_protocols = ["SOCKS5"]
                else:
                    exit_ip = self._check_socks4(record)
                    supported_protocols = ["SOCKS4"]
                record.protocol = supported_protocols[0]
                record.supported_protocols = supported_protocols
                record.working = True
                record.exit_ip = exit_ip
                record.latency_ms = round((time.perf_counter() - started) * 1000, 1)
                record.check_error = ""
                return record
            except Exception as exc:
                last_error = f"{proto.lower()}: {exc}"

        record.working = False
        record.exit_ip = ""
        record.latency_ms = 0.0
        record.check_error = last_error
        record.supported_protocols = []
        return record

    def _check_with_retry(self, record: ProxyRecord) -> ProxyRecord:
        last_error = ""
        for attempt in range(self.retries + 1):
            checked = self._check_once(record)
            if checked.working:
                return checked
            last_error = checked.check_error
            if attempt < self.retries:
                time.sleep(0.1 * (attempt + 1))
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
