from __future__ import annotations

import json
import socket
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from .models import ProxyRecord
from .strict_checker import StrictProxyChecker


DOLPHIN_CHECKER_HOSTS = (
    "geo.anty-proxy-checker.com",
    "proxy-checker.dolphin-anty-mirror3.com",
    "proxy-checker.dolphin-anty-mirror3.org",
    "proxy-checker.dolphin-anty-mirror3.net",
)

DOLPHIN_CHECKER_IPS = (
    "35.157.178.163",
    "3.126.205.234",
    "3.74.241.196",
    "85.198.110.251",
    "88.218.188.83",
    "103.253.40.125",
)

DOLPHIN_PATHS = ("/ip-info", "/")


class DolphinProxyChecker(StrictProxyChecker):
    def _parse_dolphin_response(self, text: str) -> dict:
        body = self._http_body(text).strip()
        try:
            data = json.loads(body)
        except json.JSONDecodeError as exc:
            raise OSError("invalid json response") from exc
        if not isinstance(data, dict) or not data.get("ip"):
            raise OSError("json response without ip")
        return data

    def _request_json(self, sock: socket.socket, host: str, path: str) -> dict:
        request = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}\r\n"
            "Accept: application/json,text/plain,*/*\r\n"
            "Connection: close\r\n\r\n"
        )
        sock.sendall(request.encode("ascii", errors="ignore"))
        return self._parse_dolphin_response(self._recv_text(sock))

    def _request_tls_json(self, sock: socket.socket, host: str, path: str) -> dict:
        tls_sock = None
        try:
            tls_sock = self._wrap_tls(sock, host)
            return self._request_json(tls_sock, host, path)
        finally:
            self._close_socket(tls_sock)

    def _connect_socks5_local_dns(self, record: ProxyRecord, host: str, port: int) -> socket.socket:
        addresses = socket.getaddrinfo(host, port, family=socket.AF_INET, type=socket.SOCK_STREAM)
        if not addresses:
            raise OSError("target dns lookup failed")
        target_ip = socket.inet_aton(addresses[0][4][0])

        sock = self._open_socket(record.ip, record.port)
        try:
            methods = [0x00]
            use_auth = bool(record.username or record.password)
            if use_auth:
                methods.append(0x02)
            sock.sendall(bytes([0x05, len(methods), *methods]))
            auth_reply = self._recv_exact(sock, 2)
            if auth_reply[0] != 0x05 or auth_reply[1] == 0xFF:
                raise OSError("socks5 auth negotiation failed")
            if auth_reply[1] == 0x02:
                user_b = record.username.encode("utf-8", errors="ignore")
                pass_b = record.password.encode("utf-8", errors="ignore")
                sock.sendall(bytes([0x01, len(user_b)]) + user_b + bytes([len(pass_b)]) + pass_b)
                auth_status = self._recv_exact(sock, 2)
                if auth_status[1] != 0x00:
                    raise OSError("socks5 username/password rejected")

            sock.sendall(b"\x05\x01\x00\x01" + target_ip + port.to_bytes(2, "big"))
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
            return sock
        except Exception:
            self._close_socket(sock)
            raise

    def _target_hosts(self) -> list[str]:
        return list(DOLPHIN_CHECKER_HOSTS) + list(DOLPHIN_CHECKER_IPS)

    def _check_http_target(self, record: ProxyRecord, host: str) -> dict:
        errors: list[str] = []
        for path in DOLPHIN_PATHS:
            sock = None
            try:
                sock = self._open_socket(record.ip, record.port)
                request = (
                    f"GET http://{host}{path} HTTP/1.1\r\n"
                    f"Host: {host}\r\n"
                    f"{self._proxy_auth_header(record)}"
                    "Accept: application/json,text/plain,*/*\r\n"
                    "Connection: close\r\n\r\n"
                )
                sock.sendall(request.encode("ascii", errors="ignore"))
                return self._parse_dolphin_response(self._recv_text(sock))
            except Exception as exc:
                errors.append(f"http {path}: {exc}")
            finally:
                self._close_socket(sock)

        for path in DOLPHIN_PATHS:
            sock = None
            try:
                sock = self._connect_http_proxy(record, host, 443)
                return self._request_tls_json(sock, host, path)
            except Exception as exc:
                errors.append(f"https {path}: {exc}")
                self._close_socket(sock)
        raise OSError(" | ".join(errors))

    def _check_socks5_target(self, record: ProxyRecord, host: str) -> dict:
        errors: list[str] = []
        for connect in (self._connect_socks5, self._connect_socks5_local_dns):
            for path in DOLPHIN_PATHS:
                sock = None
                try:
                    sock = connect(record, host, 443)
                    return self._request_tls_json(sock, host, path)
                except Exception as exc:
                    errors.append(str(exc))
                    self._close_socket(sock)
        raise OSError(" | ".join(errors))

    def _check_socks4_target(self, record: ProxyRecord, host: str) -> dict:
        errors: list[str] = []
        for path in DOLPHIN_PATHS:
            sock = None
            try:
                sock = self._connect_socks4(record, host, 443)
                return self._request_tls_json(sock, host, path)
            except Exception as exc:
                errors.append(str(exc))
                self._close_socket(sock)
        raise OSError(" | ".join(errors))

    def _check_protocol_target(self, record: ProxyRecord, proto: str, host: str) -> dict:
        if proto == "HTTP":
            return self._check_http_target(record, host)
        if proto == "SOCKS5":
            return self._check_socks5_target(record, host)
        if proto == "SOCKS4":
            return self._check_socks4_target(record, host)
        raise OSError(f"unsupported protocol {proto}")

    def _check_once(self, record: ProxyRecord) -> ProxyRecord:
        started = time.perf_counter()
        last_error = "all dolphin checker hosts failed"

        for proto in self._candidate_protocols(record):
            hosts = self._target_hosts()
            pool = ThreadPoolExecutor(max_workers=min(len(hosts), 4))
            futures = [pool.submit(self._check_protocol_target, record, proto, host) for host in hosts]
            try:
                for future in as_completed(futures):
                    try:
                        data = future.result()
                    except Exception as exc:
                        last_error = f"{proto.lower()}: {exc}"
                        continue

                    record.protocol = "HTTP" if proto == "HTTP" else proto
                    record.supported_protocols = ["HTTP", "HTTPS"] if proto == "HTTP" else [proto]
                    record.working = True
                    record.exit_ip = str(data.get("ip", ""))
                    record.latency_ms = round((time.perf_counter() - started) * 1000, 1)
                    record.check_error = ""
                    for item in futures:
                        item.cancel()
                    pool.shutdown(wait=False, cancel_futures=True)
                    return record
            finally:
                pool.shutdown(wait=False, cancel_futures=True)

        record.working = False
        record.exit_ip = ""
        record.latency_ms = 0.0
        record.check_error = last_error
        record.supported_protocols = []
        return record
