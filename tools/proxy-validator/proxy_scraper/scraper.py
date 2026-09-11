import ipaddress
import json
import random
import re
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Dict, List, Optional

from .models import ProxyRecord, ProxyService, ServiceRunResult


IP_PORT_RE = re.compile(
    r"(?:(?P<scheme>https?|socks4|socks5)://)?(?<![\d.])(?P<ip>\d{1,3}(?:\.\d{1,3}){3})\s*[:|\s]\s*(?P<port>\d{2,5})(?:[^\d]|$)",
    re.MULTILINE | re.IGNORECASE,
)

KNOWN_PROTOCOLS = {"HTTP", "HTTPS", "SOCKS4", "SOCKS5"}
MIXED_PROTOCOL = "MIXED"
MIXED_FALLBACK_PROTOCOL = "HTTP"

UA_POOL = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36",
]

DATA_CENTER_HINTS = {
    "aws",
    "amazon",
    "google cloud",
    "digitalocean",
    "linode",
    "ovh",
    "hetzner",
    "vultr",
    "contabo",
    "leaseweb",
    "datacenter",
    "hosting",
    "server",
    "cloudflare",
}

RESIDENTIAL_HINTS = {
    "comcast",
    "xfinity",
    "verizon",
    "spectrum",
    "vodafone",
    "telefonica",
    "orange",
    "telecom",
    "broadband",
    "cable",
    "fiber",
    "mobile",
}

_UNUSABLE_NETWORKS = [
    ipaddress.IPv4Network("0.0.0.0/8"),
    ipaddress.IPv4Network("10.0.0.0/8"),
    ipaddress.IPv4Network("100.64.0.0/10"),
    ipaddress.IPv4Network("127.0.0.0/8"),
    ipaddress.IPv4Network("169.254.0.0/16"),
    ipaddress.IPv4Network("172.16.0.0/12"),
    ipaddress.IPv4Network("192.0.0.0/24"),
    ipaddress.IPv4Network("192.168.0.0/16"),
    ipaddress.IPv4Network("198.18.0.0/15"),
    ipaddress.IPv4Network("255.255.255.255/32"),
]


def _is_public_ipv4(ip: str) -> bool:
    """Reject addresses that can never be a reachable proxy.

    ``IPv4Address.is_global`` also rejects the RFC 5737 documentation ranges
    (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24), which never show up in real
    proxy lists but are the only addresses safe to use in tests. The explicit
    list below drops exactly the unusable space and nothing else.
    """
    try:
        addr = ipaddress.IPv4Address(ip)
    except (ipaddress.AddressValueError, ValueError):
        return False
    if addr.is_unspecified or addr.is_loopback or addr.is_link_local:
        return False
    if addr.is_multicast or addr.is_reserved:
        return False
    for network in _UNUSABLE_NETWORKS:
        if addr in network:
            return False
    return True


def _parse_port(value: object) -> Optional[int]:
    try:
        port = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return port if 1 <= port <= 65535 else None


def _infer_residential(meta: Dict[str, object]) -> Optional[bool]:
    for key in ("residential", "isResidential", "residentialProxy"):
        if key in meta:
            value = meta.get(key)
            if isinstance(value, bool):
                return value
            if isinstance(value, str):
                val = value.strip().lower()
                if val in {"1", "true", "yes", "residential"}:
                    return True
                if val in {"0", "false", "no", "datacenter", "dc"}:
                    return False

    blob = " ".join(
        str(meta.get(k, "")) for k in ("isp", "org", "as", "asn", "provider")
    ).lower()
    if any(h in blob for h in DATA_CENTER_HINTS):
        return False
    if any(h in blob for h in RESIDENTIAL_HINTS):
        return True
    return None


class ProxyScraper:
    def __init__(
        self,
        services: List[ProxyService],
        threads: int = 40,
        timeout: int = 12,
        retries: int = 1,
        max_per_source: int = 0,
    ):
        self.services = [s for s in services if s.enabled]
        self.threads = max(1, threads)
        self.timeout = max(3, timeout)
        self.retries = max(0, retries)
        self.max_per_source = max(0, max_per_source)
        self._lock = threading.Lock()
        self._items: Dict[str, ProxyRecord] = {}
        self.results: List[ServiceRunResult] = []
        self._fetch_cache: Dict[str, str] = {}
        self._fetch_error: Dict[str, str] = {}
        self._fetch_wait: Dict[str, threading.Event] = {}
        self._fetch_lock = threading.Lock()

    def _headers(self) -> Dict[str, str]:
        return {
            "User-Agent": random.choice(UA_POOL),
            "Accept": "text/html,application/json,*/*",
            "Accept-Language": "en-US,en;q=0.9",
            "Connection": "close",
        }

    def _fetch(self, url: str) -> str:
        req = urllib.request.Request(url, headers=self._headers())
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            raw = resp.read()
        for enc in ("utf-8", "latin-1", "cp1251"):
            try:
                return raw.decode(enc)
            except UnicodeDecodeError:
                continue
        return raw.decode("utf-8", errors="ignore")

    def _fetch_cached(self, url: str) -> str:
        with self._fetch_lock:
            cached = self._fetch_cache.get(url)
            if cached is not None:
                return cached
            if url in self._fetch_error:
                raise OSError(self._fetch_error[url])
            waiter = self._fetch_wait.get(url)
            if waiter is None:
                waiter = threading.Event()
                self._fetch_wait[url] = waiter
                is_owner = True
            else:
                is_owner = False

        if not is_owner:
            waiter.wait(timeout=self.timeout + 2)
            with self._fetch_lock:
                cached = self._fetch_cache.get(url)
                if cached is not None:
                    return cached
                if url in self._fetch_error:
                    raise OSError(self._fetch_error[url])
            raise TimeoutError(f"wait fetch timeout: {url}")

        try:
            text = self._fetch(url)
            with self._fetch_lock:
                self._fetch_cache[url] = text
                done = self._fetch_wait.pop(url, None)
                if done:
                    done.set()
            return text
        except Exception as exc:
            with self._fetch_lock:
                self._fetch_error[url] = str(exc)
                done = self._fetch_wait.pop(url, None)
                if done:
                    done.set()
            raise

    def _add_record(self, rec: ProxyRecord) -> None:
        key = f"{rec.protocol}|{rec.address}"
        with self._lock:
            old = self._items.get(key)
            if old is None:
                self._items[key] = rec
                return
            if old.residential is not True and rec.residential is not None:
                old.residential = rec.residential
            if not old.isp_hint and rec.isp_hint:
                old.isp_hint = rec.isp_hint

    def _add_many(self, records: List[ProxyRecord]) -> None:
        with self._lock:
            for rec in records:
                key = f"{rec.protocol}|{rec.address}"
                old = self._items.get(key)
                if old is None:
                    self._items[key] = rec
                    continue
                if old.residential is not True and rec.residential is not None:
                    old.residential = rec.residential
                if not old.isp_hint and rec.isp_hint:
                    old.isp_hint = rec.isp_hint

    def _resolve_protocol(self, service: ProxyService, scheme: Optional[str]) -> str:
        """Mixed lists carry the scheme per line; single-protocol lists do not."""
        declared = (service.protocol or "").strip().upper()
        if declared != MIXED_PROTOCOL:
            return service.protocol
        value = (scheme or "").strip().upper()
        return value if value in KNOWN_PROTOCOLS else MIXED_FALLBACK_PROTOCOL

    def _parse_regex(self, text: str, service: ProxyService) -> int:
        local: List[ProxyRecord] = []
        seen = set()
        count = 0
        for m in IP_PORT_RE.finditer(text):
            ip = m.group("ip")
            port = _parse_port(m.group("port"))
            if not port or not _is_public_ipv4(ip):
                continue
            protocol = self._resolve_protocol(service, m.group("scheme"))
            key = f"{protocol}|{ip}:{port}"
            if key in seen:
                continue
            seen.add(key)
            local.append(ProxyRecord(ip=ip, port=port, protocol=protocol, source=service.name))
            count += 1
            if self.max_per_source > 0 and count >= self.max_per_source:
                break
        self._add_many(local)
        return count

    def _parse_geonode(self, text: str, service: ProxyService) -> int:
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            return self._parse_regex(text, service)

        entries: List[Dict[str, object]] = []
        if isinstance(payload, dict) and isinstance(payload.get("data"), list):
            entries = [x for x in payload["data"] if isinstance(x, dict)]
        elif isinstance(payload, list):
            entries = [x for x in payload if isinstance(x, dict)]
        else:
            return self._parse_regex(text, service)

        local: List[ProxyRecord] = []
        seen = set()
        count = 0
        for entry in entries:
            ip = str(entry.get("ip", "")).strip()
            port = _parse_port(entry.get("port"))
            if not ip or not port or not _is_public_ipv4(ip):
                continue
            protocol = service.protocol
            if isinstance(entry.get("protocol"), str):
                protocol = str(entry["protocol"]).strip().upper()
            elif isinstance(entry.get("protocols"), list) and entry["protocols"]:
                protocol = str(entry["protocols"][0]).strip().upper()
            if protocol not in {"HTTP", "HTTPS", "SOCKS4", "SOCKS5"}:
                protocol = service.protocol

            isp_hint = str(entry.get("isp", "") or entry.get("org", "")).strip()
            residential = _infer_residential(entry)
            key = f"{protocol}|{ip}:{port}"
            if key in seen:
                continue
            seen.add(key)
            local.append(
                ProxyRecord(
                    ip=ip,
                    port=port,
                    protocol=protocol,
                    source=service.name,
                    residential=residential,
                    isp_hint=isp_hint,
                )
            )
            count += 1
            if self.max_per_source > 0 and count >= self.max_per_source:
                break
        self._add_many(local)
        return count

    def _run_service(self, service: ProxyService) -> ServiceRunResult:
        started = time.perf_counter()
        error = ""
        found = 0
        for attempt in range(self.retries + 1):
            try:
                text = self._fetch_cached(service.url)
                found = self._parse_geonode(text, service) if service.parser == "geonode" else self._parse_regex(text, service)
                elapsed_ms = int((time.perf_counter() - started) * 1000)
                return ServiceRunResult(service=service.name, ok=True, proxies_found=found, elapsed_ms=elapsed_ms)
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError, ValueError) as exc:
                error = str(exc)
                if attempt < self.retries:
                    time.sleep(0.5 * (attempt + 1))
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        return ServiceRunResult(service=service.name, ok=False, proxies_found=0, elapsed_ms=elapsed_ms, error=error)

    def run(self, progress_cb=None) -> List[ProxyRecord]:
        self.results.clear()
        self._items.clear()
        total = len(self.services)
        done = 0
        with ThreadPoolExecutor(max_workers=self.threads) as pool:
            futures = [pool.submit(self._run_service, s) for s in self.services]
            for fut in as_completed(futures):
                row = fut.result()
                self.results.append(row)
                done += 1
                if progress_cb:
                    progress_cb(done, total, row)
        return sorted(self._items.values(), key=lambda x: (x.protocol, x.ip, x.port))
