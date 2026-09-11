from dataclasses import dataclass, field
from typing import Optional


@dataclass
class ProxyService:
    name: str
    url: str
    protocol: str
    parser: str = "regex"
    enabled: bool = True
    origin_repo: str = ""


@dataclass
class ProxyRecord:
    ip: str
    port: int
    protocol: str
    source: str
    username: str = ""
    password: str = ""
    residential: Optional[bool] = None
    isp_hint: str = ""
    working: bool = False
    latency_ms: float = 0.0
    exit_ip: str = ""
    check_error: str = ""
    supported_protocols: list[str] = field(default_factory=list)

    @property
    def address(self) -> str:
        return f"{self.ip}:{self.port}"


@dataclass
class ServiceRunResult:
    service: str
    ok: bool
    proxies_found: int
    elapsed_ms: int
    error: str = ""


@dataclass
class DomainTarget:
    name: str
    url: str
    host: str
    path: str = "/"
    port: int = 443
    use_tls: bool = True
    enabled: bool = True
    # How the response body must be validated.
    # "html"          -> status-only semantics (legacy behaviour)
    # "newapi_status" -> HTTP 200 + JSON object with a data object, no WAF page
    response: str = "html"


@dataclass
class DomainCheckResult:
    proxy: ProxyRecord
    passed_targets: list[str] = field(default_factory=list)
    failed_targets: list[str] = field(default_factory=list)
    errors: dict[str, str] = field(default_factory=dict)
    latency_ms: float = 0.0
