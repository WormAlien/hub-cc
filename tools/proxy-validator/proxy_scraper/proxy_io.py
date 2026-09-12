from __future__ import annotations

import re
from pathlib import Path
from typing import Iterable, List

from .models import ProxyRecord


INPUT_RE = re.compile(
    r"^(?:(?P<proto>https?|socks4|socks5)://)?(?P<host>[A-Za-z0-9.-]{1,253}):(?P<port>\d{1,5})$",
    re.IGNORECASE,
)

IPV4_RE = re.compile(r"^\d{1,3}(?:\.\d{1,3}){3}$")
HOST_LABEL_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$")


def is_valid_ipv4(text: str) -> bool:
    if not IPV4_RE.match(text):
        return False
    return all(0 <= int(part) <= 255 for part in text.split("."))


def is_valid_hostname(text: str) -> bool:
    """ASCII DNS hostname: labels 1-63 chars, '-' never on a label edge, <=253 total.

    Rented gateways are handed out as ``gate.provider.com:7000``, so a parser
    that only understands IPv4 silently dropped every paid proxy in the list.
    """
    value = text.strip()
    if not value or len(value) > 253:
        return False
    labels = value.split(".")
    if len(labels) < 2:
        return False
    if not all(HOST_LABEL_RE.match(label) for label in labels):
        return False
    # A dotted all-numeric string is a malformed IPv4, not a hostname.
    return not labels[-1].isdigit()


def is_valid_host(text: str) -> bool:
    return is_valid_ipv4(text) or is_valid_hostname(text)


def _split_credentials(text: str) -> tuple[str, str] | None:
    value = text.strip()
    if not value or ":" not in value:
        return None
    user, password = value.split(":", 1)
    user = user.strip()
    password = password.strip()
    if not user and not password:
        return None
    return user, password


def _parse_host_port(text: str) -> tuple[str, int] | None:
    match = INPUT_RE.match(text.strip())
    if not match:
        return None
    host = match.group("host")
    if not is_valid_host(host):
        return None
    port = int(match.group("port"))
    if port < 1 or port > 65535:
        return None
    return host, port


# Backwards-compatible alias: the parser now accepts hostnames as well.
_parse_ip_port = _parse_host_port


def parse_proxy_line(line: str, source: str, default_protocol: str = "AUTO") -> ProxyRecord | None:
    text = line.strip()
    if not text or text.startswith("#"):
        return None

    protocol = (default_protocol or "AUTO").strip().upper()
    if protocol not in {"AUTO", "HTTP", "HTTPS", "SOCKS4", "SOCKS5"}:
        protocol = "AUTO"

    if "://" in text:
        proto_raw, text = text.split("://", 1)
        proto = proto_raw.strip().upper()
        if proto in {"HTTP", "HTTPS", "SOCKS4", "SOCKS5"}:
            protocol = proto

    username = ""
    password = ""
    ip = ""
    port = 0

    if "@" in text:
        left, right = text.split("@", 1)
        right_ip_port = _parse_ip_port(right)
        left_ip_port = _parse_ip_port(left)
        if right_ip_port:
            creds = _split_credentials(left)
            if creds:
                username, password = creds
                ip, port = right_ip_port
        elif left_ip_port:
            creds = _split_credentials(right)
            if creds:
                username, password = creds
                ip, port = left_ip_port

    if not ip and "|" in text:
        left, right = text.split("|", 1)
        left_ip_port = _parse_ip_port(left)
        creds = _split_credentials(right)
        if left_ip_port and creds:
            ip, port = left_ip_port
            username, password = creds

    if not ip and " " in text:
        left, right = text.split(None, 1)
        left_ip_port = _parse_ip_port(left)
        creds = _split_credentials(right)
        if left_ip_port and creds:
            ip, port = left_ip_port
            username, password = creds

    if not ip:
        parts = [part.strip() for part in text.split(":")]
        if len(parts) == 4:
            if is_valid_host(parts[0]) and parts[1].isdigit():
                ip = parts[0]
                port = int(parts[1])
                username = parts[2]
                password = parts[3]
            elif is_valid_host(parts[2]) and parts[3].isdigit():
                username = parts[0]
                password = parts[1]
                ip = parts[2]
                port = int(parts[3])

    if not ip:
        parsed = _parse_host_port(text)
        if parsed:
            ip, port = parsed

    if not ip or not is_valid_host(ip) or port <= 0 or port > 65535:
        return None

    return ProxyRecord(
        ip=ip,
        port=port,
        protocol=protocol,
        source=source,
        username=username,
        password=password,
    )


def parse_proxy_file(path: str | Path, default_protocol: str = "AUTO") -> List[ProxyRecord]:
    source = Path(path)
    if not source.exists():
        return []

    result: List[ProxyRecord] = []
    seen = set()
    for raw in source.read_text(encoding="utf-8-sig", errors="ignore").splitlines():
        rec = parse_proxy_line(raw, str(source), default_protocol=default_protocol)
        if rec is None:
            continue
        key = f"{rec.protocol}|{rec.address}|{rec.username}|{rec.password}"
        if key in seen:
            continue
        seen.add(key)
        result.append(rec)
    return result


def parse_proxy_files(files: Iterable[tuple[str | Path, str]]) -> List[ProxyRecord]:
    result: List[ProxyRecord] = []
    seen = set()
    for path, default_protocol in files:
        for rec in parse_proxy_file(path, default_protocol=default_protocol):
            key = f"{rec.protocol}|{rec.address}|{rec.username}|{rec.password}"
            if key in seen:
                continue
            seen.add(key)
            result.append(rec)
    return result


TUNNELABLE_PROTOCOLS = ("http", "https", "socks4", "socks5")


def format_proxy_uri(record: ProxyRecord) -> str:
    """Render a record as a ``scheme://[auth@]host:port`` URI.

    The scheme is written into *every* line on purpose: a consumer reading a
    mixed HTTP+SOCKS list must decide per address, not per filename.

    Raises ``ValueError`` when the record carries no usable protocol. The old
    behaviour substituted ``AUTO``, which produced ``auto://host:port`` lines
    that no consumer understands -- ``routing/lib/proxy-pool.js`` only knows
    http/https/socks/socks4/socks5, so such a line was silently binned as junk
    and the proxy was lost without a word. A mixed run makes that more likely
    than a single-protocol one, because unclassified records are exactly the
    ones that survive a pass without pinning down their protocol.
    """
    protocol = (record.protocol or "").strip().lower()
    if protocol not in TUNNELABLE_PROTOCOLS:
        raise ValueError(
            f"proxy {record.address}: protocol {record.protocol!r} is not tunnelable "
            f"(need one of {', '.join(TUNNELABLE_PROTOCOLS)})"
        )
    auth = ""
    if record.username or record.password:
        auth = f"{record.username}:{record.password}@"
    return f"{protocol}://{auth}{record.address}"
